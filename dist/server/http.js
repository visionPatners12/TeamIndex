"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startHttpServer = startHttpServer;
const express_1 = __importDefault(require("express"));
const crypto_1 = require("crypto");
const zod_1 = require("zod");
const prisma_1 = require("../db/prisma");
const scheduler_1 = require("../services/scheduler");
const priceEngine_1 = require("../services/priceEngine");
const vaultExecutor_1 = require("../onchain/vaultExecutor");
const poolSync_1 = require("../onchain/poolSync");
const clubVaultFactoryExecutor_1 = require("../onchain/clubVaultFactoryExecutor");
const ethers_1 = require("ethers");
const swagger_ui_express_1 = __importDefault(require("swagger-ui-express"));
const swagger_1 = require("./swagger");
const erc20_1 = require("../contracts/erc20");
const allocationEngine_1 = require("../polymarket/allocationEngine");
const limitlessSyncService_1 = require("../limitless/limitlessSyncService");
const limitlessDiscoveryService_1 = require("../limitless/limitlessDiscoveryService");
const limitlessPositionSync_1 = require("../limitless/limitlessPositionSync");
const limitlessExecutor_1 = require("../limitless/limitlessExecutor");
const limitlessMarketData_1 = require("../limitless/limitlessMarketData");
const limitlessOrderClient_1 = require("../limitless/limitlessOrderClient");
const partnerAccounts_1 = require("../limitless/partnerAccounts");
const limitlessPortfolio_1 = require("../limitless/limitlessPortfolio");
const limitlessTeams_1 = require("../sportsData/limitlessTeams");
function startHttpServer({ env, logger }) {
    const app = (0, express_1.default)();
    app.use((_req, res, next) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type,x-admin-key");
        if (_req.method === "OPTIONS")
            return res.sendStatus(204);
        next();
    });
    app.use(express_1.default.json({
        limit: "1mb",
        verify: (req, _res, buf) => {
            req.rawBody = Buffer.from(buf);
        },
    }));
    app.use("/docs", swagger_ui_express_1.default.serve, swagger_ui_express_1.default.setup(swagger_1.swaggerSpec));
    function requireAdmin(req, res, next) {
        if (!env.ADMIN_API_KEY)
            return next();
        const key = String(req.headers["x-admin-key"] ?? "");
        if (!key || key !== env.ADMIN_API_KEY)
            return res.status(403).json({ error: "Forbidden" });
        return next();
    }
    function verifyCdpWebhook(req) {
        if (!env.CDP_WEBHOOK_SECRET)
            return true;
        const raw = req.rawBody;
        const signature = String(req.headers["x-cdp-signature"] ?? req.headers["x-webhook-signature"] ?? "");
        if (!raw || !signature)
            return false;
        const digest = (0, crypto_1.createHmac)("sha256", env.CDP_WEBHOOK_SECRET).update(raw).digest("hex");
        const normalized = signature.replace(/^sha256=/i, "");
        const a = Buffer.from(digest, "hex");
        const b = Buffer.from(normalized, "hex");
        return a.length === b.length && (0, crypto_1.timingSafeEqual)(a, b);
    }
    const manualReconciliationStatus = "NEEDS_MANUAL_RECONCILIATION";
    function serializeBaseChainDeposit(deposit) {
        if (!deposit)
            return deposit;
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
    function inferBaseRetryStatus(deposit) {
        if (deposit.processingStep === "BASE_RELEASE" && !deposit.releaseTxHash)
            return manualReconciliationStatus;
        if (deposit.processingStep === "LIFI_BRIDGE" && !deposit.lifiBridgeTxHash)
            return manualReconciliationStatus;
        if (deposit.processingStep === "POLYGON_DEPOSIT" && !deposit.polygonDepositTxHash)
            return manualReconciliationStatus;
        if (deposit.processingStep === "BASE_MINT" && !deposit.baseMintTxHash)
            return manualReconciliationStatus;
        if (deposit.baseMintTxHash)
            return "COMPLETED";
        if (deposit.polygonDepositTxHash)
            return "MINTING_SHARES";
        if (deposit.lifiBridgeTxHash)
            return deposit.usdcAmount ? "DEPOSITING" : "BRIDGING";
        if (deposit.releaseTxHash)
            return "BRIDGING";
        return manualReconciliationStatus;
    }
    function inferChilizRetryStatus(deposit) {
        if (deposit.processingStep === "POLYGON_DEPOSIT" && !deposit.polygonDepositTxHash)
            return manualReconciliationStatus;
        if (deposit.processingStep === "CHILIZ_MINT" && !deposit.chilizMintTxHash)
            return manualReconciliationStatus;
        if (deposit.chilizMintTxHash)
            return "COMPLETED";
        if (deposit.polygonDepositTxHash)
            return "MINTING_SHARES";
        if (deposit.usdcAmount)
            return "DEPOSITING";
        return manualReconciliationStatus;
    }
    async function retryFailedBaseDeposits() {
        const deposits = await prisma_1.prisma.base_chain_deposits.findMany({ where: { status: "FAILED" } });
        const summary = { retried: 0, manual: 0, completed: 0 };
        for (const deposit of deposits) {
            const nextStatus = inferBaseRetryStatus(deposit);
            await prisma_1.prisma.base_chain_deposits.update({
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
            if (nextStatus === manualReconciliationStatus)
                summary.manual += 1;
            else if (nextStatus === "COMPLETED")
                summary.completed += 1;
            else
                summary.retried += 1;
        }
        return summary;
    }
    async function retryFailedChilizDeposits() {
        const deposits = await prisma_1.prisma.cross_chain_deposits.findMany({ where: { status: "FAILED" } });
        const summary = { retried: 0, manual: 0, completed: 0 };
        for (const deposit of deposits) {
            const nextStatus = inferChilizRetryStatus(deposit);
            await prisma_1.prisma.cross_chain_deposits.update({
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
            if (nextStatus === manualReconciliationStatus)
                summary.manual += 1;
            else if (nextStatus === "COMPLETED")
                summary.completed += 1;
            else
                summary.retried += 1;
        }
        return summary;
    }
    app.get("/health", async (_req, res) => {
        const dbOk = await prisma_1.prisma
            .$queryRaw `SELECT 1`
            .then(() => true)
            .catch(() => false);
        res.json({ ok: true, db: dbOk });
    });
    const cdpWebhookEventSchema = zod_1.z.object({
        network: zod_1.z.string().optional(),
        chain: zod_1.z.string().optional(),
        event: zod_1.z.record(zod_1.z.unknown()).optional(),
        activity: zod_1.z.record(zod_1.z.unknown()).optional(),
        transactionHash: zod_1.z.string().optional(),
        txHash: zod_1.z.string().optional(),
        logIndex: zod_1.z.union([zod_1.z.number(), zod_1.z.string()]).optional(),
        blockNumber: zod_1.z.union([zod_1.z.number(), zod_1.z.string()]).optional(),
        blockHash: zod_1.z.string().optional(),
        contractAddress: zod_1.z.string().optional(),
        address: zod_1.z.string().optional(),
        eventName: zod_1.z.string().optional(),
        eventSignature: zod_1.z.string().optional(),
        timestamp: zod_1.z.string().optional(),
    }).passthrough();
    function nestedRecord(value) {
        return value && typeof value === "object" && !Array.isArray(value)
            ? value
            : {};
    }
    function stringFrom(...values) {
        for (const value of values) {
            if (typeof value === "string" && value.trim())
                return value;
            if (typeof value === "number" && Number.isFinite(value))
                return String(value);
        }
        return "";
    }
    function numberFrom(...values) {
        for (const value of values) {
            const n = typeof value === "number" ? value : Number(value);
            if (Number.isFinite(n))
                return n;
        }
        return null;
    }
    app.post("/webhooks/cdp/onchain-activity", async (req, res) => {
        if (!verifyCdpWebhook(req)) {
            return res.status(401).json({ ok: false, error: "Invalid webhook signature" });
        }
        const body = cdpWebhookEventSchema.parse(req.body ?? {});
        const event = nestedRecord(body.event);
        const activity = nestedRecord(body.activity);
        const parameters = nestedRecord(event.parameters ?? activity.parameters ?? body.parameters);
        const transactionHash = stringFrom(body.transactionHash, body.txHash, event.transactionHash, event.txHash, activity.transactionHash, activity.txHash).toLowerCase();
        const logIndex = numberFrom(body.logIndex, event.logIndex, activity.logIndex);
        if (!transactionHash || logIndex === null) {
            return res.status(400).json({ ok: false, error: "transactionHash and logIndex are required" });
        }
        const network = stringFrom(body.network, body.chain, event.network, activity.network, "base").toLowerCase();
        const contractAddress = stringFrom(body.contractAddress, body.address, event.contractAddress, event.address, activity.contractAddress, activity.address).toLowerCase();
        const eventName = stringFrom(body.eventName, event.eventName, activity.eventName, "Transfer");
        const eventSignature = stringFrom(body.eventSignature, event.eventSignature, activity.eventSignature);
        const blockNumber = numberFrom(body.blockNumber, event.blockNumber, activity.blockNumber);
        const blockHash = stringFrom(body.blockHash, event.blockHash, activity.blockHash) || null;
        const timestampRaw = stringFrom(body.timestamp, event.timestamp, activity.timestamp);
        const timestamp = timestampRaw ? new Date(timestampRaw) : null;
        const row = await prisma_1.prisma.onchain_events.upsert({
            where: {
                onchain_events_network_transactionHash_logIndex_key: {
                    network,
                    transactionHash,
                    logIndex,
                },
            },
            update: {
                rawJson: body,
                parametersJson: parameters,
            },
            create: {
                network,
                transactionHash,
                logIndex,
                blockNumber: blockNumber === null ? undefined : BigInt(Math.trunc(blockNumber)),
                blockHash,
                contractAddress,
                eventName,
                eventSignature,
                timestamp: timestamp && Number.isFinite(timestamp.getTime()) ? timestamp : undefined,
                parametersJson: parameters,
                rawJson: body,
                processingStatus: "PENDING",
            },
        });
        return res.json({ ok: true, eventId: row.id });
    });
    // ────────────────────────────────────────────────────────────────────────
    // Public platform settings (Chiliz network on/off is read from here).
    // The settings row is a singleton keyed by "default" and lazily created.
    // ────────────────────────────────────────────────────────────────────────
    async function getOrCreateSettings() {
        const existing = await prisma_1.prisma.system_settings.findUnique({ where: { key: "default" } });
        if (existing)
            return existing;
        return prisma_1.prisma.system_settings.create({ data: { key: "default" } });
    }
    app.get("/settings/public", async (_req, res) => {
        try {
            const s = await getOrCreateSettings();
            res.json({ ok: true, chilizEnabled: s.chilizEnabled, updatedAt: s.updatedAt });
        }
        catch (e) {
            res.status(500).json({ ok: false, error: e?.message ?? "settings_error" });
        }
    });
    app.get("/admin/settings", requireAdmin, async (_req, res) => {
        try {
            const s = await getOrCreateSettings();
            res.json({ ok: true, settings: s });
        }
        catch (e) {
            res.status(500).json({ ok: false, error: e?.message ?? "settings_error" });
        }
    });
    app.patch("/admin/settings/chiliz", requireAdmin, async (req, res) => {
        try {
            const enabled = Boolean(req.body?.enabled);
            const updated = await prisma_1.prisma.system_settings.upsert({
                where: { key: "default" },
                update: { chilizEnabled: enabled },
                create: { key: "default", chilizEnabled: enabled },
            });
            res.json({ ok: true, settings: updated });
        }
        catch (e) {
            res.status(500).json({ ok: false, error: e?.message ?? "settings_error" });
        }
    });
    // ────────────────────────────────────────────────────────────────────────
    // Real-time CHZ/USD price (CoinGecko, lightly cached).
    // Exposed publicly so the UI can always show the current price, even when
    // the Chiliz deposit flow is disabled by the admin.
    // ────────────────────────────────────────────────────────────────────────
    let chzPriceCache = null;
    const CHZ_CACHE_MS = 30_000;
    app.get("/chz/price", async (_req, res) => {
        try {
            const now = Date.now();
            if (chzPriceCache && now - chzPriceCache.at < CHZ_CACHE_MS) {
                return res.json({ ok: true, usd: chzPriceCache.usd, cached: true, fetchedAt: chzPriceCache.at });
            }
            const resp = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=chiliz&vs_currencies=usd", { headers: { accept: "application/json" } });
            if (!resp.ok)
                throw new Error(`coingecko_${resp.status}`);
            const json = await resp.json();
            const usd = Number(json?.chiliz?.usd);
            if (!Number.isFinite(usd) || usd <= 0)
                throw new Error("invalid_chz_price");
            chzPriceCache = { at: now, usd };
            res.json({ ok: true, usd, cached: false, fetchedAt: now });
        }
        catch (e) {
            if (chzPriceCache) {
                return res.json({ ok: true, usd: chzPriceCache.usd, cached: true, stale: true, fetchedAt: chzPriceCache.at });
            }
            res.status(502).json({ ok: false, error: e?.message ?? "chz_price_error" });
        }
    });
    app.get("/pools", async (_req, res) => {
        const rows = await prisma_1.prisma.club_pools.findMany({
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
            const teams = await (0, limitlessTeams_1.listLimitlessTeams)(prisma_1.prisma);
            res.json({ ok: true, teams });
        }
        catch (e) {
            res.status(500).json({ ok: false, error: e?.message ?? "teams_error" });
        }
    });
    app.get("/teams/:teamId/limitless-markets", async (req, res) => {
        try {
            (0, limitlessTeams_1.assertUuid)(req.params.teamId, "teamId");
            const markets = await (0, limitlessTeams_1.getLimitlessMarketsForTeam)(prisma_1.prisma, req.params.teamId);
            res.json({ ok: true, teamId: req.params.teamId, total: markets.length, markets });
        }
        catch (e) {
            const message = e?.message ?? "team_markets_error";
            res.status(message.includes("UUID") ? 400 : 500).json({ ok: false, error: message });
        }
    });
    app.get("/pools/:poolId", async (req, res) => {
        const row = await prisma_1.prisma.club_pools.findUnique({
            where: { id: req.params.poolId },
            include: { _count: { select: { users: true } } }
        });
        if (!row)
            return res.status(404).json({ error: "Pool not found" });
        const { _count, ...pool } = row;
        res.json({ ok: true, pool: { ...pool, holdersCount: _count.users } });
    });
    app.get("/pools/:poolId/candidates", async (req, res) => {
        const candidates = await prisma_1.prisma.club_market_candidates.findMany({
            where: { poolId: req.params.poolId },
            orderBy: { discoveredAt: "desc" }
        });
        res.json({ ok: true, candidates });
    });
    app.get("/pools/:poolId/queue", async (req, res) => {
        const queue = await prisma_1.prisma.club_match_queue.findMany({
            where: { poolId: req.params.poolId },
            orderBy: { executionTime: "asc" }
        });
        res.json({ ok: true, queue });
    });
    app.get("/pools/:poolId/positions", async (req, res) => {
        const poolId = req.params.poolId;
        const [rawPositions, selectedMarkets] = await Promise.all([
            prisma_1.prisma.club_pool_positions.findMany({
                where: { poolId, status: { in: ["OPEN", "SETTLED"] } },
                orderBy: { createdAt: "desc" },
            }),
            prisma_1.prisma.pool_selected_markets
                ? prisma_1.prisma.pool_selected_markets.findMany({ where: { poolId } })
                : Promise.resolve([]),
        ]);
        const metaMap = new Map(selectedMarkets.map((m) => [m.marketId, m]));
        const positions = rawPositions.map((pos) => {
            const meta = metaMap.get(pos.marketId);
            const investedAmount = Number(pos.investedAmount ?? pos.stake ?? 0);
            const currentValue = Number(pos.currentValue ?? pos.investedAmount ?? 0);
            const quantity = Number(pos.quantity ?? pos.plannedQuantity ?? 0);
            const unrealizedPnl = currentValue - investedAmount;
            const unrealizedPnlPct = investedAmount > 0 ? unrealizedPnl / investedAmount : 0;
            const currentPrice = quantity > 0 ? currentValue / quantity : Number(pos.entryPrice ?? 0.5);
            return {
                conditionId: meta?.conditionId ?? pos.marketId,
                question: meta?.question ?? `Market ${pos.marketId.slice(0, 8)}`,
                marketType: meta?.marketType ?? "game",
                selectedSide: pos.side,
                sizeUsdc: investedAmount,
                entryPrice: Number(pos.entryPrice ?? 0),
                currentPrice: currentPrice,
                unrealizedPnl,
                unrealizedPnlPct,
                status: pos.status === "OPEN" ? "open" : pos.status === "SETTLED" ? "settled" : "closed",
                endsAt: meta?.endDateIso ?? null,
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
        if (!address)
            return res.status(400).json({ error: "Missing address" });
        const VAULT_SHARE_DECIMALS = 6;
        const decimalDivisor = 10 ** VAULT_SHARE_DECIMALS;
        // Polygon direct holders.
        const userRows = await prisma_1.prisma.club_pool_users.findMany({
            where: {
                userAddress: { equals: address, mode: "insensitive" },
                tokenBalance: { gt: 0 },
            },
        });
        // Base bridge holders — only COMPLETED deposits map to onchain wrapped balances.
        const baseDepositRows = await prisma_1.prisma.base_chain_deposits.findMany({
            where: {
                userAddress: { equals: address, mode: "insensitive" },
                status: "COMPLETED",
                clubPoolId: { not: null },
                sharesMinted: { not: null }
            }
        });
        // Aggregate Base shares per pool.
        const baseSharesRawByPool = new Map();
        for (const dep of baseDepositRows) {
            if (!dep.clubPoolId || !dep.sharesMinted)
                continue;
            const prev = baseSharesRawByPool.get(dep.clubPoolId) ?? 0n;
            // `sharesMinted` is stored as a Decimal (6-decimal raw integer) — coerce via string.
            baseSharesRawByPool.set(dep.clubPoolId, prev + BigInt(dep.sharesMinted.toString().split(".")[0]));
        }
        // Union of all pool IDs we need to load for naming/pricing.
        const poolIds = new Set();
        for (const u of userRows)
            poolIds.add(u.poolId);
        for (const id of baseSharesRawByPool.keys())
            poolIds.add(id);
        if (poolIds.size === 0) {
            return res.json({ ok: true, address, holdings: [], totalValueUsd: 0 });
        }
        const pools = await prisma_1.prisma.club_pools.findMany({
            where: { id: { in: Array.from(poolIds) } },
        });
        const poolById = new Map(pools.map((p) => [p.id, p]));
        // Re-implementation of the frontend tokenPriceUsdPerWholeShare logic — keep
        // pricing rules centralised so numbers shown on the landing page, dashboard
        // and deposit modal all agree.
        const toTvlHuman = (raw) => {
            if (!raw)
                return 0;
            const s = String(raw).trim();
            const n = Number(s);
            if (!Number.isFinite(n) || n <= 0)
                return 0;
            if (s.includes(".") || /[eE]/i.test(s))
                return n;
            if (/^\d+$/.test(s))
                return n / 1_000_000;
            return n;
        };
        // Map polygon shares (raw integer string from club_pool_users.tokenBalance) per pool.
        const polygonRawByPool = new Map();
        const polygonUpdatedAtByPool = new Map();
        for (const u of userRows) {
            const raw = u.tokenBalance?.toString() ?? "0";
            polygonRawByPool.set(u.poolId, BigInt(raw.split(".")[0]));
            polygonUpdatedAtByPool.set(u.poolId, u.updatedAt);
        }
        const holdings = Array.from(poolIds)
            .map((poolId) => {
            const pool = poolById.get(poolId);
            if (!pool)
                return null;
            const polygonRaw = polygonRawByPool.get(poolId) ?? 0n;
            const baseRaw = baseSharesRawByPool.get(poolId) ?? 0n;
            const totalRaw = polygonRaw + baseRaw;
            if (totalRaw <= 0n)
                return null;
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
                if (nav > 0 && stored > 0 && nav / stored > 10_000)
                    tokenPrice = nav;
                else if (stored > 0)
                    tokenPrice = stored;
                else
                    tokenPrice = nav;
            }
            else if (stored > 0) {
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
            .filter((h) => h !== null)
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
        if (!address)
            return res.status(400).json({ error: "Missing address" });
        const PENDING_STATUSES = ["RECEIVED", "BRIDGING", "DEPOSITING", "MINTING_SHARES"];
        const pending = await prisma_1.prisma.base_chain_deposits.findMany({
            where: {
                userAddress: { equals: address, mode: "insensitive" },
                status: { in: PENDING_STATUSES }
            },
            orderBy: { createdAt: "desc" },
            take: 25
        });
        // Enrich with club name when known.
        const poolIds = Array.from(new Set(pending.map((d) => d.clubPoolId).filter(Boolean)));
        const pools = poolIds.length
            ? await prisma_1.prisma.club_pools.findMany({ where: { id: { in: poolIds } } })
            : [];
        const poolById = new Map(pools.map((p) => [p.id, p]));
        res.json({
            ok: true,
            address,
            deposits: pending.map((d) => {
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
        const latest = await prisma_1.prisma.club_pool_price_snapshots.findFirst({
            where: { poolId: req.params.poolId },
            orderBy: { snapshotTime: "desc" }
        });
        res.json({ ok: true, latest });
    });
    const poolCreateSchema = zod_1.z.object({
        clubName: zod_1.z.string().min(1),
        symbol: zod_1.z.string().min(1),
        primarySportsDataTeamId: zod_1.z.string().uuid().optional(),
        sportsDataTeamId: zod_1.z.string().uuid().optional(),
        totalTokenSupply: zod_1.z.number().optional().default(0),
        depositCap: zod_1.z.coerce.bigint().optional().default(0n),
        vaultAddress: zod_1.z.string().optional(),
        deployOnchain: zod_1.z.boolean().optional().default(false),
        createLimitlessAccount: zod_1.z.boolean().optional(),
        riskParams: zod_1.z
            .object({
            maxPerMatchPct: zod_1.z.number().optional(),
            maxTotalExposurePct: zod_1.z.number().optional(),
            liquidityMinUsd: zod_1.z.number().optional()
        })
            .optional()
    });
    // Returns unsigned tx for admin's MetaMask to sign — no backend private key used.
    app.post("/admin/pools/tx/deploy-vault", requireAdmin, async (req, res) => {
        const body = zod_1.z.object({
            clubName: zod_1.z.string().min(1),
            symbol: zod_1.z.string().min(1),
            depositCap: zod_1.z.coerce.bigint().optional().default(0n),
        }).parse(req.body);
        if (!env.CLUB_VAULT_FACTORY_ADDRESS) {
            return res.status(400).json({ error: "CLUB_VAULT_FACTORY_ADDRESS not set in backend .env" });
        }
        if (!env.BASE_RPC_URL) {
            return res.status(400).json({ error: "RPC_URL not set in backend .env" });
        }
        const provider = new ethers_1.ethers.JsonRpcProvider(env.BASE_RPC_URL);
        const FACTORY_ABI = [
            "function getVaultByClub(bytes32) view returns (address)",
            "function createClubVault(bytes32, string, string, uint256) returns (address)"
        ];
        const factory = new ethers_1.ethers.Contract(env.CLUB_VAULT_FACTORY_ADDRESS, FACTORY_ABI, provider);
        const clubId = ethers_1.ethers.solidityPackedKeccak256(["string"], [body.clubName]);
        // Check if already deployed
        const existing = await factory.getVaultByClub(clubId);
        if (existing && existing !== ethers_1.ethers.ZeroAddress) {
            return res.json({ ok: true, alreadyDeployed: true, vaultAddress: existing });
        }
        // Build unsigned tx — admin wallet will sign this via MetaMask
        const tx = await factory.createClubVault.populateTransaction(clubId, body.clubName, body.symbol, body.depositCap);
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
            const primarySportsDataTeamId = body.primarySportsDataTeamId ?? body.sportsDataTeamId;
            if (!primarySportsDataTeamId) {
                return res.status(400).json({ ok: false, error: "primarySportsDataTeamId is required" });
            }
            const riskParams = body.riskParams ?? { maxPerMatchPct: 3, maxTotalExposurePct: 20, liquidityMinUsd: 50_000 };
            let vaultDeployment = null;
            if (body.deployOnchain) {
                vaultDeployment = await (0, clubVaultFactoryExecutor_1.ensureClubVaultExists)({
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
                    const provider = new ethers_1.ethers.JsonRpcProvider(env.BASE_RPC_URL);
                    const FACTORY_ABI = ["function getVaultByClub(bytes32) view returns (address)"];
                    const factory = new ethers_1.ethers.Contract(env.CLUB_VAULT_FACTORY_ADDRESS, FACTORY_ABI, provider);
                    const clubId = ethers_1.ethers.solidityPackedKeccak256(["string"], [body.clubName]);
                    const found = await factory.getVaultByClub(clubId);
                    if (found && found !== ethers_1.ethers.ZeroAddress) {
                        resolvedVaultAddress = found;
                    }
                }
                catch {
                    // ignore — vault address will remain null
                }
            }
            const pool = await prisma_1.prisma.club_pools.create({
                data: {
                    clubName: body.clubName,
                    symbol: body.symbol,
                    primarySportsDataTeamId,
                    sportsDataTeamId: primarySportsDataTeamId,
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
            await prisma_1.prisma.pool_teams.create({
                data: {
                    poolId: pool.id,
                    sportsDataTeamId: primarySportsDataTeamId,
                    role: "PRIMARY",
                    weight: "1",
                },
            });
            const displayName = `pool-${body.symbol.trim().toLowerCase()}-${String(pool.id).slice(-6)}`;
            let limitlessAccount = null;
            const shouldCreateLimitless = body.createLimitlessAccount ?? (0, partnerAccounts_1.partnerAccountCreationEnabled)(env);
            if (shouldCreateLimitless) {
                const created = await (0, partnerAccounts_1.createPartnerServerAccount)(env, displayName);
                limitlessAccount = await prisma_1.prisma.pool_limitless_accounts.create({
                    data: {
                        poolId: pool.id,
                        limitlessProfileId: created.limitlessProfileId,
                        accountAddress: created.accountAddress,
                        displayName: created.displayName,
                        serverWallet: true,
                        allowanceStatus: "PENDING",
                        status: created.accountAddress ? "ACTIVE" : "PENDING",
                        rawJson: created.rawJson,
                    },
                });
            }
            else {
                limitlessAccount = await prisma_1.prisma.pool_limitless_accounts.create({
                    data: {
                        poolId: pool.id,
                        displayName,
                        serverWallet: true,
                        allowanceStatus: "PENDING",
                        status: "PENDING",
                        rawJson: { skipped: "LIMITLESS_PARTNER_ACCOUNT_CREATION_ENABLED is false" },
                    },
                });
            }
            return res.json({ ok: true, pool, vaultDeployment, limitlessAccount });
        }
        catch (e) {
            logger.error({ err: e }, "admin/pools create failed");
            return res.status(500).json({ ok: false, error: e?.message ?? "Pool creation failed" });
        }
    });
    app.patch("/admin/pools/:poolId", requireAdmin, async (req, res) => {
        const { poolId } = req.params;
        const updateSchema = zod_1.z.object({
            vaultAddress: zod_1.z.string().optional(),
            primarySportsDataTeamId: zod_1.z.string().uuid().nullable().optional(),
            sportsDataTeamId: zod_1.z.string().uuid().nullable().optional(),
            status: zod_1.z.enum(["ACTIVE", "PAUSED"]).optional(),
            officialTokenPrice: zod_1.z.string().optional(),
            totalPoolValue: zod_1.z.string().optional(),
            totalTokenSupply: zod_1.z.string().optional(),
            depositCap: zod_1.z.string().optional(),
        });
        const body = updateSchema.parse(req.body);
        const data = { ...body };
        if (body.primarySportsDataTeamId && body.sportsDataTeamId === undefined) {
            data.sportsDataTeamId = body.primarySportsDataTeamId;
        }
        if (body.sportsDataTeamId && body.primarySportsDataTeamId === undefined) {
            data.primarySportsDataTeamId = body.sportsDataTeamId;
        }
        const pool = await prisma_1.prisma.club_pools.update({
            where: { id: poolId },
            data
        });
        res.json({ ok: true, pool });
    });
    app.delete("/admin/pools/:poolId", requireAdmin, async (req, res) => {
        await prisma_1.prisma.club_pools.delete({ where: { id: req.params.poolId } });
        res.json({ ok: true });
    });
    // ─── Selected Markets (admin saves/retrieves market selection) ───────────────
    const selectedMarketsUpsertSchema = zod_1.z.object({
        markets: zod_1.z.array(zod_1.z.object({
            marketId: zod_1.z.string().min(1),
            conditionId: zod_1.z.string().min(1),
            tokenId: zod_1.z.string().min(1),
            eventId: zod_1.z.string().optional().default(""),
            question: zod_1.z.string().min(1),
            marketType: zod_1.z.enum(["game", "future"]).default("game"),
            selectedSide: zod_1.z.enum(["YES", "NO"]).default("YES"),
            manualClusterId: zod_1.z.string().optional(),
            endDateIso: zod_1.z.string().optional(),
            liquidity: zod_1.z.number().optional().default(0),
            yesPrice: zod_1.z.number().optional().default(0.5),
        })),
    });
    /**
     * GET /admin/pools/:poolId/selected-markets
     * Returns all admin-selected markets for a pool.
     */
    app.get("/admin/pools/:poolId/selected-markets", requireAdmin, async (req, res) => {
        try {
            const markets = await prisma_1.prisma.pool_selected_markets.findMany({
                where: { poolId: req.params.poolId },
                orderBy: { createdAt: "asc" },
            });
            res.json({ ok: true, markets });
        }
        catch (e) {
            res.status(500).json({ error: e?.message ?? "DB error" });
        }
    });
    /**
     * POST /admin/pools/:poolId/selected-markets
     * Replaces (upserts) the full list of selected markets for a pool.
     */
    app.post("/admin/pools/:poolId/selected-markets", requireAdmin, async (req, res) => {
        const poolId = req.params.poolId;
        const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: poolId } });
        if (!pool)
            return res.status(404).json({ error: "Pool not found" });
        const { markets } = selectedMarketsUpsertSchema.parse(req.body);
        try {
            await prisma_1.prisma.$transaction(markets.map((m) => prisma_1.prisma.pool_selected_markets.upsert({
                where: { poolId_conditionId: { poolId, conditionId: m.conditionId } },
                create: { ...m, poolId },
                update: { ...m, updatedAt: new Date() },
            })));
            res.json({ ok: true, saved: markets.length });
        }
        catch (e) {
            logger.error({ err: e }, "selected-markets upsert failed");
            res.status(500).json({ error: e?.message ?? "DB error" });
        }
    });
    // ─── Allocation Proposal ─────────────────────────────────────────────────────
    const allocationProposalSchema = zod_1.z.object({
        proposal: zod_1.z.object({
            nav: zod_1.z.number(),
            targetExposure: zod_1.z.number(),
            cashWeight: zod_1.z.number(),
            cashAmount: zod_1.z.number(),
            portfolioQuality: zod_1.z.number().optional().default(0),
            allocations: zod_1.z.array(zod_1.z.any()),
            rejectedMarkets: zod_1.z.array(zod_1.z.any()),
            clusterExposure: zod_1.z.record(zod_1.z.number()),
        }),
        selectedMarkets: zod_1.z.array(zod_1.z.any()),
    });
    /**
     * POST /admin/pools/:poolId/allocation-proposal
     * Saves an accepted allocation proposal to the database.
     * Also upserts the selectedMarkets for this pool.
     */
    app.post("/admin/pools/:poolId/allocation-proposal", requireAdmin, async (req, res) => {
        const poolId = req.params.poolId;
        const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: poolId } });
        if (!pool)
            return res.status(404).json({ error: "Pool not found" });
        const { proposal, selectedMarkets } = allocationProposalSchema.parse(req.body);
        try {
            const [saved] = await prisma_1.prisma.$transaction([
                prisma_1.prisma.pool_allocation_proposals.create({
                    data: {
                        poolId,
                        nav: proposal.nav,
                        targetExposure: proposal.targetExposure,
                        cashWeight: proposal.cashWeight,
                        cashAmount: proposal.cashAmount,
                        portfolioQuality: proposal.portfolioQuality ?? 0,
                        proposalJson: proposal,
                        selectedMarketsJson: selectedMarkets,
                        status: "ACCEPTED",
                    },
                }),
                // Also upsert each selected market
                ...selectedMarkets.map((m) => prisma_1.prisma.pool_selected_markets.upsert({
                    where: { poolId_conditionId: { poolId, conditionId: m.conditionId } },
                    create: {
                        poolId,
                        marketId: m.marketId,
                        conditionId: m.conditionId,
                        tokenId: m.tokenId,
                        eventId: m.eventId ?? "",
                        question: m.question,
                        marketType: m.marketType ?? "game",
                        selectedSide: m.selectedSide ?? "YES",
                        manualClusterId: m.manualClusterId ?? null,
                        endDateIso: m.endDateIso ?? null,
                        liquidity: 0,
                        yesPrice: 0.5,
                    },
                    update: {
                        selectedSide: m.selectedSide ?? "YES",
                        marketType: m.marketType ?? "game",
                        manualClusterId: m.manualClusterId ?? null,
                        updatedAt: new Date(),
                    },
                })),
            ]);
            res.json({ ok: true, proposalId: saved.id });
        }
        catch (e) {
            logger.error({ err: e }, "allocation-proposal save failed");
            res.status(500).json({ error: e?.message ?? "DB error" });
        }
    });
    // ─── Latest allocation proposal (for reference) ───────────────────────────
    app.get("/admin/pools/:poolId/allocation-proposal/latest", requireAdmin, async (req, res) => {
        try {
            const proposal = await prisma_1.prisma.pool_allocation_proposals.findFirst({
                where: { poolId: req.params.poolId },
                orderBy: { createdAt: "desc" },
            });
            res.json({ ok: true, proposal });
        }
        catch (e) {
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
    const allocationRunSchema = zod_1.z.object({
        nav: zod_1.z.number().positive(),
        persist: zod_1.z.boolean().optional().default(true),
        selectedMarkets: zod_1.z
            .array(zod_1.z.object({
            marketId: zod_1.z.string().min(1),
            conditionId: zod_1.z.string().min(1),
            tokenId: zod_1.z.string().min(1),
            eventId: zod_1.z.string().optional().default(""),
            question: zod_1.z.string().min(1),
            marketType: zod_1.z.enum(["game", "future"]).default("game"),
            selectedSide: zod_1.z.enum(["YES", "NO"]).default("YES"),
            manualClusterId: zod_1.z.string().optional(),
        }))
            .optional(),
    });
    app.post("/admin/pools/:poolId/allocation/run", requireAdmin, async (req, res) => {
        const poolId = req.params.poolId;
        const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: poolId } });
        if (!pool)
            return res.status(404).json({ error: "Pool not found" });
        const { nav, persist, selectedMarkets: bodyMarkets } = allocationRunSchema.parse(req.body);
        // Resolve the market set: prefer the body, else the pool's saved markets.
        let selectedMarkets;
        if (bodyMarkets && bodyMarkets.length > 0) {
            selectedMarkets = bodyMarkets.map((m) => ({
                marketId: m.marketId,
                conditionId: m.conditionId,
                tokenId: m.tokenId,
                eventId: m.eventId ?? "",
                question: m.question,
                marketType: m.marketType,
                selectedSide: m.selectedSide,
                manualClusterId: m.manualClusterId,
            }));
        }
        else {
            const rows = await prisma_1.prisma.pool_selected_markets.findMany({
                where: { poolId, enabled: true },
                orderBy: { createdAt: "asc" },
            });
            selectedMarkets = rows.map((r) => ({
                marketId: r.marketId,
                conditionId: r.conditionId,
                tokenId: r.tokenId,
                eventId: r.eventId ?? "",
                question: r.question,
                marketType: r.marketType ?? "game",
                selectedSide: r.selectedSide ?? "YES",
                manualClusterId: r.manualClusterId ?? undefined,
            }));
        }
        if (selectedMarkets.length === 0) {
            return res.status(400).json({ error: "No selected markets for this pool" });
        }
        try {
            // Fetch a fresh snapshot for each market (resilient: failures are skipped
            // and surface as "Market data unavailable" rejections in the proposal).
            const snapshots = await Promise.all(selectedMarkets.map(async (m) => {
                try {
                    const data = await (0, limitlessMarketData_1.fetchLimitlessMarketData)(env, m.marketId, m.conditionId);
                    return [m.conditionId, data];
                }
                catch (err) {
                    logger.warn({ err, conditionId: m.conditionId }, "market-data fetch failed for allocation run");
                    return null;
                }
            }));
            const clobData = new Map();
            for (const s of snapshots)
                if (s)
                    clobData.set(s[0], s[1]);
            const proposal = (0, allocationEngine_1.runAllocationEngine)(selectedMarkets, clobData, nav);
            let proposalId;
            if (persist) {
                const saved = await prisma_1.prisma.pool_allocation_proposals.create({
                    data: {
                        poolId,
                        nav: proposal.nav,
                        targetExposure: proposal.targetExposure,
                        cashWeight: proposal.cashWeight,
                        cashAmount: proposal.cashAmount,
                        portfolioQuality: proposal.portfolioQuality ?? 0,
                        proposalJson: proposal,
                        selectedMarketsJson: selectedMarkets,
                        marketDataJson: Object.fromEntries(clobData),
                        status: "COMPUTED",
                    },
                });
                proposalId = saved.id;
            }
            res.json({ ok: true, proposal, proposalId });
        }
        catch (e) {
            logger.error({ err: e }, "allocation/run failed");
            res.status(502).json({ error: e?.message ?? "Allocation run failed" });
        }
    });
    const discoverSchema = zod_1.z.object({
        clubName: zod_1.z.string().min(1).optional(),
        sportsDataTeamId: zod_1.z.string().uuid().optional(),
        riskPerMatchPct: zod_1.z.number().optional().default(3),
        liquidityMinUsd: zod_1.z.number().optional().default(50_000)
    });
    app.post("/admin/:poolId/discover", requireAdmin, async (req, res) => {
        const poolId = req.params.poolId;
        const body = discoverSchema.parse(req.body ?? {});
        const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: poolId } });
        if (!pool)
            return res.status(404).json({ error: "Pool not found" });
        const clubName = (body.clubName?.trim() || pool.clubName).trim();
        if (!clubName)
            return res.status(400).json({ error: "clubName missing" });
        const sportsDataTeamId = body.sportsDataTeamId?.trim() ||
            pool.primarySportsDataTeamId?.trim?.() ||
            pool.sportsDataTeamId?.trim?.() ||
            undefined;
        if (!sportsDataTeamId)
            return res.status(400).json({ error: "sportsDataTeamId missing" });
        const result = await (0, limitlessDiscoveryService_1.discoverLimitlessClubCandidates)({
            poolId,
            clubName,
            sportsDataTeamId,
            riskPerMatchPct: body.riskPerMatchPct,
            liquidityMinUsd: body.liquidityMinUsd,
            env
        });
        const candidates = await prisma_1.prisma.club_market_candidates.findMany({ where: { poolId } });
        res.json({ ok: true, ...result, count: candidates.length, candidates });
    });
    // Create scheduled queue entries (T-48h and T-24h) for the latest candidates.
    app.post("/admin/:poolId/schedule", requireAdmin, async (req, res) => {
        const poolId = req.params.poolId;
        const result = await (0, scheduler_1.scheduleMatchTranches)({ poolId, env });
        res.json({ ok: true, ...result });
    });
    app.post("/admin/:poolId/pause", requireAdmin, async (req, res) => {
        const poolId = req.params.poolId;
        const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: poolId } });
        if (!pool)
            return res.status(404).json({ error: "Pool not found" });
        await (0, vaultExecutor_1.adminPause)(env, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined });
        res.json({ ok: true });
    });
    app.post("/admin/:poolId/unpause", requireAdmin, async (req, res) => {
        const poolId = req.params.poolId;
        const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: poolId } });
        if (!pool)
            return res.status(404).json({ error: "Pool not found" });
        await (0, vaultExecutor_1.adminUnpause)(env, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined });
        res.json({ ok: true });
    });
    const opAuthSchema = zod_1.z.object({
        operator: zod_1.z.string().min(1),
        allocation: zod_1.z.coerce.bigint(),
        transactionCap: zod_1.z.coerce.bigint()
    });
    app.post("/admin/:poolId/operator/authorize", requireAdmin, async (req, res) => {
        const poolId = req.params.poolId;
        const body = opAuthSchema.parse(req.body);
        const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: poolId } });
        if (!pool)
            return res.status(404).json({ error: "Pool not found" });
        await (0, vaultExecutor_1.adminAddAuthorizedOperator)(env, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined }, body);
        res.json({ ok: true });
    });
    app.post("/admin/:poolId/operator/remove", requireAdmin, async (req, res) => {
        const poolId = req.params.poolId;
        const body = zod_1.z.object({ operator: zod_1.z.string().min(1) }).parse(req.body);
        const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: poolId } });
        if (!pool)
            return res.status(404).json({ error: "Pool not found" });
        await (0, vaultExecutor_1.adminRemoveAuthorizedOperator)(env, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined }, body.operator);
        res.json({ ok: true });
    });
    app.post("/admin/:poolId/operator/allocation", requireAdmin, async (req, res) => {
        const poolId = req.params.poolId;
        const body = zod_1.z.object({ operator: zod_1.z.string().min(1), newAllocation: zod_1.z.coerce.bigint() }).parse(req.body);
        const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: poolId } });
        if (!pool)
            return res.status(404).json({ error: "Pool not found" });
        await (0, vaultExecutor_1.adminSetOperatorAllocation)(env, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined }, body);
        res.json({ ok: true });
    });
    app.post("/admin/:poolId/operator/txcap", requireAdmin, async (req, res) => {
        const poolId = req.params.poolId;
        const body = zod_1.z.object({ operator: zod_1.z.string().min(1), newTxCap: zod_1.z.coerce.bigint() }).parse(req.body);
        const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: poolId } });
        if (!pool)
            return res.status(404).json({ error: "Pool not found" });
        await (0, vaultExecutor_1.adminSetOperatorTransactionCap)(env, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined }, body);
        res.json({ ok: true });
    });
    const whitelistSchema = zod_1.z.object({ contractAddress: zod_1.z.string().min(1) });
    app.post("/admin/:poolId/whitelist/add", requireAdmin, async (req, res) => {
        const poolId = req.params.poolId;
        const body = whitelistSchema.parse(req.body);
        const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: poolId } });
        if (!pool)
            return res.status(404).json({ error: "Pool not found" });
        await (0, vaultExecutor_1.adminAddWhitelistedContract)(env, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined }, body.contractAddress);
        res.json({ ok: true });
    });
    app.post("/admin/:poolId/whitelist/remove", requireAdmin, async (req, res) => {
        const poolId = req.params.poolId;
        const body = whitelistSchema.parse(req.body);
        const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: poolId } });
        if (!pool)
            return res.status(404).json({ error: "Pool not found" });
        await (0, vaultExecutor_1.adminRemoveWhitelistedContract)(env, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined }, body.contractAddress);
        res.json({ ok: true });
    });
    // Trusted strategies admin
    const strategySchema = zod_1.z.object({ strategy: zod_1.z.string().min(1) });
    app.post("/admin/:poolId/trusted-strategy/add", requireAdmin, async (req, res) => {
        const poolId = req.params.poolId;
        const body = strategySchema.parse(req.body);
        const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: poolId } });
        if (!pool)
            return res.status(404).json({ error: "Pool not found" });
        await (0, vaultExecutor_1.adminAddTrustedStrategy)(env, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined }, body.strategy);
        res.json({ ok: true });
    });
    app.post("/admin/:poolId/trusted-strategy/remove", requireAdmin, async (req, res) => {
        const poolId = req.params.poolId;
        const body = strategySchema.parse(req.body);
        const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: poolId } });
        if (!pool)
            return res.status(404).json({ error: "Pool not found" });
        await (0, vaultExecutor_1.adminRemoveTrustedStrategy)(env, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined }, body.strategy);
        res.json({ ok: true });
    });
    const orderSignerSchema = zod_1.z.object({
        signer: zod_1.z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        allowed: zod_1.z.boolean().default(true)
    });
    app.post("/admin/:poolId/order-signer", requireAdmin, async (req, res) => {
        const poolId = req.params.poolId;
        const body = orderSignerSchema.parse(req.body);
        const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: poolId } });
        if (!pool)
            return res.status(404).json({ error: "Pool not found" });
        const vaultRef = { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined };
        const tx = await (0, vaultExecutor_1.adminSetOrderSigner)(env, vaultRef, body);
        res.json({ ok: true, txHash: tx.hash ?? undefined });
    });
    app.get("/admin/:poolId/order-signer/:signer", requireAdmin, async (req, res) => {
        const poolId = req.params.poolId;
        const signer = zod_1.z.string().regex(/^0x[a-fA-F0-9]{40}$/).parse(req.params.signer);
        const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: poolId } });
        if (!pool)
            return res.status(404).json({ error: "Pool not found" });
        const allowed = await (0, vaultExecutor_1.isOrderSigner)(env, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined }, signer);
        res.json({ ok: true, signer, allowed });
    });
    app.get("/admin/operators", requireAdmin, async (_req, res) => {
        const operators = await (0, vaultExecutor_1.getAllOperators)(env, undefined);
        res.json({ ok: true, operators });
    });
    app.get("/admin/operators/:operator", requireAdmin, async (req, res) => {
        const info = await (0, vaultExecutor_1.getOperatorInfo)(env, undefined, req.params.operator);
        res.json({ ok: true, info });
    });
    app.get("/admin/whitelist", requireAdmin, async (_req, res) => {
        const list = await (0, vaultExecutor_1.getWhitelistedContracts)(env, undefined);
        res.json({ ok: true, whitelist: list });
    });
    app.get("/admin/whitelist/:contractAddress", requireAdmin, async (req, res) => {
        const status = await (0, vaultExecutor_1.isWhitelistedContract)(env, undefined, req.params.contractAddress);
        res.json({ ok: true, isWhitelisted: status });
    });
    app.get("/admin/trusted-strategies", requireAdmin, async (_req, res) => {
        const list = await (0, vaultExecutor_1.getTrustedStrategies)(env, undefined);
        res.json({ ok: true, trustedStrategies: list });
    });
    app.get("/admin/trusted-strategies/:strategy", requireAdmin, async (req, res) => {
        const status = await (0, vaultExecutor_1.isTrustedStrategy)(env, undefined, req.params.strategy);
        res.json({ ok: true, isTrusted: status });
    });
    app.post("/admin/:poolId/execute-tranche", requireAdmin, async (req, res) => {
        const body = zod_1.z.object({ candidateId: zod_1.z.string().min(1), tranche: zod_1.z.number().int().min(1).max(2) }).parse(req.body);
        const queue = await prisma_1.prisma.club_match_queue.findUnique({
            where: {
                poolId_candidateId_tranche: {
                    poolId: req.params.poolId,
                    candidateId: body.candidateId,
                    tranche: body.tranche
                }
            }
        });
        if (!queue)
            return res.status(404).json({ error: "Scheduled tranche not found" });
        if (queue.status !== "SCHEDULED") {
            return res.status(409).json({
                error: "Tranche is not executable",
                status: queue.status,
                queueId: queue.id
            });
        }
        const result = await (0, limitlessExecutor_1.executeLimitlessTranche)({
            env,
            queueId: queue.id,
            poolId: req.params.poolId,
            candidateId: body.candidateId,
            tranche: body.tranche,
            expectedExecutionTimeMs: Date.now()
        });
        res.json({ ok: true, result });
    });
    const vaultExecuteSchema = zod_1.z.object({
        target: zod_1.z.string().min(1),
        data: zod_1.z.string().min(2),
        value: zod_1.z.coerce.bigint().default(0n),
        assetAmount: zod_1.z.coerce.bigint().default(0n),
        minReturn: zod_1.z.coerce.bigint().default(0n),
        isTrustedRequired: zod_1.z.boolean().default(false)
    });
    app.post("/admin/:poolId/vault/execute", requireAdmin, async (req, res) => {
        const body = vaultExecuteSchema.parse(req.body);
        const poolId = req.params.poolId;
        const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: poolId } });
        if (!pool)
            return res.status(404).json({ error: "Pool not found" });
        const tx = await (0, vaultExecutor_1.executeWhitelistedCallViaVault)(env, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined }, {
            target: body.target,
            data: body.data,
            value: body.value,
            assetAmount: body.assetAmount,
            minReturn: body.minReturn,
            isTrustedRequired: body.isTrustedRequired
        });
        res.json({ ok: true, txHash: tx.hash ?? undefined });
    });
    app.post("/admin/:poolId/reprice", requireAdmin, async (req, res) => {
        await (0, priceEngine_1.recalculateOfficialPrices)(env);
        res.json({ ok: true });
    });
    // =========================
    // Admin: onchain sync (vault -> DB)
    // =========================
    app.post("/admin/:poolId/sync", requireAdmin, async (req, res) => {
        const poolId = req.params.poolId;
        const body = zod_1.z
            .object({
            fromBlock: zod_1.z.coerce.number().int().nonnegative().optional(),
            toBlock: zod_1.z.coerce.number().int().nonnegative().optional()
        })
            .parse(req.body);
        const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: poolId } });
        if (!pool)
            return res.status(404).json({ error: "Pool not found" });
        if (!env.BASE_RPC_URL)
            return res.status(400).json({ error: "RPC_URL missing" });
        const provider = new ethers_1.ethers.JsonRpcProvider(env.BASE_RPC_URL);
        const latest = await provider.getBlockNumber();
        const lastSynced = typeof pool.riskParams?.lastSyncedBlock === "number" ? pool.riskParams.lastSyncedBlock : undefined;
        const fromBlock = body.fromBlock ?? (lastSynced !== undefined ? lastSynced + 1 : Math.max(0, latest - 50_000));
        const toBlock = body.toBlock ?? latest;
        await (0, poolSync_1.syncVaultEventsToDb)({
            env,
            pool: {
                id: pool.id,
                clubName: pool.clubName,
                vaultAddress: pool.vaultAddress ?? undefined,
                officialTokenPrice: pool.officialTokenPrice,
                riskParams: pool.riskParams
            },
            fromBlock,
            toBlock
        });
        // After DB sync, refresh official prices immediately for the response.
        await (0, priceEngine_1.recalculateOfficialPrices)(env);
        res.json({ ok: true, fromBlock, toBlock });
    });
    // =========================
    // User: prepare tx for deposit/mint/withdraw/redeem
    // =========================
    const ethAddressSchema = zod_1.z.string().regex(/^0x[a-fA-F0-9]{40}$/);
    const prepareDepositSchema = zod_1.z.object({ assets: zod_1.z.coerce.bigint(), receiver: ethAddressSchema });
    const prepareMintSchema = zod_1.z.object({ shares: zod_1.z.coerce.bigint(), receiver: ethAddressSchema });
    const prepareWithdrawSchema = zod_1.z.object({ assets: zod_1.z.coerce.bigint(), receiver: ethAddressSchema, owner: ethAddressSchema });
    const prepareRedeemSchema = zod_1.z.object({ shares: zod_1.z.coerce.bigint(), receiver: ethAddressSchema, owner: ethAddressSchema });
    // WrapCHZ (Polygon) -> swap to USDC -> vault deposit.
    // Returns a sequence of unsigned txs the user signs in order.
    const prepareDepositWrapChzSchema = zod_1.z.object({
        sender: ethAddressSchema, // swap output recipient (should be the signing wallet)
        receiver: ethAddressSchema, // vault shares receiver
        wrapChzAmountIn: zod_1.z.coerce.bigint(),
        usdcAmountOutMin: zod_1.z.coerce.bigint(),
        // How much USDC to deposit to the vault (defaults to minOut so the deposit amount is guaranteed by swap).
        depositAssets: zod_1.z.coerce.bigint().optional()
    });
    // Immediately ingest a confirmed vault deposit tx into DB (single block; does not advance lastSyncedBlock).
    app.post("/pools/:poolId/deposit/confirm", async (req, res) => {
        const poolId = req.params.poolId;
        const body = zod_1.z
            .object({
            txHash: zod_1.z.string().regex(/^0x[a-fA-F0-9]{64}$/i)
        })
            .parse(req.body);
        const txLc = body.txHash.toLowerCase();
        if (!env.BASE_RPC_URL) {
            return res.status(400).json({ error: "RPC_URL missing" });
        }
        const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: poolId } });
        if (!pool)
            return res.status(404).json({ error: "Pool not found" });
        if (!pool.vaultAddress) {
            return res.status(400).json({ error: "Pool vaultAddress not configured" });
        }
        const provider = new ethers_1.ethers.JsonRpcProvider(env.BASE_RPC_URL);
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
        await (0, poolSync_1.syncVaultEventsToDb)({
            env,
            pool: {
                id: pool.id,
                clubName: pool.clubName,
                vaultAddress: pool.vaultAddress ?? undefined,
                officialTokenPrice: pool.officialTokenPrice,
                riskParams: pool.riskParams
            },
            fromBlock: bn,
            toBlock: bn,
            onlyTransactionHashes: [txLc],
            skipCursorAdvance: true
        });
        await (0, priceEngine_1.recalculateOfficialPrices)(env);
        const row = await prisma_1.prisma.club_pools.findUnique({
            where: { id: poolId },
            include: { _count: { select: { users: true } } }
        });
        if (!row)
            return res.status(404).json({ error: "Pool not found" });
        const { _count, ...rest } = row;
        res.json({ ok: true, pool: { ...rest, holdersCount: _count.users } });
    });
    app.post("/pools/:poolId/tx/deposit", async (req, res) => {
        const body = prepareDepositSchema.parse(req.body);
        const poolId = req.params.poolId;
        if (!env.BASE_RPC_URL)
            return res.status(500).json({ error: "RPC_URL is required." });
        const provider = new ethers_1.ethers.JsonRpcProvider(env.BASE_RPC_URL);
        const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: poolId } });
        if (!pool)
            return res.status(404).json({ error: "Pool not found" });
        const vault = await (0, vaultExecutor_1.getVaultContract)(env, provider, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined });
        const assetAddress = await vault.asset();
        const vaultAddress = vault.target ?? vault.address;
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
        const asset = new ethers_1.ethers.Contract(assetAddress, erc20_1.ERC20.abi, provider);
        const approveTx = await asset.approve.populateTransaction(vaultAddress, body.assets);
        const depositFn = vault.deposit;
        if (!depositFn?.populateTransaction) {
            return res.status(500).json({
                error: "Vault does not expose deposit().populateTransaction (ethers v6 ABI wiring issue)",
                poolId,
                clubName: pool.clubName,
                vaultAddress: pool.vaultAddress ?? null
            });
        }
        const tx = await depositFn.populateTransaction(body.assets, body.receiver);
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
        const provider = env.BASE_RPC_URL ? new ethers_1.ethers.JsonRpcProvider(env.BASE_RPC_URL) : undefined;
        const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: poolId } });
        if (!pool)
            return res.status(404).json({ error: "Pool not found" });
        const vault = await (0, vaultExecutor_1.getVaultContract)(env, provider, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined });
        const mintFn = vault.mint;
        if (!mintFn?.populateTransaction) {
            return res.status(500).json({
                error: "Vault does not expose mint().populateTransaction (ethers v6 ABI wiring issue)",
                poolId,
                clubName: pool.clubName,
                vaultAddress: pool.vaultAddress ?? null
            });
        }
        const tx = await mintFn.populateTransaction(body.shares, body.receiver);
        res.json({ ok: true, tx });
    });
    app.post("/pools/:poolId/tx/withdraw", async (req, res) => {
        const body = prepareWithdrawSchema.parse(req.body);
        const poolId = req.params.poolId;
        const provider = env.BASE_RPC_URL ? new ethers_1.ethers.JsonRpcProvider(env.BASE_RPC_URL) : undefined;
        const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: poolId } });
        if (!pool)
            return res.status(404).json({ error: "Pool not found" });
        const vault = await (0, vaultExecutor_1.getVaultContract)(env, provider, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined });
        const withdrawFn = vault.withdraw;
        if (!withdrawFn?.populateTransaction) {
            return res.status(500).json({
                error: "Vault does not expose withdraw().populateTransaction (ethers v6 ABI wiring issue)",
                poolId,
                clubName: pool.clubName,
                vaultAddress: pool.vaultAddress ?? null
            });
        }
        const tx = await withdrawFn.populateTransaction(body.assets, body.receiver, body.owner);
        res.json({ ok: true, tx });
    });
    app.post("/pools/:poolId/tx/redeem", async (req, res) => {
        const body = prepareRedeemSchema.parse(req.body);
        const poolId = req.params.poolId;
        const provider = env.BASE_RPC_URL ? new ethers_1.ethers.JsonRpcProvider(env.BASE_RPC_URL) : undefined;
        const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: poolId } });
        if (!pool)
            return res.status(404).json({ error: "Pool not found" });
        const vault = await (0, vaultExecutor_1.getVaultContract)(env, provider, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined });
        const redeemFn = vault.redeem;
        if (!redeemFn?.populateTransaction) {
            return res.status(500).json({
                error: "Vault does not expose redeem().populateTransaction (ethers v6 ABI wiring issue)",
                poolId,
                clubName: pool.clubName,
                vaultAddress: pool.vaultAddress ?? null
            });
        }
        const tx = await redeemFn.populateTransaction(body.shares, body.receiver, body.owner);
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
    const baseDepositUsdcSchema = zod_1.z.object({
        poolId: zod_1.z.string().min(1),
        amount: zod_1.z.coerce.bigint()
    });
    function serializeTxRequest(tx) {
        return {
            to: tx.to,
            data: tx.data,
            value: tx.value == null ? undefined : tx.value.toString(),
        };
    }
    app.post("/base/tx/deposit-usdc", async (req, res) => {
        const body = baseDepositUsdcSchema.parse(req.body);
        if (!env.BASE_USDC_ADDRESS) {
            return res.status(400).json({ error: "BASE_USDC_ADDRESS not set" });
        }
        if (!env.BASE_DEPOSIT_RECEIVER_ADDRESS) {
            return res.status(400).json({ error: "BASE_DEPOSIT_RECEIVER_ADDRESS not set" });
        }
        const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: body.poolId } });
        if (!pool)
            return res.status(404).json({ error: "Pool not found" });
        const poolIdHash = ethers_1.ethers.solidityPackedKeccak256(["string"], [pool.clubName]);
        const usdc = new ethers_1.ethers.Contract(env.BASE_USDC_ADDRESS, erc20_1.ERC20.abi);
        const receiver = new ethers_1.ethers.Contract(env.BASE_DEPOSIT_RECEIVER_ADDRESS, [
            "function depositUSDC(uint256 amount, bytes32 poolId) returns (uint256)"
        ]);
        const approveTx = await usdc.approve.populateTransaction(env.BASE_DEPOSIT_RECEIVER_ADDRESS, body.amount);
        const depositTx = await receiver.depositUSDC.populateTransaction(body.amount, poolIdHash);
        return res.json({
            ok: true,
            poolId: pool.id,
            poolIdHash,
            amount: body.amount.toString(),
            sourceToken: env.BASE_USDC_ADDRESS,
            usdcAddress: env.BASE_USDC_ADDRESS,
            receiverAddress: env.BASE_DEPOSIT_RECEIVER_ADDRESS,
            txs: {
                approveTx: serializeTxRequest(approveTx),
                depositTx: serializeTxRequest(depositTx),
            },
        });
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
        const deposit = await prisma_1.prisma.base_chain_deposits.findUnique({
            where: { id: req.params.depositId }
        });
        if (!deposit)
            return res.status(404).json({ error: "Deposit not found" });
        res.json({ ok: true, deposit: serializeBaseChainDeposit(deposit) });
    });
    app.get("/base/deposits/user/:userAddress", async (req, res) => {
        const deposits = await prisma_1.prisma.base_chain_deposits.findMany({
            where: { userAddress: req.params.userAddress },
            orderBy: { createdAt: "desc" }
        });
        res.json({ ok: true, deposits: deposits.map(serializeBaseChainDeposit) });
    });
    // GET status of a cross-chain deposit
    app.get("/chiliz/deposits/:depositId", async (req, res) => {
        const deposit = await prisma_1.prisma.cross_chain_deposits.findUnique({
            where: { id: req.params.depositId }
        });
        if (!deposit)
            return res.status(404).json({ error: "Deposit not found" });
        res.json({ ok: true, deposit });
    });
    // List all cross-chain deposits for a user
    app.get("/chiliz/deposits/user/:userAddress", async (req, res) => {
        const deposits = await prisma_1.prisma.cross_chain_deposits.findMany({
            where: { userAddress: req.params.userAddress },
            orderBy: { createdAt: "desc" }
        });
        res.json({ ok: true, deposits });
    });
    // Prepare unsigned tx for user to call depositCHZ on Chiliz chain
    const chilizDepositChzSchema = zod_1.z.object({
        poolId: zod_1.z.string().min(1) // backend poolId (we hash clubName to get bytes32)
    });
    // Redemption: user burns wrapped shares → gets value back on Chiliz
    const chilizRedeemSchema = zod_1.z.object({
        poolId: zod_1.z.string().min(1),
        userAddress: ethAddressSchema,
        shares: zod_1.z.coerce.bigint()
    });
    app.post("/chiliz/redeem", requireAdmin, async (req, res) => {
        const body = chilizRedeemSchema.parse(req.body);
        const redemption = await prisma_1.prisma.cross_chain_redemptions.create({
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
        const redemption = await prisma_1.prisma.cross_chain_redemptions.findUnique({
            where: { id: req.params.redemptionId }
        });
        if (!redemption)
            return res.status(404).json({ error: "Redemption not found" });
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
            const where = {};
            if (sport)
                where.sport = sport;
            if (league)
                where.league = league;
            if (upcomingOnly)
                where.gameTime = { gte: new Date() };
            const [games, total] = await Promise.all([
                prisma_1.prisma.lim_games.findMany({
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
                prisma_1.prisma.lim_games.count({ where }),
            ]);
            res.json({ ok: true, total, limit, offset, games });
        }
        catch (e) {
            res.status(500).json({ ok: false, error: e?.message ?? "sports_error" });
        }
    });
    /**
     * GET /admin/limitless/sync-state
     * Returns current sync state (provider, cursor, status, last sync time, counts).
     */
    app.get("/admin/limitless/sync-state", requireAdmin, async (_req, res) => {
        try {
            const state = await prisma_1.prisma.limitless_sync_state.findUnique({
                where: { id: "default" },
            });
            res.json({ ok: true, state: state ?? { id: "default", provider: "limitless", status: "IDLE", marketsSynced: 0 } });
        }
        catch (e) {
            res.status(500).json({ ok: false, error: e?.message ?? "sync_state_error" });
        }
    });
    /**
     * POST /admin/limitless/sync/categories
     * Trigger a one-off category sync.
     */
    app.post("/admin/limitless/sync/categories", requireAdmin, async (_req, res) => {
        try {
            const upserted = await (0, limitlessSyncService_1.syncCategories)(env);
            res.json({ ok: true, upserted });
        }
        catch (e) {
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
            const synced = await (0, limitlessSyncService_1.syncMarkets)(env);
            res.json({ ok: true, synced });
        }
        catch (e) {
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
            const stored = await (0, limitlessSyncService_1.syncPrices)(env, limit);
            res.json({ ok: true, stored });
        }
        catch (e) {
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
            const enriched = await (0, limitlessSyncService_1.enrichSportsGames)(env, limit);
            res.json({ ok: true, enriched });
        }
        catch (e) {
            res.status(500).json({ ok: false, error: e?.message ?? "enrich_error" });
        }
    });
    /**
     * POST /admin/limitless/sync/full
     * Run the complete pipeline: categories → markets → prices → sport enrichment.
     */
    app.post("/admin/limitless/sync/full", requireAdmin, async (_req, res) => {
        try {
            const result = await (0, limitlessSyncService_1.runFullLimitlessSync)(env);
            res.json({ ok: true, ...result });
        }
        catch (e) {
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
            const where = {};
            if (status)
                where.status = status;
            if (categoryId)
                where.categoryId = categoryId;
            const [markets, total] = await Promise.all([
                prisma_1.prisma.limitless_markets.findMany({
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
                prisma_1.prisma.limitless_markets.count({ where }),
            ]);
            res.json({ ok: true, total, limit, offset, markets });
        }
        catch (e) {
            res.status(500).json({ ok: false, error: e?.message ?? "markets_list_error" });
        }
    });
    /**
     * GET /admin/limitless/categories
     * List all synced categories.
     */
    app.get("/admin/limitless/categories", requireAdmin, async (_req, res) => {
        try {
            const categories = await prisma_1.prisma.limitless_categories.findMany({
                orderBy: { label: "asc" },
            });
            res.json({ ok: true, categories });
        }
        catch (e) {
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
            const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: poolId } });
            if (!pool)
                return res.status(404).json({ error: "Pool not found" });
            const clubName = String(req.body?.clubName ?? pool.clubName);
            const sportsDataTeamId = req.body?.sportsDataTeamId
                ? String(req.body.sportsDataTeamId)
                : (pool.primarySportsDataTeamId ?? pool.sportsDataTeamId);
            if (!sportsDataTeamId)
                return res.status(400).json({ error: "sportsDataTeamId missing" });
            const riskPerMatchPct = Number(req.body?.riskPerMatchPct ?? pool.riskParams?.maxPerMatchPct ?? 3);
            const liquidityMinUsd = Number(req.body?.liquidityMinUsd ?? pool.riskParams?.liquidityMinUsd ?? 50_000);
            const result = await (0, limitlessDiscoveryService_1.discoverLimitlessClubCandidates)({
                poolId, clubName, sportsDataTeamId, riskPerMatchPct, liquidityMinUsd, env,
            });
            const candidates = await prisma_1.prisma.club_market_candidates.findMany({ where: { poolId } });
            res.json({ ok: true, ...result, count: candidates.length, candidates });
        }
        catch (e) {
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
            const result = await (0, limitlessExecutor_1.executeLimitlessTranche)({ poolId, candidateId, tranche, queueId, env });
            res.json({ ok: true, ...result });
        }
        catch (e) {
            res.status(500).json({ ok: false, error: e?.message ?? "execute_error" });
        }
    });
    /**
     * POST /admin/limitless/position-sync
     * Reconcile fills and settle resolved Limitless positions.
     */
    app.post("/admin/limitless/position-sync", requireAdmin, async (_req, res) => {
        try {
            await (0, limitlessPositionSync_1.syncLimitlessFillsAndSettle)(env);
            res.json({ ok: true });
        }
        catch (e) {
            res.status(500).json({ ok: false, error: e?.message ?? "position_sync_error" });
        }
    });
    app.post("/admin/limitless/portfolio-sync/:poolId", requireAdmin, async (req, res) => {
        try {
            const result = await (0, limitlessPortfolio_1.syncLimitlessPortfolioForPool)(env, req.params.poolId);
            res.json({ ok: true, ...result });
        }
        catch (e) {
            logger.error({ err: e, poolId: req.params.poolId }, "limitless portfolio sync failed");
            res.status(502).json({ ok: false, error: e?.message ?? "portfolio_sync_error" });
        }
    });
    /**
     * GET /admin/limitless/market-data/:marketId
     * Fetch a live MarketClobData snapshot for a Limitless market.
     * Used by the allocation engine admin UI.
     */
    app.get("/admin/limitless/market-data/:marketId", requireAdmin, async (req, res) => {
        try {
            const data = await (0, limitlessMarketData_1.fetchLimitlessMarketData)(env, req.params.marketId);
            res.json({ ok: true, data });
        }
        catch (e) {
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
            const ids = Array.isArray(req.body?.marketIds) ? req.body.marketIds : [];
            if (ids.length === 0)
                return res.status(400).json({ error: "marketIds required" });
            if (ids.length > 50)
                return res.status(400).json({ error: "max 50 marketIds per batch" });
            const map = await (0, limitlessMarketData_1.fetchLimitlessMarketDataBatch)(env, ids);
            res.json({ ok: true, data: Object.fromEntries(map) });
        }
        catch (e) {
            res.status(500).json({ ok: false, error: e?.message ?? "batch_market_data_error" });
        }
    });
    /**
     * GET /admin/limitless/readiness
     * Check if Limitless trading wallet is configured and ready.
     */
    app.get("/admin/limitless/readiness", requireAdmin, (_req, res) => {
        const readiness = (0, limitlessOrderClient_1.isLimitlessTradingReady)(env);
        res.json({ ok: true, ...readiness });
    });
    const port = process.env.PORT ? Number(process.env.PORT) : 3001;
    app.listen(port, () => logger.info({ port }, "HTTP server listening"));
    return app;
}
