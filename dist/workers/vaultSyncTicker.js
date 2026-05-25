"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startVaultSyncTicker = startVaultSyncTicker;
const prisma_1 = require("../db/prisma");
const poolSync_1 = require("../onchain/poolSync");
const priceEngine_1 = require("../services/priceEngine");
const ethers_1 = require("ethers");
function getLastSyncedBlock(riskParams) {
    const v = riskParams?.lastSyncedBlock;
    if (typeof v === "number" && Number.isFinite(v))
        return v;
    return undefined;
}
function startVaultSyncTicker({ env, logger }) {
    const intervalMs = Number(process.env.VAULT_SYNC_INTERVAL_MS || 60_000);
    if (!env.RPC_URL) {
        logger.warn("VAULT_SYNC skipped: RPC_URL missing");
        return;
    }
    logger.info({ intervalMs }, "Vault sync ticker started");
    const provider = new ethers_1.ethers.JsonRpcProvider(env.RPC_URL);
    async function tick() {
        const pools = await prisma_1.prisma.club_pools.findMany({ where: { status: "ACTIVE" } });
        if (pools.length === 0)
            return;
        const latest = await provider.getBlockNumber();
        let didAnySync = false;
        for (const pool of pools) {
            const lastSynced = getLastSyncedBlock(pool.riskParams);
            const fromBlock = lastSynced !== undefined ? lastSynced + 1 : Math.max(0, latest - 2_000);
            const toBlock = latest;
            try {
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
                didAnySync = true;
            }
            catch (err) {
                logger.error({ err, poolId: pool.id }, "Vault sync tick failed for pool");
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
    // Run once at startup, then interval.
    tick()
        .then(() => logger.info("Initial vault sync done"))
        .catch((err) => logger.error({ err }, "Initial vault sync failed"));
    setInterval(() => {
        tick().catch((err) => logger.error({ err }, "Vault sync tick failed"));
    }, intervalMs);
}
