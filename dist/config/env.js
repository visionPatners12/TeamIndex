"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadEnv = loadEnv;
const zod_1 = require("zod");
const EnvSchema = zod_1.z.object({
    NODE_ENV: zod_1.z.string().optional().default("development"),
    DATABASE_URL: zod_1.z.string().min(1),
    ADMIN_API_KEY: zod_1.z.string().optional(),
    TRADING_PROVIDER: zod_1.z.enum(["polymarket", "legacy-disabled"]).optional().default("polymarket"),
    PROCESS_ROLE: zod_1.z
        .enum(["all", "api", "executor", "signer", "accounting", "pool-ws"])
        .optional()
        .default("all"),
    // ─── Active chain: Polygon / Polymarket CLOB V2 / pUSD ──────────────────
    POLYGON_RPC_URL: zod_1.z.string().url().optional(),
    POLYGON_EXECUTOR_PRIVATE_KEY: zod_1.z.string().optional(),
    POLYMARKET_CLOB_URL: zod_1.z.string().url().optional().default("https://clob.polymarket.com"),
    POLYMARKET_GAMMA_URL: zod_1.z.string().url().optional().default("https://gamma-api.polymarket.com"),
    POLYMARKET_DATA_API_URL: zod_1.z.string().url().optional().default("https://data-api.polymarket.com"),
    POLYMARKET_RELAYER_URL: zod_1.z.string().url().optional().default("https://relayer-v2.polymarket.com"),
    POLYMARKET_USER_WS_URL: zod_1.z
        .string()
        .url()
        .optional()
        .default("wss://ws-subscriptions-clob.polymarket.com/ws/user"),
    POLYMARKET_BUILDER_CODE: zod_1.z.string().optional(),
    POLYMARKET_PUSD_ADDRESS: zod_1.z
        .string()
        .optional()
        .default("0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB"),
    POLYMARKET_CTF_ADDRESS: zod_1.z
        .string()
        .optional()
        .default("0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"),
    POLYMARKET_CTF_EXCHANGE_ADDRESS: zod_1.z
        .string()
        .optional()
        .default("0xE111180000d2663C0091e4f400237545B87B996B"),
    POLYMARKET_NEG_RISK_EXCHANGE_ADDRESS: zod_1.z
        .string()
        .optional()
        .default("0xe2222d279d744050d28e00520010520000310F59"),
    POLYMARKET_DEPOSIT_WALLET_FACTORY: zod_1.z
        .string()
        .optional()
        .default("0x00000000000Fb5C9ADea0298D729A0CB3823Cc07"),
    TEAM_INDEX_V2_FACTORY_ADDRESS: zod_1.z.string().optional(),
    TEAM_INDEX_DEPOSIT_ESCROW_ADDRESS: zod_1.z.string().optional(),
    POLYMARKET_CREDENTIALS_ENCRYPTION_KEY: zod_1.z.string().optional(),
    POLYMARKET_MAX_ORDER_PUSD: zod_1.z.string().optional().default("25"),
    POLYMARKET_PILOT_TVL_PUSD: zod_1.z.string().optional().default("1000"),
    POLYMARKET_ACCOUNTING_INTERVAL_MS: zod_1.z.string().optional().default("60000"),
    POLYMARKET_EXECUTOR_INTERVAL_MS: zod_1.z.string().optional().default("5000"),
    POLYMARKET_RECONCILE_INTERVAL_MS: zod_1.z.string().optional().default("30000"),
    POLYMARKET_EGRESS_CHECK_ENABLED: zod_1.z.string().optional().default("true"),
    // CDP secures one EOA owner per pool. No private key is persisted by TeamIndex.
    CDP_API_KEY_ID: zod_1.z.string().optional(),
    CDP_API_KEY_SECRET: zod_1.z.string().optional(),
    CDP_WALLET_SECRET: zod_1.z.string().optional(),
    POLYMARKET_SIGNER_URL: zod_1.z.string().url().optional(),
    POLYMARKET_SIGNER_TOKEN: zod_1.z.string().optional(),
    // Hosted relayer authentication for Deposit Wallet deploy/approval batches.
    POLY_BUILDER_API_KEY: zod_1.z.string().optional(),
    POLY_BUILDER_SECRET: zod_1.z.string().optional(),
    POLY_BUILDER_PASSPHRASE: zod_1.z.string().optional(),
    // ─── Base chain (primary chain — everything runs here) ───────────────────
    BASE_RPC_URL: zod_1.z.string().optional(),
    BASE_RPC_FALLBACK_URLS: zod_1.z.string().optional(),
    // EOA executor wallet on Base: signs vault admin txs / NAV updates.
    BASE_EXECUTOR_PRIVATE_KEY: zod_1.z.string().optional(),
    // USDC contract address on Base (default: Base mainnet USDC)
    BASE_USDC_ADDRESS: zod_1.z.string().optional().default("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
    // Receiver contract that accepts Base USDC before the relayer processes it.
    BASE_DEPOSIT_RECEIVER_ADDRESS: zod_1.z.string().optional(),
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
    VAULT_SYNC_ENABLED: zod_1.z.string().optional().default("true"),
    VAULT_SYNC_START_BLOCK: zod_1.z.string().optional(),
    VAULT_SYNC_MAX_BLOCKS_PER_TICK: zod_1.z.string().optional().default("100"),
    VAULT_SYNC_MAX_LOG_REQUESTS_PER_TICK: zod_1.z.string().optional().default("40"),
    VAULT_SYNC_POOLS_PER_TICK: zod_1.z.string().optional().default("1"),
    // Min delay between on-chain NAV pushes (setPoolValuation) per pool. The DB/snapshot
    // is refreshed every price-recalc cycle (real-time); the on-chain write is throttled
    // to this interval. Default 1h.
    ONCHAIN_NAV_PUSH_ENABLED: zod_1.z.string().optional().default("true"),
    ONCHAIN_NAV_PUSH_INTERVAL_MS: zod_1.z.string().optional().default("3600000"),
    // ─── Limitless Exchange (market data + trading, Base chain) ──────────────
    LIMITLESS_BASE_URL: zod_1.z.string().optional().default("https://api.limitless.exchange"),
    LIMITLESS_REQUEST_TIMEOUT_MS: zod_1.z.string().optional().default("15000"),
    // Legacy REST auth header — existing API-key users only.
    LIMITLESS_API_KEY: zod_1.z.string().optional(),
    // Scoped HMAC token used for partner accounts and delegated signing.
    LIMITLESS_API_SECRET: zod_1.z.string().optional(),
    LIMITLESS_WS_URL: zod_1.z.string().optional().default("wss://ws.limitless.exchange/markets"),
    LIMITLESS_WS_ENABLED: zod_1.z.string().optional().default("false"),
    LIMITLESS_WS_RECONCILE_INTERVAL_MS: zod_1.z.string().optional().default("600000"),
    LIMITLESS_PORTFOLIO_POLL_ENABLED: zod_1.z.string().optional().default("false"),
    LIMITLESS_PORTFOLIO_POLL_INTERVAL_MS: zod_1.z.string().optional().default("900000"),
    LIMITLESS_PORTFOLIO_POLL_INITIAL_DELAY_MS: zod_1.z.string().optional().default("5000"),
    LIMITLESS_PARTNER_ACCOUNT_CREATION_ENABLED: zod_1.z
        .string()
        .optional()
        .default("false"),
    // Fee rate ceiling in bps. Limitless delegated/partner SDK defaults to 300.
    LIMITLESS_FEE_RATE_BPS: zod_1.z.string().optional().default("300"),
    // chainId for EIP-712 signing (8453 = Base mainnet)
    LIMITLESS_CHAIN_ID: zod_1.z.string().optional().default("8453"),
    // EOA allowed by each vault's ERC-1271 `setOrderSigner`; signs orders, does not hold funds.
    LIMITLESS_ORDER_SIGNER_PRIVATE_KEY: zod_1.z.string().optional(),
    // Override the ERC-1271 signatureType sent to Limitless (default 2, matching current SDK smart-wallet value).
    LIMITLESS_SIGNATURE_TYPE: zod_1.z.string().optional(),
    // Legacy EOA trading key. Used as a fallback signer only while migrating existing envs.
    LIMITLESS_TRADER_PRIVATE_KEY: zod_1.z.string().optional(),
    // How many markets to refresh per price-sync tick
    LIMITLESS_PRICE_SYNC_BATCH: zod_1.z.string().optional().default("200"),
    // How many markets to scan per sport-enrichment tick
    LIMITLESS_ENRICH_BATCH: zod_1.z.string().optional().default("500"),
    // ─── Coinbase CDP webhooks ───────────────────────────────────────────────
    CDP_WEBHOOK_SECRET: zod_1.z.string().optional(),
    // Bearer token/JWT for Coinbase CDP SQL API (`/platform/v2/data/query/run`).
    CDP_SQL_API_TOKEN: zod_1.z.string().optional(),
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
        TRADING_PROVIDER: process.env.TRADING_PROVIDER,
        PROCESS_ROLE: process.env.PROCESS_ROLE,
        POLYGON_RPC_URL: process.env.POLYGON_RPC_URL ?? process.env.RPC_URL,
        POLYGON_EXECUTOR_PRIVATE_KEY: process.env.POLYGON_EXECUTOR_PRIVATE_KEY ?? process.env.EXECUTOR_PRIVATE_KEY,
        POLYMARKET_CLOB_URL: process.env.POLYMARKET_CLOB_URL ?? process.env.CLOB_BASE_URL,
        POLYMARKET_GAMMA_URL: process.env.POLYMARKET_GAMMA_URL ?? process.env.GAMMA_BASE_URL,
        POLYMARKET_DATA_API_URL: process.env.POLYMARKET_DATA_API_URL,
        POLYMARKET_RELAYER_URL: process.env.POLYMARKET_RELAYER_URL ?? process.env.POLY_RELAYER_URL,
        POLYMARKET_USER_WS_URL: process.env.POLYMARKET_USER_WS_URL ?? process.env.PM_USER_WS_URL,
        POLYMARKET_BUILDER_CODE: process.env.POLYMARKET_BUILDER_CODE,
        POLYMARKET_PUSD_ADDRESS: process.env.POLYMARKET_PUSD_ADDRESS ?? process.env.POLY_PUSD_ADDRESS,
        POLYMARKET_CTF_ADDRESS: process.env.POLYMARKET_CTF_ADDRESS,
        POLYMARKET_CTF_EXCHANGE_ADDRESS: process.env.POLYMARKET_CTF_EXCHANGE_ADDRESS ?? process.env.POLY_CTF_EXCHANGE,
        POLYMARKET_NEG_RISK_EXCHANGE_ADDRESS: process.env.POLYMARKET_NEG_RISK_EXCHANGE_ADDRESS ?? process.env.POLY_NEG_RISK_CTF_EXCHANGE,
        POLYMARKET_DEPOSIT_WALLET_FACTORY: process.env.POLYMARKET_DEPOSIT_WALLET_FACTORY ?? process.env.POLY_DEPOSIT_WALLET_FACTORY,
        TEAM_INDEX_V2_FACTORY_ADDRESS: process.env.TEAM_INDEX_V2_FACTORY_ADDRESS,
        TEAM_INDEX_DEPOSIT_ESCROW_ADDRESS: process.env.TEAM_INDEX_DEPOSIT_ESCROW_ADDRESS,
        POLYMARKET_CREDENTIALS_ENCRYPTION_KEY: process.env.POLYMARKET_CREDENTIALS_ENCRYPTION_KEY,
        POLYMARKET_MAX_ORDER_PUSD: process.env.POLYMARKET_MAX_ORDER_PUSD,
        POLYMARKET_PILOT_TVL_PUSD: process.env.POLYMARKET_PILOT_TVL_PUSD,
        POLYMARKET_ACCOUNTING_INTERVAL_MS: process.env.POLYMARKET_ACCOUNTING_INTERVAL_MS,
        POLYMARKET_EXECUTOR_INTERVAL_MS: process.env.POLYMARKET_EXECUTOR_INTERVAL_MS,
        POLYMARKET_RECONCILE_INTERVAL_MS: process.env.POLYMARKET_RECONCILE_INTERVAL_MS,
        POLYMARKET_EGRESS_CHECK_ENABLED: process.env.POLYMARKET_EGRESS_CHECK_ENABLED,
        CDP_API_KEY_ID: process.env.CDP_API_KEY_ID,
        CDP_API_KEY_SECRET: process.env.CDP_API_KEY_SECRET,
        CDP_WALLET_SECRET: process.env.CDP_WALLET_SECRET,
        POLYMARKET_SIGNER_URL: process.env.POLYMARKET_SIGNER_URL,
        POLYMARKET_SIGNER_TOKEN: process.env.POLYMARKET_SIGNER_TOKEN,
        POLY_BUILDER_API_KEY: process.env.POLY_BUILDER_API_KEY,
        POLY_BUILDER_SECRET: process.env.POLY_BUILDER_SECRET,
        POLY_BUILDER_PASSPHRASE: process.env.POLY_BUILDER_PASSPHRASE,
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
        VAULT_SYNC_ENABLED: process.env.VAULT_SYNC_ENABLED,
        VAULT_SYNC_START_BLOCK: process.env.VAULT_SYNC_START_BLOCK,
        VAULT_SYNC_MAX_BLOCKS_PER_TICK: process.env.VAULT_SYNC_MAX_BLOCKS_PER_TICK,
        VAULT_SYNC_MAX_LOG_REQUESTS_PER_TICK: process.env.VAULT_SYNC_MAX_LOG_REQUESTS_PER_TICK,
        VAULT_SYNC_POOLS_PER_TICK: process.env.VAULT_SYNC_POOLS_PER_TICK,
        ONCHAIN_NAV_PUSH_ENABLED: process.env.ONCHAIN_NAV_PUSH_ENABLED,
        ONCHAIN_NAV_PUSH_INTERVAL_MS: process.env.ONCHAIN_NAV_PUSH_INTERVAL_MS,
        LIMITLESS_BASE_URL: process.env.LIMITLESS_BASE_URL,
        LIMITLESS_REQUEST_TIMEOUT_MS: process.env.LIMITLESS_REQUEST_TIMEOUT_MS,
        LIMITLESS_API_KEY: process.env.LIMITLESS_API_KEY,
        LIMITLESS_API_SECRET: process.env.LIMITLESS_API_SECRET,
        LIMITLESS_WS_URL: process.env.LIMITLESS_WS_URL,
        LIMITLESS_WS_ENABLED: process.env.LIMITLESS_WS_ENABLED,
        LIMITLESS_WS_RECONCILE_INTERVAL_MS: process.env.LIMITLESS_WS_RECONCILE_INTERVAL_MS,
        LIMITLESS_PORTFOLIO_POLL_ENABLED: process.env.LIMITLESS_PORTFOLIO_POLL_ENABLED,
        LIMITLESS_PORTFOLIO_POLL_INTERVAL_MS: process.env.LIMITLESS_PORTFOLIO_POLL_INTERVAL_MS,
        LIMITLESS_PORTFOLIO_POLL_INITIAL_DELAY_MS: process.env.LIMITLESS_PORTFOLIO_POLL_INITIAL_DELAY_MS,
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
