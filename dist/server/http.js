"use strict";
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
function startHttpServer({ env, logger }) {
    const app = (0, express_1.default)();
    app.use(express_1.default.json({ limit: "1mb" }));
    // Swagger UI
    app.use("/docs", swagger_ui_express_1.default.serve, swagger_ui_express_1.default.setup(swagger_1.swaggerSpec));
    function requireAdmin(req, res, next) {
        if (!env.ADMIN_API_KEY)
            return next();
        const key = String(req.headers["x-admin-key"] ?? "");
        if (!key || key !== env.ADMIN_API_KEY)
            return res.status(403).json({ error: "Forbidden" });
        return next();
    }
    app.get("/health", async (_req, res) => {
        const dbOk = await prisma_1.prisma
            .$queryRaw `SELECT 1`
            .then(() => true)
            .catch(() => false);
        res.json({ ok: true, db: dbOk });
    });
    // =========================
    // Read endpoints
    // =========================
    app.get("/pools/:poolId", async (req, res) => {
        const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: req.params.poolId } });
        if (!pool)
            return res.status(404).json({ error: "Pool not found" });
        res.json({ ok: true, pool });
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
        const positions = await prisma_1.prisma.club_pool_positions.findMany({
            where: { poolId: req.params.poolId, status: "OPEN" }
        });
        res.json({ ok: true, positions });
    });
    app.get("/pools/:poolId/price-snapshots/latest", async (req, res) => {
        const latest = await prisma_1.prisma.club_pool_price_snapshots.findFirst({
            where: { poolId: req.params.poolId },
            orderBy: { snapshotTime: "desc" }
        });
        res.json({ ok: true, latest });
    });
    // =========================
    // Admin: pool management
    // =========================
    const poolCreateSchema = zod_1.z.object({
        clubName: zod_1.z.string().min(1),
        symbol: zod_1.z.string().min(1),
        totalTokenSupply: zod_1.z.number().optional().default(0),
        // Multi-pool best approach:
        // 1) Each pool row corresponds to one club's per-club vault (ERC20 share token).
        // 2) If `CLUB_VAULT_FACTORY_ADDRESS` is configured, backend can auto-deploy the vault
        //    when you create the pool record here.
        deployOnchain: zod_1.z.boolean().optional().default(true),
        depositCap: zod_1.z.coerce.bigint().optional().default(0n),
        riskParams: zod_1.z
            .object({
            maxPerMatchPct: zod_1.z.number().optional(),
            maxTotalExposurePct: zod_1.z.number().optional(),
            liquidityMinUsd: zod_1.z.number().optional()
        })
            .optional()
    });
    app.post("/admin/pools", requireAdmin, async (req, res) => {
        const body = poolCreateSchema.parse(req.body);
        const riskParams = body.riskParams ?? { maxPerMatchPct: 3, maxTotalExposurePct: 20, liquidityMinUsd: 50_000 };
        let vaultAddress;
        if (body.deployOnchain && env.CLUB_VAULT_FACTORY_ADDRESS && env.RPC_URL) {
            const ensured = await (0, clubVaultFactoryExecutor_1.ensureClubVaultExists)({
                env,
                clubName: body.clubName,
                symbol: body.symbol,
                depositCap: body.depositCap
            });
            vaultAddress = ensured.vaultAddress;
        }
        const pool = await prisma_1.prisma.club_pools.create({
            data: {
                clubName: body.clubName,
                symbol: body.symbol,
                vaultAddress: vaultAddress ?? null,
                cash: "0",
                openPositionsValue: "0",
                realizedPnl: "0",
                totalPoolValue: "0",
                totalTokenSupply: body.totalTokenSupply.toString(),
                officialTokenPrice: body.totalTokenSupply > 0 ? "0" : "0",
                riskParams,
                status: "ACTIVE"
            }
        });
        res.json({ ok: true, poolId: pool.id });
    });
    // =========================
    // Admin: club -> Polymarket team mapping
    // =========================
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
    const discoverSchema = zod_1.z.object({
        clubName: zod_1.z.string().min(1),
        // Polymarket team mapping: if missing, you can run a separate importer job.
        teamPolymarketId: zod_1.z.string().optional(),
        riskPerMatchPct: zod_1.z.number().optional().default(3),
        liquidityMinUsd: zod_1.z.number().optional().default(50_000)
    });
    // Discover markets and insert match candidates for a club pool.
    app.post("/admin/:poolId/discover", requireAdmin, async (req, res) => {
        const poolId = req.params.poolId;
        const body = discoverSchema.parse(req.body);
        const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: poolId } });
        if (!pool)
            return res.status(404).json({ error: "Pool not found" });
        await (0, discoveryService_1.discoverClubCandidates)({
            poolId,
            clubName: body.clubName,
            teamPolymarketId: body.teamPolymarketId,
            riskPerMatchPct: body.riskPerMatchPct,
            liquidityMinUsd: body.liquidityMinUsd,
            env
        });
        res.json({ ok: true });
    });
    // Create scheduled queue entries (T-48h and T-24h) for the latest candidates.
    app.post("/admin/:poolId/schedule", requireAdmin, async (req, res) => {
        const poolId = req.params.poolId;
        await (0, scheduler_1.scheduleMatchTranches)({ poolId, env });
        res.json({ ok: true });
    });
    // =========================
    // Admin: vault controls
    // =========================
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
    // =========================
    // Admin: vault read helpers
    // =========================
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
    // =========================
    // Admin: execute tranche manually (for testing)
    // =========================
    app.post("/admin/:poolId/execute-tranche", requireAdmin, async (req, res) => {
        const body = zod_1.z.object({ candidateId: zod_1.z.string().min(1), tranche: zod_1.z.number().int().min(1).max(2) }).parse(req.body);
        await (0, executor_1.executeTranche)({
            env,
            poolId: req.params.poolId,
            candidateId: body.candidateId,
            tranche: body.tranche,
            expectedExecutionTimeMs: Date.now()
        });
        res.json({ ok: true });
    });
    // =========================
    // Admin: vault executeWhitelistedCall manual
    // =========================
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
    // =========================
    // Admin: official price recalculation (manual)
    // =========================
    app.post("/admin/:poolId/reprice", requireAdmin, async (req, res) => {
        // Currently recalculates all ACTIVE pools (MVP).
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
    app.post("/pools/:poolId/tx/deposit", async (req, res) => {
        const body = prepareDepositSchema.parse(req.body);
        const poolId = req.params.poolId;
        const provider = env.RPC_URL ? new ethers_1.ethers.JsonRpcProvider(env.RPC_URL) : undefined;
        const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: poolId } });
        if (!pool)
            return res.status(404).json({ error: "Pool not found" });
        const vault = await (0, vaultExecutor_1.getVaultContract)(env, provider, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined });
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
        res.json({ ok: true, tx });
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
    const port = process.env.PORT ? Number(process.env.PORT) : 3001;
    app.listen(port, () => logger.info({ port }, "HTTP server listening"));
    return app;
}
