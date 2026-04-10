import { ethers } from "ethers";
import type { Env } from "../config/env";
import { WRAPPED_VAULT_SHARE } from "../contracts/wrappedVaultShare";
import { CHILIZ_DEPOSIT_RECEIVER } from "../contracts/chilizDepositReceiver";

export function getChilizProvider(env: Env) {
  if (!env.CHILIZ_RPC_URL) throw new Error("CHILIZ_RPC_URL not set");
  return new ethers.JsonRpcProvider(env.CHILIZ_RPC_URL);
}

export function getChilizSigner(env: Env) {
  if (!env.CHILIZ_EXECUTOR_PRIVATE_KEY) throw new Error("CHILIZ_EXECUTOR_PRIVATE_KEY not set");
  const provider = getChilizProvider(env);
  return new ethers.Wallet(env.CHILIZ_EXECUTOR_PRIVATE_KEY, provider);
}

export function getWrappedShareContract(env: Env, signerOrProvider?: ethers.Signer | ethers.Provider) {
  if (!env.CHILIZ_WRAPPED_SHARE_ADDRESS) throw new Error("CHILIZ_WRAPPED_SHARE_ADDRESS not set");
  const sp = signerOrProvider ?? getChilizSigner(env);
  return new ethers.Contract(env.CHILIZ_WRAPPED_SHARE_ADDRESS, WRAPPED_VAULT_SHARE.abi, sp);
}

export function getDepositReceiverContract(env: Env, signerOrProvider?: ethers.Signer | ethers.Provider) {
  if (!env.CHILIZ_DEPOSIT_RECEIVER_ADDRESS) throw new Error("CHILIZ_DEPOSIT_RECEIVER_ADDRESS not set");
  const sp = signerOrProvider ?? getChilizProvider(env);
  return new ethers.Contract(env.CHILIZ_DEPOSIT_RECEIVER_ADDRESS, CHILIZ_DEPOSIT_RECEIVER.abi, sp);
}

export async function mintWrappedShares(
  env: Env,
  to: string,
  amount: bigint,
  polygonDepositId: string
): Promise<ethers.TransactionResponse> {
  const contract = getWrappedShareContract(env);
  const tx = await contract.mint(to, amount, polygonDepositId);
  return tx;
}

export async function burnWrappedShares(
  env: Env,
  from: string,
  amount: bigint,
  redemptionId: string
): Promise<ethers.TransactionResponse> {
  const contract = getWrappedShareContract(env);
  const tx = await contract.burn(from, amount, redemptionId);
  return tx;
}
