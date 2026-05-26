"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startHttpServer = startHttpServer;
const express_1 = __importDefault(require("express"));
const zod_1 = require("zod");
const prisma_1 = require("../db/prisma");
const discoveryService_1 = require("../services/discoveryService");
const scheduler_1 = require("../services/scheduler");
const executor_1 = require("../services/executor");
const priceEngine_1 = require("../services/priceEngine");
const vaultExecutor_1 = require("../onchain/vaultExecutor");
const poolSync_1 = require("../onchain/poolSync");
const clubVaultFactoryExecutor_1 = require("../onchain/clubVaultFactoryExecutor");
const ethers_1 = require("ethers");
const swagger_ui_express_1 = __importDefault(require("swagger-ui-express"));
const swagger_1 = require("./swagger");
const erc20_1 = require("../contracts/erc20");
const uniswapV2Router_1 = require("../contracts/uniswapV2Router");
const baseDepositReceiver_1 = require("../contracts/baseDepositReceiver");
const gammaClient_1 = require("../polymarket/gammaClient");
const clobClient_1 = require("../polymarket/clobClient");
const polymarketWallet_1 = require("../polymarket/polymarketWallet");
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
    app.use(express_1.default.json({ limit: "1mb" }));
    app.use("/docs", swagger_ui_express_1.default.serve, swagger_ui_express_1.default.setup(swagger_1.swaggerSpec));
    function requireAdmin(req, res, next) {
        if (!env.ADMIN_API_KEY)
            return next();
        const key = String(req.headers["x-admin-key"] ?? "");
        if (!key || key !== env.ADMIN_API_KEY)
            return res.status(403).json({ error: "Forbidden" });
        return next();
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
        const teams = await prisma_1.prisma.club_teams_map.findMany({ orderBy: { internalClubName: "asc" } });
        res.json({ ok: true, teams });
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
    // Returns every pool where the given wallet address holds a non-zero share
    // balance, along with computed USD value per holding and a portfolio total.
    app.get("/users/:address/holdings", async (req, res) => {
        const address = String(req.params.address || "").trim();
        if (!address)
            return res.status(400).json({ error: "Missing address" });
        // Matching is case-insensitive because checksummed vs lowercased addresses
        // get stored depending on the source (events vs admin input).
        const userRows = await prisma_1.prisma.club_pool_users.findMany({
            where: {
                userAddress: { equals: address, mode: "insensitive" },
                tokenBalance: { gt: 0 },
            },
        });
        if (userRows.length === 0) {
            return res.json({ ok: true, holdings: [], totalValueUsd: 0 });
        }
        const pools = await prisma_1.prisma.club_pools.findMany({
            where: { id: { in: userRows.map((u) => u.poolId) } },
        });
        const poolById = new Map(pools.map((p) => [p.id, p]));
        // Re-implementation of the frontend tokenPriceUsdPerWholeShare logic — keep
        // pricing rules centralised so numbers shown on the landing page, dashboard
        // and deposit modal all agree.
        const VAULT_SHARE_DECIMALS = 6;
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
        const holdings = userRows
            .map((u) => {
            const pool = poolById.get(u.poolId);
            if (!pool)
                return null;
            const rawBalance = Number(u.tokenBalance?.toString() ?? "0");
            const shares = rawBalance / 10 ** VAULT_SHARE_DECIMALS;
            if (!(shares > 0))
                return null;
            const tvl = toTvlHuman(pool.totalPoolValue?.toString());
            const rawSupply = Number(pool.totalTokenSupply?.toString() ?? "0");
            const sharesHuman = rawSupply > 0 ? rawSupply / 10 ** VAULT_SHARE_DECIMALS : 0;
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
                tokenBalanceRaw: u.tokenBalance?.toString() ?? "0",
                tokenPriceUsd: tokenPrice,
                valueUsd,
                updatedAt: u.updatedAt,
            };
        })
            .filter((h) => h !== null)
            .sort((a, b) => b.valueUsd - a.valueUsd);
        const totalValueUsd = holdings.reduce((s, h) => s + h.valueUsd, 0);
        res.json({ ok: true, address, holdings, totalValueUsd });
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
        polymarketTeamId: zod_1.z.string().optional(),
        totalTokenSupply: zod_1.z.number().optional().default(0),
        depositCap: zod_1.z.coerce.bigint().optional().default(0n),
        vaultAddress: zod_1.z.string().optional(),
        deployOnchain: zod_1.z.boolean().optional().default(false),
        bootstrapPolymarket: zod_1.z.boolean().optional(),
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
        if (!env.RPC_URL) {
            return res.status(400).json({ error: "RPC_URL not set in backend .env" });
        }
        const provider = new ethers_1.ethers.JsonRpcProvider(env.RPC_URL);
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
            if (!resolvedVaultAddress && env.CLUB_VAULT_FACTORY_ADDRESS && env.RPC_URL) {
                try {
                    const provider = new ethers_1.ethers.JsonRpcProvider(env.RPC_URL);
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
            const shouldBootstrapPolymarket = body.bootstrapPolymarket ?? Boolean(resolvedVaultAddress);
            const polymarketBootstrap = shouldBootstrapPolymarket
                ? await (0, polymarketWallet_1.bootstrapPolymarketTradingWallet)(env)
                : null;
            const pool = await prisma_1.prisma.club_pools.create({
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
            return res.json({ ok: true, pool, vaultDeployment, polymarketBootstrap });
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
            polymarketTeamId: zod_1.z.string().nullable().optional(),
            status: zod_1.z.enum(["ACTIVE", "PAUSED"]).optional(),
            officialTokenPrice: zod_1.z.string().optional(),
            totalPoolValue: zod_1.z.string().optional(),
            totalTokenSupply: zod_1.z.string().optional(),
            depositCap: zod_1.z.string().optional(),
        });
        const body = updateSchema.parse(req.body);
        const pool = await prisma_1.prisma.club_pools.update({
            where: { id: poolId },
            data: body
        });
        res.json({ ok: true, pool });
    });
    app.delete("/admin/pools/:poolId", requireAdmin, async (req, res) => {
        await prisma_1.prisma.club_pools.delete({ where: { id: req.params.poolId } });
        res.json({ ok: true });
    });
    const clubTeamMapSchema = zod_1.z.object({
        internalClubName: zod_1.z.string().min(1),
        polymarketTeamId: zod_1.z.string().min(1)
    });
    app.post("/admin/club-team-map", requireAdmin, async (req, res) => {
        const body = clubTeamMapSchema.parse(req.body);
        await prisma_1.prisma.club_teams_map.createMany({
            data: [{ internalClubName: body.internalClubName, polymarketTeamId: body.polymarketTeamId }],
            skipDuplicates: true
        });
        res.json({ ok: true });
    });
    app.get("/admin/gamma-teams", requireAdmin, async (req, res) => {
        const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
        const offset = Math.max(Number(req.query.offset) || 0, 0);
        const result = await (0, gammaClient_1.listTeams)(env, limit, offset);
        const teams = (result?.teams ?? []).map((t) => {
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
                const batch = await (0, gammaClient_1.listTeams)(env, pageSize, offset);
                const raw = batch?.teams ?? [];
                if (!raw.length)
                    break;
                pages += 1;
                const rows = [];
                for (const t of raw) {
                    const rec = t;
                    const label = String(rec.name ?? rec.slug ?? rec.slugKey ?? rec.id ?? "").trim();
                    if (!label)
                        continue;
                    rows.push({ internalClubName: label, polymarketTeamId: label });
                }
                if (rows.length) {
                    const r = await prisma_1.prisma.club_teams_map.createMany({ data: rows, skipDuplicates: true });
                    inserted += r.count;
                }
                offset += raw.length;
                if (raw.length < pageSize)
                    break;
            }
            res.json({ ok: true, inserted, pagesFetched: pages });
        }
        catch (e) {
            logger.error({ err: e }, "sync-from-gamma failed");
            res.status(502).json({ error: e?.message ?? "Gamma /teams request failed" });
        }
    });
    // ─── Polymarket Market Search & Data ────────────────────────────────────────
    /**
     * GET /admin/polymarket/search?q=Arsenal
     * Searches Polymarket Gamma API for markets matching the keyword.
     * Returns formatted markets with marketType (game/future) detection.
     */
    app.get("/admin/polymarket/search", requireAdmin, async (req, res) => {
        const q = String(req.query.q ?? "").trim();
        if (!q)
            return res.status(400).json({ error: "q is required" });
        try {
            const markets = await (0, gammaClient_1.searchMarketsByKeyword)(env, q, 50);
            res.json({ ok: true, markets });
        }
        catch (e) {
            logger.error({ err: e }, "polymarket/search failed");
            res.status(502).json({ error: e?.message ?? "Polymarket search failed" });
        }
    });
    /**
     * GET /admin/polymarket/market-data?conditionId=...&tokenId=...
     * Fetches live CLOB + Gamma data (price, spread, depth, volume24h, history, endDate).
     */
    app.get("/admin/polymarket/market-data", requireAdmin, async (req, res) => {
        const conditionId = String(req.query.conditionId ?? "").trim();
        const tokenId = String(req.query.tokenId ?? "").trim();
        if (!conditionId || !tokenId) {
            return res.status(400).json({ error: "conditionId and tokenId are required" });
        }
        try {
            // Fetch CLOB + Gamma data in parallel
            const [books, midStr, spreadMap, history, gammaMarket] = await Promise.all([
                (0, clobClient_1.getBooks)(env, [tokenId]).catch(() => []),
                (0, clobClient_1.getMidpoint)(env, tokenId).catch(() => "0.5"),
                (0, clobClient_1.getSpreadMap)(env, [tokenId]).catch(() => ({})),
                (0, clobClient_1.getPricesHistory)(env, tokenId, "1d"),
                // Gamma: get market metadata (volume24h, endDate, liquidity, closed status)
                Promise.resolve().then(() => __importStar(require("../polymarket/gammaClient"))).then(m => m.getMarketById(env, conditionId).catch(() => null)),
            ]);
            const book = books[0];
            const midpoint = parseFloat(midStr);
            const spread = parseFloat(spreadMap[tokenId] ?? "0");
            const { bestBid, bestAsk } = book
                ? (0, clobClient_1.getBestBidAsk)(book)
                : { bestBid: midpoint - 0.01, bestAsk: midpoint + 0.01 };
            const depthAt2Pct = book ? (0, clobClient_1.calculateDepthAtSlippage)(book, bestAsk, 0.02) : 0;
            const slippage = book ? (0, clobClient_1.estimateSlippage)(book, 5_000) : 0.03;
            // Liquidity from order book depth
            const bookLiquidity = book
                ? (book.bids ?? []).reduce((s, b) => s + parseFloat(b.price) * parseFloat(b.size), 0) +
                    (book.asks ?? []).reduce((s, a) => s + parseFloat(a.price) * parseFloat(a.size), 0)
                : 0;
            // Prefer Gamma for liquidity/volume (more accurate than order book snapshot)
            const gamma = gammaMarket;
            const gammaLiq = Number(gamma?.liquidityAmountUSD ?? gamma?.liquidity ?? 0);
            const liquidity = gammaLiq > 0 ? gammaLiq : bookLiquidity;
            const volume24h = Number(gamma?.volume24hr ?? gamma?.oneDayVolume ?? gamma?.volume24h ?? 0);
            const isClosed = Boolean(gamma?.closed ?? false);
            const endDateIso = gamma?.endDate ?? gamma?.resolutionTime ?? null;
            // Days to resolution: compute from Gamma endDate if available
            let daysToResolution = 14;
            if (endDateIso) {
                const endMs = new Date(endDateIso).getTime();
                daysToResolution = Math.max(0, Math.round((endMs - Date.now()) / 86_400_000));
            }
            res.json({
                conditionId,
                price: midpoint,
                bestBid,
                bestAsk,
                midpoint,
                spread: spread || Math.abs(bestAsk - bestBid),
                liquidity,
                volume24h,
                depthAt2PctSlippage: depthAt2Pct,
                estimatedSlippage: slippage,
                daysToResolution,
                marketStatus: isClosed ? "closed" : "open",
                historicalPrices: history,
            });
        }
        catch (e) {
            logger.error({ err: e }, "polymarket/market-data failed");
            res.status(502).json({ error: e?.message ?? "CLOB/Gamma data fetch failed" });
        }
    });
    app.get("/admin/polymarket/readiness", requireAdmin, async (req, res) => {
        const tokenId = String(req.query.tokenId ?? "").trim() || undefined;
        try {
            const readiness = await (0, polymarketWallet_1.getPolymarketReadiness)(env, tokenId);
            res.json({ ok: true, readiness });
        }
        catch (e) {
            logger.error({ err: e }, "polymarket/readiness failed");
            res.status(500).json({ ok: false, error: e?.message ?? "Polymarket readiness failed" });
        }
    });
    app.get("/admin/polymarket/deposit-wallet/derive", requireAdmin, async (_req, res) => {
        try {
            const wallet = await (0, polymarketWallet_1.derivePolymarketDepositWallet)(env);
            res.json({ ok: true, wallet });
        }
        catch (e) {
            logger.error({ err: e }, "polymarket/deposit-wallet/derive failed");
            res.status(500).json({ ok: false, error: e?.message ?? "Polymarket Deposit Wallet derivation failed" });
        }
    });
    app.post("/admin/polymarket/deposit-wallet/deploy", requireAdmin, async (_req, res) => {
        try {
            const deployment = await (0, polymarketWallet_1.deployPolymarketDepositWallet)(env);
            res.json({ ok: true, deployment });
        }
        catch (e) {
            logger.error({ err: e }, "polymarket/deposit-wallet/deploy failed");
            res.status(500).json({ ok: false, error: e?.message ?? "Polymarket Deposit Wallet deployment failed" });
        }
    });
    app.post("/admin/polymarket/deposit-wallet/approve-pusd", requireAdmin, async (_req, res) => {
        try {
            const approvals = await (0, polymarketWallet_1.approvePolymarketPusdAllowances)(env);
            res.json({ ok: true, approvals });
        }
        catch (e) {
            logger.error({ err: e }, "polymarket/deposit-wallet/approve-pusd failed");
            res.status(500).json({ ok: false, error: e?.message ?? "Polymarket pUSD allowance approval failed" });
        }
    });
    app.post("/admin/polymarket/deposit-wallet/bootstrap", requireAdmin, async (req, res) => {
        const tokenId = String(req.query.tokenId ?? req.body?.tokenId ?? "").trim() || undefined;
        try {
            const bootstrap = await (0, polymarketWallet_1.bootstrapPolymarketTradingWallet)(env, tokenId);
            res.json({ ok: true, bootstrap });
        }
        catch (e) {
            logger.error({ err: e }, "polymarket/deposit-wallet/bootstrap failed");
            res.status(500).json({ ok: false, error: e?.message ?? "Polymarket Deposit Wallet bootstrap failed" });
        }
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
    const discoverSchema = zod_1.z.object({
        clubName: zod_1.z.string().min(1).optional(),
        teamPolymarketId: zod_1.z.string().optional(),
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
        const teamPolymarketId = body.teamPolymarketId?.trim() || pool.polymarketTeamId?.trim() || undefined;
        await (0, discoveryService_1.discoverClubCandidates)({
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
        const result = await (0, executor_1.executeTranche)({
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
        if (!env.RPC_URL)
            return res.status(400).json({ error: "RPC_URL missing" });
        const provider = new ethers_1.ethers.JsonRpcProvider(env.RPC_URL);
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
    app.post("/pools/:poolId/tx/deposit-wrapchz", async (req, res) => {
        const body = prepareDepositWrapChzSchema.parse(req.body);
        const poolId = req.params.poolId;
        if (!env.RPC_URL)
            return res.status(500).json({ error: "RPC_URL is required." });
        if (!env.WRAPCHZ_TOKEN_ADDRESS)
            return res.status(500).json({ error: "WRAPCHZ_TOKEN_ADDRESS is not set." });
        if (!env.UNISWAP_V2_ROUTER_ADDRESS)
            return res.status(500).json({ error: "UNISWAP_V2_ROUTER_ADDRESS is not set." });
        const provider = new ethers_1.ethers.JsonRpcProvider(env.RPC_URL);
        const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: poolId } });
        if (!pool)
            return res.status(404).json({ error: "Pool not found" });
        const vault = await (0, vaultExecutor_1.getVaultContract)(env, provider, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined });
        const assetAddress = await vault.asset();
        const vaultAddress = vault.target ?? vault.address;
        const depositAssets = body.depositAssets ?? body.usdcAmountOutMin;
        if (depositAssets > body.usdcAmountOutMin) {
            return res.status(400).json({
                error: "depositAssets must be <= usdcAmountOutMin.",
                depositAssets: depositAssets.toString(),
                usdcAmountOutMin: body.usdcAmountOutMin.toString()
            });
        }
        const wrapChz = new ethers_1.ethers.Contract(env.WRAPCHZ_TOKEN_ADDRESS, erc20_1.ERC20.abi, provider);
        const usdc = new ethers_1.ethers.Contract(assetAddress, erc20_1.ERC20.abi, provider);
        const router = new ethers_1.ethers.Contract(env.UNISWAP_V2_ROUTER_ADDRESS, uniswapV2Router_1.UNISWAP_V2_ROUTER.abi, provider);
        const approveWrapChzTx = await wrapChz.approve.populateTransaction(env.UNISWAP_V2_ROUTER_ADDRESS, body.wrapChzAmountIn);
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
        const path = [env.WRAPCHZ_TOKEN_ADDRESS, assetAddress];
        const swapTx = await router.swapExactTokensForTokens.populateTransaction(body.wrapChzAmountIn, body.usdcAmountOutMin, path, body.sender, deadline);
        const approveUsdcTx = await usdc.approve.populateTransaction(vaultAddress, depositAssets);
        const depositFn = vault.deposit;
        if (!depositFn?.populateTransaction) {
            return res.status(500).json({
                error: "Vault does not expose deposit().populateTransaction (ethers v6 ABI wiring issue)",
                poolId,
                clubName: pool.clubName,
                vaultAddress: pool.vaultAddress ?? null
            });
        }
        const depositTx = await depositFn.populateTransaction(depositAssets, body.receiver);
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
    // Immediately ingest a confirmed vault deposit tx into DB (single block; does not advance lastSyncedBlock).
    app.post("/pools/:poolId/deposit/confirm", async (req, res) => {
        const poolId = req.params.poolId;
        const body = zod_1.z
            .object({
            txHash: zod_1.z.string().regex(/^0x[a-fA-F0-9]{64}$/i)
        })
            .parse(req.body);
        const txLc = body.txHash.toLowerCase();
        if (!env.RPC_URL) {
            return res.status(400).json({ error: "RPC_URL missing" });
        }
        const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: poolId } });
        if (!pool)
            return res.status(404).json({ error: "Pool not found" });
        if (!pool.vaultAddress) {
            return res.status(400).json({ error: "Pool vaultAddress not configured" });
        }
        const provider = new ethers_1.ethers.JsonRpcProvider(env.RPC_URL);
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
        if (!env.RPC_URL)
            return res.status(500).json({ error: "RPC_URL is required." });
        const provider = new ethers_1.ethers.JsonRpcProvider(env.RPC_URL);
        const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: poolId } });
        if (!pool)
            return res.status(404).json({ error: "Pool not found" });
        const vault = await (0, vaultExecutor_1.getVaultContract)(env, provider, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined });
        const assetAddress = await vault.asset();
        const vaultAddress = vault.target ?? vault.address;
        if (env.POLYGON_USDC_ADDRESS && assetAddress.toLowerCase() !== env.POLYGON_USDC_ADDRESS.toLowerCase()) {
            return res.status(409).json({
                ok: false,
                code: "VAULT_ASSET_MISMATCH",
                error: "This pool vault was deployed with a different Polygon USDC contract. Polygon native USDC deposits are disabled for this pool; use Base or create a new pool with the native USDC factory.",
                vaultAddress,
                assetAddress,
                expectedAssetAddress: env.POLYGON_USDC_ADDRESS
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
        const provider = env.RPC_URL ? new ethers_1.ethers.JsonRpcProvider(env.RPC_URL) : undefined;
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
        const provider = env.RPC_URL ? new ethers_1.ethers.JsonRpcProvider(env.RPC_URL) : undefined;
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
        const provider = env.RPC_URL ? new ethers_1.ethers.JsonRpcProvider(env.RPC_URL) : undefined;
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
    app.post("/base/tx/deposit-usdc", async (req, res) => {
        const body = baseDepositUsdcSchema.parse(req.body);
        if (!env.BASE_RPC_URL || !env.BASE_USDC_ADDRESS || !env.BASE_DEPOSIT_RECEIVER_ADDRESS) {
            return res.status(500).json({
                error: "Base env not configured (BASE_RPC_URL / BASE_USDC_ADDRESS / BASE_DEPOSIT_RECEIVER_ADDRESS)."
            });
        }
        const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: body.poolId } });
        if (!pool)
            return res.status(404).json({ error: "Pool not found" });
        const poolIdHash = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes(pool.clubName));
        const baseProvider = new ethers_1.ethers.JsonRpcProvider(env.BASE_RPC_URL);
        const usdc = new ethers_1.ethers.Contract(env.BASE_USDC_ADDRESS, erc20_1.ERC20.abi, baseProvider);
        const receiver = new ethers_1.ethers.Contract(env.BASE_DEPOSIT_RECEIVER_ADDRESS, baseDepositReceiver_1.BASE_DEPOSIT_RECEIVER.abi, baseProvider);
        const approveTx = await usdc.approve.populateTransaction(env.BASE_DEPOSIT_RECEIVER_ADDRESS, body.amount);
        const depositTx = await receiver.depositUSDC.populateTransaction(body.amount, poolIdHash);
        res.json({
            ok: true,
            receiverAddress: env.BASE_DEPOSIT_RECEIVER_ADDRESS,
            usdcAddress: env.BASE_USDC_ADDRESS,
            poolIdHash,
            txs: { approveTx, depositTx }
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
    app.post("/chiliz/tx/deposit-chz", async (req, res) => {
        const body = chilizDepositChzSchema.parse(req.body);
        if (!env.CHILIZ_RPC_URL || !env.CHILIZ_DEPOSIT_RECEIVER_ADDRESS) {
            return res.status(500).json({ error: "Chiliz env not configured (CHILIZ_RPC_URL / CHILIZ_DEPOSIT_RECEIVER_ADDRESS)." });
        }
        const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: body.poolId } });
        if (!pool)
            return res.status(404).json({ error: "Pool not found" });
        const poolIdHash = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes(pool.clubName));
        const chilizProvider = new ethers_1.ethers.JsonRpcProvider(env.CHILIZ_RPC_URL);
        const receiver = new ethers_1.ethers.Contract(env.CHILIZ_DEPOSIT_RECEIVER_ADDRESS, ["function depositCHZ(bytes32 poolId) external payable"], chilizProvider);
        const tx = await receiver.depositCHZ.populateTransaction(poolIdHash);
        res.json({
            ok: true,
            receiverAddress: env.CHILIZ_DEPOSIT_RECEIVER_ADDRESS,
            poolIdHash,
            tx
        });
    });
    // Prepare unsigned tx for user to call depositToken (fan token) on Chiliz chain
    const chilizDepositTokenSchema = zod_1.z.object({
        poolId: zod_1.z.string().min(1),
        token: ethAddressSchema,
        amount: zod_1.z.coerce.bigint()
    });
    app.post("/chiliz/tx/deposit-token", async (req, res) => {
        const body = chilizDepositTokenSchema.parse(req.body);
        if (!env.CHILIZ_RPC_URL || !env.CHILIZ_DEPOSIT_RECEIVER_ADDRESS) {
            return res.status(500).json({ error: "Chiliz env not configured." });
        }
        const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: body.poolId } });
        if (!pool)
            return res.status(404).json({ error: "Pool not found" });
        const poolIdHash = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes(pool.clubName));
        const chilizProvider = new ethers_1.ethers.JsonRpcProvider(env.CHILIZ_RPC_URL);
        const tokenContract = new ethers_1.ethers.Contract(body.token, [
            "function approve(address spender, uint256 amount) external returns (bool)"
        ], chilizProvider);
        const approveTx = await tokenContract.approve.populateTransaction(env.CHILIZ_DEPOSIT_RECEIVER_ADDRESS, body.amount);
        const receiver = new ethers_1.ethers.Contract(env.CHILIZ_DEPOSIT_RECEIVER_ADDRESS, ["function depositToken(address token, uint256 amount, bytes32 poolId) external"], chilizProvider);
        const depositTx = await receiver.depositToken.populateTransaction(body.token, body.amount, poolIdHash);
        res.json({
            ok: true,
            receiverAddress: env.CHILIZ_DEPOSIT_RECEIVER_ADDRESS,
            poolIdHash,
            txs: { approveTx, depositTx }
        });
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
    const port = process.env.PORT ? Number(process.env.PORT) : 3001;
    app.listen(port, () => logger.info({ port }, "HTTP server listening"));
    return app;
}
