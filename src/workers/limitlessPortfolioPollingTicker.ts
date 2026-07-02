import { serializeError } from "../config/log";
import type { Env } from "../config/env";
import { prisma } from "../db/prisma";
import { syncLimitlessPortfolioForPool } from "../limitless/limitlessPortfolio";
import { hasLimitlessHmacConfig } from "../limitless/limitlessAuth";

type Logger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

function envBool(value: unknown, fallback: boolean) {
  if (value === undefined || value === null || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

async function activeLimitlessPoolIds() {
  const accounts = await (prisma as any).pool_limitless_accounts.findMany({
    where: {
      pool: { status: "ACTIVE" },
      OR: [{ limitlessProfileId: { not: null } }, { accountAddress: { not: null } }],
    },
    select: { poolId: true },
    orderBy: { updatedAt: "asc" },
  }) as Array<{ poolId: string }>;
  return [...new Set(accounts.map((account) => account.poolId))];
}

export async function syncAllLimitlessPortfolios(env: Env, logger: Logger) {
  const poolIds = await activeLimitlessPoolIds();
  let synced = 0;
  let failed = 0;

  for (const poolId of poolIds) {
    try {
      await syncLimitlessPortfolioForPool(env, poolId);
      synced += 1;
    } catch (err) {
      failed += 1;
      logger.warn({ poolId, err: serializeError(err) }, "Limitless portfolio polling sync failed");
    }
  }

  logger.info({ pools: poolIds.length, synced, failed }, "Limitless portfolio polling tick completed");
  return { pools: poolIds.length, synced, failed };
}

export function startLimitlessPortfolioPollingTicker({ env, logger }: { env: Env; logger: Logger }) {
  const enabled = envBool((env as any).LIMITLESS_PORTFOLIO_POLL_ENABLED, true);
  if (!enabled) {
    logger.warn({}, "Limitless portfolio polling disabled");
    return;
  }
  if (!hasLimitlessHmacConfig(env)) {
    logger.warn({}, "Limitless portfolio polling disabled: HMAC credentials missing");
    return;
  }

  const intervalMs = Math.max(
    60_000,
    Number((env as any).LIMITLESS_PORTFOLIO_POLL_INTERVAL_MS ?? 15 * 60 * 1000)
  );
  const initialDelayMs = Math.max(
    0,
    Number((env as any).LIMITLESS_PORTFOLIO_POLL_INITIAL_DELAY_MS ?? 5_000)
  );
  let running = false;

  const tick = async () => {
    if (running) {
      logger.warn({}, "Limitless portfolio polling tick skipped: previous tick still running");
      return;
    }
    running = true;
    try {
      await syncAllLimitlessPortfolios(env, logger);
    } finally {
      running = false;
    }
  };

  setTimeout(() => {
    tick().catch((err) => logger.error({ err: serializeError(err) }, "Limitless portfolio initial polling tick failed"));
  }, initialDelayMs).unref();

  setInterval(() => {
    tick().catch((err) => logger.error({ err: serializeError(err) }, "Limitless portfolio polling tick failed"));
  }, intervalMs).unref();

  logger.info({ intervalMs, initialDelayMs }, "Limitless portfolio polling ticker started");
}
