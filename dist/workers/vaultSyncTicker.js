"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startVaultSyncTicker = startVaultSyncTicker;
const prisma_1 = require("../db/prisma");
const ethersLogChunks_1 = require("../onchain/ethersLogChunks");
const poolSync_1 = require("../onchain/poolSync");
const rpc_1 = require("../onchain/rpc");
const vaultExecutor_1 = require("../onchain/vaultExecutor");
const priceEngine_1 = require("../services/priceEngine");
const chainEventCursor_1 = require("./chainEventCursor");
function getLastSyncedBlock(riskParams) {
    const v = riskParams?.lastSyncedBlock;
    if (typeof v === "number" && Number.isFinite(v))
        return v;
    return undefined;
}
function positiveIntFromEnv(name, fallback) {
    const n = Number(process.env[name] || fallback);
    if (!Number.isFinite(n) || n < 1)
        return fallback;
    return Math.floor(n);
}
function startVaultSyncTicker({ env, logger }) {
    const intervalMs = Number(process.env.VAULT_SYNC_INTERVAL_MS || 60_000);
    const maxBlocksPerTick = positiveIntFromEnv("VAULT_SYNC_MAX_BLOCKS_PER_TICK", 100);
    const poolsPerTick = positiveIntFromEnv("VAULT_SYNC_POOLS_PER_TICK", 1);
    if ((0, rpc_1.getBaseRpcUrls)(env).length === 0) {
        logger.warn("VAULT_SYNC skipped: RPC_URL missing");
        return;
    }
    logger.info({ intervalMs }, "Vault sync ticker started");
    let isTicking = false;
    async function tick() {
        if (isTicking) {
            logger.warn("Vault sync tick skipped: previous tick still running");
            return;
        }
        isTicking = true;
        try {
            const pools = await prisma_1.prisma.club_pools.findMany({ where: { status: "ACTIVE" }, orderBy: { updatedAt: "asc" } });
            if (pools.length === 0)
                return;
            const latest = await (0, rpc_1.getBaseBlockNumber)(env);
            let didAnySync = false;
            let claimedPools = 0;
            for (const pool of pools) {
                if (claimedPools >= poolsPerTick)
                    break;
                let vaultAddress = pool.vaultAddress ?? undefined;
                if (!vaultAddress) {
                    try {
                        const vault = await (0, rpc_1.withBaseRpcRetry)(env, (provider) => (0, vaultExecutor_1.getVaultContract)(env, provider, {
                            clubName: pool.clubName,
                            vaultAddress: undefined
                        }));
                        vaultAddress = (vault.target ?? vault.address);
                    }
                    catch (err) {
                        logger.warn({ err: (0, ethersLogChunks_1.compactRpcError)(err), poolId: pool.id }, "Vault sync skipped: vault address could not be resolved");
                        continue;
                    }
                }
                const cursorKey = `polygon:${vaultAddress.toLowerCase()}:VaultEvents:${pool.id}`;
                const lastSynced = getLastSyncedBlock(pool.riskParams);
                const startBlock = lastSynced !== undefined ? lastSynced : Math.max(0, latest - 2_001);
                const workerId = (0, chainEventCursor_1.makeCursorWorkerId)("vault-sync");
                const cursor = await (0, chainEventCursor_1.claimChainEventCursor)({
                    key: cursorKey,
                    chain: "polygon",
                    contractAddress: vaultAddress,
                    eventName: "VaultEvents",
                    startBlock
                }, workerId);
                if (!cursor)
                    continue;
                claimedPools += 1;
                const cursorBlock = (0, chainEventCursor_1.cursorBlockNumber)(cursor);
                const lastProcessedBlock = Math.max(cursorBlock, lastSynced ?? 0);
                if (latest <= lastProcessedBlock) {
                    await (0, chainEventCursor_1.completeChainEventCursor)({ key: cursorKey, workerId, lastProcessedBlock });
                    continue;
                }
                const fromBlock = lastProcessedBlock + 1;
                const toBlock = Math.min(latest, lastProcessedBlock + maxBlocksPerTick);
                try {
                    await (0, poolSync_1.syncVaultEventsToDb)({
                        env,
                        pool: {
                            id: pool.id,
                            clubName: pool.clubName,
                            vaultAddress,
                            officialTokenPrice: pool.officialTokenPrice,
                            riskParams: pool.riskParams
                        },
                        fromBlock,
                        toBlock,
                        logger,
                        chunkSizeEnv: "POLYGON_GETLOGS_BLOCK_CHUNK",
                        logContext: {
                            chain: "polygon",
                            cursorKey,
                            poolId: pool.id
                        }
                    });
                    await (0, chainEventCursor_1.completeChainEventCursor)({ key: cursorKey, workerId, lastProcessedBlock: toBlock });
                    didAnySync = true;
                }
                catch (err) {
                    const cooldownUntil = (0, ethersLogChunks_1.isRpcRateLimitError)(err) ? (0, ethersLogChunks_1.getRpcRateLimitCooldownUntil)() : null;
                    await (0, chainEventCursor_1.failChainEventCursor)({ key: cursorKey, workerId, err, cooldownUntil });
                    const logPayload = {
                        err: (0, ethersLogChunks_1.compactRpcError)(err),
                        poolId: pool.id,
                        chain: "polygon",
                        cursorKey,
                        fromBlock,
                        toBlock,
                        cooldownUntil: cooldownUntil?.toISOString()
                    };
                    if (cooldownUntil) {
                        logger.warn(logPayload, "Vault sync rate limited; cursor cooling down");
                    }
                    else {
                        logger.error(logPayload, "Vault sync tick failed for pool");
                    }
                    if (cooldownUntil)
                        break;
                }
            }
            // Keep pool totals (totalPoolValue / officialTokenPrice) fresh for UI after deposits/withdraws.
            if (didAnySync) {
                try {
                    await (0, priceEngine_1.recalculateOfficialPrices)(env);
                }
                catch (err) {
                    logger.error({ err }, "Vault sync: price recalculation failed");
                }
            }
        }
        finally {
            isTicking = false;
        }
    }
    // Run once at startup, then interval.
    tick()
        .then(() => logger.info("Initial vault sync done"))
        .catch((err) => logger.error({ err }, "Initial vault sync failed"));
    setInterval(() => {
        tick().catch((err) => logger.error({ err }, "Vault sync tick failed"));
    }, intervalMs);
}
