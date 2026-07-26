"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const log_1 = require("./config/log");
const env_1 = require("./config/env");
const http_1 = require("./server/http");
const initDb_1 = require("./db/initDb");
const polymarketV2Ticker_1 = require("./workers/polymarketV2Ticker");
const polymarketPoolWs_1 = require("./workers/polymarketPoolWs");
async function main() {
    const env = (0, env_1.loadEnv)();
    const logger = (0, log_1.createLogger)();
    await (0, initDb_1.initDb)();
    logger.info({ env: { NODE_ENV: env.NODE_ENV, tradingProvider: env.TRADING_PROVIDER, processRole: env.PROCESS_ROLE } }, "backend init");
    if (env.TRADING_PROVIDER !== "polymarket") {
        throw new Error("No active trading provider: Limitless is legacy-disabled and Polymarket is required");
    }
    if (["all", "api", "signer"].includes(env.PROCESS_ROLE)) {
        try {
            (0, http_1.startHttpServer)({ env, logger });
        }
        catch (err) {
            logger.error({ err }, "HTTP server crashed");
            process.exit(1);
        }
    }
    if (["all", "executor"].includes(env.PROCESS_ROLE)) {
        (0, polymarketV2Ticker_1.startPolymarketExecutorTicker)(env, logger);
    }
    if (["all", "accounting"].includes(env.PROCESS_ROLE)) {
        (0, polymarketV2Ticker_1.startPolymarketAccountingTicker)(env, logger);
    }
    if (["all", "pool-ws"].includes(env.PROCESS_ROLE)) {
        (0, polymarketPoolWs_1.startPolymarketPoolWs)(env, logger);
    }
    logger.info("Limitless workers are legacy-disabled; no Limitless runtime was started");
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
