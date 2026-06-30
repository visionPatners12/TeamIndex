import { ethers } from "ethers";
import type { Env } from "../config/env";
import { USDC4626VAULT } from "../contracts/usdc4626vault";
import { getBaseProvider } from "./rpc";

const CLUB_VAULT_FACTORY_ABI = ["function getVaultByClub(bytes32 clubId) view returns (address)"];
const ERC20_ALLOWANCE_APPROVE_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

type PoolIdentity = {
  clubName: string;
  // If backend already stored a vault address for this pool, prefer it.
  vaultAddress?: string;
};

function computeClubId(clubName: string) {
  // Vault factory uses `bytes32 clubId` -> vault mapping.
  // MVP convention: clubId = keccak256(abi.encodePacked(clubName)).
  return ethers.solidityPackedKeccak256(["string"], [clubName]);
}

async function resolveVaultAddressFromFactory(env: Env, provider: ethers.Provider, pool: PoolIdentity) {
  if (!env.CLUB_VAULT_FACTORY_ADDRESS) return undefined;
  const factory = new ethers.Contract(env.CLUB_VAULT_FACTORY_ADDRESS, CLUB_VAULT_FACTORY_ABI, provider);
  const clubId = computeClubId(pool.clubName);
  const resolved = (await factory.getVaultByClub(clubId)) as string;
  if (!resolved || resolved === ethers.ZeroAddress) return undefined;
  return resolved;
}

export async function getVaultContract(
  env: Env,
  provider?: ethers.Provider,
  pool?: PoolIdentity
) {
  if (!provider) {
    provider = getBaseProvider(env);
  }

  const placeholderAddress = "0x0000000000000000000000000000000000000001";

  // Priority:
  // 1) Explicit stored vault address from DB (`pool.vaultAddress`)
  // 2) env.VAULT_CONTRACT_ADDRESS
  // 3) Resolve via factory (`CLUB_VAULT_FACTORY_ADDRESS`)
  let vaultAddress = pool?.vaultAddress ?? env.VAULT_CONTRACT_ADDRESS;

  if (pool && (!vaultAddress || vaultAddress === placeholderAddress)) {
    const resolved = await resolveVaultAddressFromFactory(env, provider, pool);
    if (resolved) vaultAddress = resolved;
  }

  if (!vaultAddress) throw new Error("VAULT_CONTRACT_ADDRESS missing");
  if (vaultAddress === "0x0000000000000000000000000000000000000001") {
    throw new Error(
      "VAULT_CONTRACT_ADDRESS is still a placeholder. Set VAULT_CONTRACT_ADDRESS or configure CLUB_VAULT_FACTORY_ADDRESS."
    );
  }

  const signer = env.BASE_EXECUTOR_PRIVATE_KEY ? new ethers.Wallet(env.BASE_EXECUTOR_PRIVATE_KEY, provider) : undefined;
  return new ethers.Contract(vaultAddress, USDC4626VAULT.abi, signer ?? provider);
}

export async function executeWhitelistedCallViaVault(
  env: Env,
  pool: PoolIdentity | undefined,
  params: {
  target: string;
  data: string; // hex
  value: bigint;
  assetAmount: bigint;
  minReturn: bigint;
  isTrustedRequired: boolean;
}) {
  const vault = await getVaultContract(env, undefined, pool);
  if (!("executeWhitelistedCall" in vault)) {
    throw new Error("Vault contract missing executeWhitelistedCall");
  }

  // Note: vault contract expects `uint256` args as BigInt compatible.
  const tx = await (vault as any).executeWhitelistedCall(
    params.target,
    params.data,
    params.value,
    params.assetAmount,
    params.minReturn,
    params.isTrustedRequired
  );

  return tx;
}

export async function ensureVaultErc20Allowance(
  env: Env,
  pool: PoolIdentity | undefined,
  params: {
    token: string;
    spender: string;
    minAllowance: bigint;
    minBalance?: bigint;
    approveAmount?: bigint;
  }
) {
  const provider = getBaseProvider(env);
  const vault = await getVaultContract(env, provider, pool);
  const vaultAddress = ((vault as any).target ?? (vault as any).address) as string;
  const token = new ethers.Contract(params.token, ERC20_ALLOWANCE_APPROVE_ABI, provider);

  const balance = (await (token as any).balanceOf(vaultAddress)) as bigint;
  if (params.minBalance !== undefined && balance < params.minBalance) {
    throw new Error(
      `Vault token balance too low for Limitless order: balance=${balance.toString()} required=${params.minBalance.toString()} token=${params.token} vault=${vaultAddress}`
    );
  }

  const currentAllowance = (await (token as any).allowance(vaultAddress, params.spender)) as bigint;
  if (currentAllowance >= params.minAllowance) {
    return {
      approved: false,
      whitelisted: await isWhitelistedContract(env, pool, params.token).catch(() => false),
      vaultAddress,
      token: params.token,
      spender: params.spender,
      balance: balance.toString(),
      allowance: currentAllowance.toString(),
      required: params.minAllowance.toString(),
    };
  }

  let whitelisted = await isWhitelistedContract(env, pool, params.token).catch(() => false);
  let whitelistTxHash: string | null = null;
  if (!whitelisted) {
    const tx = await adminAddWhitelistedContract(env, pool, params.token);
    whitelistTxHash = (tx as any)?.hash ?? null;
    if (typeof (tx as any)?.wait === "function") await (tx as any).wait();
    whitelisted = await isWhitelistedContract(env, pool, params.token);
  }

  const iface = new ethers.Interface(ERC20_ALLOWANCE_APPROVE_ABI);
  const approveAmount = params.approveAmount ?? ethers.MaxUint256;
  const data = iface.encodeFunctionData("approve", [params.spender, approveAmount]);
  const approveTx = await executeWhitelistedCallViaVault(env, pool, {
    target: params.token,
    data,
    value: 0n,
    assetAmount: 0n,
    minReturn: 0n,
    isTrustedRequired: false,
  });
  if (typeof (approveTx as any)?.wait === "function") await (approveTx as any).wait();

  const allowance = (await (token as any).allowance(vaultAddress, params.spender)) as bigint;
  if (allowance < params.minAllowance) {
    throw new Error(
      `Vault allowance still too low after approve: ${allowance.toString()} < ${params.minAllowance.toString()}`
    );
  }

  return {
    approved: true,
    whitelisted,
    vaultAddress,
    token: params.token,
    spender: params.spender,
    balance: balance.toString(),
    required: params.minAllowance.toString(),
    allowance: allowance.toString(),
    approveAmount: approveAmount.toString(),
    whitelistTxHash,
    approveTxHash: (approveTx as any)?.hash ?? null,
  };
}

export async function getErc20Balance(
  env: Env,
  tokenAddress: string,
  accountAddress: string
): Promise<bigint> {
  const provider = getBaseProvider(env);
  const token = new ethers.Contract(tokenAddress, ERC20_ALLOWANCE_APPROVE_ABI, provider);
  return (await (token as any).balanceOf(accountAddress)) as bigint;
}

export async function adminSetTradingWallet(
  env: Env,
  pool: PoolIdentity | undefined,
  params: { wallet: string; allowed: boolean }
) {
  const vault = await getVaultContract(env, undefined, pool);
  return (vault as any).setTradingWallet(params.wallet, params.allowed);
}

export async function isTradingWallet(
  env: Env,
  pool: PoolIdentity | undefined,
  wallet: string
): Promise<boolean> {
  const vault = await getVaultContract(env, undefined, pool);
  if (!("isTradingWallet" in vault)) throw new Error("Vault missing isTradingWallet");
  return (await (vault as any).isTradingWallet(wallet)) as boolean;
}

export async function fundTradingWalletFromVault(
  env: Env,
  pool: PoolIdentity | undefined,
  params: {
    wallet: string;
    amount: bigint;
  }
) {
  if (params.amount <= 0n) {
    return {
      funded: false,
      wallet: params.wallet,
      amount: params.amount.toString(),
      txHash: null,
    };
  }

  const vault = await getVaultContract(env, undefined, pool);
  if (!("fundTradingWallet" in vault)) {
    throw new Error(
      "Vault does not support linked trading wallets. Redeploy the pool vault with the current USDC4626Vault before server-wallet betting."
    );
  }

  const tx = await (vault as any).fundTradingWallet(params.wallet, params.amount);
  if (typeof (tx as any)?.wait === "function") await (tx as any).wait();
  return {
    funded: true,
    wallet: params.wallet,
    amount: params.amount.toString(),
    txHash: (tx as any)?.hash ?? null,
  };
}

export async function adminAddAuthorizedOperator(env: Env, pool: PoolIdentity | undefined, params: {
  operator: string;
  allocation: bigint;
  transactionCap: bigint;
}) {
  const vault = await getVaultContract(env, undefined, pool);
  return (vault as any).addAuthorizedOperator(params.operator, params.allocation, params.transactionCap);
}

export async function adminAddWhitelistedContract(env: Env, pool: PoolIdentity | undefined, contractAddress: string) {
  const vault = await getVaultContract(env, undefined, pool);
  return (vault as any).addWhitelistedContract(contractAddress);
}

export async function adminPause(env: Env, pool?: PoolIdentity) {
  const vault = await getVaultContract(env, undefined, pool);
  return (vault as any).pause();
}

export async function adminUnpause(env: Env, pool?: PoolIdentity) {
  const vault = await getVaultContract(env, undefined, pool);
  return (vault as any).unpause();
}

export async function adminRemoveAuthorizedOperator(env: Env, pool: PoolIdentity | undefined, operator: string) {
  const vault = await getVaultContract(env, undefined, pool);
  return (vault as any).removeAuthorizedOperator(operator);
}

export async function adminSetOperatorAllocation(
  env: Env,
  pool: PoolIdentity | undefined,
  params: { operator: string; newAllocation: bigint }
) {
  const vault = await getVaultContract(env, undefined, pool);
  return (vault as any).setOperatorAllocation(params.operator, params.newAllocation);
}

export async function adminSetOperatorTransactionCap(
  env: Env,
  pool: PoolIdentity | undefined,
  params: { operator: string; newTxCap: bigint }
) {
  const vault = await getVaultContract(env, undefined, pool);
  return (vault as any).setOperatorTransactionCap(params.operator, params.newTxCap);
}

export async function adminRemoveWhitelistedContract(env: Env, pool: PoolIdentity | undefined, contractAddress: string) {
  const vault = await getVaultContract(env, undefined, pool);
  return (vault as any).removeWhitelistedContract(contractAddress);
}

export async function isWhitelistedContract(env: Env, pool: PoolIdentity | undefined, contractAddress: string): Promise<boolean> {
  const vault = await getVaultContract(env, undefined, pool);
  if (!("isWhitelistedContract" in vault)) throw new Error("Vault missing isWhitelistedContract");
  return (await (vault as any).isWhitelistedContract(contractAddress)) as boolean;
}

export async function adminAddTrustedStrategy(env: Env, pool: PoolIdentity | undefined, strategy: string) {
  const vault = await getVaultContract(env, undefined, pool);
  return (vault as any).addTrustedStrategy(strategy);
}

export async function adminRemoveTrustedStrategy(env: Env, pool: PoolIdentity | undefined, strategy: string) {
  const vault = await getVaultContract(env, undefined, pool);
  return (vault as any).removeTrustedStrategy(strategy);
}

export async function isTrustedStrategy(env: Env, pool: PoolIdentity | undefined, strategy: string): Promise<boolean> {
  const vault = await getVaultContract(env, undefined, pool);
  if (!("isTrustedStrategy" in vault)) throw new Error("Vault missing isTrustedStrategy");
  return (await (vault as any).isTrustedStrategy(strategy)) as boolean;
}

export async function adminSetOrderSigner(
  env: Env,
  pool: PoolIdentity | undefined,
  params: { signer: string; allowed: boolean }
) {
  const vault = await getVaultContract(env, undefined, pool);
  return (vault as any).setOrderSigner(params.signer, params.allowed);
}

export async function isOrderSigner(env: Env, pool: PoolIdentity | undefined, signer: string): Promise<boolean> {
  const vault = await getVaultContract(env, undefined, pool);
  if (!("isOrderSigner" in vault)) throw new Error("Vault missing isOrderSigner");
  return (await (vault as any).isOrderSigner(signer)) as boolean;
}

export async function getAllOperators(env: Env, pool: PoolIdentity | undefined): Promise<string[]> {
  const vault = await getVaultContract(env, undefined, pool);
  return (await (vault as any).getAllOperators()) as string[];
}

export async function getOperatorInfo(env: Env, pool: PoolIdentity | undefined, operator: string) {
  const vault = await getVaultContract(env, undefined, pool);
  return (await (vault as any).getOperatorInfo(operator)) as {
    authorized: boolean;
    totalAlloc: bigint;
    currentAlloc: bigint;
    txCap: bigint;
  };
}

export async function getWhitelistedContracts(env: Env, pool: PoolIdentity | undefined): Promise<string[]> {
  const vault = await getVaultContract(env, undefined, pool);
  return (await (vault as any).getWhitelistedContracts()) as string[];
}

export async function getTrustedStrategies(env: Env, pool: PoolIdentity | undefined): Promise<string[]> {
  const vault = await getVaultContract(env, undefined, pool);
  return (await (vault as any).getTrustedStrategies()) as string[];
}
