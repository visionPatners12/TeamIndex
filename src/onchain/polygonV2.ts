import { Contract, JsonRpcProvider, Wallet, isAddress, keccak256, toUtf8Bytes } from "ethers";
import type { Env } from "../config/env";
import { TEAM_INDEX_PUSD_VAULT_V2_ABI } from "../contracts/teamIndexPusdVaultV2";

const TEAM_INDEX_V2_FACTORY_ABI = [
  "function createPoolVault(bytes32 poolId,string name,string symbol,uint256 depositCap,address depositWallet,address depositWalletOwner) returns (address)",
  "function getVaultByPool(bytes32 poolId) view returns (address)",
] as const;

export function getPolygonProvider(env: Env) {
  if (!env.POLYGON_RPC_URL) throw new Error("POLYGON_RPC_URL is required");
  return new JsonRpcProvider(env.POLYGON_RPC_URL, 137, { staticNetwork: true });
}

export function getPolygonExecutor(env: Env) {
  if (!env.POLYGON_EXECUTOR_PRIVATE_KEY) throw new Error("POLYGON_EXECUTOR_PRIVATE_KEY is required");
  return new Wallet(env.POLYGON_EXECUTOR_PRIVATE_KEY, getPolygonProvider(env));
}

export function getPusdVaultV2(env: Env, vaultAddress: string, write = false) {
  if (!isAddress(vaultAddress)) throw new Error(`Invalid TeamIndex V2 vault address: ${vaultAddress}`);
  return new Contract(
    vaultAddress,
    TEAM_INDEX_PUSD_VAULT_V2_ABI,
    write ? getPolygonExecutor(env) : getPolygonProvider(env),
  );
}

async function waitHash(txPromise: Promise<any>): Promise<string> {
  const tx = await txPromise;
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error("Polygon vault transaction failed");
  return receipt.hash;
}

export async function activatePoolProposal(
  env: Env,
  vaultAddress: string,
  proposalHash: string,
  allocationBaseUnits: bigint,
) {
  return waitHash(
    (getPusdVaultV2(env, vaultAddress, true) as any).activateProposal(
      proposalHash,
      allocationBaseUnits,
    ),
  );
}

export async function allocatePoolCapital(
  env: Env,
  vaultAddress: string,
  proposalHash: string,
  amountBaseUnits: bigint,
) {
  return waitHash(
    (getPusdVaultV2(env, vaultAddress, true) as any).allocateToDepositWallet(
      amountBaseUnits,
      proposalHash,
    ),
  );
}

export async function syncPoolReturnedCapital(env: Env, vaultAddress: string) {
  return waitHash((getPusdVaultV2(env, vaultAddress, true) as any).syncReturnedCapital());
}

export async function recordPoolExternalValuation(
  env: Env,
  vaultAddress: string,
  params: {
    sequence: bigint;
    externalAssetsBaseUnits: bigint;
    reservedCollateralBaseUnits: bigint;
    valuedAt: number;
    snapshotHash: string;
  },
) {
  return waitHash(
    (getPusdVaultV2(env, vaultAddress, true) as any).recordExternalValuation(
      params.sequence,
      params.externalAssetsBaseUnits,
      params.reservedCollateralBaseUnits,
      params.valuedAt,
      params.snapshotHash,
    ),
  );
}

export async function makePoolRedemptionClaimable(
  env: Env,
  vaultAddress: string,
  requestId: bigint,
) {
  return waitHash(
    (getPusdVaultV2(env, vaultAddress, true) as any).makeRedemptionClaimable(requestId),
  );
}

export async function pausePoolVaultV2(env: Env, vaultAddress: string) {
  return waitHash((getPusdVaultV2(env, vaultAddress, true) as any).pause());
}

export async function unpausePoolVaultV2(env: Env, vaultAddress: string) {
  return waitHash((getPusdVaultV2(env, vaultAddress, true) as any).unpause());
}

export async function deployPoolVaultV2(
  env: Env,
  params: {
    poolId: string;
    clubName: string;
    symbol: string;
    depositCapBaseUnits: bigint;
    depositWalletAddress: string;
    depositWalletOwner: string;
  },
) {
  if (!env.TEAM_INDEX_V2_FACTORY_ADDRESS || !isAddress(env.TEAM_INDEX_V2_FACTORY_ADDRESS)) {
    throw new Error("TEAM_INDEX_V2_FACTORY_ADDRESS is required to deploy a pool vault");
  }
  const factory = new Contract(
    env.TEAM_INDEX_V2_FACTORY_ADDRESS,
    TEAM_INDEX_V2_FACTORY_ABI,
    getPolygonExecutor(env),
  );
  const poolIdHash = keccak256(toUtf8Bytes(`team-index:${params.poolId}`));
  const existing = (await (factory as any).getVaultByPool(poolIdHash)) as string;
  if (existing !== "0x0000000000000000000000000000000000000000") {
    return { vaultAddress: existing, poolIdHash, created: false, txHash: null as string | null };
  }
  const tx = await (factory as any).createPoolVault(
    poolIdHash,
    `TeamIndex ${params.clubName}`,
    `ti${params.symbol}`.slice(0, 11),
    params.depositCapBaseUnits,
    params.depositWalletAddress,
    params.depositWalletOwner,
  );
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error("TeamIndex V2 vault deployment failed");
  const vaultAddress = (await (factory as any).getVaultByPool(poolIdHash)) as string;
  if (!isAddress(vaultAddress) || vaultAddress === "0x0000000000000000000000000000000000000000") {
    throw new Error("TeamIndex V2 factory did not register the new vault");
  }
  return { vaultAddress, poolIdHash, created: true, txHash: receipt.hash as string };
}
