import type { Env } from "../config/env";
import { prisma } from "../db/prisma";
import { getVaultContract } from "./vaultExecutor";
import { ethers } from "ethers";

type SyncInputs = {
  env: Env;
  pool: {
    id: string;
    clubName: string;
    vaultAddress?: string;
    officialTokenPrice: any;
    riskParams: any;
  };
  fromBlock: number;
  toBlock: number;
};

function decToStr(x: any) {
  if (x === null || x === undefined) return "0";
  if (typeof x === "string") return x;
  if (typeof x === "bigint") return x.toString();
  if (typeof x === "number") return String(x);
  if (x && typeof x.toString === "function") return x.toString();
  return String(x);
}

export async function syncVaultEventsToDb({ env, pool, fromBlock, toBlock }: SyncInputs) {
  if (!env.RPC_URL) throw new Error("RPC_URL missing (required for onchain sync)");
  if (fromBlock > toBlock) return;

  const provider = new ethers.JsonRpcProvider(env.RPC_URL);
  const vault = await getVaultContract(env, provider as any, { clubName: pool.clubName, vaultAddress: pool.vaultAddress });

  const depositEvents = await vault.queryFilter(vault.filters.Deposit(), fromBlock, toBlock);
  const withdrawEvents = await vault.queryFilter(vault.filters.Withdraw(), fromBlock, toBlock);
  const feeEvents = await vault.queryFilter(vault.filters.VaultFeeCharged(), fromBlock, toBlock);

  // Map txHash -> fee info for deposit/mint transactions.
  const feeByTx = new Map<
    string,
    { treasury: string; grossAssets: string; feeAssets: string; netAssets: string }
  >();
  for (const ev of feeEvents) {
    const txHash = (ev as any).transactionHash as string | undefined;
    if (!txHash) continue;
    const args = (ev as any).args ?? {};
    const treasury = args.treasury as string;
    const grossAssets = args.grossAssets as bigint;
    const feeAssets = args.feeAssets as bigint;
    const netAssets = args.netAssets as bigint;
    feeByTx.set(txHash, {
      treasury,
      grossAssets: decToStr(grossAssets),
      feeAssets: decToStr(feeAssets),
      netAssets: decToStr(netAssets)
    });
  }

  // Sort by (blockNumber, logIndex) for deterministic "latest" price assumptions.
  const sortFn = (a: any, b: any) =>
    Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex ?? 0) - Number(b.logIndex ?? 0);
  depositEvents.sort(sortFn);
  withdrawEvents.sort(sortFn);

  // Approximation for MVP:
  // tokenPriceAtMint = current pool.officialTokenPrice at the start of sync.
  const tokenPriceAtMint = decToStr(pool.officialTokenPrice);

  // =========================
  // Deposits / mints
  // =========================
  for (const ev of depositEvents) {
    const txHash = (ev as any).transactionHash as string | undefined;
    const args = (ev as any).args ?? {};
    const owner = args.owner as string;
    const assets = args.assets as bigint;
    const shares = args.shares as bigint;

    if (!txHash || !owner) continue;

    const fee = feeByTx.get(txHash);
    const depositAmount = fee?.grossAssets ?? decToStr(assets);
    const feeAmount = fee?.feeAssets ?? "0";
    const netPoolAmount = fee?.netAssets ?? decToStr(assets);

    const existingUser = await prisma.club_pool_users.findFirst({
      where: { poolId: pool.id, userAddress: owner }
    });
    if (existingUser) {
      await prisma.club_pool_users.update({
        where: { id: existingUser.id },
        data: {
          tokenBalance: { increment: shares.toString() } as any
        }
      });
    } else {
      await prisma.club_pool_users.create({
        data: {
          poolId: pool.id,
          userAddress: owner,
          tokenBalance: shares.toString()
        }
      });
    }

    await prisma.club_pool_transactions.create({
      data: {
        poolId: pool.id,
        userAddress: owner,
        depositAmount: depositAmount,
        netPoolAmount: netPoolAmount,
        feeAmount: feeAmount,
        tokenPriceAtMint: tokenPriceAtMint,
        tokensMinted: shares.toString()
      }
    });
  }

  // =========================
  // Withdraws / redeems
  // =========================
  for (const ev of withdrawEvents) {
    const args = (ev as any).args ?? {};
    const owner = args.owner as string;
    const shares = args.shares as bigint;
    if (!owner) continue;

    await prisma.club_pool_users.updateMany({
      where: { poolId: pool.id, userAddress: owner, tokenBalance: { gte: shares.toString() } },
      data: { tokenBalance: { decrement: shares.toString() } as any }
    });
  }

  const totalAssets = (await (vault as any).totalCash()) as bigint;
  const totalSupply = (await vault.totalSupply()) as bigint;

  await prisma.club_pools.update({
    where: { id: pool.id },
    data: {
      cash: totalAssets.toString(),
      totalTokenSupply: totalSupply.toString()
    }
  });

  await prisma.club_pools.update({
    where: { id: pool.id },
    data: {
      riskParams: {
        ...(pool.riskParams as any),
        lastSyncedBlock: toBlock
      } as any
    }
  });

}

