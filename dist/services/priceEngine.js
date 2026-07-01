"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.decToNumber = decToNumber;
exports.calculatePoolValuation = calculatePoolValuation;
exports.readPoolBalanceBreakdown = readPoolBalanceBreakdown;
exports.recalculateOfficialPriceForPool = recalculateOfficialPriceForPool;
exports.recalculateOfficialPrices = recalculateOfficialPrices;
const prisma_1 = require("../db/prisma");
const rpc_1 = require("../onchain/rpc");
const ethersLogChunks_1 = require("../onchain/ethersLogChunks");
const vaultExecutor_1 = require("../onchain/vaultExecutor");
const ethers_1 = require("ethers");
function decToNumber(d) {
    // Prisma Decimal -> string
    if (typeof d === "number")
        return d;
    if (typeof d === "string")
        return Number(d);
    if (d && typeof d.toString === "function")
        return Number(d.toString());
    return 0;
}
function dbStr(raw) {
    if (raw == null)
        return "";
    if (typeof raw === "string")
        return raw.trim();
    if (typeof raw === "number")
        return String(raw);
    if (raw && typeof raw.toString === "function")
        return String(raw).trim();
    return "";
}
/** `club_pools.cash`: new rows are human USD strings; legacy rows may be raw USDC (6dp) integers. */
function vaultCashDbToHuman(cashRaw) {
    const s = dbStr(cashRaw);
    if (!s || s === "0")
        return 0;
    if (s.includes(".") || /[eE]/i.test(s))
        return Number(s);
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0)
        return 0;
    if (/^\d+$/.test(s))
        return n / 1e6;
    return n;
}
function humanUsdToUsdcBaseUnits(h) {
    if (!Number.isFinite(h) || h <= 0)
        return 0n;
    return (0, ethers_1.parseUnits)(h.toFixed(6), 6);
}
/** Must match `USDC4626Vault.decimals()` — raw `totalSupply()` is in these base units. */
const VAULT_SHARE_DECIMALS = 6;
function calculatePoolValuation(inputs) {
    const vaultCash = Number.isFinite(inputs.vaultCash) && inputs.vaultCash > 0 ? inputs.vaultCash : 0;
    const serverWalletCash = Number.isFinite(inputs.serverWalletCash) && inputs.serverWalletCash > 0 ? inputs.serverWalletCash : 0;
    const openPositionsValue = Number.isFinite(inputs.openPositionsValue) && inputs.openPositionsValue > 0 ? inputs.openPositionsValue : 0;
    const realizedPnl = Number.isFinite(inputs.realizedPnl) ? inputs.realizedPnl : 0;
    const totalTokenSupplyRaw = Number.isFinite(inputs.totalTokenSupplyRaw) && inputs.totalTokenSupplyRaw > 0 ? inputs.totalTokenSupplyRaw : 0;
    const cash = vaultCash + serverWalletCash;
    const syntheticOnchainPositionsValue = serverWalletCash + openPositionsValue;
    const totalPoolValue = cash + openPositionsValue + realizedPnl;
    const totalSupplyHuman = totalTokenSupplyRaw / 10 ** VAULT_SHARE_DECIMALS;
    const officialTokenPrice = totalSupplyHuman > 0 ? totalPoolValue / totalSupplyHuman : 0;
    return {
        vaultCash,
        serverWalletCash,
        openPositionsValue,
        realizedPnl,
        totalTokenSupplyRaw,
        cash,
        syntheticOnchainPositionsValue,
        totalPoolValue,
        totalSupplyHuman,
        officialTokenPrice
    };
}
/**
 * Last time we pushed NAV on-chain per pool (epoch ms). In-memory: on restart the
 * first cycle re-pushes for every pool, which is the desired resync-after-downtime.
 */
const lastOnchainNavPushAt = new Map();
/** Last NAV values (USDC base units) actually pushed on-chain per pool, to skip no-op writes. */
const lastOnchainNavValue = new Map();
/** Min delay between on-chain `setPoolValuation` writes per pool (default 1h). */
function onchainNavPushIntervalMs(env) {
    const n = Number(env.ONCHAIN_NAV_PUSH_INTERVAL_MS);
    return Number.isFinite(n) && n > 0 ? n : 3_600_000;
}
function onchainNavPushEnabled(env) {
    const raw = String(env.ONCHAIN_NAV_PUSH_ENABLED ?? "true").trim().toLowerCase();
    return !["0", "false", "no", "off"].includes(raw);
}
async function readPoolCashBreakdown(env, pool) {
    let vaultCash = vaultCashDbToHuman(pool.cash);
    let readVaultCash = false;
    try {
        const vaultCashRaw = await (0, rpc_1.withBaseRpcRetry)(env, async (provider) => {
            const vault = await (0, vaultExecutor_1.getVaultContract)(env, provider, {
                clubName: pool.clubName,
                vaultAddress: pool.vaultAddress ?? undefined
            });
            return (await vault.totalCash());
        }, { maxRetriesPerUrl: 1 });
        vaultCash = Number((0, ethers_1.formatUnits)(vaultCashRaw, 6));
        readVaultCash = true;
    }
    catch {
        // Fall back to the DB's last idle-cash value. It may already include server
        // wallet cash from a previous canonical recalc, so don't add server cash too.
    }
    let serverWalletCash = 0;
    if (readVaultCash && env.BASE_USDC_ADDRESS) {
        const account = await prisma_1.prisma.pool_limitless_accounts.findUnique({
            where: { poolId: pool.id },
            select: { accountAddress: true }
        });
        const accountAddress = account?.accountAddress ? String(account.accountAddress) : "";
        if (accountAddress) {
            try {
                const serverWalletCashRaw = await (0, vaultExecutor_1.getErc20Balance)(env, env.BASE_USDC_ADDRESS, accountAddress);
                serverWalletCash = Number((0, ethers_1.formatUnits)(serverWalletCashRaw, 6));
            }
            catch {
                serverWalletCash = 0;
            }
        }
    }
    return { vaultCash, serverWalletCash, readVaultCash };
}
async function readPoolBalanceBreakdown(env, pool) {
    const dbCash = vaultCashDbToHuman(pool.cash);
    let vaultCash = dbCash;
    let readVaultCash = false;
    let vaultCashSource = "db";
    try {
        const vaultCashRaw = await (0, rpc_1.withBaseRpcRetry)(env, async (provider) => {
            const vault = await (0, vaultExecutor_1.getVaultContract)(env, provider, {
                clubName: pool.clubName,
                vaultAddress: pool.vaultAddress ?? undefined
            });
            return (await vault.totalCash());
        }, { maxRetriesPerUrl: 1 });
        vaultCash = Number((0, ethers_1.formatUnits)(vaultCashRaw, 6));
        readVaultCash = true;
        vaultCashSource = "onchain";
    }
    catch {
        vaultCash = dbCash;
    }
    const account = await prisma_1.prisma.pool_limitless_accounts.findUnique({
        where: { poolId: pool.id },
        select: {
            accountAddress: true,
            limitlessProfileId: true,
            status: true,
            allowanceStatus: true
        }
    });
    const serverWalletAddress = account?.accountAddress ? String(account.accountAddress) : null;
    const serverWalletProfileId = account?.limitlessProfileId ? String(account.limitlessProfileId) : null;
    let serverWalletCash = 0;
    let readServerWalletCash = false;
    if (env.BASE_USDC_ADDRESS && serverWalletAddress) {
        try {
            const serverWalletCashRaw = await (0, vaultExecutor_1.getErc20Balance)(env, env.BASE_USDC_ADDRESS, serverWalletAddress);
            serverWalletCash = Number((0, ethers_1.formatUnits)(serverWalletCashRaw, 6));
            readServerWalletCash = true;
        }
        catch {
            serverWalletCash = 0;
        }
    }
    let totalCash = vaultCash;
    if (readVaultCash) {
        totalCash = vaultCash + serverWalletCash;
    }
    else if (readServerWalletCash) {
        // DB cash is the last aggregate value written by the price engine. If we can
        // still read the server wallet, split that aggregate for UI purposes.
        totalCash = Math.max(dbCash, serverWalletCash);
        vaultCash = Math.max(0, totalCash - serverWalletCash);
        vaultCashSource = "db-derived";
    }
    return {
        vaultCash,
        serverWalletCash,
        totalCash,
        readVaultCash,
        readServerWalletCash,
        vaultCashSource,
        serverWalletAddress,
        serverWalletProfileId,
        serverWalletStatus: account?.status ? String(account.status) : null,
        allowanceStatus: account?.allowanceStatus ? String(account.allowanceStatus) : null
    };
}
async function recalculateOfficialPriceForPool(env, poolId, options) {
    const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: poolId } });
    if (!pool)
        throw new Error(`Pool not found: ${poolId}`);
    const openPositions = await prisma_1.prisma.club_pool_positions.findMany({
        where: { poolId: pool.id, status: "OPEN" }
    });
    let positionsValue = 0;
    for (const pos of openPositions) {
        // `currentValue` is the marked-to-market value maintained by
        // `syncLimitlessFillsAndSettle` (Limitless mid-price × matched quantity),
        // which runs immediately before this recalc in the price ticker. We treat it
        // as the single source of truth instead of re-fetching mid-prices here.
        positionsValue += decToNumber(pos.currentValue);
    }
    const { vaultCash, serverWalletCash, readVaultCash } = await readPoolCashBreakdown(env, pool);
    const valuation = calculatePoolValuation({
        vaultCash,
        serverWalletCash,
        openPositionsValue: positionsValue,
        realizedPnl: decToNumber(pool.realizedPnl),
        totalTokenSupplyRaw: decToNumber(pool.totalTokenSupply)
    });
    await prisma_1.prisma.club_pools.update({
        where: { id: pool.id },
        data: {
            cash: valuation.cash.toString(),
            openPositionsValue: valuation.openPositionsValue.toString(),
            totalPoolValue: valuation.totalPoolValue.toString(),
            officialTokenPrice: valuation.officialTokenPrice.toString()
        }
    });
    await prisma_1.prisma.club_pool_price_snapshots.create({
        data: {
            poolId: pool.id,
            cash: valuation.cash.toString(),
            positionsValue: valuation.openPositionsValue.toString(),
            realizedPnl: valuation.realizedPnl.toString(),
            totalPoolValue: valuation.totalPoolValue.toString(),
            officialTokenPrice: valuation.officialTokenPrice.toString()
        }
    });
    let valuationSnapshot = null;
    if (options?.valuationSnapshot) {
        valuationSnapshot = await prisma_1.prisma.pool_valuation_snapshots.create({
            data: {
                poolId: pool.id,
                cash: valuation.cash.toString(),
                positionsValue: valuation.openPositionsValue.toString(),
                realizedPnl: valuation.realizedPnl.toString(),
                totalPoolValue: valuation.totalPoolValue.toString(),
                totalTokenSupply: valuation.totalTokenSupplyRaw.toString(),
                officialTokenPrice: valuation.officialTokenPrice.toString(),
                source: options.valuationSnapshot.source,
                rawJson: options.valuationSnapshot.rawJson
            }
        });
    }
    // Keep onchain valuation inputs in sync with offchain calculations so ERC4626
    // conversions use the same "official token price" basis. The vault already
    // includes its own `totalCash()`, so only push server-wallet cash plus positions
    // as the synthetic external NAV component.
    const posBase = humanUsdToUsdcBaseUnits(valuation.syntheticOnchainPositionsValue);
    // realizedPnl is `int256` onchain — preserve sign so losses are reflected in NAV.
    const rPnLBase = valuation.realizedPnl >= 0
        ? humanUsdToUsdcBaseUnits(valuation.realizedPnl)
        : -humanUsdToUsdcBaseUnits(-valuation.realizedPnl);
    const lastPushed = lastOnchainNavValue.get(pool.id);
    const navChanged = !lastPushed || lastPushed.pos !== posBase || lastPushed.pnl !== rPnLBase;
    const navPushDue = Date.now() - (lastOnchainNavPushAt.get(pool.id) ?? 0) >= onchainNavPushIntervalMs(env);
    if (readVaultCash && onchainNavPushEnabled(env) && env.BASE_EXECUTOR_PRIVATE_KEY && navPushDue && navChanged) {
        try {
            await (0, rpc_1.withBaseRpcRetry)(env, async (provider) => {
                const vault = await (0, vaultExecutor_1.getVaultContract)(env, provider, {
                    clubName: pool.clubName,
                    vaultAddress: pool.vaultAddress ?? undefined
                });
                const tx = await vault.setPoolValuation(posBase.toString(), rPnLBase.toString());
                try {
                    await tx.wait(); // serialize when the RPC can confirm the tx
                }
                catch (err) {
                    if (!(0, ethersLogChunks_1.isRpcRateLimitError)(err))
                        throw err;
                }
            }, { maxRetriesPerUrl: 1 });
            // Only record on success so failures retry on the next cycle.
            lastOnchainNavPushAt.set(pool.id, Date.now());
            lastOnchainNavValue.set(pool.id, { pos: posBase, pnl: rPnLBase });
        }
        catch {
            // Onchain valuation update failure shouldn't block price recalculation.
        }
    }
    return { valuation, valuationSnapshot };
}
async function recalculateOfficialPrices(env) {
    const pools = await prisma_1.prisma.club_pools.findMany({ where: { status: "ACTIVE" }, select: { id: true } });
    for (const pool of pools) {
        await recalculateOfficialPriceForPool(env, pool.id);
    }
}
