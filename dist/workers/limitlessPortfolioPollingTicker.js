"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncAllLimitlessPortfolios = syncAllLimitlessPortfolios;
exports.startLimitlessPortfolioPollingTicker = startLimitlessPortfolioPollingTicker;
const log_1 = require("../config/log");
const prisma_1 = require("../db/prisma");
const limitlessPortfolio_1 = require("../limitless/limitlessPortfolio");
const limitlessAuth_1 = require("../limitless/limitlessAuth");
function envBool(value, fallback) {
    if (value === undefined || value === null || value === "")
        return fallback;
    return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}
async function activeLimitlessPoolIds() {
    const accounts = await prisma_1.prisma.pool_limitless_accounts.findMany({
        where: {
            pool: { status: "ACTIVE" },
            OR: [{ limitlessProfileId: { not: null } }, { accountAddress: { not: null } }],
        },
        select: { poolId: true },
        orderBy: { updatedAt: "asc" },
    });
    return [...new Set(accounts.map((account) => account.poolId))];
}
async function syncAllLimitlessPortfolios(env, logger) {
    const poolIds = await activeLimitlessPoolIds();
    let synced = 0;
    let failed = 0;
    for (const poolId of poolIds) {
        try {
            await (0, limitlessPortfolio_1.syncLimitlessPortfolioForPool)(env, poolId);
            synced += 1;
        }
        catch (err) {
            failed += 1;
            logger.warn({ poolId, err: (0, log_1.serializeError)(err) }, "Limitless portfolio polling sync failed");
        }
    }
    logger.info({ pools: poolIds.length, synced, failed }, "Limitless portfolio polling tick completed");
    return { pools: poolIds.length, synced, failed };
}
function startLimitlessPortfolioPollingTicker({ env, logger }) {
    const enabled = envBool(env.LIMITLESS_PORTFOLIO_POLL_ENABLED, true);
    if (!enabled) {
        logger.warn({}, "Limitless portfolio polling disabled");
        return;
    }
    if (!(0, limitlessAuth_1.hasLimitlessHmacConfig)(env)) {
        logger.warn({}, "Limitless portfolio polling disabled: HMAC credentials missing");
        return;
    }
    const intervalMs = Math.max(60_000, Number(env.LIMITLESS_PORTFOLIO_POLL_INTERVAL_MS ?? 15 * 60 * 1000));
    const initialDelayMs = Math.max(0, Number(env.LIMITLESS_PORTFOLIO_POLL_INITIAL_DELAY_MS ?? 5_000));
    let running = false;
    const tick = async () => {
        if (running) {
            logger.warn({}, "Limitless portfolio polling tick skipped: previous tick still running");
            return;
        }
        running = true;
        try {
            await syncAllLimitlessPortfolios(env, logger);
        }
        finally {
            running = false;
        }
    };
    setTimeout(() => {
        tick().catch((err) => logger.error({ err: (0, log_1.serializeError)(err) }, "Limitless portfolio initial polling tick failed"));
    }, initialDelayMs).unref();
    setInterval(() => {
        tick().catch((err) => logger.error({ err: (0, log_1.serializeError)(err) }, "Limitless portfolio polling tick failed"));
    }, intervalMs).unref();
    logger.info({ intervalMs, initialDelayMs }, "Limitless portfolio polling ticker started");
}
