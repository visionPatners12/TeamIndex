"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncVaultEventsToDb = syncVaultEventsToDb;
const prisma_1 = require("../db/prisma");
const vaultExecutor_1 = require("./vaultExecutor");
const ethers_1 = require("ethers");
const ethersLogChunks_1 = require("./ethersLogChunks");
const rpc_1 = require("./rpc");
function decToStr(x) {
    if (x === null || x === undefined)
        return "0";
    if (typeof x === "string")
        return x;
    if (typeof x === "bigint")
        return x.toString();
    if (typeof x === "number")
        return String(x);
    if (x && typeof x.toString === "function")
        return x.toString();
    return String(x);
}
async function readVaultSyncSnapshot({ env, pool, fromBlock, toBlock, logger, logContext, chunkSizeEnv }, provider) {
    const vault = await (0, vaultExecutor_1.getVaultContract)(env, provider, { clubName: pool.clubName, vaultAddress: pool.vaultAddress });
    const logOptions = {
        chunkSizeEnv,
        maxRetriesEnv: "BASE_RPC_GETLOGS_MAX_RETRIES_PER_URL",
        logger,
        context: logContext
    };
    const depositEvents = await (0, ethersLogChunks_1.queryFilterInBlockChunks)(vault, vault.filters.Deposit(), fromBlock, toBlock, {
        ...logOptions,
        context: { ...(logContext ?? {}), eventName: "Deposit" }
    });
    const withdrawEvents = await (0, ethersLogChunks_1.queryFilterInBlockChunks)(vault, vault.filters.Withdraw(), fromBlock, toBlock, {
        ...logOptions,
        context: { ...(logContext ?? {}), eventName: "Withdraw" }
    });
    const feeEvents = await (0, ethersLogChunks_1.queryFilterInBlockChunks)(vault, vault.filters.VaultFeeCharged(), fromBlock, toBlock, {
        ...logOptions,
        context: { ...(logContext ?? {}), eventName: "VaultFeeCharged" }
    });
    const totalAssets = (await vault.totalCash());
    const totalSupply = (await vault.totalSupply());
    return { depositEvents, withdrawEvents, feeEvents, totalAssets, totalSupply };
}
async function syncVaultEventsToDb({ env, pool, fromBlock, toBlock, onlyTransactionHashes, skipCursorAdvance, logger, logContext, chunkSizeEnv }) {
    if (fromBlock > toBlock)
        return;
    const onlySet = onlyTransactionHashes && onlyTransactionHashes.length > 0
        ? new Set(onlyTransactionHashes.map((h) => h.toLowerCase()))
        : null;
    const { depositEvents, withdrawEvents, feeEvents, totalAssets, totalSupply } = await (0, rpc_1.withBaseRpcRetry)(env, (provider) => readVaultSyncSnapshot({
        env,
        pool,
        fromBlock,
        toBlock,
        logger,
        logContext,
        chunkSizeEnv
    }, provider), { maxRetriesPerUrl: 1 });
    // Map txHash -> fee info for deposit/mint transactions.
    const feeByTx = new Map();
    for (const ev of feeEvents) {
        const txHash = ev.transactionHash;
        if (!txHash)
            continue;
        if (onlySet && !onlySet.has(txHash.toLowerCase()))
            continue;
        const args = ev.args ?? {};
        const treasury = args.treasury;
        const grossAssets = args.grossAssets;
        const feeAssets = args.feeAssets;
        const netAssets = args.netAssets;
        feeByTx.set(txHash.toLowerCase(), {
            treasury,
            grossAssets: decToStr(grossAssets),
            feeAssets: decToStr(feeAssets),
            netAssets: decToStr(netAssets)
        });
    }
    // Sort by (blockNumber, logIndex) for deterministic "latest" price assumptions.
    const sortFn = (a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex ?? 0) - Number(b.logIndex ?? 0);
    depositEvents.sort(sortFn);
    withdrawEvents.sort(sortFn);
    // Approximation for MVP:
    // tokenPriceAtMint = current pool.officialTokenPrice at the start of sync.
    const tokenPriceAtMint = decToStr(pool.officialTokenPrice);
    // =========================
    // Deposits / mints
    // =========================
    for (const ev of depositEvents) {
        const txHash = ev.transactionHash;
        const args = ev.args ?? {};
        const owner = args.owner;
        const assets = args.assets;
        const shares = args.shares;
        if (!txHash || !owner)
            continue;
        if (onlySet && !onlySet.has(txHash.toLowerCase()))
            continue;
        const txKey = txHash.toLowerCase();
        const dup = await prisma_1.prisma.club_pool_transactions.findFirst({
            where: { poolId: pool.id, txHash: txKey }
        });
        if (dup)
            continue;
        const fee = feeByTx.get(txKey);
        const depositAmount = fee?.grossAssets ?? decToStr(assets);
        const feeAmount = fee?.feeAssets ?? "0";
        const netPoolAmount = fee?.netAssets ?? decToStr(assets);
        const existingUser = await prisma_1.prisma.club_pool_users.findFirst({
            where: { poolId: pool.id, userAddress: owner }
        });
        if (existingUser) {
            await prisma_1.prisma.club_pool_users.update({
                where: { id: existingUser.id },
                data: {
                    tokenBalance: { increment: shares.toString() }
                }
            });
        }
        else {
            await prisma_1.prisma.club_pool_users.create({
                data: {
                    poolId: pool.id,
                    userAddress: owner,
                    tokenBalance: shares.toString()
                }
            });
        }
        await prisma_1.prisma.club_pool_transactions.create({
            data: {
                poolId: pool.id,
                txHash: txKey,
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
        const txHash = ev.transactionHash;
        if (onlySet && (!txHash || !onlySet.has(txHash.toLowerCase())))
            continue;
        const args = ev.args ?? {};
        const owner = args.owner;
        const shares = args.shares;
        if (!owner)
            continue;
        await prisma_1.prisma.club_pool_users.updateMany({
            where: { poolId: pool.id, userAddress: owner, tokenBalance: { gte: shares.toString() } },
            data: { tokenBalance: { decrement: shares.toString() } }
        });
    }
    // totalCash is USDC base units (6 decimals); store human USD in DB for pricing + UI.
    const cashHuman = (0, ethers_1.formatUnits)(totalAssets, 6);
    await prisma_1.prisma.club_pools.update({
        where: { id: pool.id },
        data: {
            cash: cashHuman,
            totalTokenSupply: totalSupply.toString()
        }
    });
    if (!skipCursorAdvance) {
        await prisma_1.prisma.club_pools.update({
            where: { id: pool.id },
            data: {
                riskParams: {
                    ...pool.riskParams,
                    lastSyncedBlock: toBlock
                }
            }
        });
    }
}
