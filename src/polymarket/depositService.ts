import {
  Contract,
  Interface,
  getAddress,
  isAddress,
  keccak256,
  parseUnits,
  toUtf8Bytes,
} from "ethers";
import type { Env } from "../config/env";
import { prisma } from "../db/prisma";
import { getPolygonExecutor, getPolygonProvider, getPusdVaultV2 } from "../onchain/polygonV2";
import { assertPolymarketVaultDirectSupported } from "./constants";

const erc20Interface = new Interface([
  "function approve(address spender,uint256 amount) returns (bool)",
  "function transfer(address to,uint256 amount) returns (bool)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const vaultInterface = new Interface(["function deposit(uint256 assets,address receiver) returns (uint256)"]);
const escrowAbi = [
  "function settle(bytes32 intentId,address vault,address receiver,uint256 assets) returns (uint256)",
] as const;

function normalizeAddress(value: string, label: string) {
  if (!isAddress(value)) throw new Error(`${label} is not a valid EVM address`);
  return getAddress(value);
}

function positiveBaseUnits(value: string) {
  const assets = BigInt(value);
  if (assets <= 0n) throw new Error("assets must be positive pUSD base units");
  return assets;
}

export async function createPoolDepositIntent(
  env: Env,
  params: {
    poolId: string;
    idempotencyKey: string;
    userAddress: string;
    depositWalletAddress: string;
    receiverAddress: string;
    assets: string;
  },
) {
  assertPolymarketVaultDirectSupported("Polymarket Deposit Wallet deposit");
  const pool = await prisma.club_pools.findUnique({ where: { id: params.poolId } });
  if (!pool?.vaultAddress) throw new Error("Pool V2 vault not found");
  const userAddress = normalizeAddress(params.userAddress, "userAddress");
  const depositWalletAddress = normalizeAddress(params.depositWalletAddress, "depositWalletAddress");
  const receiverAddress = normalizeAddress(params.receiverAddress, "receiverAddress");
  const assets = positiveBaseUnits(params.assets);

  const vault = getPusdVaultV2(env, pool.vaultAddress);
  const [vaultAsset, totalAssets] = await Promise.all([
    (vault as any).asset() as Promise<string>,
    (vault as any).totalAssets() as Promise<bigint>,
  ]);
  if (vaultAsset.toLowerCase() !== env.POLYMARKET_PUSD_ADDRESS.toLowerCase()) {
    throw new Error("Pool vault asset is not Polymarket pUSD");
  }
  const pilotCap = parseUnits(env.POLYMARKET_PILOT_TVL_PUSD, 6);
  if (totalAssets + assets > pilotCap) throw new Error("Polymarket pilot TVL cap exceeded");

  const intent = await prisma.pool_deposit_intents.upsert({
    where: { idempotencyKey: params.idempotencyKey },
    create: {
      poolId: params.poolId,
      idempotencyKey: params.idempotencyKey,
      userAddress,
      depositWalletAddress,
      receiverAddress,
      assets: assets.toString(),
    },
    update: {},
  });
  if (
    intent.poolId !== params.poolId
    || intent.depositWalletAddress.toLowerCase() !== depositWalletAddress.toLowerCase()
    || intent.assets.toString() !== assets.toString()
  ) {
    throw new Error("Idempotency key already belongs to a different deposit intent");
  }

  const directCalls = [
    {
      target: env.POLYMARKET_PUSD_ADDRESS,
      value: "0",
      data: erc20Interface.encodeFunctionData("approve", [pool.vaultAddress, assets]),
    },
    {
      target: pool.vaultAddress,
      value: "0",
      data: vaultInterface.encodeFunctionData("deposit", [assets, receiverAddress]),
    },
  ];

  const escrowAddress = env.TEAM_INDEX_DEPOSIT_ESCROW_ADDRESS
    ? normalizeAddress(env.TEAM_INDEX_DEPOSIT_ESCROW_ADDRESS, "TEAM_INDEX_DEPOSIT_ESCROW_ADDRESS")
    : null;
  const fallbackCalls = escrowAddress
    ? [
        {
          target: env.POLYMARKET_PUSD_ADDRESS,
          value: "0",
          data: erc20Interface.encodeFunctionData("transfer", [escrowAddress, assets]),
        },
      ]
    : [];

  return {
    intentId: intent.id,
    chainId: 137,
    assetAddress: env.POLYMARKET_PUSD_ADDRESS,
    vaultAddress: pool.vaultAddress,
    depositWalletAddress,
    receiverAddress,
    assets: assets.toString(),
    direct: { mode: "DEPOSIT_WALLET_BATCH", calls: directCalls },
    fallback: escrowAddress
      ? { mode: "PUSD_TRANSFER_TO_ESCROW", escrowAddress, calls: fallbackCalls }
      : null,
  };
}

export async function confirmPoolDepositIntent(
  env: Env,
  intentId: string,
  txHash: string,
  mode: "DIRECT" | "ESCROW",
) {
  const intent = await prisma.pool_deposit_intents.findUnique({
    where: { id: intentId },
    include: { pool: true },
  });
  if (!intent?.pool.vaultAddress) throw new Error("Deposit intent or vault not found");
  const receipt = await getPolygonProvider(env).getTransactionReceipt(txHash);
  if (!receipt || receipt.status !== 1) throw new Error("Polygon deposit transaction is not successful");

  if (mode === "DIRECT") {
    const touchesVault = receipt.logs.some(
      (log) => log.address.toLowerCase() === intent.pool.vaultAddress!.toLowerCase(),
    );
    if (!touchesVault) throw new Error("Transaction did not call the expected TeamIndex vault");
    return prisma.pool_deposit_intents.update({
      where: { id: intentId },
      data: { status: "COMPLETED", txHash: receipt.hash },
    });
  }

  if (!env.TEAM_INDEX_DEPOSIT_ESCROW_ADDRESS) throw new Error("Deposit escrow is not configured");
  const escrowAddress = env.TEAM_INDEX_DEPOSIT_ESCROW_ADDRESS.toLowerCase();
  const expectedAmount = BigInt(intent.assets.toString());
  const validTransfer = receipt.logs.some((log) => {
    if (log.address.toLowerCase() !== env.POLYMARKET_PUSD_ADDRESS.toLowerCase()) return false;
    try {
      const parsed = erc20Interface.parseLog(log);
      return (
        parsed?.name === "Transfer"
        && String(parsed.args.from).toLowerCase() === intent.depositWalletAddress.toLowerCase()
        && String(parsed.args.to).toLowerCase() === escrowAddress
        && BigInt(parsed.args.value.toString()) === expectedAmount
      );
    } catch {
      return false;
    }
  });
  if (!validTransfer) throw new Error("Expected pUSD transfer from Deposit Wallet to escrow was not found");

  const escrow = new Contract(
    env.TEAM_INDEX_DEPOSIT_ESCROW_ADDRESS,
    escrowAbi,
    getPolygonExecutor(env),
  );
  const onchainIntentId = keccak256(toUtf8Bytes(`team-index-deposit:${intent.id}`));
  const settlement = await (escrow as any).settle(
    onchainIntentId,
    intent.pool.vaultAddress,
    intent.receiverAddress,
    expectedAmount,
  );
  const settlementReceipt = await settlement.wait();
  if (!settlementReceipt || settlementReceipt.status !== 1) throw new Error("Escrow settlement failed");
  return prisma.pool_deposit_intents.update({
    where: { id: intentId },
    data: { status: "COMPLETED", txHash: settlementReceipt.hash },
  });
}
