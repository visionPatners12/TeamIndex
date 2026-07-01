import type { Env } from "../config/env";
import { prisma } from "../db/prisma";
import { getVaultContract } from "./vaultExecutor";
import { formatUnits, type EventLog, type JsonRpcProvider } from "ethers";
import { queryFilterInBlockChunks } from "./ethersLogChunks";
import { withBaseRpcRetry } from "./rpc";
import { fetchVaultTransferEventsFromCdpSql, isCdpSqlConfigured, type CdpTransferEvent } from "./cdpSqlApi";

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

type VaultSyncSnapshot = {
  depositEvents: EventLog[];
  withdrawEvents: EventLog[];
  transferEvents: Array<EventLog | CdpTransferEvent>;
  feeEvents: EventLog[];
  vaultCash: bigint;
  totalSupply: bigint;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function decToStr(x: any) {
  if (x === null || x === undefined) return "0";
  if (typeof x === "string") return x;
  if (typeof x === "bigint") return x.toString();
  if (typeof x === "number") return String(x);
  if (x && typeof x.toString === "function") return x.toString();
  return String(x);
}

async function readVaultSyncSnapshot(
  {
    env,
    pool,
    fromBlock,
    toBlock,
    logger,
    logContext,
    chunkSizeEnv
  }: Pick<SyncInputs, "env" | "pool" | "fromBlock" | "toBlock" | "logger" | "logContext" | "chunkSizeEnv">,
  provider: JsonRpcProvider
): Promise<VaultSyncSnapshot> {
  const vault = await getVaultContract(env, provider as any, { clubName: pool.clubName, vaultAddress: pool.vaultAddress });
  const logOptions = {
    chunkSizeEnv,
    maxRetriesEnv: "BASE_RPC_GETLOGS_MAX_RETRIES_PER_URL",
    logger,
    context: logContext
  };

  const depositEvents = await queryFilterInBlockChunks(vault, vault.filters.Deposit(), fromBlock, toBlock, {
    ...logOptions,
    context: { ...(logContext ?? {}), eventName: "Deposit" }
  });
  const withdrawEvents = await queryFilterInBlockChunks(vault, vault.filters.Withdraw(), fromBlock, toBlock, {
    ...logOptions,
    context: { ...(logContext ?? {}), eventName: "Withdraw" }
  });
  let transferEvents: Array<EventLog | CdpTransferEvent>;
  if (isCdpSqlConfigured(env)) {
    try {
      const vaultAddress = ((vault as any).target ?? (vault as any).address) as string;
      transferEvents = await fetchVaultTransferEventsFromCdpSql({
        env,
        contractAddress: vaultAddress,
        fromBlock,
        toBlock
      });
    } catch (err) {
      logger?.warn({ ...(logContext ?? {}), err }, "CDP SQL transfer query failed; falling back to RPC logs");
      transferEvents = await queryFilterInBlockChunks(vault, vault.filters.Transfer(), fromBlock, toBlock, {
        ...logOptions,
        context: { ...(logContext ?? {}), eventName: "Transfer" }
      });
    }
  } else {
    transferEvents = await queryFilterInBlockChunks(vault, vault.filters.Transfer(), fromBlock, toBlock, {
      ...logOptions,
      context: { ...(logContext ?? {}), eventName: "Transfer" }
    });
  }
  const feeEvents = await queryFilterInBlockChunks(vault, vault.filters.VaultFeeCharged(), fromBlock, toBlock, {
    ...logOptions,
    context: { ...(logContext ?? {}), eventName: "VaultFeeCharged" }
  });
  const vaultCash = (await (vault as any).totalCash()) as bigint;
  const totalSupply = (await vault.totalSupply()) as bigint;

  return { depositEvents, withdrawEvents, transferEvents, feeEvents, vaultCash, totalSupply };
}

function transferPosition(ev: EventLog | CdpTransferEvent) {
  return {
    blockNumber: Number((ev as any).blockNumber ?? 0),
    logIndex: Number((ev as any).logIndex ?? 0)
  };
}

function isAfterTransfer(a: EventLog | CdpTransferEvent, b?: EventLog | CdpTransferEvent) {
  if (!b) return true;
  const ap = transferPosition(a);
  const bp = transferPosition(b);
  return ap.blockNumber > bp.blockNumber || (ap.blockNumber === bp.blockNumber && ap.logIndex > bp.logIndex);
}

function addTouchedHolder(
  touched: Map<string, { address: string; event: EventLog | CdpTransferEvent }>,
  address: string | undefined,
  ev: EventLog | CdpTransferEvent
) {
  if (!address || address.toLowerCase() === ZERO_ADDRESS) return;
  const key = address.toLowerCase();
  const current = touched.get(key);
  if (!current || isAfterTransfer(ev, current.event)) {
    touched.set(key, { address, event: ev });
  }
}

async function upsertSyncedHolderBalance({
  poolId,
  address,
  balance,
  lastTransfer
}: {
  poolId: string;
  address: string;
  balance: bigint;
  lastTransfer: EventLog | CdpTransferEvent;
}) {
  const existingUser = await prisma.club_pool_users.findFirst({
    where: { poolId, userAddress: { equals: address, mode: "insensitive" } }
  });
  const data = {
    tokenBalance: balance.toString(),
    sharesRaw: balance.toString(),
    lastTransferTxHash: ((lastTransfer as any).transactionHash as string | undefined)?.toLowerCase(),
    lastTransferLogIndex: Number((lastTransfer as any).logIndex ?? 0),
    lastSyncedBlock: BigInt(Number((lastTransfer as any).blockNumber ?? 0)),
    lastSyncedAt: new Date()
  };

  if (existingUser) {
    await prisma.club_pool_users.update({
      where: { id: existingUser.id },
      data
    });
  } else {
    await prisma.club_pool_users.create({
      data: {
        poolId,
        userAddress: address,
        ...data
      }
    });
  }
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
  if (fromBlock > toBlock) return;

  const onlySet =
    onlyTransactionHashes && onlyTransactionHashes.length > 0
      ? new Set(onlyTransactionHashes.map((h) => h.toLowerCase()))
      : null;

  const {
    depositEvents,
    withdrawEvents,
    transferEvents,
    feeEvents,
    vaultCash,
    totalSupply
  } = await withBaseRpcRetry(
    env,
    (provider) =>
      readVaultSyncSnapshot(
        {
          env,
          pool,
          fromBlock,
          toBlock,
          logger,
          logContext,
          chunkSizeEnv
        },
        provider
      ),
    { maxRetriesPerUrl: 1 }
  );

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
  transferEvents.sort(sortFn);

  const touchedHolders = new Map<string, { address: string; event: EventLog | CdpTransferEvent }>();
  for (const ev of transferEvents) {
    const txHash = (ev as any).transactionHash as string | undefined;
    if (onlySet && (!txHash || !onlySet.has(txHash.toLowerCase()))) continue;
    const args = (ev as any).args ?? {};
    addTouchedHolder(touchedHolders, args.from as string | undefined, ev);
    addTouchedHolder(touchedHolders, args.to as string | undefined, ev);
  }

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

  // Make holder balances authoritative by reading the vault's ERC20 share balance
  // for every address touched in this block window. Deposit/Withdraw events remain
  // transaction history; Transfer + balanceOf is the source of truth for holders.
  if (touchedHolders.size > 0) {
    await withBaseRpcRetry(
      env,
      async (provider) => {
        const vault = await getVaultContract(env, provider as any, {
          clubName: pool.clubName,
          vaultAddress: pool.vaultAddress
        });
        for (const holder of touchedHolders.values()) {
          const balance = (await vault.balanceOf(holder.address)) as bigint;
          await upsertSyncedHolderBalance({
            poolId: pool.id,
            address: holder.address,
            balance,
            lastTransfer: holder.event
          });
        }
      },
      { maxRetriesPerUrl: 1 }
    );
  }

  // totalCash is USDC base units (6 decimals); store human USD in DB for pricing + UI.
  const cashHuman = formatUnits(vaultCash, 6);

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
