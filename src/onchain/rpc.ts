import { ethers } from "ethers";
import type { Env } from "../config/env";
import { compactRpcError, isRpcRateLimitError } from "./ethersLogChunks";

const PUBLIC_BASE_RPC_URL = "https://mainnet.base.org";

const providerCache = new Map<string, ethers.JsonRpcProvider>();

export type BaseRpcErrorCode = "RPC_RATE_LIMITED" | "RPC_UNAVAILABLE";

export class BaseRpcError extends Error {
  code: BaseRpcErrorCode;
  details?: ReturnType<typeof compactRpcError>;

  constructor(code: BaseRpcErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "BaseRpcError";
    this.code = code;
    this.cause = cause;
    this.details = cause ? compactRpcError(cause) : undefined;
  }
}

function sleep(ms: number) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : fallback;
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function splitRpcUrls(raw?: string) {
  return (raw ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
}

export function getBaseRpcUrls(env: Env) {
  const urls = [
    ...splitRpcUrls(env.BASE_RPC_URL),
    ...splitRpcUrls(env.BASE_RPC_FALLBACK_URLS),
    PUBLIC_BASE_RPC_URL,
  ];
  return Array.from(new Set(urls));
}

export function getBaseProvider(env: Env, rpcUrl?: string) {
  const url = rpcUrl ?? getBaseRpcUrls(env)[0];
  if (!url) throw new BaseRpcError("RPC_UNAVAILABLE", "No Base RPC URL configured");

  const cached = providerCache.get(url);
  if (cached) return cached;

  const provider = new ethers.JsonRpcProvider(url, undefined, { batchMaxCount: 1 });
  providerCache.set(url, provider);
  return provider;
}

export function isBaseRpcRateLimitError(err: unknown) {
  return err instanceof BaseRpcError
    ? err.code === "RPC_RATE_LIMITED"
    : isRpcRateLimitError(err);
}

export function isBaseRpcUnavailableError(err: unknown) {
  return err instanceof BaseRpcError && err.code === "RPC_UNAVAILABLE";
}

type BaseRpcRetryOptions = {
  maxRetriesPerUrl?: number;
  retryBaseMs?: number;
};

export async function withBaseRpcRetry<T>(
  env: Env,
  operation: (provider: ethers.JsonRpcProvider, rpcUrl: string) => Promise<T>,
  options?: BaseRpcRetryOptions
): Promise<T> {
  const urls = getBaseRpcUrls(env);
  if (urls.length === 0) throw new BaseRpcError("RPC_UNAVAILABLE", "No Base RPC URL configured");

  const maxRetriesPerUrl = options?.maxRetriesPerUrl ?? positiveIntFromEnv("BASE_RPC_MAX_RETRIES", 2);
  const retryBaseMs = options?.retryBaseMs ?? positiveIntFromEnv("BASE_RPC_RETRY_BASE_MS", 500);
  let lastErr: unknown;
  let sawRateLimit = false;

  for (const url of urls) {
    for (let attempt = 0; attempt <= maxRetriesPerUrl; attempt += 1) {
      try {
        return await operation(getBaseProvider(env, url), url);
      } catch (err) {
        lastErr = err;
        const rateLimited = isRpcRateLimitError(err);
        sawRateLimit = sawRateLimit || rateLimited;

        if (!rateLimited) break;
        if (attempt >= maxRetriesPerUrl) break;

        const jitterMs = Math.floor(Math.random() * retryBaseMs);
        await sleep(retryBaseMs * 2 ** attempt + jitterMs);
      }
    }
  }

  if (sawRateLimit) {
    throw new BaseRpcError("RPC_RATE_LIMITED", "Base RPC rate limited", lastErr);
  }
  throw new BaseRpcError("RPC_UNAVAILABLE", "Base RPC unavailable", lastErr);
}

export function getBaseBlockNumber(env: Env) {
  return withBaseRpcRetry(env, (provider) => provider.getBlockNumber());
}

export function getBaseTransactionReceipt(env: Env, txHash: string) {
  return withBaseRpcRetry(env, (provider) => provider.getTransactionReceipt(txHash));
}
