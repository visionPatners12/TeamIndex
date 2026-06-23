"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncVaultEventsToDb = syncVaultEventsToDb;
const prisma_1 = require("../db/prisma");
const vaultExecutor_1 = require("./vaultExecutor");
const ethers_1 = require("ethers");
const ethersLogChunks_1 = require("./ethersLogChunks");
const rpc_1 = require("./rpc");
const cdpSqlApi_1 = require("./cdpSqlApi");
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
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
    let transferEvents;
    if ((0, cdpSqlApi_1.isCdpSqlConfigured)(env)) {
        try {
            const vaultAddress = (vault.target ?? vault.address);
            transferEvents = await (0, cdpSqlApi_1.fetchVaultTransferEventsFromCdpSql)({
                env,
                contractAddress: vaultAddress,
                fromBlock,
                toBlock
            });
        }
        catch (err) {
            logger?.warn({ ...(logContext ?? {}), err }, "CDP SQL transfer query failed; falling back to RPC logs");
            transferEvents = await (0, ethersLogChunks_1.queryFilterInBlockChunks)(vault, vault.filters.Transfer(), fromBlock, toBlock, {
                ...logOptions,
                context: { ...(logContext ?? {}), eventName: "Transfer" }
            });
        }
    }
    else {
        transferEvents = await (0, ethersLogChunks_1.queryFilterInBlockChunks)(vault, vault.filters.Transfer(), fromBlock, toBlock, {
            ...logOptions,
            context: { ...(logContext ?? {}), eventName: "Transfer" }
        });
    }
    const feeEvents = await (0, ethersLogChunks_1.queryFilterInBlockChunks)(vault, vault.filters.VaultFeeCharged(), fromBlock, toBlock, {
        ...logOptions,
        context: { ...(logContext ?? {}), eventName: "VaultFeeCharged" }
    });
    const totalAssets = (await vault.totalCash());
    const totalSupply = (await vault.totalSupply());
    return { depositEvents, withdrawEvents, transferEvents, feeEvents, totalAssets, totalSupply };
}
function transferPosition(ev) {
    return {
        blockNumber: Number(ev.blockNumber ?? 0),
        logIndex: Number(ev.logIndex ?? 0)
    };
}
function isAfterTransfer(a, b) {
    if (!b)
        return true;
    const ap = transferPosition(a);
    const bp = transferPosition(b);
    return ap.blockNumber > bp.blockNumber || (ap.blockNumber === bp.blockNumber && ap.logIndex > bp.logIndex);
}
function addTouchedHolder(touched, address, ev) {
    if (!address || address.toLowerCase() === ZERO_ADDRESS)
        return;
    const key = address.toLowerCase();
    const current = touched.get(key);
    if (!current || isAfterTransfer(ev, current.event)) {
        touched.set(key, { address, event: ev });
    }
}
async function upsertSyncedHolderBalance({ poolId, address, balance, lastTransfer }) {
    const existingUser = await prisma_1.prisma.club_pool_users.findFirst({
        where: { poolId, userAddress: { equals: address, mode: "insensitive" } }
    });
    const data = {
        tokenBalance: balance.toString(),
        sharesRaw: balance.toString(),
        lastTransferTxHash: lastTransfer.transactionHash?.toLowerCase(),
        lastTransferLogIndex: Number(lastTransfer.logIndex ?? 0),
        lastSyncedBlock: BigInt(Number(lastTransfer.blockNumber ?? 0)),
        lastSyncedAt: new Date()
    };
    if (existingUser) {
        await prisma_1.prisma.club_pool_users.update({
            where: { id: existingUser.id },
            data
        });
    }
    else {
        await prisma_1.prisma.club_pool_users.create({
            data: {
                poolId,
                userAddress: address,
                ...data
            }
        });
    }
}
async function syncVaultEventsToDb({ env, pool, fromBlock, toBlock, onlyTransactionHashes, skipCursorAdvance, logger, logContext, chunkSizeEnv }) {
    if (fromBlock > toBlock)
        return;
    const onlySet = onlyTransactionHashes && onlyTransactionHashes.length > 0
        ? new Set(onlyTransactionHashes.map((h) => h.toLowerCase()))
        : null;
    const { depositEvents, withdrawEvents, transferEvents, feeEvents, totalAssets, totalSupply } = await (0, rpc_1.withBaseRpcRetry)(env, (provider) => readVaultSyncSnapshot({
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
    transferEvents.sort(sortFn);
    const touchedHolders = new Map();
    for (const ev of transferEvents) {
        const txHash = ev.transactionHash;
        if (onlySet && (!txHash || !onlySet.has(txHash.toLowerCase())))
            continue;
        const args = ev.args ?? {};
        addTouchedHolder(touchedHolders, args.from, ev);
        addTouchedHolder(touchedHolders, args.to, ev);
    }
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
    // Make holder balances authoritative by reading the vault's ERC20 share balance
    // for every address touched in this block window. Deposit/Withdraw events remain
    // transaction history; Transfer + balanceOf is the source of truth for holders.
    if (touchedHolders.size > 0) {
        await (0, rpc_1.withBaseRpcRetry)(env, async (provider) => {
            const vault = await (0, vaultExecutor_1.getVaultContract)(env, provider, {
                clubName: pool.clubName,
                vaultAddress: pool.vaultAddress
            });
            for (const holder of touchedHolders.values()) {
                const balance = (await vault.balanceOf(holder.address));
                await upsertSyncedHolderBalance({
                    poolId: pool.id,
                    address: holder.address,
                    balance,
                    lastTransfer: holder.event
                });
            }
        }, { maxRetriesPerUrl: 1 });
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
