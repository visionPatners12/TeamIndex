import type { Env } from "../config/env";
import { prisma } from "../db/prisma";
import { syncVaultEventsToDb } from "../onchain/poolSync";
import { recalculateOfficialPrices } from "../services/priceEngine";
import { ethers } from "ethers";

function getLastSyncedBlock(riskParams: any): number | undefined {
  const v = riskParams?.lastSyncedBlock;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
}

export function startVaultSyncTicker({ env, logger }: { env: Env; logger: ReturnType<any> }) {
  const intervalMs = Number(process.env.VAULT_SYNC_INTERVAL_MS || 60_000);

  if (!env.RPC_URL) {
    logger.warn("VAULT_SYNC skipped: RPC_URL missing");
    return;
  }

  logger.info({ intervalMs }, "Vault sync ticker started");

  const provider = new ethers.JsonRpcProvider(env.RPC_URL);

  async function tick() {
    const pools = await prisma.club_pools.findMany({ where: { status: "ACTIVE" } });
    if (pools.length === 0) return;

    const latest = await provider.getBlockNumber();

    let didAnySync = false;
    for (const pool of pools) {
      const lastSynced = getLastSyncedBlock(pool.riskParams);
      const fromBlock = lastSynced !== undefined ? lastSynced + 1 : Math.max(0, latest - 2_000);
      const toBlock = latest;

      try {
        await syncVaultEventsToDb({
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
      } catch (err: any) {
        logger.error({ err, poolId: pool.id }, "Vault sync tick failed for pool");
      }
    }

    // Keep pool totals (totalPoolValue / officialTokenPrice) fresh for UI after deposits/withdraws.
    if (didAnySync) {
      try {
        await recalculateOfficialPrices(env);
      } catch (err: any) {
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

