"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseRpcError = void 0;
exports.getBaseRpcUrls = getBaseRpcUrls;
exports.getBaseProvider = getBaseProvider;
exports.isBaseRpcRateLimitError = isBaseRpcRateLimitError;
exports.isBaseRpcUnavailableError = isBaseRpcUnavailableError;
exports.withBaseRpcRetry = withBaseRpcRetry;
exports.getBaseBlockNumber = getBaseBlockNumber;
exports.getBaseTransactionReceipt = getBaseTransactionReceipt;
const ethers_1 = require("ethers");
const ethersLogChunks_1 = require("./ethersLogChunks");
const PUBLIC_BASE_RPC_URL = "https://mainnet.base.org";
const providerCache = new Map();
class BaseRpcError extends Error {
    code;
    details;
    constructor(code, message, cause) {
        super(message);
        this.name = "BaseRpcError";
        this.code = code;
        this.cause = cause;
        this.details = cause ? (0, ethersLogChunks_1.compactRpcError)(cause) : undefined;
    }
}
exports.BaseRpcError = BaseRpcError;
function sleep(ms) {
    if (ms <= 0)
        return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function positiveIntFromEnv(name, fallback) {
    const raw = process.env[name];
    const n = raw ? Number(raw) : fallback;
    if (!Number.isFinite(n) || n < 0)
        return fallback;
    return Math.floor(n);
}
function splitRpcUrls(raw) {
    return (raw ?? "")
        .split(",")
        .map((url) => url.trim())
        .filter(Boolean);
}
function getBaseRpcUrls(env) {
    const urls = [
        ...splitRpcUrls(env.BASE_RPC_URL),
        ...splitRpcUrls(env.BASE_RPC_FALLBACK_URLS),
        PUBLIC_BASE_RPC_URL,
    ];
    return Array.from(new Set(urls));
}
function getBaseProvider(env, rpcUrl) {
    const url = rpcUrl ?? getBaseRpcUrls(env)[0];
    if (!url)
        throw new BaseRpcError("RPC_UNAVAILABLE", "No Base RPC URL configured");
    const cached = providerCache.get(url);
    if (cached)
        return cached;
    const provider = new ethers_1.ethers.JsonRpcProvider(url, undefined, { batchMaxCount: 1 });
    providerCache.set(url, provider);
    return provider;
}
function isBaseRpcRateLimitError(err) {
    return err instanceof BaseRpcError
        ? err.code === "RPC_RATE_LIMITED"
        : (0, ethersLogChunks_1.isRpcRateLimitError)(err);
}
function isBaseRpcUnavailableError(err) {
    return err instanceof BaseRpcError && err.code === "RPC_UNAVAILABLE";
}
async function withBaseRpcRetry(env, operation, options) {
    const urls = getBaseRpcUrls(env);
    if (urls.length === 0)
        throw new BaseRpcError("RPC_UNAVAILABLE", "No Base RPC URL configured");
    const maxRetriesPerUrl = options?.maxRetriesPerUrl ?? positiveIntFromEnv("BASE_RPC_MAX_RETRIES", 2);
    const retryBaseMs = options?.retryBaseMs ?? positiveIntFromEnv("BASE_RPC_RETRY_BASE_MS", 500);
    let lastErr;
    let sawRateLimit = false;
    for (const url of urls) {
        for (let attempt = 0; attempt <= maxRetriesPerUrl; attempt += 1) {
            try {
                return await operation(getBaseProvider(env, url), url);
            }
            catch (err) {
                lastErr = err;
                const rateLimited = (0, ethersLogChunks_1.isRpcRateLimitError)(err);
                sawRateLimit = sawRateLimit || rateLimited;
                if (!rateLimited)
                    break;
                if (attempt >= maxRetriesPerUrl)
                    break;
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
function getBaseBlockNumber(env) {
    return withBaseRpcRetry(env, (provider) => provider.getBlockNumber());
}
function getBaseTransactionReceipt(env, txHash) {
    return withBaseRpcRetry(env, (provider) => provider.getTransactionReceipt(txHash));
}
