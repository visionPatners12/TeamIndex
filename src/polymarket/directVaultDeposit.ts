import { Contract, Interface, formatUnits, getAddress, isAddress, parseUnits } from "ethers";
import type { Env } from "../config/env";
import { prisma } from "../db/prisma";
import { getPolygonProvider } from "../onchain/polygonV2";

const PUSD_DECIMALS = 6;
const vaultAbi = [
  "function asset() view returns (address)",
  "function maxDeposit(address) view returns (uint256)",
  "function previewDeposit(uint256) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function totalCash() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function deposit(uint256,address) returns (uint256)",
  "event Deposit(address indexed caller,address indexed owner,uint256 assets,uint256 shares)",
] as const;
const erc20 = new Interface(["function approve(address,uint256) returns (bool)"]);
const vaultInterface = new Interface(vaultAbi);

export function readSingleVaultDeposit(
  logs: readonly { address: string; data: string; topics: readonly string[] }[],
  vaultAddress: string,
) {
  const deposits = logs.flatMap((log) => {
    if (log.address.toLowerCase() !== vaultAddress.toLowerCase()) return [];
    try {
      const parsed = vaultInterface.parseLog({ data: log.data, topics: [...log.topics] });
      return parsed?.name === "Deposit" ? [parsed] : [];
    } catch { return []; }
  });
  if (deposits.length !== 1) throw new DirectDepositError("Expected exactly one vault Deposit event");
  const owner = getAddress(String(deposits[0].args.owner));
  const assets = BigInt(deposits[0].args.assets);
  const shares = BigInt(deposits[0].args.shares);
  if (assets <= 0n || shares <= 0n) throw new DirectDepositError("Invalid vault Deposit event");
  return { owner, assets, shares };
}

export class DirectDepositError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

async function loadVault(env: Env, poolId: string, requireActive = true) {
  const pool = await prisma.club_pools.findUnique({ where: { id: poolId } });
  if (!pool) throw new DirectDepositError("Pool not found", 404);
  if ((requireActive && pool.status !== "ACTIVE") || !pool.vaultAddress || !isAddress(pool.vaultAddress)) {
    throw new DirectDepositError("Pool vault is not ready");
  }
  const provider = getPolygonProvider(env);
  if (await provider.getCode(pool.vaultAddress) === "0x") {
    throw new DirectDepositError("Pool vault is not deployed on Polygon");
  }
  const vault = new Contract(pool.vaultAddress, vaultAbi, provider);
  const asset = getAddress(await vault.asset());
  if (asset !== getAddress(env.POLYMARKET_PUSD_ADDRESS)) {
    throw new DirectDepositError("Pool vault asset is not Polygon pUSD");
  }
  return { pool, vault, provider, asset };
}

export async function prepareDirectPusdDeposit(env: Env, poolId: string, assetsText: string, receiverText: string) {
  if (env.TEAM_INDEX_PUSD_DEPOSITS_ENABLED !== "true") {
    throw new DirectDepositError("Pilot pUSD deposits are disabled", 503);
  }
  const assets = BigInt(assetsText);
  if (assets <= 0n || !isAddress(receiverText)) throw new DirectDepositError("Invalid deposit", 400);
  const receiver = getAddress(receiverText);
  const { pool, vault, asset } = await loadVault(env, poolId);
  const [maximum, shares, totalAssets] = await Promise.all([
    vault.maxDeposit(receiver) as Promise<bigint>,
    vault.previewDeposit(assets) as Promise<bigint>,
    vault.totalAssets() as Promise<bigint>,
  ]);
  if (assets > maximum || shares <= 0n) throw new DirectDepositError("Deposit exceeds current vault capacity");
  if (totalAssets + assets > parseUnits(env.POLYMARKET_PILOT_TVL_PUSD, PUSD_DECIMALS)) {
    throw new DirectDepositError("Deposit exceeds the pUSD pilot limit");
  }
  return {
    ok: true,
    chainId: 137,
    assetAddress: asset,
    vaultAddress: getAddress(pool.vaultAddress!),
    expectedShares: shares.toString(),
    txs: {
      approveTx: { to: asset, data: erc20.encodeFunctionData("approve", [pool.vaultAddress, assets]) },
      depositTx: { to: getAddress(pool.vaultAddress!), data: vaultInterface.encodeFunctionData("deposit", [assets, receiver]) },
    },
  };
}

export async function confirmDirectPusdDeposit(env: Env, poolId: string, txHash: string) {
  const { pool, vault, provider } = await loadVault(env, poolId, false);
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt || receipt.status !== 1) throw new DirectDepositError("Successful Polygon receipt not found");
  const { owner, assets, shares } = readSingleVaultDeposit(receipt.logs, pool.vaultAddress!);

  const [balance, cash, totalAssets, totalSupply] = await Promise.all([
    vault.balanceOf(owner) as Promise<bigint>,
    vault.totalCash() as Promise<bigint>,
    vault.totalAssets() as Promise<bigint>,
    vault.totalSupply() as Promise<bigint>,
  ]);
  const price = totalSupply > 0n
    ? formatUnits(totalAssets * 10n ** 18n / totalSupply, 18)
    : "1";
  const mintPrice = formatUnits(assets * 10n ** 18n / shares, 18);
  const lowerHash = receipt.hash.toLowerCase();
  const lowerOwner = owner.toLowerCase();
  await prisma.$transaction(async (tx) => {
    const existing = await tx.club_pool_transactions.findUnique({
      where: { poolId_txHash: { poolId, txHash: lowerHash } },
    });
    await tx.club_pool_transactions.upsert({
      where: { poolId_txHash: { poolId, txHash: lowerHash } },
      create: {
        poolId,
        txHash: lowerHash,
        userAddress: lowerOwner,
        depositAmount: assets.toString(),
        netPoolAmount: assets.toString(),
        feeAmount: "0",
        tokenPriceAtMint: mintPrice,
        tokensMinted: shares.toString(),
      },
      update: {},
    });
    await tx.club_pool_users.upsert({
      where: { poolId_userAddress: { poolId, userAddress: lowerOwner } },
      create: { poolId, userAddress: lowerOwner, tokenBalance: balance.toString(), sharesRaw: balance.toString() },
      update: { tokenBalance: balance.toString(), sharesRaw: balance.toString(), lastSyncedBlock: BigInt(receipt.blockNumber), lastSyncedAt: new Date() },
    });
    await tx.club_pools.update({
      where: { id: poolId },
      data: {
        cash: formatUnits(cash, PUSD_DECIMALS),
        totalPoolValue: formatUnits(totalAssets, PUSD_DECIMALS),
        totalTokenSupply: totalSupply.toString(),
        officialTokenPrice: price,
      },
    });
    if (!existing) {
      await tx.club_pool_price_snapshots.create({
        data: {
          poolId,
          cash: formatUnits(cash, PUSD_DECIMALS),
          positionsValue: formatUnits(totalAssets > cash ? totalAssets - cash : 0n, PUSD_DECIMALS),
          realizedPnl: pool.realizedPnl,
          totalPoolValue: formatUnits(totalAssets, PUSD_DECIMALS),
          officialTokenPrice: price,
        },
      });
    }
  });
  return { ok: true, poolId, txHash: lowerHash, owner, assets: assets.toString(), shares: shares.toString() };
}
