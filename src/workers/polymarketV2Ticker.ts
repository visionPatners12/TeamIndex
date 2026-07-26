import type { Env } from "../config/env";
import type { createLogger } from "../config/log";
import { prisma } from "../db/prisma";
import { executeNextTradeIntent } from "../polymarket/tradeExecutor";
import { reconcileAndValuePool } from "../polymarket/accountingService";
import { POLYMARKET_VAULT_DIRECT_CAPABILITY } from "../polymarket/constants";

type Logger = ReturnType<typeof createLogger>;

function interval(raw: string, fallback: number) {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1_000 ? value : fallback;
}

async function acquireLease(key: string, owner: string, ttlMs: number) {
  const expiresAt = new Date(Date.now() + ttlMs);
  const affected = await prisma.$executeRaw`
    INSERT INTO "pool_worker_leases" ("key", "owner", "expiresAt", "heartbeatAt", "createdAt", "updatedAt")
    VALUES (${key}, ${owner}, ${expiresAt}, NOW(), NOW(), NOW())
    ON CONFLICT ("key") DO UPDATE SET
      "owner" = EXCLUDED."owner",
      "expiresAt" = EXCLUDED."expiresAt",
      "heartbeatAt" = NOW(),
      "updatedAt" = NOW()
    WHERE "pool_worker_leases"."expiresAt" < NOW() OR "pool_worker_leases"."owner" = ${owner}
  `;
  return affected > 0;
}

export function startPolymarketExecutorTicker(env: Env, logger: Logger) {
  if (!POLYMARKET_VAULT_DIRECT_CAPABILITY.canTrade) {
    logger.warn(
      { capability: POLYMARKET_VAULT_DIRECT_CAPABILITY },
      "Polymarket executor disabled; vault-direct CLOB trading is not supported",
    );
    return () => undefined;
  }
  const owner = `executor:${process.pid}:${Math.random().toString(36).slice(2)}`;
  const everyMs = interval(env.POLYMARKET_EXECUTOR_INTERVAL_MS, 5_000);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      if (!(await acquireLease("polymarket:executor", owner, everyMs * 3))) return;
      const result = await executeNextTradeIntent(env, owner);
      if (result) logger.info({ result }, "Polymarket V2 trade intent executed");
    } catch (error) {
      logger.error({ err: error }, "Polymarket V2 executor tick failed");
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), everyMs);
  return () => clearInterval(timer);
}

export function startPolymarketAccountingTicker(env: Env, logger: Logger) {
  const owner = `accounting:${process.pid}:${Math.random().toString(36).slice(2)}`;
  const everyMs = interval(env.POLYMARKET_ACCOUNTING_INTERVAL_MS, 60_000);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      if (!(await acquireLease("polymarket:accounting", owner, everyMs * 3))) return;
      const accounts = await prisma.pool_polymarket_accounts.findMany({
        where: { status: "READY" },
        select: { poolId: true },
      });
      for (const account of accounts) {
        try {
          const result = await reconcileAndValuePool(env, account.poolId);
          logger.info({ poolId: account.poolId, result }, "Polymarket V2 pool reconciled and valued");
        } catch (error) {
          logger.error({ poolId: account.poolId, err: error }, "Polymarket V2 accounting failed for pool");
        }
      }
    } catch (error) {
      logger.error({ err: error }, "Polymarket V2 accounting tick failed");
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), everyMs);
  return () => clearInterval(timer);
}
