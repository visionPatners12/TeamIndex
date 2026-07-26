import { createHash } from "node:crypto";
import { CdpClient } from "@coinbase/cdp-sdk";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import { RelayClient } from "@polymarket/builder-relayer-client";
import { Chain, ClobClient, SignatureTypeV2 } from "@polymarket/clob-client-v2";
import { encodeFunctionData, maxUint256 } from "viem";
import type { Env } from "../config/env";
import { prisma } from "../db/prisma";
import { encryptPoolCredential } from "./credentialCrypto";
import { CdpPolymarketSigner } from "./cdpSigner";
import { assertPolymarketEgressAllowed } from "./egress";
import { POLYMARKET_CHAIN_ID } from "./constants";
import { deployPoolVaultV2 } from "../onchain/polygonV2";
import { decimalToBaseUnits } from "./money";
import { assertPolymarketVaultDirectSupported } from "./constants";

type DepositWalletSigner = { createWalletClient(): any };

const erc20ApproveAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const erc1155ApprovalAbi = [
  {
    type: "function",
    name: "setApprovalForAll",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
] as const;

function cdpAccountName(poolId: string): string {
  return `ti-${createHash("sha256").update(poolId).digest("hex").slice(0, 24)}`;
}

function requireCdp(env: Env) {
  if (!env.CDP_API_KEY_ID || !env.CDP_API_KEY_SECRET || !env.CDP_WALLET_SECRET) {
    throw new Error("CDP server-wallet credentials are required to bootstrap a pool");
  }
  return new CdpClient({
    apiKeyId: env.CDP_API_KEY_ID,
    apiKeySecret: env.CDP_API_KEY_SECRET,
    walletSecret: env.CDP_WALLET_SECRET,
  });
}

function builderConfig(env: Env): BuilderConfig {
  if (!env.POLY_BUILDER_API_KEY || !env.POLY_BUILDER_SECRET || !env.POLY_BUILDER_PASSPHRASE) {
    throw new Error("POLY_BUILDER_API_KEY, POLY_BUILDER_SECRET and POLY_BUILDER_PASSPHRASE are required");
  }
  return new BuilderConfig({
    localBuilderCreds: {
      key: env.POLY_BUILDER_API_KEY,
      secret: env.POLY_BUILDER_SECRET,
      passphrase: env.POLY_BUILDER_PASSPHRASE,
    },
  });
}

export function createPoolRelayClient(env: Env, signer: DepositWalletSigner) {
  return new RelayClient(
    env.POLYMARKET_RELAYER_URL,
    POLYMARKET_CHAIN_ID,
    signer.createWalletClient() as any,
    builderConfig(env),
  );
}

export async function bootstrapPoolPolymarketAccountLocal(env: Env, poolId: string) {
  assertPolymarketVaultDirectSupported("Polymarket account bootstrap");
  if (env.TRADING_PROVIDER !== "polymarket") throw new Error("Polymarket is not the active provider");
  await assertPolymarketEgressAllowed(env);

  const pool = await prisma.club_pools.findUnique({ where: { id: poolId } });
  if (!pool) throw new Error("Pool not found");
  const provisionalVaultAddress = pool.vaultAddress ?? env.TEAM_INDEX_V2_FACTORY_ADDRESS;
  if (!provisionalVaultAddress) {
    throw new Error("TEAM_INDEX_V2_FACTORY_ADDRESS is required before bootstrapping Polymarket");
  }

  const accountName = cdpAccountName(poolId);
  const cdpAccount = await requireCdp(env).evm.getOrCreateAccount({ name: accountName });
  const provisionalSigner = new CdpPolymarketSigner(env, {
    ownerAddress: cdpAccount.address,
    vaultAddress: provisionalVaultAddress,
  });
  const provisionalRelay = createPoolRelayClient(env, provisionalSigner);
  const depositWalletAddress = await provisionalRelay.deriveDepositWalletAddress();

  const existing = await prisma.pool_polymarket_accounts.findUnique({ where: { poolId } });
  if (existing && existing.cdpOwnerAddress.toLowerCase() !== cdpAccount.address.toLowerCase()) {
    throw new Error("Existing pool account belongs to another CDP EOA; automatic key rotation is disabled");
  }
  if (existing && existing.depositWalletAddress.toLowerCase() !== depositWalletAddress.toLowerCase()) {
    throw new Error("Derived Deposit Wallet differs from the registered one; automatic rotation is disabled");
  }

  const deployed = await provisionalRelay.getDeployed(depositWalletAddress, "WALLET");
  let deployTransactionId: string | null = null;
  if (!deployed) {
    const deployment = await provisionalRelay.deployDepositWallet();
    deployTransactionId = deployment.transactionID;
    const mined = await deployment.wait();
    if (!mined || ["STATE_FAILED", "STATE_INVALID"].includes(mined.state)) {
      throw new Error("Polymarket Deposit Wallet deployment failed");
    }
  }

  let vaultAddress = pool.vaultAddress;
  let vaultDeployment: Awaited<ReturnType<typeof deployPoolVaultV2>> | null = null;
  if (!vaultAddress) {
    const configuredCap = BigInt(pool.depositCap.toString().split(".")[0] || "0");
    vaultDeployment = await deployPoolVaultV2(env, {
      poolId,
      clubName: pool.clubName,
      symbol: pool.symbol,
      depositCapBaseUnits:
        configuredCap > 0n ? configuredCap : decimalToBaseUnits(env.POLYMARKET_PILOT_TVL_PUSD),
      depositWalletAddress,
      depositWalletOwner: cdpAccount.address,
    });
    vaultAddress = vaultDeployment.vaultAddress;
    await prisma.club_pools.update({ where: { id: poolId }, data: { vaultAddress } });
  }

  const signer = new CdpPolymarketSigner(env, {
    ownerAddress: cdpAccount.address,
    depositWalletAddress,
    vaultAddress,
  });
  const unauthenticatedClient = new ClobClient({
    host: env.POLYMARKET_CLOB_URL,
    chain: Chain.POLYGON,
    signer: signer as any,
    signatureType: SignatureTypeV2.POLY_1271,
    funderAddress: depositWalletAddress,
    useServerTime: true,
    throwOnError: true,
    builderConfig: env.POLYMARKET_BUILDER_CODE
      ? { builderCode: env.POLYMARKET_BUILDER_CODE }
      : undefined,
  });
  const credentials = await unauthenticatedClient.createOrDeriveApiKey();

  const row = await prisma.pool_polymarket_accounts.upsert({
    where: { poolId },
    create: {
      poolId,
      cdpAccountName: accountName,
      cdpOwnerAddress: cdpAccount.address,
      depositWalletAddress,
      vaultAddress,
      clobApiKeyCiphertext: encryptPoolCredential(env, poolId, "apiKey", credentials.key),
      clobSecretCiphertext: encryptPoolCredential(env, poolId, "secret", credentials.secret),
      clobPassphraseCiphertext: encryptPoolCredential(env, poolId, "passphrase", credentials.passphrase),
      status: "DEPLOYED",
      rawJson: { deployTransactionId },
    },
    update: {
      vaultAddress,
      clobApiKeyCiphertext: encryptPoolCredential(env, poolId, "apiKey", credentials.key),
      clobSecretCiphertext: encryptPoolCredential(env, poolId, "secret", credentials.secret),
      clobPassphraseCiphertext: encryptPoolCredential(env, poolId, "passphrase", credentials.passphrase),
      status: "DEPLOYED",
      rawJson: { deployTransactionId },
    },
  });

  return {
    id: row.id,
    poolId,
    cdpAccountName: accountName,
    cdpOwnerAddress: cdpAccount.address,
    depositWalletAddress,
    vaultAddress,
    deployed: true,
    deployTransactionId,
    vaultDeployment,
    approvalsReady: row.approvalsReady,
  };
}

export async function ensurePoolDepositWalletApprovalsLocal(env: Env, poolId: string) {
  assertPolymarketVaultDirectSupported("Polymarket Deposit Wallet approvals");
  const account = await prisma.pool_polymarket_accounts.findUnique({ where: { poolId } });
  if (!account) throw new Error("Pool Polymarket account is not bootstrapped");
  const signer = new CdpPolymarketSigner(env, {
    ownerAddress: account.cdpOwnerAddress,
    depositWalletAddress: account.depositWalletAddress,
    vaultAddress: account.vaultAddress,
  });
  const relay = createPoolRelayClient(env, signer);
  const calls = [
    env.POLYMARKET_CTF_EXCHANGE_ADDRESS,
    env.POLYMARKET_NEG_RISK_EXCHANGE_ADDRESS,
  ].flatMap((exchange) => [
    {
      target: env.POLYMARKET_PUSD_ADDRESS,
      value: "0",
      data: encodeFunctionData({
        abi: erc20ApproveAbi,
        functionName: "approve",
        args: [exchange as `0x${string}`, maxUint256],
      }),
    },
    {
      target: env.POLYMARKET_CTF_ADDRESS,
      value: "0",
      data: encodeFunctionData({
        abi: erc1155ApprovalAbi,
        functionName: "setApprovalForAll",
        args: [exchange as `0x${string}`, true],
      }),
    },
  ]);
  const deadline = String(Math.floor(Date.now() / 1000) + 10 * 60);
  const transaction = await relay.executeDepositWalletBatch(
    calls,
    account.depositWalletAddress,
    deadline,
  );
  const mined = await transaction.wait();
  if (!mined || ["STATE_FAILED", "STATE_INVALID"].includes(mined.state)) {
    throw new Error("Deposit Wallet approval batch failed");
  }
  await prisma.pool_polymarket_accounts.update({
    where: { poolId },
    data: {
      approvalsReady: true,
      status: "READY",
      rawJson: { approvalTransactionId: transaction.transactionID, approvalTransactionHash: mined.transactionHash },
    },
  });
  return {
    transactionId: transaction.transactionID,
    transactionHash: mined.transactionHash,
    depositWalletAddress: account.depositWalletAddress,
  };
}

async function callSignerService(env: Env, path: string, poolId: string) {
  if (!env.POLYMARKET_SIGNER_URL || !env.POLYMARKET_SIGNER_TOKEN) {
    throw new Error("POLYMARKET_SIGNER_URL and POLYMARKET_SIGNER_TOKEN are required");
  }
  const response = await fetch(new URL(path, env.POLYMARKET_SIGNER_URL), {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.POLYMARKET_SIGNER_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ poolId }),
    signal: AbortSignal.timeout(120_000),
  });
  const payload = (await response.json()) as any;
  if (!response.ok) throw new Error(payload?.error ?? `Signer service failed (${response.status})`);
  return payload;
}

export async function bootstrapPoolPolymarketAccount(env: Env, poolId: string) {
  if (env.POLYMARKET_SIGNER_URL && env.PROCESS_ROLE !== "signer") {
    return callSignerService(env, "/internal/polymarket/bootstrap", poolId);
  }
  return bootstrapPoolPolymarketAccountLocal(env, poolId);
}

export async function ensurePoolDepositWalletApprovals(env: Env, poolId: string) {
  if (env.POLYMARKET_SIGNER_URL && env.PROCESS_ROLE !== "signer") {
    return callSignerService(env, "/internal/polymarket/approvals", poolId);
  }
  return ensurePoolDepositWalletApprovalsLocal(env, poolId);
}
