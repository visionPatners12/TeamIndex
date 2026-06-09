import type { Env } from "../config/env";
import { prisma } from "../db/prisma";
import { getVaultContract } from "./vaultExecutor";
import { ethers } from "ethers";
import { queryFilterInBlockChunks } from "./ethersLogChunks";

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
  /** If set, only process logs from these tx hashes (lowercase hex). */
  onlyTransactionHashes?: string[];
  /** When true, do not advance riskParams.lastSyncedBlock (used for targeted post-deposit ingest). */
  skipCursorAdvance?: boolean;
  logger?: { warn: (obj: Record<string, unknown>, msg?: string) => void };
  logContext?: Record<string, unknown>;
  chunkSizeEnv?: string;
};

function decToStr(x: any) {
  if (x === null || x === undefined) return "0";
  if (typeof x === "string") return x;
  if (typeof x === "bigint") return x.toString();
  if (typeof x === "number") return String(x);
  if (x && typeof x.toString === "function") return x.toString();
  return String(x);
}

export async function syncVaultEventsToDb({
  env,
  pool,
  fromBlock,
  toBlock,
  onlyTransactionHashes,
  skipCursorAdvance,
  logger,
  logContext,
  chunkSizeEnv
}: SyncInputs) {
  if (!env.BASE_RPC_URL) throw new Error("RPC_URL missing (required for onchain sync)");
  if (fromBlock > toBlock) return;

  const onlySet =
    onlyTransactionHashes && onlyTransactionHashes.length > 0
      ? new Set(onlyTransactionHashes.map((h) => h.toLowerCase()))
      : null;

  const provider = new ethers.JsonRpcProvider(env.BASE_RPC_URL, undefined, { batchMaxCount: 1 });
  const vault = await getVaultContract(env, provider as any, { clubName: pool.clubName, vaultAddress: pool.vaultAddress });

  const depositEvents = await queryFilterInBlockChunks(vault, vault.filters.Deposit(), fromBlock, toBlock, {
    chunkSizeEnv,
    logger,
    context: { ...(logContext ?? {}), eventName: "Deposit" }
  });
  const withdrawEvents = await queryFilterInBlockChunks(vault, vault.filters.Withdraw(), fromBlock, toBlock, {
    chunkSizeEnv,
    logger,
    context: { ...(logContext ?? {}), eventName: "Withdraw" }
  });
  const feeEvents = await queryFilterInBlockChunks(vault, vault.filters.VaultFeeCharged(), fromBlock, toBlock, {
    chunkSizeEnv,
    logger,
    context: { ...(logContext ?? {}), eventName: "VaultFeeCharged" }
  });

  // Map txHash -> fee info for deposit/mint transactions.
  const feeByTx = new Map<
    string,
    { treasury: string; grossAssets: string; feeAssets: string; netAssets: string }
  >();
  for (const ev of feeEvents) {
    const txHash = (ev as any).transactionHash as string | undefined;
    if (!txHash) continue;
    if (onlySet && !onlySet.has(txHash.toLowerCase())) continue;
    const args = (ev as any).args ?? {};
    const treasury = args.treasury as string;
    const grossAssets = args.grossAssets as bigint;
    const feeAssets = args.feeAssets as bigint;
    const netAssets = args.netAssets as bigint;
    feeByTx.set(txHash.toLowerCase(), {
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
    if (onlySet && !onlySet.has(txHash.toLowerCase())) continue;

    const txKey = txHash.toLowerCase();
    const dup = await prisma.club_pool_transactions.findFirst({
      where: { poolId: pool.id, txHash: txKey } as any
    });
    if (dup) continue;

    const fee = feeByTx.get(txKey);
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
        txHash: txKey,
        userAddress: owner,
        depositAmount: depositAmount,
        netPoolAmount: netPoolAmount,
        feeAmount: feeAmount,
        tokenPriceAtMint: tokenPriceAtMint,
        tokensMinted: shares.toString()
      } as any
    });
  }

  // =========================
  // Withdraws / redeems
  // =========================
  for (const ev of withdrawEvents) {
    const txHash = (ev as any).transactionHash as string | undefined;
    if (onlySet && (!txHash || !onlySet.has(txHash.toLowerCase()))) continue;
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

  // totalCash is USDC base units (6 decimals); store human USD in DB for pricing + UI.
  const cashHuman = ethers.formatUnits(totalAssets, 6);

  await prisma.club_pools.update({
    where: { id: pool.id },
    data: {
      cash: cashHuman,
      totalTokenSupply: totalSupply.toString()
    }
  });

  if (!skipCursorAdvance) {
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

}
