import { ethers } from "ethers";
import type { Env } from "../config/env";
import { getBaseProvider } from "./rpc";

const CLUB_VAULT_FACTORY_ABI = [
  "function getVaultByClub(bytes32 clubId) view returns (address)",
  "function createClubVault(bytes32 clubId, string name_, string symbol_, uint256 depositCap) returns (address)"
];

function computeClubId(clubName: string) {
  // Must match the `bytes32 clubId` convention used by the vault factory mapping.
  // We keep MVP convention: clubId = keccak256(abi.encodePacked(clubName)).
  return ethers.solidityPackedKeccak256(["string"], [clubName]);
}

/**
 * Ensures a per-club `USDC4626Vault` is deployed.
 * Note: `createClubVault` is `onlyOwner`, so `EXECUTOR_PRIVATE_KEY` must be the factory owner.
 */
export async function ensureClubVaultExists(params: {
  env: Env;
  clubName: string;
  symbol: string;
  depositCap: bigint;
}): Promise<{ vaultAddress: string; created: boolean }> {
  const { env, clubName, symbol, depositCap } = params;

  if (!env.CLUB_VAULT_FACTORY_ADDRESS) {
    throw new Error("CLUB_VAULT_FACTORY_ADDRESS missing (factory auto-deploy disabled)");
  }
  const provider = getBaseProvider(env);
  const signer = env.BASE_EXECUTOR_PRIVATE_KEY ? new ethers.Wallet(env.BASE_EXECUTOR_PRIVATE_KEY, provider) : undefined;

  const factory = new ethers.Contract(env.CLUB_VAULT_FACTORY_ADDRESS, CLUB_VAULT_FACTORY_ABI, signer ?? provider);

  const clubId = computeClubId(clubName);
  const existing = (await factory.getVaultByClub(clubId)) as string;
  if (existing && existing !== ethers.ZeroAddress) {
    return { vaultAddress: existing, created: false };
  }

  if (!signer) {
    throw new Error("Vault not found in factory, but EXECUTOR_PRIVATE_KEY missing so auto-deploy is disabled");
  }

  const tx = await (factory as any).createClubVault(clubId, clubName, symbol, depositCap);
  await tx.wait();

  const resolved = (await factory.getVaultByClub(clubId)) as string;
  if (!resolved || resolved === ethers.ZeroAddress) {
    throw new Error("Factory createClubVault succeeded but vault address not found");
  }

  return { vaultAddress: resolved, created: true };
}
