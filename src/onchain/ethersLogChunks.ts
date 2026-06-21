import type { Contract, EventLog } from "ethers";

type LogRetryLogger = {
  warn: (obj: Record<string, unknown>, msg?: string) => void;
};

type QueryFilterInBlockChunksOptions = {
  chunkSize?: number;
  chunkSizeEnv?: string;
  minDelayMs?: number;
  maxRetries?: number;
  maxRetriesEnv?: string;
  retryBaseMs?: number;
  logger?: LogRetryLogger;
  context?: Record<string, unknown>;
};

/**
 * Alchemy free tier limits eth_getLogs to a small block window (commonly 10 blocks).
 * Chunk requests so vault sync works without PAYG.
 *
 * Override with ETH_GETLOGS_BLOCK_CHUNK (e.g. 2000 on paid RPCs).
 */
export function getLogsBlockChunkSize(overrideEnv?: string): number {
  const raw = (overrideEnv ? process.env[overrideEnv] : undefined) ?? process.env.ETH_GETLOGS_BLOCK_CHUNK;
  const n = raw ? Number(raw) : 10;
  if (!Number.isFinite(n) || n < 1) return 10;
  return Math.floor(n);
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : fallback;
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function sleep(ms: number) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(value: unknown, depth = 0): string {
  if (value === null || value === undefined || depth > 4) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return value.map((x) => errorText(x, depth + 1)).join(" ");
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return [
      errorText(obj.code, depth + 1),
      errorText(obj.message, depth + 1),
      errorText(obj.shortMessage, depth + 1),
      errorText(obj.error, depth + 1),
      errorText(obj.value, depth + 1),
      errorText(obj.info, depth + 1),
      errorText(obj.payload, depth + 1),
      errorText(obj.responseBody, depth + 1),
      errorText(obj.responseStatus, depth + 1),
      errorText(obj.requestUrl, depth + 1),
      errorText(obj.status, depth + 1),
      errorText(obj.statusCode, depth + 1)
    ].join(" ");
  }
  return "";
}

export function compactRpcError(err: unknown) {
  const e = err as any;
  return {
    code: e?.code ?? e?.error?.code,
    shortMessage: e?.shortMessage,
    message: e?.message ?? e?.error?.message
  };
}

export function isRpcRateLimitError(err: unknown): boolean {
  const text = errorText(err).toLowerCase();
  return (
    text.includes("too many requests") ||
    text.includes("rate limit") ||
    text.includes("exceeded") ||
    text.includes("429") ||
    text.includes("-32005")
  );
}

export function getRpcRateLimitCooldownUntil(): Date {
  const cooldownMs = positiveIntFromEnv("ETH_GETLOGS_COOLDOWN_MS", 60_000);
  return new Date(Date.now() + cooldownMs);
}

function normalizeOptions(options?: number | QueryFilterInBlockChunksOptions): Required<Omit<QueryFilterInBlockChunksOptions, "logger" | "context">> & Pick<QueryFilterInBlockChunksOptions, "logger" | "context"> {
  if (typeof options === "number") {
    return {
      chunkSize: Math.max(1, Math.floor(options)),
      chunkSizeEnv: "",
      minDelayMs: positiveIntFromEnv("ETH_GETLOGS_MIN_DELAY_MS", 300),
      maxRetries: positiveIntFromEnv("ETH_GETLOGS_MAX_RETRIES", 6),
      maxRetriesEnv: "",
      retryBaseMs: positiveIntFromEnv("ETH_GETLOGS_RETRY_BASE_MS", 1000)
    };
  }

  const chunkSize = options?.chunkSize ?? getLogsBlockChunkSize(options?.chunkSizeEnv);
  const maxRetries =
    options?.maxRetries ??
    (options?.maxRetriesEnv ? positiveIntFromEnv(options.maxRetriesEnv, 1) : positiveIntFromEnv("ETH_GETLOGS_MAX_RETRIES", 6));
  return {
    chunkSize: Math.max(1, Math.floor(chunkSize)),
    chunkSizeEnv: options?.chunkSizeEnv ?? "",
    minDelayMs: options?.minDelayMs ?? positiveIntFromEnv("ETH_GETLOGS_MIN_DELAY_MS", 300),
    maxRetries,
    maxRetriesEnv: options?.maxRetriesEnv ?? "",
    retryBaseMs: options?.retryBaseMs ?? positiveIntFromEnv("ETH_GETLOGS_RETRY_BASE_MS", 1000),
    logger: options?.logger,
    context: options?.context
  };
}

async function queryFilterWithRateLimitRetry(
  contract: Contract,
  filter: Parameters<Contract["queryFilter"]>[0],
  fromBlock: number,
  toBlock: number,
  options: ReturnType<typeof normalizeOptions>
): Promise<EventLog[]> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return (await contract.queryFilter(filter, fromBlock, toBlock)) as EventLog[];
    } catch (err) {
      if (!isRpcRateLimitError(err) || attempt > options.maxRetries) {
        throw err;
      }

      const exponentialMs = options.retryBaseMs * 2 ** (attempt - 1);
      const jitterMs = Math.floor(Math.random() * options.retryBaseMs);
      const delayMs = exponentialMs + jitterMs;
      options.logger?.warn(
        {
          ...(options.context ?? {}),
          fromBlock,
          toBlock,
          attempt,
          delayMs,
          err: compactRpcError(err)
        },
        "eth_getLogs rate limited; retrying"
      );
      await sleep(delayMs);
    }
  }
}

export async function queryFilterInBlockChunks(
  contract: Contract,
  filter: Parameters<Contract["queryFilter"]>[0],
  fromBlock: number,
  toBlock: number,
  chunkSizeOrOptions?: number | QueryFilterInBlockChunksOptions
): Promise<EventLog[]> {
  if (fromBlock > toBlock) return [];
  const options = normalizeOptions(chunkSizeOrOptions);
  const size = Math.max(1, options.chunkSize);
  const out: EventLog[] = [];
  let start = fromBlock;
  while (start <= toBlock) {
    const end = Math.min(start + size - 1, toBlock);
    const chunk = await queryFilterWithRateLimitRetry(contract, filter, start, end, options);
    out.push(...chunk);
    start = end + 1;
    if (start <= toBlock) {
      await sleep(options.minDelayMs);
    }
  }
  return out;
}
