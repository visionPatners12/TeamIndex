"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureClubVaultExists = ensureClubVaultExists;
const ethers_1 = require("ethers");
const CLUB_VAULT_FACTORY_ABI = [
    "function getVaultByClub(bytes32 clubId) view returns (address)",
    "function createClubVault(bytes32 clubId, string name_, string symbol_, uint256 depositCap) returns (address)"
];
function computeClubId(clubName) {
    // Must match the `bytes32 clubId` convention used by the vault factory mapping.
    // We keep MVP convention: clubId = keccak256(abi.encodePacked(clubName)).
    return ethers_1.ethers.solidityPackedKeccak256(["string"], [clubName]);
}
/**
 * Ensures a per-club `USDC4626Vault` is deployed.
 * Note: `createClubVault` is `onlyOwner`, so `EXECUTOR_PRIVATE_KEY` must be the factory owner.
 */
async function ensureClubVaultExists(params) {
    const { env, clubName, symbol, depositCap } = params;
    if (!env.CLUB_VAULT_FACTORY_ADDRESS) {
        throw new Error("CLUB_VAULT_FACTORY_ADDRESS missing (factory auto-deploy disabled)");
    }
    if (!env.BASE_RPC_URL) {
        throw new Error("RPC_URL missing (needed for factory reads/writes)");
    }
    const provider = new ethers_1.ethers.JsonRpcProvider(env.BASE_RPC_URL);
    const signer = env.BASE_EXECUTOR_PRIVATE_KEY ? new ethers_1.ethers.Wallet(env.BASE_EXECUTOR_PRIVATE_KEY, provider) : undefined;
    const factory = new ethers_1.ethers.Contract(env.CLUB_VAULT_FACTORY_ADDRESS, CLUB_VAULT_FACTORY_ABI, signer ?? provider);
    const clubId = computeClubId(clubName);
    const existing = (await factory.getVaultByClub(clubId));
    if (existing && existing !== ethers_1.ethers.ZeroAddress) {
        return { vaultAddress: existing, created: false };
    }
    if (!signer) {
        throw new Error("Vault not found in factory, but EXECUTOR_PRIVATE_KEY missing so auto-deploy is disabled");
    }
    const tx = await factory.createClubVault(clubId, clubName, symbol, depositCap);
    await tx.wait();
    const resolved = (await factory.getVaultByClub(clubId));
    if (!resolved || resolved === ethers_1.ethers.ZeroAddress) {
        throw new Error("Factory createClubVault succeeded but vault address not found");
    }
    return { vaultAddress: resolved, created: true };
}
