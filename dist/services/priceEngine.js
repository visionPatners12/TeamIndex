"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recalculateOfficialPrices = recalculateOfficialPrices;
const clobClient_1 = require("../polymarket/clobClient");
const prisma_1 = require("../db/prisma");
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
async function recalculateOfficialPrices(env) {
    const pools = await prisma_1.prisma.club_pools.findMany({ where: { status: "ACTIVE" } });
    for (const pool of pools) {
        const openPositions = await prisma_1.prisma.club_pool_positions.findMany({
            where: { poolId: pool.id, status: "OPEN" }
        });
        let positionsValue = 0;
        const positionUpdates = [];
        for (const pos of openPositions) {
            // For MVP: use midpoint price for each open token and value by current quantity.
            // Polymarket binary token price is an implied probability; if your settlement differs,
            // adjust valuation formula accordingly.
            const mid = await (0, clobClient_1.getMidpoint)(env, pos.tokenId).catch(() => "0");
            const midNum = Number(mid);
            const quantity = decToNumber(pos.quantity);
            const currentValue = midNum * quantity;
            positionsValue += currentValue;
            // Keep position-level mark-to-market currentValue in sync.
            positionUpdates.push(prisma_1.prisma.club_pool_positions.update({
                where: { id: pos.id },
                data: { currentValue: currentValue.toString() }
            }));
        }
        await Promise.all(positionUpdates);
        const cashHuman = vaultCashDbToHuman(pool.cash);
        const realizedPnl = decToNumber(pool.realizedPnl);
        const totalPoolValue = cashHuman + positionsValue + realizedPnl;
        const totalSupplyRaw = decToNumber(pool.totalTokenSupply);
        const sharesHuman = totalSupplyRaw / 10 ** VAULT_SHARE_DECIMALS;
        // USD (or pool accounting unit) per **1.0** vault share — not per raw 1e-6 share unit.
        const officialTokenPrice = sharesHuman > 0 ? totalPoolValue / sharesHuman : 0;
        await prisma_1.prisma.club_pools.update({
            where: { id: pool.id },
            data: {
                cash: String(cashHuman),
                openPositionsValue: positionsValue.toString(),
                totalPoolValue: totalPoolValue.toString(),
                officialTokenPrice: officialTokenPrice.toString()
            }
        });
        await prisma_1.prisma.club_pool_price_snapshots.create({
            data: {
                poolId: pool.id,
                cash: String(cashHuman),
                positionsValue: positionsValue.toString(),
                realizedPnl: pool.realizedPnl,
                totalPoolValue: totalPoolValue.toString(),
                officialTokenPrice: officialTokenPrice.toString()
            }
        });
        // Keep onchain valuation inputs in sync with offchain calculations.
        // This makes ERC4626 conversions use the same "official token price" basis.
        if (env.RPC_URL) {
            try {
                const vault = await (0, vaultExecutor_1.getVaultContract)(env, undefined, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined });
                const posBase = humanUsdToUsdcBaseUnits(positionsValue);
                const rPnLBase = realizedPnl >= 0 ? humanUsdToUsdcBaseUnits(realizedPnl) : 0n;
                await vault.setPoolValuation(posBase.toString(), rPnLBase.toString());
            }
            catch {
                // Optional: onchain valuation update failure should not block price recalculation.
            }
        }
    }
}
