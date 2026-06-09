import { Worker } from "bullmq";
import type { Env } from "../config/env";
import { QUEUE_NAMES, buildConnection } from "../queues/bull";
import { executeLimitlessTranche } from "../limitless/limitlessExecutor";

export function startWorker({ env, logger }: { env: Env; logger: ReturnType<any> }) {
  const concurrency = Number(env.QUEUE_CONCURRENCY || 1);
  const connection = buildConnection(env);

  const worker = new Worker(
    QUEUE_NAMES.MATCH_EXECUTION,
    async (job) => {
      const { queueId, poolId, candidateId, tranche } = job.data as any;
      logger.info({ queueId, poolId, candidateId, tranche }, "execute job start");

      try {
        await executeLimitlessTranche({ env, queueId, poolId, candidateId, tranche, expectedExecutionTimeMs: (job.data as any).expectedExecutionTimeMs });
        logger.info({ queueId, poolId, candidateId, tranche }, "execute job done");
      } catch (err: any) {
        await job.discard();
        await (async () => {
          const { prisma } = await import("../db/prisma");
          await prisma.club_match_queue.updateMany({
            where: queueId
              ? { id: queueId, status: "PROCESSING" }
              : { poolId, candidateId, tranche, status: "PROCESSING" },
            data: { status: "FAILED", lastError: String(err?.message ?? err) }
          });
        })();
        throw err;
      }
    },
    {
      concurrency,
      connection: connection as any
    }
  );

  logger.info({ concurrency }, "BullMQ worker started");
  return worker;
}
