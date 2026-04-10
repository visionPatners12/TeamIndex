"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadEnv = loadEnv;
const zod_1 = require("zod");
const EnvSchema = zod_1.z.object({
    NODE_ENV: zod_1.z.string().optional().default("development"),
    DATABASE_URL: zod_1.z.string().min(1),
    ADMIN_API_KEY: zod_1.z.string().optional(),
    // Polymarket Gamma (public)
    GAMMA_BASE_URL: zod_1.z.string().optional().default("https://gamma-api.polymarket.com"),
    // Polymarket CLOB (public reads + authenticated writes)
    CLOB_BASE_URL: zod_1.z.string().optional().default("https://clob.polymarket.com"),
    // L2 trading credentials (server-side only)
    POLY_API_KEY: zod_1.z.string().optional(),
    POLY_ADDRESS: zod_1.z.string().optional(),
    POLY_PASSPHRASE: zod_1.z.string().optional(),
    POLY_SIGNATURE_SECRET: zod_1.z.string().optional(),
    // Scheduling / execution
    // Redis is only needed for scheduled execution (BullMQ). On Railway,
    // you should set this to your Railway Redis URL (or disable worker by leaving it empty).
    REDIS_URL: zod_1.z.string().optional(),
    QUEUE_CONCURRENCY: zod_1.z.string().optional().default("1"),
    MISSED_EXECUTION_GRACE_MINUTES: zod_1.z.string().optional().default("15"),
    // Onchain contract integration (optional for MVP)
    RPC_URL: zod_1.z.string().optional(),
    EXECUTOR_PRIVATE_KEY: zod_1.z.string().optional(),
    VAULT_CONTRACT_ADDRESS: zod_1.z.string().optional(),
    VAULT_CONTRACT_ABI_PATH: zod_1.z.string().optional(),
    // Optional factory to resolve per-club vault addresses.
    // Vault address is derived as: vaultFactory.getVaultByClub(keccak256(clubName)).
    CLUB_VAULT_FACTORY_ADDRESS: zod_1.z.string().optional()
});
function loadEnv() {
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
        VAULT_CONTRACT_ABI_PATH: process.env.VAULT_CONTRACT_ABI_PATH
    });
}
