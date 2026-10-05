import { createLogger } from "./config/log";
import { loadEnv } from "./config/env";
import { startHttpServer } from "./server/http";
import { initDb } from "./db/initDb";
import {
  startPolymarketAccountingTicker,
  startPolymarketExecutorTicker,
} from "./workers/polymarketV2Ticker";
import { startPolymarketPoolWs } from "./workers/polymarketPoolWs";
import { startPolymarketMarketWs } from "./workers/polymarketMarketWs";

async function main() {
  const env = loadEnv();
  const logger = createLogger();

  await initDb();
  logger.info(
    { env: { NODE_ENV: env.NODE_ENV, tradingProvider: env.TRADING_PROVIDER, processRole: env.PROCESS_ROLE } },
    "backend init",
  );

  if (env.TRADING_PROVIDER !== "polymarket") {
    throw new Error("No active trading provider: Limitless is legacy-disabled and Polymarket is required");
  }

  if (["all", "api", "signer"].includes(env.PROCESS_ROLE)) {
    try {
      startHttpServer({ env, logger });
    } catch (err: any) {
      logger.error({ err }, "HTTP server crashed");
      process.exit(1);
    }
  }

  if (["all", "executor"].includes(env.PROCESS_ROLE)) {
    startPolymarketExecutorTicker(env, logger);
  }

  if (["all", "accounting"].includes(env.PROCESS_ROLE)) {
    startPolymarketAccountingTicker(env, logger);
  }

  if (["all", "pool-ws"].includes(env.PROCESS_ROLE)) {
    startPolymarketPoolWs(env, logger);
  }
  if (["all", "market-ws"].includes(env.PROCESS_ROLE)) {
    startPolymarketMarketWs(env, logger);
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
