import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.string().optional().default("development"),
  DATABASE_URL: z.string().min(1),
  ADMIN_API_KEY: z.string().optional(),

  // ─── Base chain (primary chain — everything runs here) ───────────────────
  BASE_RPC_URL: z.string().optional(),
  // EOA executor wallet on Base: signs vault admin txs + Limitless EIP-712 orders
  BASE_EXECUTOR_PRIVATE_KEY: z.string().optional(),
  // USDC contract address on Base (default: Base mainnet USDC)
  BASE_USDC_ADDRESS: z.string().optional().default("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),

  // ─── Vault contracts (deployed on Base) ──────────────────────────────────
  VAULT_CONTRACT_ADDRESS: z.string().optional(),
  // Optional: factory resolves per-club vault → vaultFactory.getVaultByClub(keccak256(clubName))
  CLUB_VAULT_FACTORY_ADDRESS: z.string().optional(),

  // ─── Onchain event sync (Base) ────────────────────────────────────────────
  ETH_GETLOGS_BLOCK_CHUNK: z.string().optional().default("10"),
  ETH_GETLOGS_MIN_DELAY_MS: z.string().optional().default("300"),
  ETH_GETLOGS_MAX_RETRIES: z.string().optional().default("6"),
  ETH_GETLOGS_RETRY_BASE_MS: z.string().optional().default("1000"),
  ETH_GETLOGS_COOLDOWN_MS: z.string().optional().default("60000"),
  CHAIN_EVENT_CURSOR_LOCK_STALE_MS: z.string().optional().default("120000"),
  BASE_GETLOGS_BLOCK_CHUNK: z.string().optional().default("10"),
  VAULT_SYNC_MAX_BLOCKS_PER_TICK: z.string().optional().default("100"),
  VAULT_SYNC_POOLS_PER_TICK: z.string().optional().default("1"),

  // ─── Limitless Exchange (market data + trading, Base chain) ──────────────
  LIMITLESS_BASE_URL: z.string().optional().default("https://api.limitless.exchange"),
  // REST auth header — created at limitless.exchange → Profile → API keys
  LIMITLESS_API_KEY: z.string().optional(),
  // Fee rate in bps (Bronze=200, Silver=150, Gold=100, Diamond=50)
  LIMITLESS_FEE_RATE_BPS: z.string().optional().default("200"),
  // chainId for EIP-712 signing (8453 = Base mainnet)
  LIMITLESS_CHAIN_ID: z.string().optional().default("8453"),
  // How many markets to refresh per price-sync tick
  LIMITLESS_PRICE_SYNC_BATCH: z.string().optional().default("200"),
  // How many markets to scan per sport-enrichment tick
  LIMITLESS_ENRICH_BATCH: z.string().optional().default("500"),

  // ─── Scheduling / BullMQ ─────────────────────────────────────────────────
  REDIS_URL: z.string().optional(),
  QUEUE_CONCURRENCY: z.string().optional().default("1"),
  MISSED_EXECUTION_GRACE_MINUTES: z.string().optional().default("15"),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(): Env {
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
