/**
 * limitlessExecutor.ts
 *
 * Trade execution engine for Limitless Exchange.
 * Equivalent of executor.ts (which posts limit orders to Polymarket CLOB).
 *
 * Flow per tranche:
 *   1. Claim the queue entry (optimistic lock).
 *   2. Check missed-execution window.
 *   3. Load pool + candidate.
 *   4. Fetch live order book — liquidity gate.
 *   5. Risk check (isWithinRisk).
 *   6. Check Limitless trading readiness (wallet configured).
 *   7. Post limit order via Limitless order API.
 *   8. Persist club_pool_positions + mark queue as EXECUTED in a transaction.
 */

import type { Env } from "../config/env";
import { prisma } from "../db/prisma";
import {
  getBestBidAsk,
  postLimitlessOrder,
  isAcceptedOrderResult,
  getOrderRejectMessage,
  isLimitlessTradingReady,
} from "./limitlessOrderClient";
import { getMarketBySlug, getOrderBook } from "./limitlessClient";
import { decodeLimitlessTokenId } from "./limitlessDiscoveryService";
import { resolveProfileIdForAddress, sameAddress } from "./partnerAccounts";
import { isWithinRisk } from "../services/riskEngine";
import { ensureVaultErc20Allowance } from "../onchain/vaultExecutor";

type ExecuteLimitlessParams = {
  queueId?: string;
  poolId: string;
  candidateId: string;
  tranche: number; // 1 → 48h window, 2 → 24h window
  expectedExecutionTimeMs?: number;
  env: Env;
};

function decToNumber(d: unknown): number {
  if (typeof d === "number") return d;
  if (typeof d === "string") return Number(d);
  if (d && typeof (d as any).toString === "function") return Number((d as any).toString());
  return 0;
}

function humanUsdToBase6(amount: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`Invalid USD amount: ${amount}`);
  return BigInt(Math.ceil(amount * 1_000_000));
}

function getRiskPerMatchPct(poolRiskParams: unknown, fallback: number): number {
  const p = poolRiskParams as Record<string, unknown> | null | undefined;
  const v = p?.maxPerMatchPct ?? p?.riskPerMatchPct ?? p?.perMatchPct;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function getLiquidityMinUsd(poolRiskParams: unknown, fallback: number): number {
  const p = poolRiskParams as Record<string, unknown> | null | undefined;
  const v = p?.liquidityMinUsd ?? p?.liquidityUsdMin ?? p?.minLiquidityUsd;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ─── Queue claim / release helpers ───────────────────────────────────────────

function queueLookup(params: ExecuteLimitlessParams) {
  if (params.queueId) {
    return prisma.club_match_queue.findUnique({ where: { id: params.queueId } });
  }
  return prisma.club_match_queue.findUnique({
    where: {
      poolId_candidateId_tranche: {
        poolId: params.poolId,
        candidateId: params.candidateId,
        tranche: params.tranche,
      },
    },
  });
}

async function claimQueue(params: ExecuteLimitlessParams) {
  const current = await queueLookup(params);
  if (!current) return { claimed: null, current: null };

  const lockOwner = `limitless-executor:${process.pid}:${Date.now()}`;
  const result = await prisma.club_match_queue.updateMany({
    where: { id: current.id, status: "SCHEDULED" },
    data: {
      status: "PROCESSING",
      lockedAt: new Date(),
      lockedBy: lockOwner,
      attempts: { increment: 1 },
      lastError: null,
    },
  });

  if (result.count !== 1) {
    return {
      claimed: null,
      current: await prisma.club_match_queue.findUnique({ where: { id: current.id } }),
    };
  }

  return {
    claimed: await prisma.club_match_queue.findUnique({ where: { id: current.id } }),
    current: null,
  };
}

async function finishQueue(
  queueId: string,
  status: "SKIPPED" | "FAILED" | "EXECUTED",
  lastError?: string | null
) {
  await prisma.club_match_queue.updateMany({
    where: { id: queueId, status: "PROCESSING" },
    data: {
      status,
      lastError: lastError ?? null,
      lockedAt: null,
      lockedBy: null,
      executedAt: status === "EXECUTED" ? new Date() : undefined,
    },
  });
}

// ─── Main executor ────────────────────────────────────────────────────────────

export async function executeLimitlessTranche(params: ExecuteLimitlessParams) {
  const { env, poolId, candidateId, tranche } = params;
  const { claimed: queue, current } = await claimQueue(params);

  if (!queue) {
    return {
      skipped: true,
      reason: current ? "already_claimed_or_terminal" : "queue_not_found",
      status: current?.status ?? null,
    };
  }

  try {
    // ── Missed-window check ───────────────────────────────────────────────
    const graceMinutes = Number(env.MISSED_EXECUTION_GRACE_MINUTES ?? 15);
    const graceMs = graceMinutes * 60 * 1000;
    const expectedMs = params.expectedExecutionTimeMs ?? queue.executionTime.getTime();
    if (expectedMs && Date.now() > expectedMs + graceMs) {
      await finishQueue(queue.id, "SKIPPED", "Missed execution window");
      return { skipped: true, reason: "missed_window" };
    }

    // ── Load pool + candidate ─────────────────────────────────────────────
    const [pool, candidate] = await Promise.all([
      prisma.club_pools.findUnique({ where: { id: poolId } }),
      prisma.club_market_candidates.findUnique({ where: { id: candidateId } }),
    ]);
    if (!pool) throw new Error("Pool not found");
    if (!candidate) throw new Error("Candidate not found");
    if (!pool.vaultAddress) {
      await finishQueue(queue.id, "SKIPPED", "Pool vaultAddress missing");
      return { skipped: true, reason: "missing_vaultAddress" };
    }
    if (!candidate.tokenId) {
      await finishQueue(queue.id, "SKIPPED", "Candidate tokenId missing");
      return { skipped: true, reason: "missing_tokenId" };
    }

    // ── Decode Limitless tokenId → marketSlug + outcome side ──────────────
    // tokenId format: "<slug>:yes" or "<slug>:no"
    const { marketId: marketSlug, outcomeIndex } = decodeLimitlessTokenId(candidate.tokenId);
    const outcome: "yes" | "no" = outcomeIndex === 0 ? "yes" : "no";

    // ── Live order book + liquidity gate ──────────────────────────────────
    // GET /markets/{slug}/orderbook
    const book = await getOrderBook(env, marketSlug);
    const { bestBid, bestAsk } = getBestBidAsk(book);

    if (!bestAsk || !bestBid || !Number.isFinite(bestAsk)) {
      await finishQueue(queue.id, "SKIPPED", "No valid market / no liquidity");
      return { skipped: true, reason: "no_liquidity" };
    }

    const liquidityUsdc = book.bids.reduce((s, b) => s + b.price * b.size, 0) +
                          book.asks.reduce((s, a) => s + a.price * a.size, 0);
    const liquidityMinUsd = getLiquidityMinUsd(pool.riskParams, 50_000);

    if (liquidityUsdc < liquidityMinUsd) {
      await finishQueue(queue.id, "SKIPPED", `Liquidity too low: ${liquidityUsdc}`);
      return { skipped: true, reason: "low_liquidity", liquidityUsdc };
    }

    // ── Risk check ────────────────────────────────────────────────────────
    const poolTotalValueUsd = decToNumber(pool.totalPoolValue);
    const exposureAgg = await prisma.club_pool_positions.aggregate({
      where: { poolId, status: "OPEN" },
      _sum: { plannedStake: true },
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
      proposedMatchExposureUsd,
    });

    if (!risk.ok) {
      await finishQueue(queue.id, "SKIPPED", "Risk limits exceeded");
      return { skipped: true, reason: "risk" };
    }

    // ── Limitless trading readiness check ─────────────────────────────────
    const readiness = isLimitlessTradingReady(env);
    if (!readiness.ready) {
      const lastError = `Limitless not ready: ${readiness.reasons.join("; ")}`;
      await finishQueue(queue.id, "SKIPPED", lastError);
      return { skipped: true, reason: "limitless_not_ready", readiness };
    }

    // ── Size + price calculation ──────────────────────────────────────────
    const trancheStakeUsd = proposedMatchExposureUsd / 2;
    if (!Number.isFinite(trancheStakeUsd) || trancheStakeUsd <= 0) {
      throw new Error("Invalid trancheStakeUsd");
    }

    // ── Resolve the vault's Limitless ownerId ──────────────────────────────
    // Since the order maker is the vault, ownerId must belong to that vault's
    // Limitless partner sub-account, not the global API profile/server wallet.
    const storedLimitlessAccount = await (prisma as any).pool_limitless_accounts.findUnique({
      where: { poolId },
    });
    let vaultProfileId: string | null = null;
    if (
      storedLimitlessAccount?.limitlessProfileId &&
      sameAddress(storedLimitlessAccount.accountAddress, pool.vaultAddress)
    ) {
      vaultProfileId = String(storedLimitlessAccount.limitlessProfileId);
    } else {
      vaultProfileId = await resolveProfileIdForAddress(env, pool.vaultAddress);
    }

    if (!vaultProfileId) {
      const lastError =
        `No Limitless profile is registered for the vault ${pool.vaultAddress}. ` +
        "Register the vault as a Limitless partner sub-account before betting.";
      await finishQueue(queue.id, "FAILED", lastError);
      return { skipped: true, reason: "missing_vault_limitless_profile" };
    }

    const ownerId = Number(vaultProfileId);
    if (!Number.isFinite(ownerId) || ownerId <= 0) {
      const lastError = `Invalid Limitless profileId for vault ${pool.vaultAddress}: ${vaultProfileId}`;
      await finishQueue(queue.id, "FAILED", lastError);
      return { skipped: true, reason: "invalid_vault_limitless_profile" };
    }

    try {
      await (prisma as any).pool_limitless_accounts.upsert({
        where: { poolId },
        update: {
          limitlessProfileId: vaultProfileId,
          accountAddress: pool.vaultAddress,
          serverWallet: false,
          status: "ACTIVE",
        },
        create: {
          poolId,
          limitlessProfileId: vaultProfileId,
          accountAddress: pool.vaultAddress,
          displayName: `pool-${String(poolId).slice(-6)}`,
          serverWallet: false,
          allowanceStatus: "PENDING",
          status: "ACTIVE",
        },
      });
    } catch {
      // A cache write should not block an otherwise valid order attempt.
    }

    // ── Ensure the vault has allowed Limitless to pull collateral ───────────
    const marketDetail = await getMarketBySlug(env, marketSlug);
    const limitlessExchange = marketDetail?.venue?.exchange;
    if (!limitlessExchange) {
      const lastError = `Market ${marketSlug} has no Limitless exchange address`;
      await finishQueue(queue.id, "FAILED", lastError);
      return { skipped: true, reason: "missing_limitless_exchange" };
    }
    const collateralToken =
      ((marketDetail as any)?.collateralToken?.address as string | undefined) ?? env.BASE_USDC_ADDRESS;
    await ensureVaultErc20Allowance(
      env,
      { clubName: pool.clubName, vaultAddress: pool.vaultAddress },
      {
        token: collateralToken,
        spender: limitlessExchange,
        minAllowance: humanUsdToBase6(trancheStakeUsd),
      }
    );

    // ── Post the order via Limitless order API ────────────────────────────
    let orderResult: Awaited<ReturnType<typeof postLimitlessOrder>>;
    try {
      orderResult = await postLimitlessOrder(env, {
        marketSlug,
        outcome,
        price: bestAsk,
        size: trancheStakeUsd,
        side: "BUY",
        orderType: "GTC",
        makerAddress: pool.vaultAddress,
        ownerId,
        onBehalfOf: ownerId,
      });
    } catch (err: any) {
      const lastError = `Order posting failed: ${String(err?.message ?? err)}`;
      await finishQueue(queue.id, "FAILED", lastError);
      throw new Error(lastError);
    }

    if (!isAcceptedOrderResult(orderResult)) {
      const lastError = getOrderRejectMessage(orderResult);
      await finishQueue(queue.id, "FAILED", lastError);
      return { skipped: true, reason: "order_rejected", orderResult };
    }

    const clobOrderId: string | undefined =
      (orderResult as any)?.orderId ?? (orderResult as any)?.orderID ?? (orderResult as any)?.id;

    // ── Persist position + close queue atomically ─────────────────────────
    await prisma.$transaction([
      prisma.club_pool_positions.upsert({
        where: { queueId: queue.id },
        update: { clobOrderId: clobOrderId ?? undefined },
        create: {
          queueId: queue.id,
          poolId,
          eventId: candidate.eventId,
          marketId: marketSlug,         // store the slug as marketId
          tokenId: candidate.tokenId,   // keep encoded form "<slug>:yes|no"
          side: candidate.side as any,
          entryPrice: String(bestAsk),
          clobOrderId: clobOrderId ?? null,
          plannedStake: trancheStakeUsd.toString(),
          plannedQuantity: (trancheStakeUsd / bestAsk).toString(),
          stake: "0",
          quantity: "0",
          investedAmount: "0",
          currentValue: "0",
          realizedPnl: "0",
          status: "OPEN",
        },
      }),
      prisma.club_match_queue.update({
        where: { id: queue.id },
        data: {
          status: "EXECUTED",
          lastError: null,
          lockedAt: null,
          lockedBy: null,
          executedAt: new Date(),
        },
      }),
    ]);

    return { executed: true, orderResult };
  } catch (err: any) {
    await finishQueue(queue.id, "FAILED", String(err?.message ?? err).slice(0, 500));
    throw err;
  }
}
