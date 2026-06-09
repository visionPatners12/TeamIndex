import express from "express";
import { z } from "zod";
import { createLogger } from "../config/log";
import type { Env } from "../config/env";
import { prisma } from "../db/prisma";
import { scheduleMatchTranches } from "../services/scheduler";
import { recalculateOfficialPrices } from "../services/priceEngine";
import {
  executeWhitelistedCallViaVault,
  adminAddAuthorizedOperator,
  adminAddWhitelistedContract,
  adminPause,
  adminUnpause,
  adminRemoveAuthorizedOperator,
  adminSetOperatorAllocation,
  adminSetOperatorTransactionCap,
  adminRemoveWhitelistedContract,
  adminAddTrustedStrategy,
  adminRemoveTrustedStrategy,
  getAllOperators,
  getOperatorInfo,
  getWhitelistedContracts,
  getTrustedStrategies,
  isWhitelistedContract,
  isTrustedStrategy,
  getVaultContract
} from "../onchain/vaultExecutor";
import { syncVaultEventsToDb } from "../onchain/poolSync";
import { ensureClubVaultExists } from "../onchain/clubVaultFactoryExecutor";
import { ethers } from "ethers";
import type { TransactionRequest } from "ethers";
import swaggerUi from "swagger-ui-express";
import { swaggerSpec } from "./swagger";
import { ERC20 } from "../contracts/erc20";
import { runAllocationEngine } from "../polymarket/allocationEngine";
import type { SelectedMarket, MarketClobData } from "../polymarket/allocationTypes";
import {
  syncCategories,
  syncMarkets,
  syncPrices,
  enrichSportsGames,
  runFullLimitlessSync,
} from "../limitless/limitlessSyncService";
import { discoverLimitlessClubCandidates } from "../limitless/limitlessDiscoveryService";
import { syncLimitlessFillsAndSettle } from "../limitless/limitlessPositionSync";
import { executeLimitlessTranche } from "../limitless/limitlessExecutor";
import { fetchLimitlessMarketData, fetchLimitlessMarketDataBatch } from "../limitless/limitlessMarketData";
import { isLimitlessTradingReady } from "../limitless/limitlessOrderClient";
import { assertUuid, getLimitlessMarketsForTeam, listLimitlessTeams } from "../sportsData/limitlessTeams";

export function startHttpServer({ env, logger }: { env: Env; logger: ReturnType<typeof createLogger> }) {
  const app = express();

  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,x-admin-key");
    if (_req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.use(express.json({ limit: "1mb" }));

  app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

  function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
    if (!env.ADMIN_API_KEY) return next();
    const key = String(req.headers["x-admin-key"] ?? "");
    if (!key || key !== env.ADMIN_API_KEY) return res.status(403).json({ error: "Forbidden" });
    return next();
  }

  const manualReconciliationStatus = "NEEDS_MANUAL_RECONCILIATION" as const;

  function serializeBaseChainDeposit(deposit: any) {
    if (!deposit) return deposit;
    return {
      ...deposit,
      sourceAmount: deposit.sourceAmount?.toString?.() ?? deposit.sourceAmount,
      baseDepositId: deposit.baseDepositId?.toString?.() ?? deposit.baseDepositId,
      polygonBalanceBeforeBridge: deposit.polygonBalanceBeforeBridge?.toString?.() ?? deposit.polygonBalanceBeforeBridge,
      usdcAmount: deposit.usdcAmount?.toString?.() ?? deposit.usdcAmount,
      sharesMinted: deposit.sharesMinted?.toString?.() ?? deposit.sharesMinted,
      createdAt: deposit.createdAt instanceof Date ? deposit.createdAt.toISOString() : deposit.createdAt,
      updatedAt: deposit.updatedAt instanceof Date ? deposit.updatedAt.toISOString() : deposit.updatedAt
    };
  }

  function inferBaseRetryStatus(deposit: any) {
    if (deposit.processingStep === "BASE_RELEASE" && !deposit.releaseTxHash) return manualReconciliationStatus;
    if (deposit.processingStep === "LIFI_BRIDGE" && !deposit.lifiBridgeTxHash) return manualReconciliationStatus;
    if (deposit.processingStep === "POLYGON_DEPOSIT" && !deposit.polygonDepositTxHash) return manualReconciliationStatus;
    if (deposit.processingStep === "BASE_MINT" && !deposit.baseMintTxHash) return manualReconciliationStatus;
    if (deposit.baseMintTxHash) return "COMPLETED";
    if (deposit.polygonDepositTxHash) return "MINTING_SHARES";
    if (deposit.lifiBridgeTxHash) return deposit.usdcAmount ? "DEPOSITING" : "BRIDGING";
    if (deposit.releaseTxHash) return "BRIDGING";
    return manualReconciliationStatus;
  }

  function inferChilizRetryStatus(deposit: any) {
    if (deposit.processingStep === "POLYGON_DEPOSIT" && !deposit.polygonDepositTxHash) return manualReconciliationStatus;
    if (deposit.processingStep === "CHILIZ_MINT" && !deposit.chilizMintTxHash) return manualReconciliationStatus;
    if (deposit.chilizMintTxHash) return "COMPLETED";
    if (deposit.polygonDepositTxHash) return "MINTING_SHARES";
    if (deposit.usdcAmount) return "DEPOSITING";
    return manualReconciliationStatus;
  }

  async function retryFailedBaseDeposits() {
    const deposits = await (prisma as any).base_chain_deposits.findMany({ where: { status: "FAILED" } });
    const summary = { retried: 0, manual: 0, completed: 0 };
    for (const deposit of deposits) {
      const nextStatus = inferBaseRetryStatus(deposit);
      await (prisma as any).base_chain_deposits.update({
        where: { id: deposit.id },
        data: {
          status: nextStatus,
          lastError: nextStatus === manualReconciliationStatus
            ? "Retry blocked: missing persisted transaction hash for a step that may have been attempted"
            : null,
          processingLockedAt: null,
          processingLockedBy: null,
          processingStep: nextStatus === manualReconciliationStatus ? deposit.processingStep : null
        }
      });
      if (nextStatus === manualReconciliationStatus) summary.manual += 1;
      else if (nextStatus === "COMPLETED") summary.completed += 1;
      else summary.retried += 1;
    }
    return summary;
  }

  async function retryFailedChilizDeposits() {
    const deposits = await prisma.cross_chain_deposits.findMany({ where: { status: "FAILED" } });
    const summary = { retried: 0, manual: 0, completed: 0 };
    for (const deposit of deposits) {
      const nextStatus = inferChilizRetryStatus(deposit);
      await prisma.cross_chain_deposits.update({
        where: { id: deposit.id },
        data: {
          status: nextStatus,
          lastError: nextStatus === manualReconciliationStatus
            ? "Retry blocked: missing persisted transaction hash for a step that may have been attempted"
            : null,
          processingLockedAt: null,
          processingLockedBy: null,
          processingStep: nextStatus === manualReconciliationStatus ? deposit.processingStep : null
        }
      });
      if (nextStatus === manualReconciliationStatus) summary.manual += 1;
      else if (nextStatus === "COMPLETED") summary.completed += 1;
      else summary.retried += 1;
    }
    return summary;
  }

  app.get("/health", async (_req, res) => {
    const dbOk = await prisma
      .$queryRaw`SELECT 1`
      .then(() => true)
      .catch(() => false);
    res.json({ ok: true, db: dbOk });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Public platform settings (Chiliz network on/off is read from here).
  // The settings row is a singleton keyed by "default" and lazily created.
  // ────────────────────────────────────────────────────────────────────────
  async function getOrCreateSettings() {
    const existing = await prisma.system_settings.findUnique({ where: { key: "default" } });
    if (existing) return existing;
    return prisma.system_settings.create({ data: { key: "default" } });
  }

  app.get("/settings/public", async (_req, res) => {
    try {
      const s = await getOrCreateSettings();
      res.json({ ok: true, chilizEnabled: s.chilizEnabled, updatedAt: s.updatedAt });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? "settings_error" });
    }
  });

  app.get("/admin/settings", requireAdmin, async (_req, res) => {
    try {
      const s = await getOrCreateSettings();
      res.json({ ok: true, settings: s });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? "settings_error" });
    }
  });

  app.patch("/admin/settings/chiliz", requireAdmin, async (req, res) => {
    try {
      const enabled = Boolean(req.body?.enabled);
      const updated = await prisma.system_settings.upsert({
        where: { key: "default" },
        update: { chilizEnabled: enabled },
        create: { key: "default", chilizEnabled: enabled },
      });
      res.json({ ok: true, settings: updated });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? "settings_error" });
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // Real-time CHZ/USD price (CoinGecko, lightly cached).
  // Exposed publicly so the UI can always show the current price, even when
  // the Chiliz deposit flow is disabled by the admin.
  // ────────────────────────────────────────────────────────────────────────
  let chzPriceCache: { at: number; usd: number } | null = null;
  const CHZ_CACHE_MS = 30_000;

  app.get("/chz/price", async (_req, res) => {
    try {
      const now = Date.now();
      if (chzPriceCache && now - chzPriceCache.at < CHZ_CACHE_MS) {
        return res.json({ ok: true, usd: chzPriceCache.usd, cached: true, fetchedAt: chzPriceCache.at });
      }
      const resp = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=chiliz&vs_currencies=usd",
        { headers: { accept: "application/json" } }
      );
      if (!resp.ok) throw new Error(`coingecko_${resp.status}`);
      const json: any = await resp.json();
      const usd = Number(json?.chiliz?.usd);
      if (!Number.isFinite(usd) || usd <= 0) throw new Error("invalid_chz_price");
      chzPriceCache = { at: now, usd };
      res.json({ ok: true, usd, cached: false, fetchedAt: now });
    } catch (e: any) {
      if (chzPriceCache) {
        return res.json({ ok: true, usd: chzPriceCache.usd, cached: true, stale: true, fetchedAt: chzPriceCache.at });
      }
      res.status(502).json({ ok: false, error: e?.message ?? "chz_price_error" });
    }
  });

  app.get("/pools", async (_req, res) => {
    const rows = await prisma.club_pools.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { users: true } } }
    });
    const pools = rows.map(({ _count, ...pool }) => ({
      ...pool,
      holdersCount: _count.users
    }));
    res.json({ ok: true, pools });
  });

  app.get("/teams", async (_req, res) => {
    try {
      const teams = await listLimitlessTeams(prisma);
      res.json({ ok: true, teams });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? "teams_error" });
    }
  });

  app.get("/teams/:teamId/limitless-markets", async (req, res) => {
    try {
      assertUuid(req.params.teamId, "teamId");
      const markets = await getLimitlessMarketsForTeam(prisma, req.params.teamId);
      res.json({ ok: true, teamId: req.params.teamId, total: markets.length, markets });
    } catch (e: any) {
      const message = e?.message ?? "team_markets_error";
      res.status(message.includes("UUID") ? 400 : 500).json({ ok: false, error: message });
    }
  });

  app.get("/pools/:poolId", async (req, res) => {
    const row = await prisma.club_pools.findUnique({
      where: { id: req.params.poolId },
      include: { _count: { select: { users: true } } }
    });
    if (!row) return res.status(404).json({ error: "Pool not found" });
    const { _count, ...pool } = row;
    res.json({ ok: true, pool: { ...pool, holdersCount: _count.users } });
  });

  app.get("/pools/:poolId/candidates", async (req, res) => {
    const candidates = await prisma.club_market_candidates.findMany({
      where: { poolId: req.params.poolId },
      orderBy: { discoveredAt: "desc" }
    });
    res.json({ ok: true, candidates });
  });

  app.get("/pools/:poolId/queue", async (req, res) => {
    const queue = await prisma.club_match_queue.findMany({
      where: { poolId: req.params.poolId },
      orderBy: { executionTime: "asc" }
    });
    res.json({ ok: true, queue });
  });

  app.get("/pools/:poolId/positions", async (req, res) => {
    const poolId = req.params.poolId;

    const [rawPositions, selectedMarkets] = await Promise.all([
      prisma.club_pool_positions.findMany({
        where: { poolId, status: { in: ["OPEN", "SETTLED"] } },
        orderBy: { createdAt: "desc" },
      }),
      (prisma as any).pool_selected_markets
        ? (prisma as any).pool_selected_markets.findMany({ where: { poolId } })
        : Promise.resolve([]),
    ]);

    const metaMap = new Map<string, any>(
      (selectedMarkets as any[]).map((m: any) => [m.marketId, m])
    );

    const positions = rawPositions.map((pos) => {
      const meta = metaMap.get(pos.marketId);
      const investedAmount = Number(pos.investedAmount ?? pos.stake ?? 0);
      const currentValue   = Number(pos.currentValue ?? pos.investedAmount ?? 0);
      const quantity       = Number(pos.quantity ?? pos.plannedQuantity ?? 0);
      const unrealizedPnl  = currentValue - investedAmount;
      const unrealizedPnlPct = investedAmount > 0 ? unrealizedPnl / investedAmount : 0;
      const currentPrice   = quantity > 0 ? currentValue / quantity : Number(pos.entryPrice ?? 0.5);

      return {
        conditionId:      meta?.conditionId ?? pos.marketId,
        question:         meta?.question ?? `Market ${pos.marketId.slice(0, 8)}`,
        marketType:       meta?.marketType ?? "game",
        selectedSide:     pos.side,
        sizeUsdc:         investedAmount,
        entryPrice:       Number(pos.entryPrice ?? 0),
        currentPrice:     currentPrice,
        unrealizedPnl,
        unrealizedPnlPct,
        status:           pos.status === "OPEN" ? "open" : pos.status === "SETTLED" ? "settled" : "closed",
        endsAt:           meta?.endDateIso ?? null,
      };
    });

    res.json({ ok: true, positions });
  });

  // ─── User holdings across all pools ──────────────────────────────────────────
  // Returns every pool where the given wallet address holds shares, combining
  //   • Polygon direct shares (club_pool_users — populated from vault Deposit/Withdraw events)
  //   • Base-bridged shares (base_chain_deposits where status=COMPLETED — wrapped ERC20 on Base)
  // The frontend gets a unified `shares` total plus a `sharesByChain` breakdown.
  app.get("/users/:address/holdings", async (req, res) => {
    const address = String(req.params.address || "").trim();
    if (!address) return res.status(400).json({ error: "Missing address" });

    const VAULT_SHARE_DECIMALS = 6;
    const decimalDivisor = 10 ** VAULT_SHARE_DECIMALS;

    // Polygon direct holders.
    const userRows = await prisma.club_pool_users.findMany({
      where: {
        userAddress: { equals: address, mode: "insensitive" },
        tokenBalance: { gt: 0 },
      },
    });

    // Base bridge holders — only COMPLETED deposits map to onchain wrapped balances.
    const baseDepositRows = await (prisma as any).base_chain_deposits.findMany({
      where: {
        userAddress: { equals: address, mode: "insensitive" },
        status: "COMPLETED",
        clubPoolId: { not: null },
        sharesMinted: { not: null }
      }
    });

    // Aggregate Base shares per pool.
    const baseSharesRawByPool = new Map<string, bigint>();
    for (const dep of baseDepositRows as Array<{ clubPoolId: string | null; sharesMinted: { toString(): string } | null }>) {
      if (!dep.clubPoolId || !dep.sharesMinted) continue;
      const prev = baseSharesRawByPool.get(dep.clubPoolId) ?? 0n;
      // `sharesMinted` is stored as a Decimal (6-decimal raw integer) — coerce via string.
      baseSharesRawByPool.set(dep.clubPoolId, prev + BigInt(dep.sharesMinted.toString().split(".")[0]));
    }

    // Union of all pool IDs we need to load for naming/pricing.
    const poolIds = new Set<string>();
    for (const u of userRows) poolIds.add(u.poolId);
    for (const id of baseSharesRawByPool.keys()) poolIds.add(id);

    if (poolIds.size === 0) {
      return res.json({ ok: true, address, holdings: [], totalValueUsd: 0 });
    }

    const pools = await prisma.club_pools.findMany({
      where: { id: { in: Array.from(poolIds) } },
    });
    const poolById = new Map(pools.map((p) => [p.id, p]));

    // Re-implementation of the frontend tokenPriceUsdPerWholeShare logic — keep
    // pricing rules centralised so numbers shown on the landing page, dashboard
    // and deposit modal all agree.
    const toTvlHuman = (raw: string | null | undefined) => {
      if (!raw) return 0;
      const s = String(raw).trim();
      const n = Number(s);
      if (!Number.isFinite(n) || n <= 0) return 0;
      if (s.includes(".") || /[eE]/i.test(s)) return n;
      if (/^\d+$/.test(s)) return n / 1_000_000;
      return n;
    };

    // Map polygon shares (raw integer string from club_pool_users.tokenBalance) per pool.
    const polygonRawByPool = new Map<string, bigint>();
    const polygonUpdatedAtByPool = new Map<string, Date>();
    for (const u of userRows) {
      const raw = u.tokenBalance?.toString() ?? "0";
      polygonRawByPool.set(u.poolId, BigInt(raw.split(".")[0]));
      polygonUpdatedAtByPool.set(u.poolId, u.updatedAt);
    }

    const holdings = Array.from(poolIds)
      .map((poolId) => {
        const pool = poolById.get(poolId);
        if (!pool) return null;

        const polygonRaw = polygonRawByPool.get(poolId) ?? 0n;
        const baseRaw = baseSharesRawByPool.get(poolId) ?? 0n;
        const totalRaw = polygonRaw + baseRaw;
        if (totalRaw <= 0n) return null;

        const polygonShares = Number(polygonRaw) / decimalDivisor;
        const baseShares = Number(baseRaw) / decimalDivisor;
        const shares = polygonShares + baseShares;

        const tvl = toTvlHuman(pool.totalPoolValue?.toString());
        const rawSupply = Number(pool.totalTokenSupply?.toString() ?? "0");
        const sharesHuman = rawSupply > 0 ? rawSupply / decimalDivisor : 0;

        const stored = Number(pool.officialTokenPrice?.toString() ?? "0");
        let tokenPrice = 1;
        if (sharesHuman > 0 && tvl > 0) {
          const nav = tvl / sharesHuman;
          if (nav > 0 && stored > 0 && nav / stored > 10_000) tokenPrice = nav;
          else if (stored > 0) tokenPrice = stored;
          else tokenPrice = nav;
        } else if (stored > 0) {
          tokenPrice = stored;
        }

        const valueUsd = shares * tokenPrice;

        return {
          poolId: pool.id,
          clubName: pool.clubName,
          symbol: pool.symbol,
          vaultAddress: pool.vaultAddress,
          status: pool.status,
          shares,
          sharesByChain: {
            polygon: polygonShares,
            base: baseShares,
          },
          tokenBalanceRaw: totalRaw.toString(),
          tokenPriceUsd: tokenPrice,
          valueUsd,
          updatedAt: polygonUpdatedAtByPool.get(poolId) ?? new Date(),
        };
      })
      .filter((h): h is NonNullable<typeof h> => h !== null)
      .sort((a, b) => b.valueUsd - a.valueUsd);

    const totalValueUsd = holdings.reduce((s, h) => s + h.valueUsd, 0);

    res.json({ ok: true, address, holdings, totalValueUsd });
  });

  // ─── Pending Base deposits for a user ────────────────────────────────────────
  // Returns the user's in-flight cross-chain deposits from Base — those that
  // were received on the BaseDepositReceiver but haven't been fully processed
  // into wrapped shares yet. Lets the Dashboard surface a "Bridging…" banner.
  app.get("/users/:address/pending-base-deposits", async (req, res) => {
    const address = String(req.params.address || "").trim();
    if (!address) return res.status(400).json({ error: "Missing address" });

    const PENDING_STATUSES = ["RECEIVED", "BRIDGING", "DEPOSITING", "MINTING_SHARES"];

    const pending = await (prisma as any).base_chain_deposits.findMany({
      where: {
        userAddress: { equals: address, mode: "insensitive" },
        status: { in: PENDING_STATUSES }
      },
      orderBy: { createdAt: "desc" },
      take: 25
    });

    // Enrich with club name when known.
    const poolIds = Array.from(new Set(pending.map((d: any) => d.clubPoolId).filter(Boolean) as string[]));
    const pools = poolIds.length
      ? await prisma.club_pools.findMany({ where: { id: { in: poolIds } } })
      : [];
    const poolById = new Map(pools.map((p) => [p.id, p]));

    res.json({
      ok: true,
      address,
      deposits: pending.map((d: any) => {
        const pool = d.clubPoolId ? poolById.get(d.clubPoolId) : undefined;
        return {
          id: d.id,
          clubPoolId: d.clubPoolId,
          clubName: pool?.clubName ?? null,
          symbol: pool?.symbol ?? null,
          status: d.status,
          processingStep: d.processingStep,
          sourceAmount: d.sourceAmount?.toString() ?? null,
          baseTxHash: d.baseTxHash ?? null,
          baseDepositId: d.baseDepositId?.toString() ?? null,
          lastError: d.lastError ?? null,
          createdAt: d.createdAt
        };
      })
    });
  });

  app.get("/pools/:poolId/price-snapshots/latest", async (req, res) => {
    const latest = await prisma.club_pool_price_snapshots.findFirst({
      where: { poolId: req.params.poolId },
      orderBy: { snapshotTime: "desc" }
    });
    res.json({ ok: true, latest });
  });

  const poolCreateSchema = z.object({
    clubName: z.string().min(1),
    symbol: z.string().min(1),
    sportsDataTeamId: z.string().uuid(),
    totalTokenSupply: z.number().optional().default(0),
    depositCap: z.coerce.bigint().optional().default(0n),
    vaultAddress: z.string().optional(),
    deployOnchain: z.boolean().optional().default(false),
    riskParams: z
      .object({
        maxPerMatchPct: z.number().optional(),
        maxTotalExposurePct: z.number().optional(),
        liquidityMinUsd: z.number().optional()
      })
      .optional()
  });

  // Returns unsigned tx for admin's MetaMask to sign — no backend private key used.
  app.post("/admin/pools/tx/deploy-vault", requireAdmin, async (req, res) => {
    const body = z.object({
      clubName: z.string().min(1),
      symbol: z.string().min(1),
      depositCap: z.coerce.bigint().optional().default(0n),
    }).parse(req.body);

    if (!env.CLUB_VAULT_FACTORY_ADDRESS) {
      return res.status(400).json({ error: "CLUB_VAULT_FACTORY_ADDRESS not set in backend .env" });
    }
    if (!env.BASE_RPC_URL) {
      return res.status(400).json({ error: "RPC_URL not set in backend .env" });
    }

    const provider = new ethers.JsonRpcProvider(env.BASE_RPC_URL);
    const FACTORY_ABI = [
      "function getVaultByClub(bytes32) view returns (address)",
      "function createClubVault(bytes32, string, string, uint256) returns (address)"
    ];
    const factory = new ethers.Contract(env.CLUB_VAULT_FACTORY_ADDRESS, FACTORY_ABI, provider);

    const clubId = ethers.solidityPackedKeccak256(["string"], [body.clubName]);

    // Check if already deployed
    const existing = await (factory as any).getVaultByClub(clubId) as string;
    if (existing && existing !== ethers.ZeroAddress) {
      return res.json({ ok: true, alreadyDeployed: true, vaultAddress: existing });
    }

    // Build unsigned tx — admin wallet will sign this via MetaMask
    const tx: TransactionRequest = await (factory as any).createClubVault.populateTransaction(
      clubId,
      body.clubName,
      body.symbol,
      body.depositCap
    );

    return res.json({
      ok: true,
      alreadyDeployed: false,
      tx: { to: tx.to, data: tx.data },
      factoryAddress: env.CLUB_VAULT_FACTORY_ADDRESS,
      clubId,
    });
  });

  // After admin signs the vault deploy tx in MetaMask and gets back the vault address,
  // call this to create the DB pool record.
  app.post("/admin/pools", requireAdmin, async (req, res) => {
    try {
      const body = poolCreateSchema.parse(req.body);
      const riskParams = body.riskParams ?? { maxPerMatchPct: 3, maxTotalExposurePct: 20, liquidityMinUsd: 50_000 };

      let vaultDeployment: { vaultAddress: string; created: boolean } | null = null;
      if (body.deployOnchain) {
        vaultDeployment = await ensureClubVaultExists({
          env,
          clubName: body.clubName,
          symbol: body.symbol,
          depositCap: body.depositCap
        });
      }

      // If vaultAddress not provided, try to resolve from factory (read-only, no signing)
      let resolvedVaultAddress = vaultDeployment?.vaultAddress ?? body.vaultAddress ?? null;
      if (!resolvedVaultAddress && env.CLUB_VAULT_FACTORY_ADDRESS && env.BASE_RPC_URL) {
        try {
          const provider = new ethers.JsonRpcProvider(env.BASE_RPC_URL);
          const FACTORY_ABI = ["function getVaultByClub(bytes32) view returns (address)"];
          const factory = new ethers.Contract(env.CLUB_VAULT_FACTORY_ADDRESS, FACTORY_ABI, provider);
          const clubId = ethers.solidityPackedKeccak256(["string"], [body.clubName]);
          const found = await (factory as any).getVaultByClub(clubId) as string;
          if (found && found !== ethers.ZeroAddress) {
            resolvedVaultAddress = found;
          }
        } catch {
          // ignore — vault address will remain null
        }
      }

      const pool = await (prisma as any).club_pools.create({
        data: {
          clubName: body.clubName,
          symbol: body.symbol,
          sportsDataTeamId: body.sportsDataTeamId,
          vaultAddress: resolvedVaultAddress,
          depositCap: body.depositCap.toString(),
          cash: "0",
          openPositionsValue: "0",
          realizedPnl: "0",
          totalPoolValue: "0",
          totalTokenSupply: body.totalTokenSupply.toString(),
          officialTokenPrice: "0",
          riskParams,
          status: "ACTIVE"
        }
      });

      return res.json({ ok: true, pool, vaultDeployment });
    } catch (e: any) {
      logger.error({ err: e }, "admin/pools create failed");
      return res.status(500).json({ ok: false, error: e?.message ?? "Pool creation failed" });
    }
  });

  app.patch("/admin/pools/:poolId", requireAdmin, async (req, res) => {
    const { poolId } = req.params;
    const updateSchema = z.object({
      vaultAddress: z.string().optional(),
      sportsDataTeamId: z.string().uuid().nullable().optional(),
      status: z.enum(["ACTIVE", "PAUSED"]).optional(),
      officialTokenPrice: z.string().optional(),
      totalPoolValue: z.string().optional(),
      totalTokenSupply: z.string().optional(),
      depositCap: z.string().optional(),
    });
    const body = updateSchema.parse(req.body);
    const pool = await prisma.club_pools.update({
      where: { id: poolId },
      data: body
    });
    res.json({ ok: true, pool });
  });

  app.delete("/admin/pools/:poolId", requireAdmin, async (req, res) => {
    await prisma.club_pools.delete({ where: { id: req.params.poolId } });
    res.json({ ok: true });
  });

  // ─── Selected Markets (admin saves/retrieves market selection) ───────────────

  const selectedMarketsUpsertSchema = z.object({
    markets: z.array(z.object({
      marketId:        z.string().min(1),
      conditionId:     z.string().min(1),
      tokenId:         z.string().min(1),
      eventId:         z.string().optional().default(""),
      question:        z.string().min(1),
      marketType:      z.enum(["game", "future"]).default("game"),
      selectedSide:    z.enum(["YES", "NO"]).default("YES"),
      manualClusterId: z.string().optional(),
      endDateIso:      z.string().optional(),
      liquidity:       z.number().optional().default(0),
      yesPrice:        z.number().optional().default(0.5),
    })),
  });

  /**
   * GET /admin/pools/:poolId/selected-markets
   * Returns all admin-selected markets for a pool.
   */
  app.get("/admin/pools/:poolId/selected-markets", requireAdmin, async (req, res) => {
    try {
      const markets = await (prisma as any).pool_selected_markets.findMany({
        where: { poolId: req.params.poolId },
        orderBy: { createdAt: "asc" },
      });
      res.json({ ok: true, markets });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "DB error" });
    }
  });

  /**
   * POST /admin/pools/:poolId/selected-markets
   * Replaces (upserts) the full list of selected markets for a pool.
   */
  app.post("/admin/pools/:poolId/selected-markets", requireAdmin, async (req, res) => {
    const poolId = req.params.poolId;
    const pool = await prisma.club_pools.findUnique({ where: { id: poolId } });
    if (!pool) return res.status(404).json({ error: "Pool not found" });

    const { markets } = selectedMarketsUpsertSchema.parse(req.body);

    try {
      await (prisma as any).$transaction(
        markets.map((m: any) =>
          (prisma as any).pool_selected_markets.upsert({
            where: { poolId_conditionId: { poolId, conditionId: m.conditionId } },
            create: { ...m, poolId },
            update: { ...m, updatedAt: new Date() },
          })
        )
      );
      res.json({ ok: true, saved: markets.length });
    } catch (e: any) {
      logger.error({ err: e }, "selected-markets upsert failed");
      res.status(500).json({ error: e?.message ?? "DB error" });
    }
  });

  // ─── Allocation Proposal ─────────────────────────────────────────────────────

  const allocationProposalSchema = z.object({
    proposal: z.object({
      nav:              z.number(),
      targetExposure:   z.number(),
      cashWeight:       z.number(),
      cashAmount:       z.number(),
      portfolioQuality: z.number().optional().default(0),
      allocations:      z.array(z.any()),
      rejectedMarkets:  z.array(z.any()),
      clusterExposure:  z.record(z.number()),
    }),
    selectedMarkets: z.array(z.any()),
  });

  /**
   * POST /admin/pools/:poolId/allocation-proposal
   * Saves an accepted allocation proposal to the database.
   * Also upserts the selectedMarkets for this pool.
   */
  app.post("/admin/pools/:poolId/allocation-proposal", requireAdmin, async (req, res) => {
    const poolId = req.params.poolId;
    const pool = await prisma.club_pools.findUnique({ where: { id: poolId } });
    if (!pool) return res.status(404).json({ error: "Pool not found" });

    const { proposal, selectedMarkets } = allocationProposalSchema.parse(req.body);

    try {
      const [saved] = await (prisma as any).$transaction([
        (prisma as any).pool_allocation_proposals.create({
          data: {
            poolId,
            nav:              proposal.nav,
            targetExposure:   proposal.targetExposure,
            cashWeight:       proposal.cashWeight,
            cashAmount:       proposal.cashAmount,
            portfolioQuality: proposal.portfolioQuality ?? 0,
            proposalJson:     proposal as any,
            selectedMarketsJson: selectedMarkets as any,
            status:           "ACCEPTED",
          },
        }),
        // Also upsert each selected market
        ...(selectedMarkets as any[]).map((m: any) =>
          (prisma as any).pool_selected_markets.upsert({
            where: { poolId_conditionId: { poolId, conditionId: m.conditionId } },
            create: {
              poolId,
              marketId:        m.marketId,
              conditionId:     m.conditionId,
              tokenId:         m.tokenId,
              eventId:         m.eventId ?? "",
              question:        m.question,
              marketType:      m.marketType ?? "game",
              selectedSide:    m.selectedSide ?? "YES",
              manualClusterId: m.manualClusterId ?? null,
              endDateIso:      m.endDateIso ?? null,
              liquidity:       0,
              yesPrice:        0.5,
            },
            update: {
              selectedSide:    m.selectedSide ?? "YES",
              marketType:      m.marketType ?? "game",
              manualClusterId: m.manualClusterId ?? null,
              updatedAt:       new Date(),
            },
          })
        ),
      ]);

      res.json({ ok: true, proposalId: (saved as any).id });
    } catch (e: any) {
      logger.error({ err: e }, "allocation-proposal save failed");
      res.status(500).json({ error: e?.message ?? "DB error" });
    }
  });

  // ─── Latest allocation proposal (for reference) ───────────────────────────

  app.get("/admin/pools/:poolId/allocation-proposal/latest", requireAdmin, async (req, res) => {
    try {
      const proposal = await (prisma as any).pool_allocation_proposals.findFirst({
        where: { poolId: req.params.poolId },
        orderBy: { createdAt: "desc" },
      });
      res.json({ ok: true, proposal });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "DB error" });
    }
  });

  // ─── Run the allocation engine server-side ─────────────────────────────────
  //
  // POST /admin/pools/:poolId/allocation/run
  //   Body: { nav: number, selectedMarkets?: SelectedMarket[], persist?: boolean }
  //
  // Loads the pool's selected markets (from the body, or from the DB when
  // omitted), fetches a fresh CLOB/Gamma snapshot for each, runs the v2 quant
  // engine, and (by default) persists both the snapshot and the resulting
  // proposal as a COMPUTED row. Returns the proposal for immediate display.
  const allocationRunSchema = z.object({
    nav: z.number().positive(),
    persist: z.boolean().optional().default(true),
    selectedMarkets: z
      .array(
        z.object({
          marketId:        z.string().min(1),
          conditionId:     z.string().min(1),
          tokenId:         z.string().min(1),
          eventId:         z.string().optional().default(""),
          question:        z.string().min(1),
          marketType:      z.enum(["game", "future"]).default("game"),
          selectedSide:    z.enum(["YES", "NO"]).default("YES"),
          manualClusterId: z.string().optional(),
        })
      )
      .optional(),
  });

  app.post("/admin/pools/:poolId/allocation/run", requireAdmin, async (req, res) => {
    const poolId = req.params.poolId;
    const pool = await prisma.club_pools.findUnique({ where: { id: poolId } });
    if (!pool) return res.status(404).json({ error: "Pool not found" });

    const { nav, persist, selectedMarkets: bodyMarkets } = allocationRunSchema.parse(req.body);

    // Resolve the market set: prefer the body, else the pool's saved markets.
    let selectedMarkets: SelectedMarket[];
    if (bodyMarkets && bodyMarkets.length > 0) {
      selectedMarkets = bodyMarkets.map((m) => ({
        marketId:        m.marketId,
        conditionId:     m.conditionId,
        tokenId:         m.tokenId,
        eventId:         m.eventId ?? "",
        question:        m.question,
        marketType:      m.marketType,
        selectedSide:    m.selectedSide,
        manualClusterId: m.manualClusterId,
      }));
    } else {
      const rows = await (prisma as any).pool_selected_markets.findMany({
        where: { poolId, enabled: true },
        orderBy: { createdAt: "asc" },
      });
      selectedMarkets = (rows as any[]).map((r) => ({
        marketId:        r.marketId,
        conditionId:     r.conditionId,
        tokenId:         r.tokenId,
        eventId:         r.eventId ?? "",
        question:        r.question,
        marketType:      (r.marketType as "game" | "future") ?? "game",
        selectedSide:    (r.selectedSide as "YES" | "NO") ?? "YES",
        manualClusterId: r.manualClusterId ?? undefined,
      }));
    }

    if (selectedMarkets.length === 0) {
      return res.status(400).json({ error: "No selected markets for this pool" });
    }

    try {
      // Fetch a fresh snapshot for each market (resilient: failures are skipped
      // and surface as "Market data unavailable" rejections in the proposal).
      const snapshots = await Promise.all(
        selectedMarkets.map(async (m) => {
          try {
            const data = await fetchLimitlessMarketData(env, m.marketId, m.conditionId);
            return [m.conditionId, data] as const;
          } catch (err) {
            logger.warn({ err, conditionId: m.conditionId }, "market-data fetch failed for allocation run");
            return null;
          }
        })
      );

      const clobData = new Map<string, MarketClobData>();
      for (const s of snapshots) if (s) clobData.set(s[0], s[1]);

      const proposal = runAllocationEngine(selectedMarkets, clobData, nav);

      let proposalId: string | undefined;
      if (persist) {
        const saved = await (prisma as any).pool_allocation_proposals.create({
          data: {
            poolId,
            nav:                 proposal.nav,
            targetExposure:      proposal.targetExposure,
            cashWeight:          proposal.cashWeight,
            cashAmount:          proposal.cashAmount,
            portfolioQuality:    proposal.portfolioQuality ?? 0,
            proposalJson:        proposal as any,
            selectedMarketsJson: selectedMarkets as any,
            marketDataJson:      Object.fromEntries(clobData) as any,
            status:              "COMPUTED",
          },
        });
        proposalId = (saved as any).id;
      }

      res.json({ ok: true, proposal, proposalId });
    } catch (e: any) {
      logger.error({ err: e }, "allocation/run failed");
      res.status(502).json({ error: e?.message ?? "Allocation run failed" });
    }
  });

  const discoverSchema = z.object({
    clubName: z.string().min(1).optional(),
    sportsDataTeamId: z.string().uuid().optional(),
    riskPerMatchPct: z.number().optional().default(3),
    liquidityMinUsd: z.number().optional().default(50_000)
  });

  app.post("/admin/:poolId/discover", requireAdmin, async (req, res) => {
    const poolId = req.params.poolId;
    const body = discoverSchema.parse(req.body ?? {});

    const pool = await prisma.club_pools.findUnique({ where: { id: poolId } });
    if (!pool) return res.status(404).json({ error: "Pool not found" });

    const clubName = (body.clubName?.trim() || pool.clubName).trim();
    if (!clubName) return res.status(400).json({ error: "clubName missing" });

    const sportsDataTeamId =
      body.sportsDataTeamId?.trim() || (pool as any).sportsDataTeamId?.trim?.() || undefined;
    if (!sportsDataTeamId) return res.status(400).json({ error: "sportsDataTeamId missing" });

    const result = await discoverLimitlessClubCandidates({
      poolId,
      clubName,
      sportsDataTeamId,
      riskPerMatchPct: body.riskPerMatchPct,
      liquidityMinUsd: body.liquidityMinUsd,
      env
    });

    const candidates = await prisma.club_market_candidates.findMany({ where: { poolId } });
    res.json({ ok: true, ...result, count: candidates.length, candidates });
  });

  // Create scheduled queue entries (T-48h and T-24h) for the latest candidates.
  app.post("/admin/:poolId/schedule", requireAdmin, async (req, res) => {
    const poolId = req.params.poolId;
    const result = await scheduleMatchTranches({ poolId, env });
    res.json({ ok: true, ...result });
  });

  app.post("/admin/:poolId/pause", requireAdmin, async (req, res) => {
    const poolId = req.params.poolId;
    const pool = await prisma.club_pools.findUnique({ where: { id: poolId } });
    if (!pool) return res.status(404).json({ error: "Pool not found" });
    await adminPause(env, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined });
    res.json({ ok: true });
  });

  app.post("/admin/:poolId/unpause", requireAdmin, async (req, res) => {
    const poolId = req.params.poolId;
    const pool = await prisma.club_pools.findUnique({ where: { id: poolId } });
    if (!pool) return res.status(404).json({ error: "Pool not found" });
    await adminUnpause(env, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined });
    res.json({ ok: true });
  });

  const opAuthSchema = z.object({
    operator: z.string().min(1),
    allocation: z.coerce.bigint(),
    transactionCap: z.coerce.bigint()
  });

  app.post("/admin/:poolId/operator/authorize", requireAdmin, async (req, res) => {
    const poolId = req.params.poolId;
    const body = opAuthSchema.parse(req.body);
    const pool = await prisma.club_pools.findUnique({ where: { id: poolId } });
    if (!pool) return res.status(404).json({ error: "Pool not found" });
    await adminAddAuthorizedOperator(env, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined }, body);
    res.json({ ok: true });
  });

  app.post("/admin/:poolId/operator/remove", requireAdmin, async (req, res) => {
    const poolId = req.params.poolId;
    const body = z.object({ operator: z.string().min(1) }).parse(req.body);
    const pool = await prisma.club_pools.findUnique({ where: { id: poolId } });
    if (!pool) return res.status(404).json({ error: "Pool not found" });
    await adminRemoveAuthorizedOperator(env, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined }, body.operator);
    res.json({ ok: true });
  });

  app.post("/admin/:poolId/operator/allocation", requireAdmin, async (req, res) => {
    const poolId = req.params.poolId;
    const body = z.object({ operator: z.string().min(1), newAllocation: z.coerce.bigint() }).parse(req.body);
    const pool = await prisma.club_pools.findUnique({ where: { id: poolId } });
    if (!pool) return res.status(404).json({ error: "Pool not found" });
    await adminSetOperatorAllocation(env, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined }, body);
    res.json({ ok: true });
  });

  app.post("/admin/:poolId/operator/txcap", requireAdmin, async (req, res) => {
    const poolId = req.params.poolId;
    const body = z.object({ operator: z.string().min(1), newTxCap: z.coerce.bigint() }).parse(req.body);
    const pool = await prisma.club_pools.findUnique({ where: { id: poolId } });
    if (!pool) return res.status(404).json({ error: "Pool not found" });
    await adminSetOperatorTransactionCap(env, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined }, body);
    res.json({ ok: true });
  });

  const whitelistSchema = z.object({ contractAddress: z.string().min(1) });

  app.post("/admin/:poolId/whitelist/add", requireAdmin, async (req, res) => {
    const poolId = req.params.poolId;
    const body = whitelistSchema.parse(req.body);
    const pool = await prisma.club_pools.findUnique({ where: { id: poolId } });
    if (!pool) return res.status(404).json({ error: "Pool not found" });
    await adminAddWhitelistedContract(env, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined }, body.contractAddress);
    res.json({ ok: true });
  });

  app.post("/admin/:poolId/whitelist/remove", requireAdmin, async (req, res) => {
    const poolId = req.params.poolId;
    const body = whitelistSchema.parse(req.body);
    const pool = await prisma.club_pools.findUnique({ where: { id: poolId } });
    if (!pool) return res.status(404).json({ error: "Pool not found" });
    await adminRemoveWhitelistedContract(env, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined }, body.contractAddress);
    res.json({ ok: true });
  });

  // Trusted strategies admin
  const strategySchema = z.object({ strategy: z.string().min(1) });

  app.post("/admin/:poolId/trusted-strategy/add", requireAdmin, async (req, res) => {
    const poolId = req.params.poolId;
    const body = strategySchema.parse(req.body);
    const pool = await prisma.club_pools.findUnique({ where: { id: poolId } });
    if (!pool) return res.status(404).json({ error: "Pool not found" });
    await adminAddTrustedStrategy(env, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined }, body.strategy);
    res.json({ ok: true });
  });

  app.post("/admin/:poolId/trusted-strategy/remove", requireAdmin, async (req, res) => {
    const poolId = req.params.poolId;
    const body = strategySchema.parse(req.body);
    const pool = await prisma.club_pools.findUnique({ where: { id: poolId } });
    if (!pool) return res.status(404).json({ error: "Pool not found" });
    await adminRemoveTrustedStrategy(env, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined }, body.strategy);
    res.json({ ok: true });
  });

  app.get("/admin/operators", requireAdmin, async (_req, res) => {
    const operators = await getAllOperators(env, undefined);
    res.json({ ok: true, operators });
  });

  app.get("/admin/operators/:operator", requireAdmin, async (req, res) => {
    const info = await getOperatorInfo(env, undefined, req.params.operator);
    res.json({ ok: true, info });
  });

  app.get("/admin/whitelist", requireAdmin, async (_req, res) => {
    const list = await getWhitelistedContracts(env, undefined);
    res.json({ ok: true, whitelist: list });
  });

  app.get("/admin/whitelist/:contractAddress", requireAdmin, async (req, res) => {
    const status = await isWhitelistedContract(env, undefined, req.params.contractAddress);
    res.json({ ok: true, isWhitelisted: status });
  });

  app.get("/admin/trusted-strategies", requireAdmin, async (_req, res) => {
    const list = await getTrustedStrategies(env, undefined);
    res.json({ ok: true, trustedStrategies: list });
  });

  app.get("/admin/trusted-strategies/:strategy", requireAdmin, async (req, res) => {
    const status = await isTrustedStrategy(env, undefined, req.params.strategy);
    res.json({ ok: true, isTrusted: status });
  });

  app.post("/admin/:poolId/execute-tranche", requireAdmin, async (req, res) => {
    const body = z.object({ candidateId: z.string().min(1), tranche: z.number().int().min(1).max(2) }).parse(req.body);
    const queue = await prisma.club_match_queue.findUnique({
      where: {
        poolId_candidateId_tranche: {
          poolId: req.params.poolId,
          candidateId: body.candidateId,
          tranche: body.tranche
        }
      }
    });
    if (!queue) return res.status(404).json({ error: "Scheduled tranche not found" });
    if (queue.status !== "SCHEDULED") {
      return res.status(409).json({
        error: "Tranche is not executable",
        status: queue.status,
        queueId: queue.id
      });
    }

    const result = await executeLimitlessTranche({
      env,
      queueId: queue.id,
      poolId: req.params.poolId,
      candidateId: body.candidateId,
      tranche: body.tranche,
      expectedExecutionTimeMs: Date.now()
    });
    res.json({ ok: true, result });
  });

  const vaultExecuteSchema = z.object({
    target: z.string().min(1),
    data: z.string().min(2),
    value: z.coerce.bigint().default(0n),
    assetAmount: z.coerce.bigint().default(0n),
    minReturn: z.coerce.bigint().default(0n),
    isTrustedRequired: z.boolean().default(false)
  });

  app.post("/admin/:poolId/vault/execute", requireAdmin, async (req, res) => {
    const body = vaultExecuteSchema.parse(req.body);
    const poolId = req.params.poolId;
    const pool = await prisma.club_pools.findUnique({ where: { id: poolId } });
    if (!pool) return res.status(404).json({ error: "Pool not found" });
    const tx = await executeWhitelistedCallViaVault(
      env,
      { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined },
      {
        target: body.target,
        data: body.data,
        value: body.value,
        assetAmount: body.assetAmount,
        minReturn: body.minReturn,
        isTrustedRequired: body.isTrustedRequired
      }
    );
    res.json({ ok: true, txHash: tx.hash ?? undefined });
  });

  app.post("/admin/:poolId/reprice", requireAdmin, async (req, res) => {
    await recalculateOfficialPrices(env);
    res.json({ ok: true });
  });

  // =========================
  // Admin: onchain sync (vault -> DB)
  // =========================
  app.post("/admin/:poolId/sync", requireAdmin, async (req, res) => {
    const poolId = req.params.poolId;
    const body = z
      .object({
        fromBlock: z.coerce.number().int().nonnegative().optional(),
        toBlock: z.coerce.number().int().nonnegative().optional()
      })
      .parse(req.body);

    const pool = await prisma.club_pools.findUnique({ where: { id: poolId } });
    if (!pool) return res.status(404).json({ error: "Pool not found" });

    if (!env.BASE_RPC_URL) return res.status(400).json({ error: "RPC_URL missing" });
    const provider = new ethers.JsonRpcProvider(env.BASE_RPC_URL);

    const latest = await provider.getBlockNumber();
    const lastSynced = typeof (pool.riskParams as any)?.lastSyncedBlock === "number" ? (pool.riskParams as any).lastSyncedBlock : undefined;

    const fromBlock = body.fromBlock ?? (lastSynced !== undefined ? lastSynced + 1 : Math.max(0, latest - 50_000));
    const toBlock = body.toBlock ?? latest;

    await syncVaultEventsToDb({
      env,
      pool: {
        id: pool.id,
        clubName: pool.clubName,
        vaultAddress: pool.vaultAddress ?? undefined,
        officialTokenPrice: pool.officialTokenPrice,
        riskParams: pool.riskParams
      } as any,
      fromBlock,
      toBlock
    });

    // After DB sync, refresh official prices immediately for the response.
    await recalculateOfficialPrices(env);

    res.json({ ok: true, fromBlock, toBlock });
  });

  // =========================
  // User: prepare tx for deposit/mint/withdraw/redeem
  // =========================
  const ethAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
  const prepareDepositSchema = z.object({ assets: z.coerce.bigint(), receiver: ethAddressSchema });
  const prepareMintSchema = z.object({ shares: z.coerce.bigint(), receiver: ethAddressSchema });
  const prepareWithdrawSchema = z.object({ assets: z.coerce.bigint(), receiver: ethAddressSchema, owner: ethAddressSchema });
  const prepareRedeemSchema = z.object({ shares: z.coerce.bigint(), receiver: ethAddressSchema, owner: ethAddressSchema });

  // WrapCHZ (Polygon) -> swap to USDC -> vault deposit.
  // Returns a sequence of unsigned txs the user signs in order.
  const prepareDepositWrapChzSchema = z.object({
    sender: ethAddressSchema, // swap output recipient (should be the signing wallet)
    receiver: ethAddressSchema, // vault shares receiver
    wrapChzAmountIn: z.coerce.bigint(),
    usdcAmountOutMin: z.coerce.bigint(),
    // How much USDC to deposit to the vault (defaults to minOut so the deposit amount is guaranteed by swap).
    depositAssets: z.coerce.bigint().optional()
  });

  // Immediately ingest a confirmed vault deposit tx into DB (single block; does not advance lastSyncedBlock).
  app.post("/pools/:poolId/deposit/confirm", async (req, res) => {
    const poolId = req.params.poolId;
    const body = z
      .object({
        txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/i)
      })
      .parse(req.body);
    const txLc = body.txHash.toLowerCase();

    if (!env.BASE_RPC_URL) {
      return res.status(400).json({ error: "RPC_URL missing" });
    }

    const pool = await prisma.club_pools.findUnique({ where: { id: poolId } });
    if (!pool) return res.status(404).json({ error: "Pool not found" });
    if (!pool.vaultAddress) {
      return res.status(400).json({ error: "Pool vaultAddress not configured" });
    }

    const provider = new ethers.JsonRpcProvider(env.BASE_RPC_URL);
    const receipt = await provider.getTransactionReceipt(body.txHash);
    if (!receipt || receipt.status !== 1) {
      return res.status(400).json({ error: "Transaction not found or not successful" });
    }

    const vaultLc = pool.vaultAddress.toLowerCase();
    const touchesVault = receipt.logs.some((l) => (l.address || "").toLowerCase() === vaultLc);
    if (!touchesVault) {
      return res.status(400).json({ error: "Transaction does not involve this pool vault" });
    }

    const bn = Number(receipt.blockNumber);
    await syncVaultEventsToDb({
      env,
      pool: {
        id: pool.id,
        clubName: pool.clubName,
        vaultAddress: pool.vaultAddress ?? undefined,
        officialTokenPrice: pool.officialTokenPrice,
        riskParams: pool.riskParams
      } as any,
      fromBlock: bn,
      toBlock: bn,
      onlyTransactionHashes: [txLc],
      skipCursorAdvance: true
    });

    await recalculateOfficialPrices(env);

    const row = await prisma.club_pools.findUnique({
      where: { id: poolId },
      include: { _count: { select: { users: true } } }
    });
    if (!row) return res.status(404).json({ error: "Pool not found" });
    const { _count, ...rest } = row;
    res.json({ ok: true, pool: { ...rest, holdersCount: _count.users } });
  });

  app.post("/pools/:poolId/tx/deposit", async (req, res) => {
    const body = prepareDepositSchema.parse(req.body);
    const poolId = req.params.poolId;
    if (!env.BASE_RPC_URL) return res.status(500).json({ error: "RPC_URL is required." });
    const provider = new ethers.JsonRpcProvider(env.BASE_RPC_URL);
    const pool = await prisma.club_pools.findUnique({ where: { id: poolId } });
    if (!pool) return res.status(404).json({ error: "Pool not found" });
    const vault = await getVaultContract(env, provider as any, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined });
    const assetAddress: string = await (vault as any).asset();
    const vaultAddress: string = (vault as any).target ?? (vault as any).address;
    if (env.BASE_USDC_ADDRESS && assetAddress.toLowerCase() !== env.BASE_USDC_ADDRESS.toLowerCase()) {
      return res.status(409).json({
        ok: false,
        code: "VAULT_ASSET_MISMATCH",
        error: "This pool vault was deployed with a different USDC contract than the configured Base USDC. Deposits are disabled for this pool; create a new pool with the Base native USDC factory.",
        vaultAddress,
        assetAddress,
        expectedAssetAddress: env.BASE_USDC_ADDRESS
      });
    }
    const asset = new ethers.Contract(assetAddress, ERC20.abi, provider);
    const approveTx: TransactionRequest = await (asset as any).approve.populateTransaction(vaultAddress, body.assets);
    const depositFn = (vault as any).deposit;
    if (!depositFn?.populateTransaction) {
      return res.status(500).json({
        error: "Vault does not expose deposit().populateTransaction (ethers v6 ABI wiring issue)",
        poolId,
        clubName: pool.clubName,
        vaultAddress: pool.vaultAddress ?? null
      });
    }
    const tx: TransactionRequest = await depositFn.populateTransaction(body.assets, body.receiver);
    res.json({
      ok: true,
      tx,
      vaultAddress,
      assetAddress,
      txs: {
        approveTx,
        depositTx: tx
      }
    });
  });

  app.post("/pools/:poolId/tx/mint", async (req, res) => {
    const body = prepareMintSchema.parse(req.body);
    const poolId = req.params.poolId;
    const provider = env.BASE_RPC_URL ? new ethers.JsonRpcProvider(env.BASE_RPC_URL) : undefined;
    const pool = await prisma.club_pools.findUnique({ where: { id: poolId } });
    if (!pool) return res.status(404).json({ error: "Pool not found" });
    const vault = await getVaultContract(env, provider as any, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined });
    const mintFn = (vault as any).mint;
    if (!mintFn?.populateTransaction) {
      return res.status(500).json({
        error: "Vault does not expose mint().populateTransaction (ethers v6 ABI wiring issue)",
        poolId,
        clubName: pool.clubName,
        vaultAddress: pool.vaultAddress ?? null
      });
    }
    const tx: TransactionRequest = await mintFn.populateTransaction(body.shares, body.receiver);
    res.json({ ok: true, tx });
  });

  app.post("/pools/:poolId/tx/withdraw", async (req, res) => {
    const body = prepareWithdrawSchema.parse(req.body);
    const poolId = req.params.poolId;
    const provider = env.BASE_RPC_URL ? new ethers.JsonRpcProvider(env.BASE_RPC_URL) : undefined;
    const pool = await prisma.club_pools.findUnique({ where: { id: poolId } });
    if (!pool) return res.status(404).json({ error: "Pool not found" });
    const vault = await getVaultContract(env, provider as any, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined });
    const withdrawFn = (vault as any).withdraw;
    if (!withdrawFn?.populateTransaction) {
      return res.status(500).json({
        error: "Vault does not expose withdraw().populateTransaction (ethers v6 ABI wiring issue)",
        poolId,
        clubName: pool.clubName,
        vaultAddress: pool.vaultAddress ?? null
      });
    }
    const tx: TransactionRequest = await withdrawFn.populateTransaction(body.assets, body.receiver, body.owner);
    res.json({ ok: true, tx });
  });

  app.post("/pools/:poolId/tx/redeem", async (req, res) => {
    const body = prepareRedeemSchema.parse(req.body);
    const poolId = req.params.poolId;
    const provider = env.BASE_RPC_URL ? new ethers.JsonRpcProvider(env.BASE_RPC_URL) : undefined;
    const pool = await prisma.club_pools.findUnique({ where: { id: poolId } });
    if (!pool) return res.status(404).json({ error: "Pool not found" });
    const vault = await getVaultContract(env, provider as any, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined });
    const redeemFn = (vault as any).redeem;
    if (!redeemFn?.populateTransaction) {
      return res.status(500).json({
        error: "Vault does not expose redeem().populateTransaction (ethers v6 ABI wiring issue)",
        poolId,
        clubName: pool.clubName,
        vaultAddress: pool.vaultAddress ?? null
      });
    }
    const tx: TransactionRequest = await redeemFn.populateTransaction(body.shares, body.receiver, body.owner);
    res.json({ ok: true, tx });
  });

  // =========================
  // Chiliz cross-chain endpoints
  // =========================

  // Admin: safely retry FAILED deposits from their furthest persisted stage.
  app.post("/admin/chiliz/retry-failed", requireAdmin, async (_req, res) => {
    const summary = await retryFailedChilizDeposits();
    res.json({ ok: true, ...summary });
  });

  // Backward-compatible route; it no longer resets deposits to RECEIVED.
  app.post("/admin/chiliz/reset-failed", requireAdmin, async (_req, res) => {
    const summary = await retryFailedChilizDeposits();
    res.json({ ok: true, deprecated: true, ...summary });
  });

  // =========================
  // Base USDC deposit endpoints
  // =========================

  const baseDepositUsdcSchema = z.object({
    poolId: z.string().min(1),
    amount: z.coerce.bigint()
  });

  app.post("/admin/base/retry-failed", requireAdmin, async (_req, res) => {
    const summary = await retryFailedBaseDeposits();
    res.json({ ok: true, ...summary });
  });

  // Backward-compatible route; it no longer resets deposits to RECEIVED.
  app.post("/admin/base/reset-failed", requireAdmin, async (_req, res) => {
    const summary = await retryFailedBaseDeposits();
    res.json({ ok: true, deprecated: true, ...summary });
  });

  app.get("/base/deposits/:depositId", async (req, res) => {
    const deposit = await (prisma as any).base_chain_deposits.findUnique({
      where: { id: req.params.depositId }
    });
    if (!deposit) return res.status(404).json({ error: "Deposit not found" });
    res.json({ ok: true, deposit: serializeBaseChainDeposit(deposit) });
  });

  app.get("/base/deposits/user/:userAddress", async (req, res) => {
    const deposits = await (prisma as any).base_chain_deposits.findMany({
      where: { userAddress: req.params.userAddress },
      orderBy: { createdAt: "desc" }
    });
    res.json({ ok: true, deposits: deposits.map(serializeBaseChainDeposit) });
  });

  // GET status of a cross-chain deposit
  app.get("/chiliz/deposits/:depositId", async (req, res) => {
    const deposit = await prisma.cross_chain_deposits.findUnique({
      where: { id: req.params.depositId }
    });
    if (!deposit) return res.status(404).json({ error: "Deposit not found" });
    res.json({ ok: true, deposit });
  });

  // List all cross-chain deposits for a user
  app.get("/chiliz/deposits/user/:userAddress", async (req, res) => {
    const deposits = await prisma.cross_chain_deposits.findMany({
      where: { userAddress: req.params.userAddress },
      orderBy: { createdAt: "desc" }
    });
    res.json({ ok: true, deposits });
  });

  // Prepare unsigned tx for user to call depositCHZ on Chiliz chain
  const chilizDepositChzSchema = z.object({
    poolId: z.string().min(1) // backend poolId (we hash clubName to get bytes32)
  });

  // Redemption: user burns wrapped shares → gets value back on Chiliz
  const chilizRedeemSchema = z.object({
    poolId: z.string().min(1),
    userAddress: ethAddressSchema,
    shares: z.coerce.bigint()
  });

  app.post("/chiliz/redeem", requireAdmin, async (req, res) => {
    const body = chilizRedeemSchema.parse(req.body);

    const redemption = await prisma.cross_chain_redemptions.create({
      data: {
        poolId: body.poolId,
        userAddress: body.userAddress,
        sharesBurned: body.shares.toString(),
        status: "BURN_REQUESTED"
      }
    });

    res.json({ ok: true, redemption });
  });

  // GET redemption status
  app.get("/chiliz/redemptions/:redemptionId", async (req, res) => {
    const redemption = await prisma.cross_chain_redemptions.findUnique({
      where: { id: req.params.redemptionId }
    });
    if (!redemption) return res.status(404).json({ error: "Redemption not found" });
    res.json({ ok: true, redemption });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Limitless pipeline — /sports + /admin/limitless/*
  // Pipeline-only routes: not queried by the client-side app.
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * GET /sports
   * Returns enriched sport fixtures from lim_games joined with limitless_markets.
   * Filters: ?sport=soccer&league=Premier+League&limit=50&offset=0&upcoming=true
   * Admin-only (internal pipeline / dashboard).
   */
  app.get("/sports", requireAdmin, async (req, res) => {
    try {
      const sport = req.query.sport ? String(req.query.sport) : undefined;
      const league = req.query.league ? String(req.query.league) : undefined;
      const limit = Math.min(Number(req.query.limit ?? 50), 200);
      const offset = Number(req.query.offset ?? 0);
      const upcomingOnly = req.query.upcoming === "true";

      const where: Record<string, unknown> = {};
      if (sport) where.sport = sport;
      if (league) where.league = league;
      if (upcomingOnly) where.gameTime = { gte: new Date() };

      const [games, total] = await Promise.all([
        (prisma as any).lim_games.findMany({
          where,
          include: {
            market: {
              select: {
                id: true,
                title: true,
                status: true,
                yesPrice: true,
                noPrice: true,
                liquidity: true,
                volume: true,
                endDate: true,
                categoryId: true,
              },
            },
          },
          orderBy: { gameTime: "asc" },
          take: limit,
          skip: offset,
        }),
        (prisma as any).lim_games.count({ where }),
      ]);

      res.json({ ok: true, total, limit, offset, games });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? "sports_error" });
    }
  });

  /**
   * GET /admin/limitless/sync-state
   * Returns current sync state (provider, cursor, status, last sync time, counts).
   */
  app.get("/admin/limitless/sync-state", requireAdmin, async (_req, res) => {
    try {
      const state = await (prisma as any).limitless_sync_state.findUnique({
        where: { id: "default" },
      });
      res.json({ ok: true, state: state ?? { id: "default", provider: "limitless", status: "IDLE", marketsSynced: 0 } });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? "sync_state_error" });
    }
  });

  /**
   * POST /admin/limitless/sync/categories
   * Trigger a one-off category sync.
   */
  app.post("/admin/limitless/sync/categories", requireAdmin, async (_req, res) => {
    try {
      const upserted = await syncCategories(env);
      res.json({ ok: true, upserted });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? "sync_categories_error" });
    }
  });

  /**
   * POST /admin/limitless/sync/markets
   * Trigger a full market crawl (all pages, all statuses).
   * Long-running — may take tens of seconds for a large market set.
   */
  app.post("/admin/limitless/sync/markets", requireAdmin, async (_req, res) => {
    try {
      const synced = await syncMarkets(env);
      res.json({ ok: true, synced });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? "sync_markets_error" });
    }
  });

  /**
   * POST /admin/limitless/sync/prices
   * Refresh price ticks for active markets.
   * Query param: ?limit=200 (max markets to refresh per call)
   */
  app.post("/admin/limitless/sync/prices", requireAdmin, async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit ?? env.LIMITLESS_PRICE_SYNC_BATCH ?? 200), 500);
      const stored = await syncPrices(env, limit);
      res.json({ ok: true, stored });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? "sync_prices_error" });
    }
  });

  /**
   * POST /admin/limitless/sync/enrich
   * Run sport/league/team enrichment pass on un-enriched markets.
   */
  app.post("/admin/limitless/sync/enrich", requireAdmin, async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit ?? env.LIMITLESS_ENRICH_BATCH ?? 500), 2000);
      const enriched = await enrichSportsGames(env, limit);
      res.json({ ok: true, enriched });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? "enrich_error" });
    }
  });

  /**
   * POST /admin/limitless/sync/full
   * Run the complete pipeline: categories → markets → prices → sport enrichment.
   */
  app.post("/admin/limitless/sync/full", requireAdmin, async (_req, res) => {
    try {
      const result = await runFullLimitlessSync(env);
      res.json({ ok: true, ...result });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? "full_sync_error" });
    }
  });

  /**
   * GET /admin/limitless/markets
   * Browse raw limitless_markets with optional filters.
   * ?status=ACTIVE&categoryId=...&limit=50&offset=0
   */
  app.get("/admin/limitless/markets", requireAdmin, async (req, res) => {
    try {
      const status = req.query.status ? String(req.query.status) : undefined;
      const categoryId = req.query.categoryId ? String(req.query.categoryId) : undefined;
      const limit = Math.min(Number(req.query.limit ?? 50), 200);
      const offset = Number(req.query.offset ?? 0);

      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (categoryId) where.categoryId = categoryId;

      const [markets, total] = await Promise.all([
        (prisma as any).limitless_markets.findMany({
          where,
          select: {
            id: true, title: true, status: true,
            yesPrice: true, noPrice: true, liquidity: true,
            volume: true, endDate: true, categoryId: true, syncedAt: true,
          },
          orderBy: { liquidity: "desc" },
          take: limit,
          skip: offset,
        }),
        (prisma as any).limitless_markets.count({ where }),
      ]);

      res.json({ ok: true, total, limit, offset, markets });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? "markets_list_error" });
    }
  });

  /**
   * GET /admin/limitless/categories
   * List all synced categories.
   */
  app.get("/admin/limitless/categories", requireAdmin, async (_req, res) => {
    try {
      const categories = await (prisma as any).limitless_categories.findMany({
        orderBy: { label: "asc" },
      });
      res.json({ ok: true, categories });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? "categories_error" });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Limitless — Discovery + execution
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * POST /admin/limitless/discover/:poolId
   * Discover Limitless markets for a pool's club and create club_market_candidates.
   * Body: { sportsDataTeamId?, clubName?, riskPerMatchPct?, liquidityMinUsd? }
   */
  app.post("/admin/limitless/discover/:poolId", requireAdmin, async (req, res) => {
    try {
      const poolId = req.params.poolId;
      const pool = await prisma.club_pools.findUnique({ where: { id: poolId } });
      if (!pool) return res.status(404).json({ error: "Pool not found" });

      const clubName = String(req.body?.clubName ?? pool.clubName);
      const sportsDataTeamId =
        req.body?.sportsDataTeamId ? String(req.body.sportsDataTeamId) : (pool as any).sportsDataTeamId;
      if (!sportsDataTeamId) return res.status(400).json({ error: "sportsDataTeamId missing" });
      const riskPerMatchPct = Number(req.body?.riskPerMatchPct ?? (pool.riskParams as any)?.maxPerMatchPct ?? 3);
      const liquidityMinUsd = Number(req.body?.liquidityMinUsd ?? (pool.riskParams as any)?.liquidityMinUsd ?? 50_000);

      const result = await discoverLimitlessClubCandidates({
        poolId, clubName, sportsDataTeamId, riskPerMatchPct, liquidityMinUsd, env,
      });

      const candidates = await prisma.club_market_candidates.findMany({ where: { poolId } });
      res.json({ ok: true, ...result, count: candidates.length, candidates });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? "discovery_error" });
    }
  });

  /**
   * POST /admin/limitless/execute
   * Execute a single queue tranche on Limitless.
   * Body: { poolId, candidateId, tranche, queueId? }
   */
  app.post("/admin/limitless/execute", requireAdmin, async (req, res) => {
    try {
      const poolId = String(req.body?.poolId ?? "");
      const candidateId = String(req.body?.candidateId ?? "");
      const tranche = Number(req.body?.tranche ?? 1);
      const queueId = req.body?.queueId ? String(req.body.queueId) : undefined;

      if (!poolId || !candidateId) {
        return res.status(400).json({ error: "poolId and candidateId are required" });
      }

      const result = await executeLimitlessTranche({ poolId, candidateId, tranche, queueId, env });
      res.json({ ok: true, ...result });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? "execute_error" });
    }
  });

  /**
   * POST /admin/limitless/position-sync
   * Reconcile fills and settle resolved Limitless positions.
   */
  app.post("/admin/limitless/position-sync", requireAdmin, async (_req, res) => {
    try {
      await syncLimitlessFillsAndSettle(env);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? "position_sync_error" });
    }
  });

  /**
   * GET /admin/limitless/market-data/:marketId
   * Fetch a live MarketClobData snapshot for a Limitless market.
   * Used by the allocation engine admin UI.
   */
  app.get("/admin/limitless/market-data/:marketId", requireAdmin, async (req, res) => {
    try {
      const data = await fetchLimitlessMarketData(env, req.params.marketId);
      res.json({ ok: true, data });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? "market_data_error" });
    }
  });

  /**
   * POST /admin/limitless/market-data/batch
   * Fetch MarketClobData for multiple markets.
   * Body: { marketIds: string[] }
   */
  app.post("/admin/limitless/market-data/batch", requireAdmin, async (req, res) => {
    try {
      const ids: string[] = Array.isArray(req.body?.marketIds) ? req.body.marketIds : [];
      if (ids.length === 0) return res.status(400).json({ error: "marketIds required" });
      if (ids.length > 50) return res.status(400).json({ error: "max 50 marketIds per batch" });

      const map = await fetchLimitlessMarketDataBatch(env, ids);
      res.json({ ok: true, data: Object.fromEntries(map) });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? "batch_market_data_error" });
    }
  });

  /**
   * GET /admin/limitless/readiness
   * Check if Limitless trading wallet is configured and ready.
   */
  app.get("/admin/limitless/readiness", requireAdmin, (_req, res) => {
    const readiness = isLimitlessTradingReady(env);
    res.json({ ok: true, ...readiness });
  });

  const port = process.env.PORT ? Number(process.env.PORT) : 3001;
  app.listen(port, () => logger.info({ port }, "HTTP server listening"));
  return app;
}
