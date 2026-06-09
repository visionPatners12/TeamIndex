"use strict";
/**
 * limitlessPositionSync.ts
 *
 * Position reconciliation and settlement for Limitless-sourced positions.
 * Equivalent of positionSync.ts (which uses Polymarket CLOB fills).
 *
 * Differences vs Polymarket:
 *   • "tokenId" in club_pool_positions is encoded as "<marketId>:<outcomeIndex>".
 *     Use decodeLimitlessTokenId() to split it.
 *   • Fill status is fetched from Limitless order API (GET /orders/:id).
 *   • Mid-price for mark-to-market comes from getMidpoint() (Limitless API)
 *     or falls back to the cached yesPrice in limitless_markets.
 *   • Settlement detection: when the market status becomes RESOLVED in
 *     limitless_markets and a resolution value is set.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncLimitlessFillsAndSettle = syncLimitlessFillsAndSettle;
const prisma_1 = require("../db/prisma");
const limitlessOrderClient_1 = require("./limitlessOrderClient");
const limitlessDiscoveryService_1 = require("./limitlessDiscoveryService");
function decToNumber(d) {
    if (typeof d === "number")
        return d;
    if (typeof d === "string")
        return Number(d);
    if (d && typeof d.toString === "function")
        return Number(d.toString());
    return 0;
}
function decToStr(d) {
    if (d === null || d === undefined)
        return "0";
    if (typeof d === "string")
        return d;
    if (typeof d === "number")
        return d.toString();
    if (typeof d === "bigint")
        return d.toString();
    if (d && typeof d.toString === "function")
        return String(d.toString());
    return String(d);
}
// ─── Main sync function ───────────────────────────────────────────────────────
/**
 * Reconcile all OPEN positions that were placed on Limitless:
 *   1. Update fill quantities from the Limitless order API (if clobOrderId present).
 *   2. Mark-to-market currentValue using live mid-price.
 *   3. Settle positions when the underlying Limitless market is RESOLVED.
 */
async function syncLimitlessFillsAndSettle(env) {
    // Only process positions whose tokenId follows the Limitless encoding scheme.
    // Limitless tokenIds are "<marketId>:<outcomeIndex>" — never plain Polymarket hex token ids.
    const openPositions = await prisma_1.prisma.club_pool_positions.findMany({
        where: {
            status: "OPEN",
            tokenId: { contains: ":" },
        },
        take: 200,
    });
    for (const pos of openPositions) {
        const { marketId, outcomeIndex } = (0, limitlessDiscoveryService_1.decodeLimitlessTokenId)(pos.tokenId);
        const plannedQty = decToNumber(pos.plannedQuantity);
        const plannedStake = decToNumber(pos.plannedStake);
        let investedNow = decToNumber(pos.investedAmount);
        let filledQtyNow = decToNumber(pos.quantity);
        // ── 1. Fill sync via Limitless order API ──────────────────────────────
        let matchedQty = filledQtyNow;
        let clobStatus;
        if (pos.clobOrderId) {
            try {
                const order = await (0, limitlessOrderClient_1.getLimitlessOrder)(env, pos.clobOrderId);
                clobStatus = order?.status;
                const sizeMatchedStr = order?.size_matched ?? order?.sizeMatched ?? order?.filledSize;
                const sizeMatchedNum = decToNumber(sizeMatchedStr);
                if (sizeMatchedNum > 0)
                    matchedQty = sizeMatchedNum;
                // Cancel position if the order was rejected before any fill
                const statusLc = String(clobStatus ?? "").toLowerCase();
                if (sizeMatchedNum === 0 && (statusLc.includes("cancel") || statusLc.includes("reject"))) {
                    await prisma_1.prisma.club_pool_positions.update({
                        where: { id: pos.id },
                        data: {
                            status: "CANCELLED",
                            currentValue: "0",
                            quantity: "0",
                            stake: "0",
                            investedAmount: "0",
                            realizedPnl: "0",
                        },
                    });
                    continue;
                }
            }
            catch {
                // order lookup failed — keep existing data, retry next tick
            }
        }
        // ── 2. Live mid-price (Limitless API, fallback to db cache) ──────────
        const outcomeForMid = outcomeIndex === 0 ? "yes" : "no";
        const midNum = await (0, limitlessOrderClient_1.getMidpoint)(env, marketId, outcomeForMid).catch(async () => {
            // Fallback: read cached price from limitless_markets
            const mkt = await prisma_1.prisma.limitless_markets.findUnique({
                where: { id: marketId },
                select: { yesPrice: true },
            });
            const p = Number(mkt?.yesPrice?.toString() ?? "0.5");
            // outcomeIndex=1 means NO side → price = 1 − yesPrice
            return outcomeIndex === 0 ? p : (1 - p);
        });
        // ── 3. Fill accounting ────────────────────────────────────────────────
        if (plannedQty > 0 && plannedStake > 0 && matchedQty > 0) {
            const fillRatio = Math.min(1, matchedQty / plannedQty);
            const newInvested = plannedStake * fillRatio;
            if (newInvested > investedNow) {
                const deltaInvested = newInvested - investedNow;
                await prisma_1.prisma.club_pools.update({
                    where: { id: pos.poolId },
                    data: { cash: { decrement: decToStr(deltaInvested) } },
                });
                await prisma_1.prisma.club_pool_positions.update({
                    where: { id: pos.id },
                    data: {
                        quantity: decToStr(matchedQty),
                        stake: decToStr(newInvested),
                        investedAmount: decToStr(newInvested),
                        currentValue: decToStr(matchedQty * midNum),
                    },
                });
                investedNow = newInvested;
            }
            else {
                await prisma_1.prisma.club_pool_positions.update({
                    where: { id: pos.id },
                    data: { currentValue: decToStr(matchedQty * midNum) },
                });
            }
        }
        else {
            if (filledQtyNow !== 0) {
                await prisma_1.prisma.club_pool_positions.update({
                    where: { id: pos.id },
                    data: { currentValue: "0", quantity: "0", stake: "0", investedAmount: "0" },
                });
            }
        }
        // ── 4. Settlement: check if Limitless market is RESOLVED ─────────────
        const resolvedMarket = await prisma_1.prisma.limitless_markets.findUnique({
            where: { id: marketId },
            select: { status: true, resolution: true },
        });
        if (resolvedMarket?.status === "RESOLVED" && investedNow > 0) {
            const resolution = String(resolvedMarket.resolution ?? "").toLowerCase();
            // Determine if the chosen outcome won.
            // For a YES (outcomeIndex=0) position: wins if resolution = "yes"
            // For a NO  (outcomeIndex=1) position: wins if resolution = "no"
            const didWin = outcomeIndex === 0
                ? resolution === "yes" || resolution === "1" || resolution === "true"
                : resolution === "no" || resolution === "0" || resolution === "false";
            const finalPayoutValue = didWin ? matchedQty * 1 : 0;
            const realizedProfit = finalPayoutValue - investedNow;
            await prisma_1.prisma.club_pool_positions.update({
                where: { id: pos.id },
                data: {
                    status: "SETTLED",
                    realizedPnl: decToStr(realizedProfit),
                    currentValue: decToStr(finalPayoutValue),
                },
            });
            if (investedNow > 0) {
                await prisma_1.prisma.club_pools.update({
                    where: { id: pos.poolId },
                    data: { cash: { increment: decToStr(investedNow) } },
                });
            }
            if (Math.abs(realizedProfit) > 0) {
                await prisma_1.prisma.club_pools.update({
                    where: { id: pos.poolId },
                    data: { realizedPnl: { increment: decToStr(realizedProfit) } },
                });
            }
        }
    }
}
