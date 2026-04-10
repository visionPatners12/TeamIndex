import type { Env } from "../config/env";
import { recalculateOfficialPrices } from "../services/priceEngine";
import { syncClobFillsAndSettle } from "../services/positionSync";

export function startPriceTicker({ env, logger }: { env: Env; logger: ReturnType<any> }) {
  const intervalMs = Number(process.env.PRICE_RECALC_INTERVAL_MS || 5 * 60 * 1000);
  logger.info({ intervalMs }, "Price ticker started");

  // Run once at startup.
  syncClobFillsAndSettle(env)
    .catch((err) => logger.error({ err }, "Initial CLOB fill/settle sync failed"))
    .finally(() => {
      recalculateOfficialPrices(env)
        .then(() => logger.info("Initial price recalculation done"))
        .catch((err) => logger.error({ err }, "Initial price recalculation failed"));
    });

  setInterval(() => {
    syncClobFillsAndSettle(env)
      .then(() => recalculateOfficialPrices(env))
      .catch((err) => logger.error({ err }, "Price sync/recalculation failed"));
  }, intervalMs);
}

