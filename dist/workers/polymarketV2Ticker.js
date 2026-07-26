"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startPolymarketExecutorTicker = startPolymarketExecutorTicker;
exports.startPolymarketAccountingTicker = startPolymarketAccountingTicker;
const prisma_1 = require("../db/prisma");
const tradeExecutor_1 = require("../polymarket/tradeExecutor");
const accountingService_1 = require("../polymarket/accountingService");
const constants_1 = require("../polymarket/constants");
function interval(raw, fallback) {
    const value = Number(raw);
    return Number.isFinite(value) && value >= 1_000 ? value : fallback;
}
async function acquireLease(key, owner, ttlMs) {
    const expiresAt = new Date(Date.now() + ttlMs);
    const affected = await prisma_1.prisma.$executeRaw `
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
function startPolymarketExecutorTicker(env, logger) {
    if (!constants_1.POLYMARKET_VAULT_DIRECT_CAPABILITY.canTrade) {
        logger.warn({ capability: constants_1.POLYMARKET_VAULT_DIRECT_CAPABILITY }, "Polymarket executor disabled; vault-direct CLOB trading is not supported");
        return () => undefined;
    }
    const owner = `executor:${process.pid}:${Math.random().toString(36).slice(2)}`;
    const everyMs = interval(env.POLYMARKET_EXECUTOR_INTERVAL_MS, 5_000);
    let running = false;
    const tick = async () => {
        if (running)
            return;
        running = true;
        try {
            if (!(await acquireLease("polymarket:executor", owner, everyMs * 3)))
                return;
            const result = await (0, tradeExecutor_1.executeNextTradeIntent)(env, owner);
            if (result)
                logger.info({ result }, "Polymarket V2 trade intent executed");
        }
        catch (error) {
            logger.error({ err: error }, "Polymarket V2 executor tick failed");
        }
        finally {
            running = false;
        }
    };
    void tick();
    const timer = setInterval(() => void tick(), everyMs);
    return () => clearInterval(timer);
}
function startPolymarketAccountingTicker(env, logger) {
    const owner = `accounting:${process.pid}:${Math.random().toString(36).slice(2)}`;
    const everyMs = interval(env.POLYMARKET_ACCOUNTING_INTERVAL_MS, 60_000);
    let running = false;
    const tick = async () => {
        if (running)
            return;
        running = true;
        try {
            if (!(await acquireLease("polymarket:accounting", owner, everyMs * 3)))
                return;
            const accounts = await prisma_1.prisma.pool_polymarket_accounts.findMany({
                where: { status: "READY" },
                select: { poolId: true },
            });
            for (const account of accounts) {
                try {
                    const result = await (0, accountingService_1.reconcileAndValuePool)(env, account.poolId);
                    logger.info({ poolId: account.poolId, result }, "Polymarket V2 pool reconciled and valued");
                }
                catch (error) {
                    logger.error({ poolId: account.poolId, err: error }, "Polymarket V2 accounting failed for pool");
                }
            }
        }
        catch (error) {
            logger.error({ err: error }, "Polymarket V2 accounting tick failed");
        }
        finally {
            running = false;
        }
    };
    void tick();
    const timer = setInterval(() => void tick(), everyMs);
    return () => clearInterval(timer);
}
