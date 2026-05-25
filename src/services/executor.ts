import type { Env } from "../config/env";
import { prisma } from "../db/prisma";
import {
  getBooks,
  getOrderRejectMessage,
  isAcceptedOrderResult,
  postLimitOrder
} from "../polymarket/clobClient";
import { getPolymarketReadiness } from "../polymarket/polymarketWallet";
import { isWithinRisk } from "./riskEngine";

type ExecuteParams = {
  queueId?: string;
  poolId: string;
  candidateId: string;
  tranche: number; // 1 => 48h, 2 => 24h
  expectedExecutionTimeMs?: number;
  env: Env;
};

function decToNumber(d: any): number {
  if (typeof d === "number") return d;
  if (typeof d === "string") return Number(d);
  if (d && typeof d.toString === "function") return Number(d.toString());
  return 0;
}

function getRiskPerMatchPct(poolRiskParams: any, fallback: number) {
  const v = poolRiskParams?.maxPerMatchPct ?? poolRiskParams?.riskPerMatchPct ?? poolRiskParams?.perMatchPct;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function getLiquidityMinUsd(poolRiskParams: any, fallback: number) {
  const v = poolRiskParams?.liquidityMinUsd ?? poolRiskParams?.liquidityUsdMin ?? poolRiskParams?.minLiquidityUsd;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function queueLookup(params: ExecuteParams) {
  if (params.queueId) return prisma.club_match_queue.findUnique({ where: { id: params.queueId } });
  return prisma.club_match_queue.findUnique({
    where: {
      poolId_candidateId_tranche: {
        poolId: params.poolId,
        candidateId: params.candidateId,
        tranche: params.tranche
      }
    }
  });
}

async function claimQueue(params: ExecuteParams) {
  const current = await queueLookup(params);
  if (!current) {
    return { claimed: null, current: null };
  }

  const lockOwner = `executor:${process.pid}:${Date.now()}`;
  const result = await prisma.club_match_queue.updateMany({
    where: { id: current.id, status: "SCHEDULED" },
    data: {
      status: "PROCESSING",
      lockedAt: new Date(),
      lockedBy: lockOwner,
      attempts: { increment: 1 },
      lastError: null
    }
  });

  if (result.count !== 1) {
    return {
      claimed: null,
      current: await prisma.club_match_queue.findUnique({ where: { id: current.id } })
    };
  }

  return {
    claimed: await prisma.club_match_queue.findUnique({ where: { id: current.id } }),
    current: null
  };
}

async function finishQueue(queueId: string, status: "SKIPPED" | "FAILED" | "EXECUTED", lastError?: string | null) {
  await prisma.club_match_queue.updateMany({
    where: { id: queueId, status: "PROCESSING" },
    data: {
      status,
      lastError: lastError ?? null,
      lockedAt: null,
      lockedBy: null,
      executedAt: status === "EXECUTED" ? new Date() : undefined
    }
  });
}

export async function executeTranche(params: ExecuteParams) {
  const { env, poolId, candidateId, tranche } = params;
  const { claimed: queue, current } = await claimQueue(params);

  if (!queue) {
    return {
      skipped: true,
      reason: current ? "already_claimed_or_terminal" : "queue_not_found",
      status: current?.status ?? null
    };
  }

  try {
    // Missed execution window handling (brief requirement):
    // If the worker runs too late, mark as SKIPPED instead of failing.
    const graceMinutes = Number(env.MISSED_EXECUTION_GRACE_MINUTES ?? 15);
    const graceMs = graceMinutes * 60 * 1000;
    const expectedExecutionTimeMs = params.expectedExecutionTimeMs ?? queue.executionTime.getTime();
    if (expectedExecutionTimeMs && Date.now() > expectedExecutionTimeMs + graceMs) {
      await finishQueue(queue.id, "SKIPPED", "Missed execution window");
      return { skipped: true, reason: "missed_window" };
    }

    const [pool, candidate] = await Promise.all([
      prisma.club_pools.findUnique({ where: { id: poolId } }),
      prisma.club_market_candidates.findUnique({ where: { id: candidateId } })
    ]);
    if (!pool) throw new Error("Pool not found");
    if (!candidate) throw new Error("Candidate not found");

    if (!candidate.tokenId) {
      await finishQueue(queue.id, "SKIPPED", "Candidate tokenId missing");
      return { skipped: true, reason: "missing_tokenId" };
    }

    // Liquidity check (MVP heuristic).
    const books = await getBooks(env, [candidate.tokenId]);
    const book = books[0];
    const bestAsk = book?.asks?.[0]?.price;
    const bestBid = book?.bids?.[0]?.price;
    const bestAskSize = book?.asks?.[0]?.size;
    const bestBidSize = book?.bids?.[0]?.size;

    if (!bestAsk || !bestBid) {
      await finishQueue(queue.id, "SKIPPED", "No valid market/liquidity");
      return { skipped: true, reason: "no_liquidity" };
    }

    const liquidityUsd = Number(bestBid) * Number(bestBidSize || "0");
    const liquidityMinUsd = getLiquidityMinUsd(pool.riskParams, 50_000);
    if (liquidityUsd < liquidityMinUsd) {
      await finishQueue(queue.id, "SKIPPED", `Liquidity too low: ${liquidityUsd}`);
      return { skipped: true, liquidityUsd };
    }

    // Risk check: proposed match exposure uses pool.totalPoolValue * maxPerMatchPct / 100.
    const poolTotalValueUsd = decToNumber(pool.totalPoolValue);
    // Exposure should count pending/tranche stake as well (brief: "simultaneous exposure"),
    // so use plannedStake from OPEN positions instead of mark-to-market openPositionsValue.
    const exposureAgg = await prisma.club_pool_positions.aggregate({
      where: { poolId, status: "OPEN" },
      _sum: { plannedStake: true }
    });
    const poolExposureUsd = decToNumber((exposureAgg as any)?._sum?.plannedStake);

    const maxPerMatchPct = getRiskPerMatchPct(pool.riskParams, 3);
    const maxTotalExposurePct = Number((pool.riskParams as any)?.maxTotalExposurePct ?? 20);

    const proposedMatchExposureUsd = poolTotalValueUsd * (maxPerMatchPct / 100);
    const risk = isWithinRisk({
      poolTotalValueUsd,
      poolTotalExposureUsd: poolExposureUsd,
      maxPerMatchPct,
      maxTotalExposurePct,
      proposedMatchExposureUsd
    });
    if (!risk.ok) {
      await finishQueue(queue.id, "SKIPPED", "Risk limits exceeded");
      return { skipped: true, reason: "risk" };
    }

    // MVP rule: split exposure equally across two tranches.
    const trancheStakeUsd = proposedMatchExposureUsd / 2;
    const entryPrice = bestAsk; // marketable-ish for BUY

    if (!entryPrice) throw new Error("Entry price missing");

    const quantity = trancheStakeUsd / Number(entryPrice);
    if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("Invalid quantity");

    // Side mapping:
    // If candidate.side is YES token, we BUY that token to represent "club wins".
    const sideForClob = "BUY";

    const readiness = await getPolymarketReadiness(env, candidate.tokenId);
    if (!readiness.tradingReady) {
      const lastError = `Polymarket not ready: ${readiness.reasons.join("; ") || "unknown readiness failure"}`;
      await finishQueue(queue.id, "SKIPPED", lastError);
      return { skipped: true, reason: "polymarket_not_ready", readiness };
    }

    let orderResult: unknown;
    try {
      orderResult = await postLimitOrder(env, {
        tokenId: candidate.tokenId,
        price: entryPrice,
        size: quantity.toString(),
        side: sideForClob
      });
    } catch (err: any) {
      const lastError = `Order posting failed: ${String(err?.message ?? err)}`;
      await finishQueue(queue.id, "FAILED", lastError);
      throw new Error(lastError);
    }

    if (!isAcceptedOrderResult(orderResult)) {
      const lastError = getOrderRejectMessage(orderResult);
      await finishQueue(queue.id, "FAILED", lastError);
      return { skipped: true, reason: "clob_rejected", orderResult };
    }

    const clobOrderId: string | undefined = (orderResult as any)?.orderID ?? (orderResult as any)?.orderId;

    // Persist position and finish queue together. `queueId` is unique, so a
    // replay cannot create a second position for the same scheduled tranche.
    await prisma.$transaction([
      prisma.club_pool_positions.upsert({
        where: { queueId: queue.id },
        update: {
          clobOrderId: clobOrderId ?? undefined
        },
        create: {
          queueId: queue.id,
          poolId,
          eventId: candidate.eventId,
          marketId: candidate.marketId,
          tokenId: candidate.tokenId,
          side: candidate.side as any,
          entryPrice: entryPrice.toString(),
          clobOrderId: clobOrderId ?? null,

          plannedStake: trancheStakeUsd.toString(),
          plannedQuantity: quantity.toString(),

          // Start with 0 filled until we confirm fills from CLOB.
          stake: "0",
          quantity: "0",
          investedAmount: "0",
          currentValue: "0",
          realizedPnl: "0",
          status: "OPEN"
        }
      }),
      prisma.club_match_queue.update({
        where: { id: queue.id },
        data: {
          status: "EXECUTED",
          lastError: null,
          lockedAt: null,
          lockedBy: null,
          executedAt: new Date()
        }
      })
    ]);

    // You may also want to store orderResult in a tx table; MVP keeps it offchain.
    return { executed: true, orderResult };
  } catch (err: any) {
    await finishQueue(queue.id, "FAILED", String(err?.message ?? err).slice(0, 500));
    throw err;
  }
}
