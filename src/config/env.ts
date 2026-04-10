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
  CHILIZ_WRAPPED_SHARE_ADDRESS: z.string().optional()
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
    REDIS_URL: process.env.REDIS_URL,
    QUEUE_CONCURRENCY: process.env.QUEUE_CONCURRENCY,
    MISSED_EXECUTION_GRACE_MINUTES: process.env.MISSED_EXECUTION_GRACE_MINUTES,
    RPC_URL: process.env.RPC_URL,
    EXECUTOR_PRIVATE_KEY: process.env.EXECUTOR_PRIVATE_KEY,
    VAULT_CONTRACT_ADDRESS: process.env.VAULT_CONTRACT_ADDRESS,
    CLUB_VAULT_FACTORY_ADDRESS: process.env.CLUB_VAULT_FACTORY_ADDRESS,
    // VAULT_CONTRACT_ABI_PATH intentionally unused: backend keeps its own ABI fragments
    VAULT_CONTRACT_ABI_PATH: process.env.VAULT_CONTRACT_ABI_PATH,

    WRAPCHZ_TOKEN_ADDRESS: process.env.WRAPCHZ_TOKEN_ADDRESS,
    UNISWAP_V2_ROUTER_ADDRESS: process.env.UNISWAP_V2_ROUTER_ADDRESS,

    CHILIZ_RPC_URL: process.env.CHILIZ_RPC_URL,
    CHILIZ_EXECUTOR_PRIVATE_KEY: process.env.CHILIZ_EXECUTOR_PRIVATE_KEY,
    CHILIZ_DEPOSIT_RECEIVER_ADDRESS: process.env.CHILIZ_DEPOSIT_RECEIVER_ADDRESS,
    CHILIZ_WRAPPED_SHARE_ADDRESS: process.env.CHILIZ_WRAPPED_SHARE_ADDRESS
  });
}

