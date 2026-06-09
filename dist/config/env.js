"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadEnv = loadEnv;
const zod_1 = require("zod");
const EnvSchema = zod_1.z.object({
    NODE_ENV: zod_1.z.string().optional().default("development"),
    DATABASE_URL: zod_1.z.string().min(1),
    ADMIN_API_KEY: zod_1.z.string().optional(),
    // ─── Base chain (primary chain — everything runs here) ───────────────────
    BASE_RPC_URL: zod_1.z.string().optional(),
    // EOA executor wallet on Base: signs vault admin txs + Limitless EIP-712 orders
    BASE_EXECUTOR_PRIVATE_KEY: zod_1.z.string().optional(),
    // USDC contract address on Base (default: Base mainnet USDC)
    BASE_USDC_ADDRESS: zod_1.z.string().optional().default("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
    // ─── Vault contracts (deployed on Base) ──────────────────────────────────
    VAULT_CONTRACT_ADDRESS: zod_1.z.string().optional(),
    // Optional: factory resolves per-club vault → vaultFactory.getVaultByClub(keccak256(clubName))
    CLUB_VAULT_FACTORY_ADDRESS: zod_1.z.string().optional(),
    // ─── Onchain event sync (Base) ────────────────────────────────────────────
    ETH_GETLOGS_BLOCK_CHUNK: zod_1.z.string().optional().default("10"),
    ETH_GETLOGS_MIN_DELAY_MS: zod_1.z.string().optional().default("300"),
    ETH_GETLOGS_MAX_RETRIES: zod_1.z.string().optional().default("6"),
    ETH_GETLOGS_RETRY_BASE_MS: zod_1.z.string().optional().default("1000"),
    ETH_GETLOGS_COOLDOWN_MS: zod_1.z.string().optional().default("60000"),
    CHAIN_EVENT_CURSOR_LOCK_STALE_MS: zod_1.z.string().optional().default("120000"),
    BASE_GETLOGS_BLOCK_CHUNK: zod_1.z.string().optional().default("10"),
    VAULT_SYNC_MAX_BLOCKS_PER_TICK: zod_1.z.string().optional().default("100"),
    VAULT_SYNC_POOLS_PER_TICK: zod_1.z.string().optional().default("1"),
    // ─── Limitless Exchange (market data + trading, Base chain) ──────────────
    LIMITLESS_BASE_URL: zod_1.z.string().optional().default("https://api.limitless.exchange"),
    // REST auth header — created at limitless.exchange → Profile → API keys
    LIMITLESS_API_KEY: zod_1.z.string().optional(),
    // Fee rate in bps (Bronze=200, Silver=150, Gold=100, Diamond=50)
    LIMITLESS_FEE_RATE_BPS: zod_1.z.string().optional().default("200"),
    // chainId for EIP-712 signing (8453 = Base mainnet)
    LIMITLESS_CHAIN_ID: zod_1.z.string().optional().default("8453"),
    // How many markets to refresh per price-sync tick
    LIMITLESS_PRICE_SYNC_BATCH: zod_1.z.string().optional().default("200"),
    // How many markets to scan per sport-enrichment tick
    LIMITLESS_ENRICH_BATCH: zod_1.z.string().optional().default("500"),
    // ─── Scheduling / BullMQ ─────────────────────────────────────────────────
    REDIS_URL: zod_1.z.string().optional(),
    QUEUE_CONCURRENCY: zod_1.z.string().optional().default("1"),
    MISSED_EXECUTION_GRACE_MINUTES: zod_1.z.string().optional().default("15"),
});
function loadEnv() {
    return EnvSchema.parse({
        NODE_ENV: process.env.NODE_ENV,
        DATABASE_URL: process.env.DATABASE_URL,
        ADMIN_API_KEY: process.env.ADMIN_API_KEY,
        BASE_RPC_URL: process.env.BASE_RPC_URL,
        BASE_EXECUTOR_PRIVATE_KEY: process.env.BASE_EXECUTOR_PRIVATE_KEY,
        BASE_USDC_ADDRESS: process.env.BASE_USDC_ADDRESS,
        VAULT_CONTRACT_ADDRESS: process.env.VAULT_CONTRACT_ADDRESS,
        CLUB_VAULT_FACTORY_ADDRESS: process.env.CLUB_VAULT_FACTORY_ADDRESS,
        ETH_GETLOGS_BLOCK_CHUNK: process.env.ETH_GETLOGS_BLOCK_CHUNK,
        ETH_GETLOGS_MIN_DELAY_MS: process.env.ETH_GETLOGS_MIN_DELAY_MS,
        ETH_GETLOGS_MAX_RETRIES: process.env.ETH_GETLOGS_MAX_RETRIES,
        ETH_GETLOGS_RETRY_BASE_MS: process.env.ETH_GETLOGS_RETRY_BASE_MS,
        ETH_GETLOGS_COOLDOWN_MS: process.env.ETH_GETLOGS_COOLDOWN_MS,
        CHAIN_EVENT_CURSOR_LOCK_STALE_MS: process.env.CHAIN_EVENT_CURSOR_LOCK_STALE_MS,
        BASE_GETLOGS_BLOCK_CHUNK: process.env.BASE_GETLOGS_BLOCK_CHUNK,
        VAULT_SYNC_MAX_BLOCKS_PER_TICK: process.env.VAULT_SYNC_MAX_BLOCKS_PER_TICK,
        VAULT_SYNC_POOLS_PER_TICK: process.env.VAULT_SYNC_POOLS_PER_TICK,
        LIMITLESS_BASE_URL: process.env.LIMITLESS_BASE_URL,
        LIMITLESS_API_KEY: process.env.LIMITLESS_API_KEY,
        LIMITLESS_FEE_RATE_BPS: process.env.LIMITLESS_FEE_RATE_BPS,
        LIMITLESS_CHAIN_ID: process.env.LIMITLESS_CHAIN_ID,
        LIMITLESS_PRICE_SYNC_BATCH: process.env.LIMITLESS_PRICE_SYNC_BATCH,
        LIMITLESS_ENRICH_BATCH: process.env.LIMITLESS_ENRICH_BATCH,
        REDIS_URL: process.env.REDIS_URL,
        QUEUE_CONCURRENCY: process.env.QUEUE_CONCURRENCY,
        MISSED_EXECUTION_GRACE_MINUTES: process.env.MISSED_EXECUTION_GRACE_MINUTES,
    });
}
