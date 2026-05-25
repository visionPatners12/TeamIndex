import { ethers } from "ethers";
import type { Env } from "../config/env";
import { BASE_DEPOSIT_RECEIVER } from "../contracts/baseDepositReceiver";
import { WRAPPED_VAULT_SHARE } from "../contracts/wrappedVaultShare";

export function getBaseProvider(env: Env) {
  if (!env.BASE_RPC_URL) throw new Error("BASE_RPC_URL not set");
  return new ethers.JsonRpcProvider(env.BASE_RPC_URL);
}

export function getBaseSigner(env: Env) {
  if (!env.BASE_EXECUTOR_PRIVATE_KEY) throw new Error("BASE_EXECUTOR_PRIVATE_KEY not set");
  const provider = getBaseProvider(env);
  return new ethers.Wallet(env.BASE_EXECUTOR_PRIVATE_KEY, provider);
}

export function getBaseDepositReceiverContract(env: Env, signerOrProvider?: ethers.Signer | ethers.Provider) {
  if (!env.BASE_DEPOSIT_RECEIVER_ADDRESS) throw new Error("BASE_DEPOSIT_RECEIVER_ADDRESS not set");
  const sp = signerOrProvider ?? getBaseProvider(env);
  return new ethers.Contract(env.BASE_DEPOSIT_RECEIVER_ADDRESS, BASE_DEPOSIT_RECEIVER.abi, sp);
}

export function getBaseWrappedShareContract(env: Env, signerOrProvider?: ethers.Signer | ethers.Provider) {
  if (!env.BASE_WRAPPED_SHARE_ADDRESS) throw new Error("BASE_WRAPPED_SHARE_ADDRESS not set");
  const sp = signerOrProvider ?? getBaseSigner(env);
  return new ethers.Contract(env.BASE_WRAPPED_SHARE_ADDRESS, WRAPPED_VAULT_SHARE.abi, sp);
}

export async function mintBaseWrappedShares(
  env: Env,
  to: string,
  amount: bigint,
  polygonDepositId: string
): Promise<ethers.TransactionResponse> {
  const contract = getBaseWrappedShareContract(env);
  return contract.mint(to, amount, polygonDepositId);
}
