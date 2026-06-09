import { createLogger } from "./config/log";
import { loadEnv } from "./config/env";
import { startHttpServer } from "./server/http";
import { startWorker } from "./workers/startWorker";
import { initDb } from "./db/initDb";
import { startPriceTicker } from "./workers/priceTicker";
import { startVaultSyncTicker } from "./workers/vaultSyncTicker";

async function main() {
  const env = loadEnv();
  const logger = createLogger();

  await initDb();
  logger.info({ env: { NODE_ENV: env.NODE_ENV } }, "backend init");

  // HTTP API (optional)
  try {
    startHttpServer({ env, logger });
  } catch (err: any) {
    logger.error({ err }, "HTTP server crashed");
    process.exit(1);
  }

  // Worker for scheduled executions
  if (env.REDIS_URL) {
    try {
      startWorker({ env, logger });
    } catch (err: any) {
      logger.error({ err }, "Worker crashed");
      process.exit(1);
    }
  } else {
    logger.warn("Redis/queue disabled: REDIS_URL missing");
  }

  try {
    startPriceTicker({ env, logger });
  } catch (err: any) {
    logger.error({ err }, "Price ticker crashed");
  }

  try {
    startVaultSyncTicker({ env, logger });
  } catch (err: any) {
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
