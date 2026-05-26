import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.string().optional().default("development"),
  DATABASE_URL: z.string().min(1),
  ADMIN_API_KEY: z.string().optional(),

  // Polymarket Gamma (public)
  GAMMA_BASE_URL: z.string().optional().default("https://gamma-api.polymarket.com"),

  // Polymarket CLOB (public reads + authenticated writes)
  CLOB_BASE_URL: z.string().optional().default("https://clob.polymarket.com"),

  // L2 trading credentials (server-side only)
  POLY_API_KEY: z.string().optional(),
  POLY_ADDRESS: z.string().optional(),
  POLY_PASSPHRASE: z.string().optional(),
  POLY_SIGNATURE_SECRET: z.string().optional(),
  POLY_SIGNATURE_TYPE: z.string().optional().default("3"),
  POLY_FUNDER_ADDRESS: z.string().optional(),
  POLY_DEPOSIT_WALLET_FACTORY: z.string().optional().default("0x00000000000Fb5C9ADea0298D729A0CB3823Cc07"),
  POLY_PUSD_ADDRESS: z.string().optional().default("0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB"),
  POLY_CTF_EXCHANGE: z.string().optional().default("0xE111180000d2663C0091e4f400237545B87B996B"),
  POLY_NEG_RISK_CTF_EXCHANGE: z.string().optional().default("0xe2222d279d744050d28e00520010520000310F59"),
  POLY_RELAYER_URL: z.string().optional().default("https://relayer-v2.polymarket.com"),
  RELAYER_API_KEY: z.string().optional(),
  RELAYER_API_KEY_ADDRESS: z.string().optional(),
  POLY_BUILDER_API_KEY: z.string().optional(),
  POLY_BUILDER_SECRET: z.string().optional(),
  POLY_BUILDER_PASSPHRASE: z.string().optional(),

  // Scheduling / execution
  // Redis is only needed for scheduled execution (BullMQ). On Railway,
  // you should set this to your Railway Redis URL (or disable worker by leaving it empty).
  REDIS_URL: z.string().optional(),
  QUEUE_CONCURRENCY: z.string().optional().default("1"),
  MISSED_EXECUTION_GRACE_MINUTES: z.string().optional().default("15"),

  // Onchain contract integration (optional for MVP)
  RPC_URL: z.string().optional(),
  EXECUTOR_PRIVATE_KEY: z.string().optional(),
  VAULT_CONTRACT_ADDRESS: z.string().optional(),
  VAULT_CONTRACT_ABI_PATH: z.string().optional(),
  ETH_GETLOGS_BLOCK_CHUNK: z.string().optional().default("10"),
  ETH_GETLOGS_MIN_DELAY_MS: z.string().optional().default("300"),
  ETH_GETLOGS_MAX_RETRIES: z.string().optional().default("6"),
  ETH_GETLOGS_RETRY_BASE_MS: z.string().optional().default("1000"),
  ETH_GETLOGS_COOLDOWN_MS: z.string().optional().default("60000"),
  CHAIN_EVENT_CURSOR_LOCK_STALE_MS: z.string().optional().default("120000"),
  BASE_GETLOGS_BLOCK_CHUNK: z.string().optional(),
  POLYGON_GETLOGS_BLOCK_CHUNK: z.string().optional(),
  BASE_RELAYER_MAX_BLOCKS_PER_TICK: z.string().optional().default("100"),
  VAULT_SYNC_MAX_BLOCKS_PER_TICK: z.string().optional().default("100"),
  VAULT_SYNC_POOLS_PER_TICK: z.string().optional().default("1"),
  // Optional factory to resolve per-club vault addresses.
  // Vault address is derived as: vaultFactory.getVaultByClub(keccak256(clubName)).
  CLUB_VAULT_FACTORY_ADDRESS: z.string().optional(),

  // Optional: user deposit via WrapCHZ -> swap -> USDC -> vault deposit (Polygon)
  WRAPCHZ_TOKEN_ADDRESS: z.string().optional(),
  UNISWAP_V2_ROUTER_ADDRESS: z.string().optional(),

  // Chiliz cross-chain flow
  CHILIZ_RPC_URL: z.string().optional(),
  CHILIZ_EXECUTOR_PRIVATE_KEY: z.string().optional(),
  CHILIZ_DEPOSIT_RECEIVER_ADDRESS: z.string().optional(),
  CHILIZ_WRAPPED_SHARE_ADDRESS: z.string().optional(),

  // Base USDC deposit flow (Base -> LI.FI bridge -> Polygon vault)
  BASE_RPC_URL: z.string().optional(),
  BASE_EXECUTOR_PRIVATE_KEY: z.string().optional(),
  BASE_USDC_ADDRESS: z.string().optional(),
  BASE_DEPOSIT_RECEIVER_ADDRESS: z.string().optional(),
  BASE_WRAPPED_SHARE_ADDRESS: z.string().optional(),
  LIFI_BASE_URL: z.string().optional().default("https://li.quest/v1"),
  LIFI_API_KEY: z.string().optional(),
  LIFI_INTEGRATOR: z.string().optional().default("teamindex"),
  LIFI_SLIPPAGE: z.string().optional().default("0.005")
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(): Env {
  return EnvSchema.parse({
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    ADMIN_API_KEY: process.env.ADMIN_API_KEY,
    GAMMA_BASE_URL: process.env.GAMMA_BASE_URL,
    CLOB_BASE_URL: process.env.CLOB_BASE_URL,
    POLY_API_KEY: process.env.POLY_API_KEY,
    POLY_ADDRESS: process.env.POLY_ADDRESS,
    POLY_PASSPHRASE: process.env.POLY_PASSPHRASE,
    POLY_SIGNATURE_SECRET: process.env.POLY_SIGNATURE_SECRET,
    POLY_SIGNATURE_TYPE: process.env.POLY_SIGNATURE_TYPE,
    POLY_FUNDER_ADDRESS: process.env.POLY_FUNDER_ADDRESS,
    POLY_DEPOSIT_WALLET_FACTORY: process.env.POLY_DEPOSIT_WALLET_FACTORY,
    POLY_PUSD_ADDRESS: process.env.POLY_PUSD_ADDRESS,
    POLY_CTF_EXCHANGE: process.env.POLY_CTF_EXCHANGE,
    POLY_NEG_RISK_CTF_EXCHANGE: process.env.POLY_NEG_RISK_CTF_EXCHANGE,
    POLY_RELAYER_URL: process.env.POLY_RELAYER_URL,
    RELAYER_API_KEY: process.env.RELAYER_API_KEY,
    RELAYER_API_KEY_ADDRESS: process.env.RELAYER_API_KEY_ADDRESS,
    POLY_BUILDER_API_KEY: process.env.POLY_BUILDER_API_KEY,
    POLY_BUILDER_SECRET: process.env.POLY_BUILDER_SECRET,
    POLY_BUILDER_PASSPHRASE: process.env.POLY_BUILDER_PASSPHRASE,
    REDIS_URL: process.env.REDIS_URL,
    QUEUE_CONCURRENCY: process.env.QUEUE_CONCURRENCY,
    MISSED_EXECUTION_GRACE_MINUTES: process.env.MISSED_EXECUTION_GRACE_MINUTES,
    RPC_URL: process.env.RPC_URL,
    EXECUTOR_PRIVATE_KEY: process.env.EXECUTOR_PRIVATE_KEY,
    VAULT_CONTRACT_ADDRESS: process.env.VAULT_CONTRACT_ADDRESS,
    ETH_GETLOGS_BLOCK_CHUNK: process.env.ETH_GETLOGS_BLOCK_CHUNK,
    ETH_GETLOGS_MIN_DELAY_MS: process.env.ETH_GETLOGS_MIN_DELAY_MS,
    ETH_GETLOGS_MAX_RETRIES: process.env.ETH_GETLOGS_MAX_RETRIES,
    ETH_GETLOGS_RETRY_BASE_MS: process.env.ETH_GETLOGS_RETRY_BASE_MS,
    ETH_GETLOGS_COOLDOWN_MS: process.env.ETH_GETLOGS_COOLDOWN_MS,
    CHAIN_EVENT_CURSOR_LOCK_STALE_MS: process.env.CHAIN_EVENT_CURSOR_LOCK_STALE_MS,
    BASE_GETLOGS_BLOCK_CHUNK: process.env.BASE_GETLOGS_BLOCK_CHUNK,
    POLYGON_GETLOGS_BLOCK_CHUNK: process.env.POLYGON_GETLOGS_BLOCK_CHUNK,
    BASE_RELAYER_MAX_BLOCKS_PER_TICK: process.env.BASE_RELAYER_MAX_BLOCKS_PER_TICK,
    VAULT_SYNC_MAX_BLOCKS_PER_TICK: process.env.VAULT_SYNC_MAX_BLOCKS_PER_TICK,
    VAULT_SYNC_POOLS_PER_TICK: process.env.VAULT_SYNC_POOLS_PER_TICK,
    CLUB_VAULT_FACTORY_ADDRESS: process.env.CLUB_VAULT_FACTORY_ADDRESS,
    // VAULT_CONTRACT_ABI_PATH intentionally unused: backend keeps its own ABI fragments
    VAULT_CONTRACT_ABI_PATH: process.env.VAULT_CONTRACT_ABI_PATH,

    WRAPCHZ_TOKEN_ADDRESS: process.env.WRAPCHZ_TOKEN_ADDRESS,
    UNISWAP_V2_ROUTER_ADDRESS: process.env.UNISWAP_V2_ROUTER_ADDRESS,

    CHILIZ_RPC_URL: process.env.CHILIZ_RPC_URL,
    CHILIZ_EXECUTOR_PRIVATE_KEY: process.env.CHILIZ_EXECUTOR_PRIVATE_KEY,
    CHILIZ_DEPOSIT_RECEIVER_ADDRESS: process.env.CHILIZ_DEPOSIT_RECEIVER_ADDRESS,
    CHILIZ_WRAPPED_SHARE_ADDRESS: process.env.CHILIZ_WRAPPED_SHARE_ADDRESS,

    BASE_RPC_URL: process.env.BASE_RPC_URL,
    BASE_EXECUTOR_PRIVATE_KEY: process.env.BASE_EXECUTOR_PRIVATE_KEY,
    BASE_USDC_ADDRESS: process.env.BASE_USDC_ADDRESS,
    BASE_DEPOSIT_RECEIVER_ADDRESS: process.env.BASE_DEPOSIT_RECEIVER_ADDRESS,
    BASE_WRAPPED_SHARE_ADDRESS: process.env.BASE_WRAPPED_SHARE_ADDRESS,
    LIFI_BASE_URL: process.env.LIFI_BASE_URL,
    LIFI_API_KEY: process.env.LIFI_API_KEY,
    LIFI_INTEGRATOR: process.env.LIFI_INTEGRATOR,
    LIFI_SLIPPAGE: process.env.LIFI_SLIPPAGE
  });
}
