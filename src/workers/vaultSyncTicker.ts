import type { Env } from "../config/env";
import { prisma } from "../db/prisma";
import {
  compactRpcError,
  getLogsBlockChunkSize,
  getRpcRateLimitCooldownUntil,
  isRpcRateLimitError
} from "../onchain/ethersLogChunks";
import { syncVaultEventsToDb } from "../onchain/poolSync";
import { getBaseBlockNumber, getBaseRpcUrls, withBaseRpcRetry } from "../onchain/rpc";
import { getVaultContract } from "../onchain/vaultExecutor";
import { recalculateOfficialPrices } from "../services/priceEngine";
import {
  claimChainEventCursor,
  completeChainEventCursor,
  cursorBlockNumber,
  failChainEventCursor,
  makeCursorWorkerId
} from "./chainEventCursor";

function getLastSyncedBlock(riskParams: any): number | undefined {
  const v = riskParams?.lastSyncedBlock;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const n = Number(process.env[name] || fallback);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

function booleanFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

function nonNegativeIntFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}

export function startVaultSyncTicker({ env, logger }: { env: Env; logger: ReturnType<any> }) {
  if (!booleanFromEnv("VAULT_SYNC_ENABLED", String((env as any).VAULT_SYNC_ENABLED ?? "true") !== "false")) {
    logger.warn("Vault sync ticker disabled by VAULT_SYNC_ENABLED=false");
    return;
  }

  const intervalMs = Number(process.env.VAULT_SYNC_INTERVAL_MS || 60_000);
  const configuredStartBlock = nonNegativeIntFromEnv("VAULT_SYNC_START_BLOCK");
  const maxBlocksPerTick = positiveIntFromEnv("VAULT_SYNC_MAX_BLOCKS_PER_TICK", 100);
  const maxLogRequestsPerTick = positiveIntFromEnv("VAULT_SYNC_MAX_LOG_REQUESTS_PER_TICK", 40);
  const poolsPerTick = positiveIntFromEnv("VAULT_SYNC_POOLS_PER_TICK", 1);
  const logChunkSize = getLogsBlockChunkSize("BASE_GETLOGS_BLOCK_CHUNK");
  const eventLogFiltersPerSync = 4;
  const maxBlocksByRpcBudget = Math.max(
    1,
    Math.floor(maxLogRequestsPerTick / eventLogFiltersPerSync) * logChunkSize
  );
  const effectiveMaxBlocksPerTick = Math.min(maxBlocksPerTick, maxBlocksByRpcBudget);
  const estimatedLogRequestsPerPool = eventLogFiltersPerSync * Math.ceil(effectiveMaxBlocksPerTick / logChunkSize);

  if (getBaseRpcUrls(env).length === 0) {
    logger.warn("VAULT_SYNC skipped: RPC_URL missing");
    return;
  }

  logger.info(
    {
      intervalMs,
      maxBlocksPerTick,
      effectiveMaxBlocksPerTick,
      poolsPerTick,
      logChunkSize,
      maxLogRequestsPerTick,
      estimatedLogRequestsPerPool,
    },
    "Vault sync ticker started"
  );

  let isTicking = false;

  async function tick() {
    if (isTicking) {
      logger.warn("Vault sync tick skipped: previous tick still running");
      return;
    }
    isTicking = true;
    try {
      const pools = await prisma.club_pools.findMany({ where: { status: "ACTIVE" }, orderBy: { updatedAt: "asc" } });
      if (pools.length === 0) return;

      const latest = await getBaseBlockNumber(env);

      let didAnySync = false;
      let claimedPools = 0;
      for (const pool of pools) {
        if (claimedPools >= poolsPerTick) break;

        let vaultAddress = pool.vaultAddress ?? undefined;
        if (!vaultAddress) {
          try {
            const vault = await withBaseRpcRetry(env, (provider) =>
              getVaultContract(env, provider as any, {
                clubName: pool.clubName,
                vaultAddress: undefined
              })
            );
            vaultAddress = ((vault as any).target ?? (vault as any).address) as string;
          } catch (err: any) {
            logger.warn({ err: compactRpcError(err), poolId: pool.id }, "Vault sync skipped: vault address could not be resolved");
            continue;
          }
        }

        const cursorKey = `polygon:${vaultAddress.toLowerCase()}:VaultEvents:${pool.id}`;
        const lastSynced = getLastSyncedBlock(pool.riskParams);
        const startBlock = lastSynced ?? configuredStartBlock ?? Math.max(0, latest - 2_001);
        const workerId = makeCursorWorkerId("vault-sync");
        const cursor = await claimChainEventCursor(
          {
            key: cursorKey,
            chain: "polygon",
            contractAddress: vaultAddress,
            eventName: "VaultEvents",
            startBlock
          },
          workerId
        );
        if (!cursor) continue;

        claimedPools += 1;
        const cursorBlock = cursorBlockNumber(cursor);
        const lastProcessedBlock = Math.max(cursorBlock, lastSynced ?? 0);
        if (latest <= lastProcessedBlock) {
          await completeChainEventCursor({ key: cursorKey, workerId, lastProcessedBlock });
          continue;
        }

        const fromBlock = lastProcessedBlock + 1;
        const toBlock = Math.min(latest, lastProcessedBlock + effectiveMaxBlocksPerTick);

        try {
          await syncVaultEventsToDb({
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
            chunkSizeEnv: "BASE_GETLOGS_BLOCK_CHUNK",
            logContext: {
              chain: "polygon",
              cursorKey,
              poolId: pool.id
            }
          });
          await completeChainEventCursor({ key: cursorKey, workerId, lastProcessedBlock: toBlock });
          didAnySync = true;
        } catch (err: any) {
          const cooldownUntil = isRpcRateLimitError(err) ? getRpcRateLimitCooldownUntil() : null;
          await failChainEventCursor({ key: cursorKey, workerId, err, cooldownUntil });
          const logPayload = {
            err: compactRpcError(err),
            poolId: pool.id,
            chain: "polygon",
            cursorKey,
            fromBlock,
            toBlock,
            cooldownUntil: cooldownUntil?.toISOString()
          };
          if (cooldownUntil) {
            logger.warn(logPayload, "Vault sync rate limited; cursor cooling down");
          } else {
            logger.error(logPayload, "Vault sync tick failed for pool");
          }
          if (cooldownUntil) break;
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
    } finally {
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
