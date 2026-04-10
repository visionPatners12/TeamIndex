"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.executeTranche = executeTranche;
const prisma_1 = require("../db/prisma");
const clobClient_1 = require("../polymarket/clobClient");
const riskEngine_1 = require("./riskEngine");
const ethers_1 = require("ethers");
const vaultExecutor_1 = require("../onchain/vaultExecutor");
function decToNumber(d) {
    if (typeof d === "number")
        return d;
    if (typeof d === "string")
        return Number(d);
    if (d && typeof d.toString === "function")
        return Number(d.toString());
    return 0;
}
function getRiskPerMatchPct(poolRiskParams, fallback) {
    const v = poolRiskParams?.maxPerMatchPct ?? poolRiskParams?.riskPerMatchPct ?? poolRiskParams?.perMatchPct;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}
function getLiquidityMinUsd(poolRiskParams, fallback) {
    const v = poolRiskParams?.liquidityMinUsd ?? poolRiskParams?.liquidityUsdMin ?? poolRiskParams?.minLiquidityUsd;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}
async function executeTranche(params) {
    const { env, poolId, candidateId, tranche, expectedExecutionTimeMs } = params;
    // Missed execution window handling (brief requirement):
    // If the worker runs too late, mark as SKIPPED instead of failing.
    const graceMinutes = Number(env.MISSED_EXECUTION_GRACE_MINUTES ?? 15);
    const graceMs = graceMinutes * 60 * 1000;
    if (expectedExecutionTimeMs && Date.now() > expectedExecutionTimeMs + graceMs) {
        await prisma_1.prisma.club_match_queue.updateMany({
            where: { poolId, candidateId, tranche, status: "SCHEDULED" },
            data: { status: "SKIPPED", lastError: "Missed execution window" }
        });
        return { skipped: true, reason: "missed_window" };
    }
    const [pool, candidate] = await Promise.all([
        prisma_1.prisma.club_pools.findUnique({ where: { id: poolId } }),
        prisma_1.prisma.club_market_candidates.findUnique({ where: { id: candidateId } })
    ]);
    if (!pool)
        throw new Error("Pool not found");
    if (!candidate)
        throw new Error("Candidate not found");
    if (!candidate.tokenId) {
        await prisma_1.prisma.club_match_queue.updateMany({
            where: { poolId, candidateId, tranche, status: "SCHEDULED" },
            data: { status: "SKIPPED", lastError: "Candidate tokenId missing" }
        });
        return { skipped: true, reason: "missing_tokenId" };
    }
    // Liquidity check (MVP heuristic).
    const books = await (0, clobClient_1.getBooks)(env, [candidate.tokenId]);
    const book = books[0];
    const bestAsk = book?.asks?.[0]?.price;
    const bestBid = book?.bids?.[0]?.price;
    const bestAskSize = book?.asks?.[0]?.size;
    const bestBidSize = book?.bids?.[0]?.size;
    if (!bestAsk || !bestBid) {
        await prisma_1.prisma.club_match_queue.updateMany({
            where: { poolId, candidateId, tranche, status: "SCHEDULED" },
            data: { status: "SKIPPED", lastError: "No valid market/liquidity" }
        });
        return { skipped: true, reason: "no_liquidity" };
    }
    const liquidityUsd = Number(bestBid) * Number(bestBidSize || "0");
    const liquidityMinUsd = getLiquidityMinUsd(pool.riskParams, 50_000);
    if (liquidityUsd < liquidityMinUsd) {
        await prisma_1.prisma.club_match_queue.updateMany({
            where: { poolId, candidateId, tranche, status: "SCHEDULED" },
            data: { status: "SKIPPED", lastError: `Liquidity too low: ${liquidityUsd}` }
        });
        return { skipped: true, liquidityUsd };
    }
    // Risk check: proposed match exposure uses pool.totalPoolValue * maxPerMatchPct / 100.
    const poolTotalValueUsd = decToNumber(pool.totalPoolValue);
    // Exposure should count pending/tranche stake as well (brief: "simultaneous exposure"),
    // so use plannedStake from OPEN positions instead of mark-to-market openPositionsValue.
    const exposureAgg = await prisma_1.prisma.club_pool_positions.aggregate({
        where: { poolId, status: "OPEN" },
        _sum: { plannedStake: true }
    });
    const poolExposureUsd = decToNumber(exposureAgg?._sum?.plannedStake);
    const maxPerMatchPct = getRiskPerMatchPct(pool.riskParams, 3);
    const maxTotalExposurePct = Number(pool.riskParams?.maxTotalExposurePct ?? 20);
    const proposedMatchExposureUsd = poolTotalValueUsd * (maxPerMatchPct / 100);
    const risk = (0, riskEngine_1.isWithinRisk)({
        poolTotalValueUsd,
        poolTotalExposureUsd: poolExposureUsd,
        maxPerMatchPct,
        maxTotalExposurePct,
        proposedMatchExposureUsd
    });
    if (!risk.ok) {
        await prisma_1.prisma.club_match_queue.updateMany({
            where: { poolId, candidateId, tranche, status: "SCHEDULED" },
            data: { status: "SKIPPED", lastError: "Risk limits exceeded" }
        });
        return { skipped: true, reason: "risk" };
    }
    // MVP rule: split exposure equally across two tranches.
    const trancheStakeUsd = proposedMatchExposureUsd / 2;
    const entryPrice = bestAsk; // marketable-ish for BUY
    if (!entryPrice)
        throw new Error("Entry price missing");
    const quantity = trancheStakeUsd / Number(entryPrice);
    if (!Number.isFinite(quantity) || quantity <= 0)
        throw new Error("Invalid quantity");
    // Side mapping:
    // If candidate.side is YES token, we BUY that token to represent "club wins".
    const sideForClob = "BUY";
    // Custody improvement: set CLOB `taker` to the pool's vault contract address.
    // This increases the chance that conditional tokens/settlement are credited to the vault.
    let taker;
    let vaultContractForAuth;
    if (env.RPC_URL) {
        try {
            const provider = new ethers_1.ethers.JsonRpcProvider(env.RPC_URL);
            const vault = await (0, vaultExecutor_1.getVaultContract)(env, provider, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined });
            vaultContractForAuth = vault;
            taker = vault.target;
        }
        catch {
            taker = undefined;
        }
    }
    // Access control: require executor wallet to be an authorized operator on the vault.
    if (vaultContractForAuth && env.EXECUTOR_PRIVATE_KEY) {
        const executorAddress = new ethers_1.ethers.Wallet(env.EXECUTOR_PRIVATE_KEY).address;
        const opInfo = await vaultContractForAuth.getOperatorInfo(executorAddress);
        if (!opInfo?.authorized) {
            await prisma_1.prisma.club_match_queue.updateMany({
                where: { poolId, candidateId, tranche, status: "SCHEDULED" },
                data: { status: "SKIPPED", lastError: "Unauthorized executor operator" }
            });
            return { skipped: true, reason: "unauthorized_operator" };
        }
    }
    const orderResult = await (0, clobClient_1.postLimitOrder)(env, {
        tokenId: candidate.tokenId,
        price: entryPrice,
        size: quantity.toString(),
        side: sideForClob,
        taker
    }).catch((err) => {
        // Brief: "skip if no valid market is found"; order posting failures are often
        // transient but should not mark the job as SUCCESS.
        throw new Error(`Order posting failed: ${String(err?.message ?? err)}`);
    });
    const clobOrderId = orderResult?.orderID ?? orderResult?.orderId;
    // Persist position.
    await prisma_1.prisma.club_pool_positions.create({
        data: {
            poolId,
            eventId: candidate.eventId,
            marketId: candidate.marketId,
            tokenId: candidate.tokenId,
            side: candidate.side,
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
    });
    await prisma_1.prisma.club_match_queue.updateMany({
        where: { poolId, candidateId, tranche, status: "SCHEDULED" },
        data: { status: "EXECUTED", lastError: null }
    });
    // You may also want to store orderResult in a tx table; MVP keeps it offchain.
    return { executed: true, orderResult };
}
