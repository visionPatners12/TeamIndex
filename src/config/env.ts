import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.string().optional().default("development"),
  DATABASE_URL: z.string().min(1),
  ADMIN_API_KEY: z.string().optional(),

  // ─── Base chain (primary chain — everything runs here) ───────────────────
  BASE_RPC_URL: z.string().optional(),
  BASE_RPC_FALLBACK_URLS: z.string().optional(),
  // EOA executor wallet on Base: signs vault admin txs / NAV updates.
  BASE_EXECUTOR_PRIVATE_KEY: z.string().optional(),
  // USDC contract address on Base (default: Base mainnet USDC)
  BASE_USDC_ADDRESS: z.string().optional().default("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
  // Receiver contract that accepts Base USDC before the relayer processes it.
  BASE_DEPOSIT_RECEIVER_ADDRESS: z.string().optional(),

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
  VAULT_SYNC_START_BLOCK: z.string().optional(),
  VAULT_SYNC_MAX_BLOCKS_PER_TICK: z.string().optional().default("100"),
  VAULT_SYNC_POOLS_PER_TICK: z.string().optional().default("1"),
  // Min delay between on-chain NAV pushes (setPoolValuation) per pool. The DB/snapshot
  // is refreshed every price-recalc cycle (real-time); the on-chain write is throttled
  // to this interval. Default 1h.
  ONCHAIN_NAV_PUSH_INTERVAL_MS: z.string().optional().default("3600000"),

  // ─── Limitless Exchange (market data + trading, Base chain) ──────────────
  LIMITLESS_BASE_URL: z.string().optional().default("https://api.limitless.exchange"),
  // Legacy REST auth header — existing API-key users only.
  LIMITLESS_API_KEY: z.string().optional(),
  // Scoped HMAC token used for partner accounts and delegated signing.
  LIMITLESS_API_SECRET: z.string().optional(),
  LIMITLESS_WS_URL: z.string().optional().default("wss://ws.limitless.exchange/markets"),
  LIMITLESS_WS_ENABLED: z.string().optional().default("true"),
  LIMITLESS_WS_RECONCILE_INTERVAL_MS: z.string().optional().default("600000"),
  LIMITLESS_PARTNER_ACCOUNT_CREATION_ENABLED: z
    .string()
    .optional()
    .default("false"),
  // Fee rate in bps (Bronze=200, Silver=150, Gold=100, Diamond=50)
  LIMITLESS_FEE_RATE_BPS: z.string().optional().default("200"),
  // chainId for EIP-712 signing (8453 = Base mainnet)
  LIMITLESS_CHAIN_ID: z.string().optional().default("8453"),
  // EOA allowed by each vault's ERC-1271 `setOrderSigner`; signs orders, does not hold funds.
  LIMITLESS_ORDER_SIGNER_PRIVATE_KEY: z.string().optional(),
  // Override the ERC-1271 signatureType sent to Limitless (default 2, matching current SDK smart-wallet value).
  LIMITLESS_SIGNATURE_TYPE: z.string().optional(),
  // Legacy EOA trading key. Used as a fallback signer only while migrating existing envs.
  LIMITLESS_TRADER_PRIVATE_KEY: z.string().optional(),
  // How many markets to refresh per price-sync tick
  LIMITLESS_PRICE_SYNC_BATCH: z.string().optional().default("200"),
  // How many markets to scan per sport-enrichment tick
  LIMITLESS_ENRICH_BATCH: z.string().optional().default("500"),

  // ─── Coinbase CDP webhooks ───────────────────────────────────────────────
  CDP_WEBHOOK_SECRET: z.string().optional(),
  // Bearer token/JWT for Coinbase CDP SQL API (`/platform/v2/data/query/run`).
  CDP_SQL_API_TOKEN: z.string().optional(),

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
    BASE_RPC_FALLBACK_URLS: process.env.BASE_RPC_FALLBACK_URLS,
    BASE_EXECUTOR_PRIVATE_KEY: process.env.BASE_EXECUTOR_PRIVATE_KEY,
    BASE_USDC_ADDRESS: process.env.BASE_USDC_ADDRESS,
    BASE_DEPOSIT_RECEIVER_ADDRESS: process.env.BASE_DEPOSIT_RECEIVER_ADDRESS,

    VAULT_CONTRACT_ADDRESS: process.env.VAULT_CONTRACT_ADDRESS,
    CLUB_VAULT_FACTORY_ADDRESS: process.env.CLUB_VAULT_FACTORY_ADDRESS,

    ETH_GETLOGS_BLOCK_CHUNK: process.env.ETH_GETLOGS_BLOCK_CHUNK,
    ETH_GETLOGS_MIN_DELAY_MS: process.env.ETH_GETLOGS_MIN_DELAY_MS,
    ETH_GETLOGS_MAX_RETRIES: process.env.ETH_GETLOGS_MAX_RETRIES,
    ETH_GETLOGS_RETRY_BASE_MS: process.env.ETH_GETLOGS_RETRY_BASE_MS,
    ETH_GETLOGS_COOLDOWN_MS: process.env.ETH_GETLOGS_COOLDOWN_MS,
    CHAIN_EVENT_CURSOR_LOCK_STALE_MS: process.env.CHAIN_EVENT_CURSOR_LOCK_STALE_MS,
    BASE_GETLOGS_BLOCK_CHUNK: process.env.BASE_GETLOGS_BLOCK_CHUNK,
    VAULT_SYNC_START_BLOCK: process.env.VAULT_SYNC_START_BLOCK,
    VAULT_SYNC_MAX_BLOCKS_PER_TICK: process.env.VAULT_SYNC_MAX_BLOCKS_PER_TICK,
    VAULT_SYNC_POOLS_PER_TICK: process.env.VAULT_SYNC_POOLS_PER_TICK,
    ONCHAIN_NAV_PUSH_INTERVAL_MS: process.env.ONCHAIN_NAV_PUSH_INTERVAL_MS,

    LIMITLESS_BASE_URL: process.env.LIMITLESS_BASE_URL,
    LIMITLESS_API_KEY: process.env.LIMITLESS_API_KEY,
    LIMITLESS_API_SECRET: process.env.LIMITLESS_API_SECRET,
    LIMITLESS_WS_URL: process.env.LIMITLESS_WS_URL,
    LIMITLESS_WS_ENABLED: process.env.LIMITLESS_WS_ENABLED,
    LIMITLESS_WS_RECONCILE_INTERVAL_MS: process.env.LIMITLESS_WS_RECONCILE_INTERVAL_MS,
    LIMITLESS_PARTNER_ACCOUNT_CREATION_ENABLED: process.env.LIMITLESS_PARTNER_ACCOUNT_CREATION_ENABLED,
    LIMITLESS_FEE_RATE_BPS: process.env.LIMITLESS_FEE_RATE_BPS,
    LIMITLESS_CHAIN_ID: process.env.LIMITLESS_CHAIN_ID,
    LIMITLESS_ORDER_SIGNER_PRIVATE_KEY: process.env.LIMITLESS_ORDER_SIGNER_PRIVATE_KEY,
    LIMITLESS_SIGNATURE_TYPE: process.env.LIMITLESS_SIGNATURE_TYPE,
    LIMITLESS_TRADER_PRIVATE_KEY: process.env.LIMITLESS_TRADER_PRIVATE_KEY,
    LIMITLESS_PRICE_SYNC_BATCH: process.env.LIMITLESS_PRICE_SYNC_BATCH,
    LIMITLESS_ENRICH_BATCH: process.env.LIMITLESS_ENRICH_BATCH,

    CDP_WEBHOOK_SECRET: process.env.CDP_WEBHOOK_SECRET,
    CDP_SQL_API_TOKEN: process.env.CDP_SQL_API_TOKEN,

    REDIS_URL: process.env.REDIS_URL,
    QUEUE_CONCURRENCY: process.env.QUEUE_CONCURRENCY,
    MISSED_EXECUTION_GRACE_MINUTES: process.env.MISSED_EXECUTION_GRACE_MINUTES,
  });
}
