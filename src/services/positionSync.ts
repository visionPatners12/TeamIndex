import type { Env } from "../config/env";
import { prisma } from "../db/prisma";
import { getMidpoint, getOrder } from "../polymarket/clobClient";

function decToNumber(d: any): number {
  if (typeof d === "number") return d;
  if (typeof d === "string") return Number(d);
  if (d && typeof d.toString === "function") return Number(d.toString());
  return 0;
}

function decToStr(d: any): string {
  if (d === null || d === undefined) return "0";
  if (typeof d === "string") return d;
  if (typeof d === "number") return d.toString();
  if (typeof d === "bigint") return d.toString();
  if (d && typeof d.toString === "function") return d.toString();
  return String(d);
}

export async function syncClobFillsAndSettle(env: Env) {
  // MVP: periodic reconciliation from CLOB order state + midpoint settlement heuristic.
  const openPositions = await prisma.club_pool_positions.findMany({
    where: { status: "OPEN" },
    take: 200
  });

  for (const pos of openPositions) {
    const plannedQty = decToNumber(pos.plannedQuantity);
    const plannedStake = decToNumber(pos.plannedStake);
    let investedNow = decToNumber(pos.investedAmount);
    let filledQtyNow = decToNumber(pos.quantity);

    // Fetch fill status (if we have an order id).
    let matchedQty = filledQtyNow;
    let clobStatus: string | undefined;
    if (pos.clobOrderId) {
      try {
        const order = await getOrder(env, pos.clobOrderId);
        clobStatus = order?.status;

        const sizeMatchedStr = order?.size_matched ?? order?.sizeMatched;
        const sizeMatchedNum = decToNumber(sizeMatchedStr);
        if (sizeMatchedNum > 0) matchedQty = sizeMatchedNum;

        // If the order is cancelled before fills, cancel the position.
        const statusLc = String(clobStatus ?? "").toLowerCase();
        if (sizeMatchedNum === 0 && (statusLc.includes("cancel") || statusLc.includes("reject"))) {
          await prisma.club_pool_positions.update({
            where: { id: pos.id },
            data: { status: "CANCELLED", currentValue: "0", quantity: "0", stake: "0", investedAmount: "0", realizedPnl: "0" }
          });
          continue;
        }
      } catch {
        // If clob order lookup fails, keep current data and try again next tick.
      }
    }

    // Mark-to-market / settlement uses midpoint.
    const midRaw = await getMidpoint(env, pos.tokenId).catch(() => "0");
    const midNum = Number(midRaw);

    // 1) Fill sync: when a fill arrives, reserve stake from pool.cash.
    // We only increase investedAmount (never decrease) to avoid double accounting.
    if (plannedQty > 0 && plannedStake > 0 && matchedQty > 0) {
      const fillRatio = Math.min(1, matchedQty / plannedQty);
      const newInvested = plannedStake * fillRatio;

      if (newInvested > investedNow) {
        const deltaInvested = newInvested - investedNow;
        // Cash accounting: remove invested stake from uninvested pool.cash.
        await prisma.club_pools.update({
          where: { id: pos.poolId },
          data: { cash: { decrement: decToStr(deltaInvested) } }
        });

        await prisma.club_pool_positions.update({
          where: { id: pos.id },
          data: {
            quantity: decToStr(matchedQty),
            stake: decToStr(newInvested),
            investedAmount: decToStr(newInvested),
            currentValue: decToStr(matchedQty * midNum)
          }
        });

        investedNow = newInvested;
      } else {
        // Even if invested doesn't change, keep currentValue synced.
        await prisma.club_pool_positions.update({
          where: { id: pos.id },
          data: { currentValue: decToStr(matchedQty * midNum) }
        });
      }
    } else {
      // No fills yet: keep currentValue at 0.
      if (filledQtyNow !== 0) {
        await prisma.club_pool_positions.update({
          where: { id: pos.id },
          data: { currentValue: "0", quantity: "0", stake: "0", investedAmount: "0" }
        });
      }
    }

    // 2) Settlement sync: when midpoint is ~0 or ~1 (binary resolution), realize PnL.
    // We require investedAmount > 0 so realized PnL isn't computed on unfilled bets.
    const EPS = 0.0001;
    const resolvedYes = midNum >= 1 - EPS;
    const resolvedNo = midNum <= EPS;
    if (investedNow > 0 && (resolvedYes || resolvedNo)) {
      const finalPayoutValue = resolvedYes ? matchedQty * 1 : 0; // YES token pays 1 on win
      // Accounting model (aligns with brief naming):
      // - At fill time we decrement pool.cash by invested stake.
      // - At settlement, we "return" the invested stake back into pool.cash,
      //   and realize profit/loss as `payout - invested`.
      const realizedProfit = finalPayoutValue - investedNow;

      await prisma.club_pool_positions.update({
        where: { id: pos.id },
        data: {
          status: "SETTLED",
          realizedPnl: decToStr(realizedProfit),
          currentValue: decToStr(finalPayoutValue)
        }
      });

      // Return the invested amount to cash, then apply realized PnL.
      if (investedNow > 0) {
        await prisma.club_pools.update({
          where: { id: pos.poolId },
          data: { cash: { increment: decToStr(investedNow) } }
        });
      }

      if (Math.abs(realizedProfit) > 0) {
        await prisma.club_pools.update({
          where: { id: pos.poolId },
          data: { realizedPnl: { increment: decToStr(realizedProfit) } }
        });
      }
    }
  }
}

