import type { Env } from "../config/env";
import { recalculateOfficialPrices } from "../services/priceEngine";
import { syncLimitlessFillsAndSettle } from "../limitless/limitlessPositionSync";

export function startPriceTicker({ env, logger }: { env: Env; logger: ReturnType<any> }) {
  const intervalMs = Number(process.env.PRICE_RECALC_INTERVAL_MS || 5 * 60 * 1000);
  logger.info({ intervalMs }, "Price ticker started");

  // Run once at startup.
  syncLimitlessFillsAndSettle(env)
    .catch((err) => logger.error({ err }, "Initial Limitless fill/settle sync failed"))
    .finally(() => {
      recalculateOfficialPrices(env)
        .then(() => logger.info("Initial price recalculation done"))
        .catch((err) => logger.error({ err }, "Initial price recalculation failed"));
    });

  setInterval(() => {
    syncLimitlessFillsAndSettle(env)
      .then(() => recalculateOfficialPrices(env))
      .catch((err) => logger.error({ err }, "Limitless price sync/recalculation failed"));
  }, intervalMs);
}
