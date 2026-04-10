import express from "express";
import { z } from "zod";
import { createLogger } from "../config/log";
import type { Env } from "../config/env";
import { prisma } from "../db/prisma";
import { discoverClubCandidates } from "../services/discoveryService";
import { scheduleMatchTranches } from "../services/scheduler";
import { executeTranche } from "../services/executor";
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
import { UNISWAP_V2_ROUTER } from "../contracts/uniswapV2Router";
import { listTeams } from "../polymarket/gammaClient";

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

  app.get("/health", async (_req, res) => {
    const dbOk = await prisma
      .$queryRaw`SELECT 1`
      .then(() => true)
      .catch(() => false);
    res.json({ ok: true, db: dbOk });
  });

  app.get("/pools", async (_req, res) => {
    const pools = await prisma.club_pools.findMany({ orderBy: { createdAt: "desc" } });
    res.json({ ok: true, pools });
  });

  app.get("/teams", async (_req, res) => {
    const teams = await prisma.club_teams_map.findMany({ orderBy: { internalClubName: "asc" } });
    res.json({ ok: true, teams });
  });

  app.get("/pools/:poolId", async (req, res) => {
    const pool = await prisma.club_pools.findUnique({ where: { id: req.params.poolId } });
    if (!pool) return res.status(404).json({ error: "Pool not found" });
    res.json({ ok: true, pool });
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
    const positions = await prisma.club_pool_positions.findMany({
      where: { poolId: req.params.poolId, status: "OPEN" }
    });
    res.json({ ok: true, positions });
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
    polymarketTeamId: z.string().optional(),
    totalTokenSupply: z.number().optional().default(0),
    depositCap: z.coerce.bigint().optional().default(0n),
    vaultAddress: z.string().optional(),
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
    if (!env.RPC_URL) {
      return res.status(400).json({ error: "RPC_URL not set in backend .env" });
    }

    const provider = new ethers.JsonRpcProvider(env.RPC_URL);
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
    const body = poolCreateSchema.parse(req.body);
    const riskParams = body.riskParams ?? { maxPerMatchPct: 3, maxTotalExposurePct: 20, liquidityMinUsd: 50_000 };

    // If vaultAddress not provided, try to resolve from factory (read-only, no signing)
    let resolvedVaultAddress = body.vaultAddress ?? null;
    if (!resolvedVaultAddress && env.CLUB_VAULT_FACTORY_ADDRESS && env.RPC_URL) {
      try {
        const provider = new ethers.JsonRpcProvider(env.RPC_URL);
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

    const pool = await prisma.club_pools.create({
      data: {
        clubName: body.clubName,
        symbol: body.symbol,
        polymarketTeamId: body.polymarketTeamId?.trim() || null,
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

    return res.json({ ok: true, pool });
  });

  app.patch("/admin/pools/:poolId", requireAdmin, async (req, res) => {
    const { poolId } = req.params;
    const updateSchema = z.object({
      vaultAddress: z.string().optional(),
      polymarketTeamId: z.string().nullable().optional(),
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

  const clubTeamMapSchema = z.object({
    internalClubName: z.string().min(1),
    polymarketTeamId: z.string().min(1)
  });

  app.post("/admin/club-team-map", requireAdmin, async (req, res) => {
    const body = clubTeamMapSchema.parse(req.body);
    await prisma.club_teams_map.createMany({
      data: [{ internalClubName: body.internalClubName, polymarketTeamId: body.polymarketTeamId }],
      skipDuplicates: true
    });
    res.json({ ok: true });
  });

  app.get("/admin/gamma-teams", requireAdmin, async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const result = await listTeams(env, limit, offset);
    const teams = (result?.teams ?? []).map((t: Record<string, unknown>) => {
      const name = String(t.name ?? t.slug ?? t.slugKey ?? t.id ?? "").trim();
      return {
        id: String(t.id ?? ""),
        name,
        slug: t.slug != null ? String(t.slug) : undefined,
        league: t.league != null ? String(t.league) : undefined
      };
    }).filter((t) => t.name.length > 0);
    res.json({ ok: true, teams });
  });

  app.post("/admin/club-team-map/sync-from-gamma", requireAdmin, async (_req, res) => {
    try {
      const maxTeams = 5000;
      const pageSize = 100;
      let offset = 0;
      let inserted = 0;
      let pages = 0;
      while (offset < maxTeams) {
        const batch = await listTeams(env, pageSize, offset);
        const raw = batch?.teams ?? [];
        if (!raw.length) break;
        pages += 1;
        const rows: { internalClubName: string; polymarketTeamId: string }[] = [];
        for (const t of raw) {
          const rec = t as Record<string, unknown>;
          const label = String(rec.name ?? rec.slug ?? rec.slugKey ?? rec.id ?? "").trim();
          if (!label) continue;
          rows.push({ internalClubName: label, polymarketTeamId: label });
        }
        if (rows.length) {
          const r = await prisma.club_teams_map.createMany({ data: rows, skipDuplicates: true });
          inserted += r.count;
        }
        offset += raw.length;
        if (raw.length < pageSize) break;
      }
      res.json({ ok: true, inserted, pagesFetched: pages });
    } catch (e: any) {
      logger.error({ err: e }, "sync-from-gamma failed");
      res.status(502).json({ error: e?.message ?? "Gamma /teams request failed" });
    }
  });

  const discoverSchema = z.object({
    clubName: z.string().min(1).optional(),
    teamPolymarketId: z.string().optional(),
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

    const teamPolymarketId =
      body.teamPolymarketId?.trim() || pool.polymarketTeamId?.trim() || undefined;

    await discoverClubCandidates({
      poolId,
      clubName,
      teamPolymarketId,
      riskPerMatchPct: body.riskPerMatchPct,
      liquidityMinUsd: body.liquidityMinUsd,
      env
    });

    res.json({ ok: true });
  });

  // Create scheduled queue entries (T-48h and T-24h) for the latest candidates.
  app.post("/admin/:poolId/schedule", requireAdmin, async (req, res) => {
    const poolId = req.params.poolId;
    await scheduleMatchTranches({ poolId, env });
    res.json({ ok: true });
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
    await executeTranche({
      env,
      poolId: req.params.poolId,
      candidateId: body.candidateId,
      tranche: body.tranche,
      expectedExecutionTimeMs: Date.now()
    });
    res.json({ ok: true });
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

    if (!env.RPC_URL) return res.status(400).json({ error: "RPC_URL missing" });
    const provider = new ethers.JsonRpcProvider(env.RPC_URL);

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

  app.post("/pools/:poolId/tx/deposit-wrapchz", async (req, res) => {
    const body = prepareDepositWrapChzSchema.parse(req.body);
    const poolId = req.params.poolId;

    if (!env.RPC_URL) return res.status(500).json({ error: "RPC_URL is required." });
    if (!env.WRAPCHZ_TOKEN_ADDRESS) return res.status(500).json({ error: "WRAPCHZ_TOKEN_ADDRESS is not set." });
    if (!env.UNISWAP_V2_ROUTER_ADDRESS) return res.status(500).json({ error: "UNISWAP_V2_ROUTER_ADDRESS is not set." });

    const provider = new ethers.JsonRpcProvider(env.RPC_URL);
    const pool = await prisma.club_pools.findUnique({ where: { id: poolId } });
    if (!pool) return res.status(404).json({ error: "Pool not found" });

    const vault = await getVaultContract(env, provider as any, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined });
    const assetAddress: string = await (vault as any).asset();
    const vaultAddress: string = (vault as any).target ?? (vault as any).address;

    const depositAssets = body.depositAssets ?? body.usdcAmountOutMin;
    if (depositAssets > body.usdcAmountOutMin) {
      return res.status(400).json({
        error: "depositAssets must be <= usdcAmountOutMin.",
        depositAssets: depositAssets.toString(),
        usdcAmountOutMin: body.usdcAmountOutMin.toString()
      });
    }

    const wrapChz = new ethers.Contract(env.WRAPCHZ_TOKEN_ADDRESS, ERC20.abi, provider);
    const usdc = new ethers.Contract(assetAddress, ERC20.abi, provider);
    const router = new ethers.Contract(env.UNISWAP_V2_ROUTER_ADDRESS, UNISWAP_V2_ROUTER.abi, provider);

    const approveWrapChzTx: TransactionRequest = await (wrapChz as any).approve.populateTransaction(
      env.UNISWAP_V2_ROUTER_ADDRESS,
      body.wrapChzAmountIn
    );

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
    const path = [env.WRAPCHZ_TOKEN_ADDRESS, assetAddress];
    const swapTx: TransactionRequest = await (router as any).swapExactTokensForTokens.populateTransaction(
      body.wrapChzAmountIn,
      body.usdcAmountOutMin,
      path,
      body.sender,
      deadline
    );

    const approveUsdcTx: TransactionRequest = await (usdc as any).approve.populateTransaction(vaultAddress, depositAssets);

    const depositFn = (vault as any).deposit;
    if (!depositFn?.populateTransaction) {
      return res.status(500).json({
        error: "Vault does not expose deposit().populateTransaction (ethers v6 ABI wiring issue)",
        poolId,
        clubName: pool.clubName,
        vaultAddress: pool.vaultAddress ?? null
      });
    }
    const depositTx: TransactionRequest = await depositFn.populateTransaction(depositAssets, body.receiver);

    res.json({
      ok: true,
      meta: {
        vaultAddress,
        usdcAssetAddress: assetAddress,
        wrapChzAddress: env.WRAPCHZ_TOKEN_ADDRESS,
        routerAddress: env.UNISWAP_V2_ROUTER_ADDRESS,
        deadline: deadline.toString(),
        depositAssets: depositAssets.toString(),
        usdcAmountOutMin: body.usdcAmountOutMin.toString()
      },
      txs: { approveWrapChzTx, swapTx, approveUsdcTx, depositTx }
    });
  });

  app.post("/pools/:poolId/tx/deposit", async (req, res) => {
    const body = prepareDepositSchema.parse(req.body);
    const poolId = req.params.poolId;
    const provider = env.RPC_URL ? new ethers.JsonRpcProvider(env.RPC_URL) : undefined;
    const pool = await prisma.club_pools.findUnique({ where: { id: poolId } });
    if (!pool) return res.status(404).json({ error: "Pool not found" });
    const vault = await getVaultContract(env, provider as any, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined });
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
    res.json({ ok: true, tx });
  });

  app.post("/pools/:poolId/tx/mint", async (req, res) => {
    const body = prepareMintSchema.parse(req.body);
    const poolId = req.params.poolId;
    const provider = env.RPC_URL ? new ethers.JsonRpcProvider(env.RPC_URL) : undefined;
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
    const provider = env.RPC_URL ? new ethers.JsonRpcProvider(env.RPC_URL) : undefined;
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
    const provider = env.RPC_URL ? new ethers.JsonRpcProvider(env.RPC_URL) : undefined;
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

  // Admin: reset all FAILED deposits back to RECEIVED so relayer retries them
  app.post("/admin/chiliz/reset-failed", requireAdmin, async (_req, res) => {
    const result = await prisma.cross_chain_deposits.updateMany({
      where: { status: "FAILED" },
      data: { status: "RECEIVED", lastError: null }
    });
    res.json({ ok: true, reset: result.count });
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

  app.post("/chiliz/tx/deposit-chz", async (req, res) => {
    const body = chilizDepositChzSchema.parse(req.body);

    if (!env.CHILIZ_RPC_URL || !env.CHILIZ_DEPOSIT_RECEIVER_ADDRESS) {
      return res.status(500).json({ error: "Chiliz env not configured (CHILIZ_RPC_URL / CHILIZ_DEPOSIT_RECEIVER_ADDRESS)." });
    }

    const pool = await prisma.club_pools.findUnique({ where: { id: body.poolId } });
    if (!pool) return res.status(404).json({ error: "Pool not found" });

    const poolIdHash = ethers.keccak256(ethers.toUtf8Bytes(pool.clubName));

    const chilizProvider = new ethers.JsonRpcProvider(env.CHILIZ_RPC_URL);
    const receiver = new ethers.Contract(
      env.CHILIZ_DEPOSIT_RECEIVER_ADDRESS,
      ["function depositCHZ(bytes32 poolId) external payable"],
      chilizProvider
    );

    const tx = await (receiver as any).depositCHZ.populateTransaction(poolIdHash);
    res.json({
      ok: true,
      receiverAddress: env.CHILIZ_DEPOSIT_RECEIVER_ADDRESS,
      poolIdHash,
      tx
    });
  });

  // Prepare unsigned tx for user to call depositToken (fan token) on Chiliz chain
  const chilizDepositTokenSchema = z.object({
    poolId: z.string().min(1),
    token: ethAddressSchema,
    amount: z.coerce.bigint()
  });

  app.post("/chiliz/tx/deposit-token", async (req, res) => {
    const body = chilizDepositTokenSchema.parse(req.body);

    if (!env.CHILIZ_RPC_URL || !env.CHILIZ_DEPOSIT_RECEIVER_ADDRESS) {
      return res.status(500).json({ error: "Chiliz env not configured." });
    }

    const pool = await prisma.club_pools.findUnique({ where: { id: body.poolId } });
    if (!pool) return res.status(404).json({ error: "Pool not found" });

    const poolIdHash = ethers.keccak256(ethers.toUtf8Bytes(pool.clubName));

    const chilizProvider = new ethers.JsonRpcProvider(env.CHILIZ_RPC_URL);
    const tokenContract = new ethers.Contract(body.token, [
      "function approve(address spender, uint256 amount) external returns (bool)"
    ], chilizProvider);

    const approveTx = await (tokenContract as any).approve.populateTransaction(
      env.CHILIZ_DEPOSIT_RECEIVER_ADDRESS,
      body.amount
    );

    const receiver = new ethers.Contract(
      env.CHILIZ_DEPOSIT_RECEIVER_ADDRESS,
      ["function depositToken(address token, uint256 amount, bytes32 poolId) external"],
      chilizProvider
    );

    const depositTx = await (receiver as any).depositToken.populateTransaction(body.token, body.amount, poolIdHash);

    res.json({
      ok: true,
      receiverAddress: env.CHILIZ_DEPOSIT_RECEIVER_ADDRESS,
      poolIdHash,
      txs: { approveTx, depositTx }
    });
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

  const port = process.env.PORT ? Number(process.env.PORT) : 3001;
  app.listen(port, () => logger.info({ port }, "HTTP server listening"));
  return app;
}

