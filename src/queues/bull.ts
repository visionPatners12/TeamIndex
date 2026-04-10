import { Queue, Worker, Job } from "bullmq";
import IORedis from "ioredis";
import type { Env } from "../config/env";

export const QUEUE_NAMES = {
  MATCH_EXECUTION: "match_execution"
} as const;

export function buildConnection(env: Env) {
  if (!env.REDIS_URL) {
    throw new Error("REDIS_URL missing. Set Railway Redis URL or disable worker by leaving REDIS_URL empty.");
  }
  // BullMQ requires `maxRetriesPerRequest` to be `null` for blocking clients.
  // ioredis defaults can vary by version, so set explicitly.
  return new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null } as any);
}

export function buildQueue(env: Env) {
  const connection = buildConnection(env);
  // `ioredis` can be installed as a transitive dependency via `bullmq`,
  // causing TS type mismatch across versions. Cast to avoid compile-time friction.
  return new Queue(QUEUE_NAMES.MATCH_EXECUTION, { connection: connection as any });
}

export type MatchExecutionJobData = {
  poolId: string;
  candidateId: string;
  tranche: number;
  expectedExecutionTimeMs: number;
};

export type MatchExecutionJob = Job<MatchExecutionJobData, any, string>;

export async function addMatchExecutionJob(
  env: Env,
  data: MatchExecutionJobData,
  runAt: Date
) {
  const queue = buildQueue(env);
  const delayMs = Math.max(0, runAt.getTime() - Date.now());
  await queue.add(
    "execute",
    data,
    {
      delay: delayMs
    }
  );
  await queue.close();
}

