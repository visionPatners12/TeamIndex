"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startPriceTicker = startPriceTicker;
const priceEngine_1 = require("../services/priceEngine");
const limitlessPositionSync_1 = require("../limitless/limitlessPositionSync");
function startPriceTicker({ env, logger }) {
    const intervalMs = Number(process.env.PRICE_RECALC_INTERVAL_MS || 5 * 60 * 1000);
    logger.info({ intervalMs }, "Price ticker started");
    // Run once at startup.
    (0, limitlessPositionSync_1.syncLimitlessFillsAndSettle)(env)
        .catch((err) => logger.error({ err }, "Initial Limitless fill/settle sync failed"))
        .finally(() => {
        (0, priceEngine_1.recalculateOfficialPrices)(env)
            .then(() => logger.info("Initial price recalculation done"))
            .catch((err) => logger.error({ err }, "Initial price recalculation failed"));
    });
    setInterval(() => {
        (0, limitlessPositionSync_1.syncLimitlessFillsAndSettle)(env)
            .then(() => (0, priceEngine_1.recalculateOfficialPrices)(env))
            .catch((err) => logger.error({ err }, "Limitless price sync/recalculation failed"));
    }, intervalMs);
}
