"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const log_1 = require("./config/log");
const env_1 = require("./config/env");
const http_1 = require("./server/http");
const startWorker_1 = require("./workers/startWorker");
const initDb_1 = require("./db/initDb");
const priceTicker_1 = require("./workers/priceTicker");
const vaultSyncTicker_1 = require("./workers/vaultSyncTicker");
async function main() {
    const env = (0, env_1.loadEnv)();
    const logger = (0, log_1.createLogger)();
    await (0, initDb_1.initDb)();
    logger.info({ env: { NODE_ENV: env.NODE_ENV } }, "backend init");
    // HTTP API (optional)
    try {
        (0, http_1.startHttpServer)({ env, logger });
    }
    catch (err) {
        logger.error({ err }, "HTTP server crashed");
        process.exit(1);
    }
    // Worker for scheduled executions
    if (env.REDIS_URL) {
        try {
            (0, startWorker_1.startWorker)({ env, logger });
        }
        catch (err) {
            logger.error({ err }, "Worker crashed");
            process.exit(1);
        }
    }
    else {
        logger.warn("Redis/queue disabled: REDIS_URL missing");
    }
    try {
        (0, priceTicker_1.startPriceTicker)({ env, logger });
    }
    catch (err) {
        logger.error({ err }, "Price ticker crashed");
    }
    try {
        (0, vaultSyncTicker_1.startVaultSyncTicker)({ env, logger });
    }
    catch (err) {
        logger.error({ err }, "Vault sync ticker crashed");
    }
}
// Prevent unhandled promise rejections (e.g. RPC rate limits) from crashing the process
process.on("unhandledRejection", (reason) => {
    console.error("[unhandledRejection]", reason);
});
main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
});
