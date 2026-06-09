"use strict";
/**
 * limitlessMarketData.ts
 *
 * Builds engine-ready MarketClobData snapshots for Limitless markets.
 * Equivalent of polymarket/marketData.ts — same output shape so the allocation
 * engine (allocationEngine.ts) requires zero changes.
 *
 * Data sources (in priority order):
 *   1. limitless_prices table   → historicalPrices (already synced by pipeline)
 *   2. Limitless order-book API → live bid/ask/spread/depth (real-time)
 *   3. limitless_markets table  → yesPrice, liquidity, volume, endDate (cached)
 *
 * All fields are safe (finite numbers, no NaN/Infinity reaching the engine).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchLimitlessMarketData = fetchLimitlessMarketData;
exports.fetchLimitlessMarketDataBatch = fetchLimitlessMarketDataBatch;
const prisma_1 = require("../db/prisma");
const limitlessOrderClient_1 = require("./limitlessOrderClient");
// ─── Public API ───────────────────────────────────────────────────────────────
/**
 * Build a complete MarketClobData for one Limitless market.
 *
 * `marketId` is the Limitless market ID (stored as `id` in limitless_markets).
 * `conditionId` is an alias used by the engine — pass the same marketId unless
 * you have a separate condition/question ID.
 */
async function fetchLimitlessMarketData(env, marketId, conditionId) {
    const resolvedConditionId = conditionId ?? marketId;
    // ── Parallel fetches ─────────────────────────────────────────────────────
    // In Limitless, `marketId` IS the slug — it's used as the DB primary key
    const [dbMarket, book, historicalPrices] = await Promise.all([
        prisma_1.prisma.limitless_markets.findUnique({
            where: { id: marketId }, // id = slug
            select: {
                yesPrice: true, noPrice: true, liquidity: true,
                volume: true, endDate: true, status: true,
            },
        }),
        // Limitless orderbook endpoint: GET /markets/{slug}/orderbook (slug = marketId here)
        (0, limitlessOrderClient_1.getOrderBook)(env, marketId).catch(() => ({ bids: [], asks: [] })),
        fetchHistoricalPrices(marketId),
    ]);
    // ── Midpoint (prefer adjustedMidpoint from Limitless, fallback to cached) ─
    const { bestBid, bestAsk } = (0, limitlessOrderClient_1.getBestBidAsk)(book);
    const hasBook = book.bids.length > 0 || book.asks.length > 0;
    const cachedPrice = Number(dbMarket?.yesPrice?.toString() ?? "0.5");
    // getMidpointFromBook uses adjustedMidpoint if available, else (bid+ask)/2
    const bookMid = hasBook ? (0, limitlessOrderClient_1.getMidpointFromBook)(book) : NaN;
    const midpoint = Number.isFinite(bookMid) && bookMid > 0 && bookMid < 1
        ? bookMid
        : (cachedPrice > 0 && cachedPrice < 1 ? cachedPrice : 0.5);
    const safeBestBid = Number.isFinite(bestBid) ? bestBid : Math.max(0, midpoint - 0.01);
    const safeBestAsk = Number.isFinite(bestAsk) ? bestAsk : Math.min(1, midpoint + 0.01);
    // ── Spread ───────────────────────────────────────────────────────────────
    const spread = hasBook
        ? (0, limitlessOrderClient_1.getSpread)(book)
        : Math.abs(safeBestAsk - safeBestBid);
    // ── Depth & slippage ─────────────────────────────────────────────────────
    const depthAt2Pct = hasBook
        ? (0, limitlessOrderClient_1.calculateDepthAtSlippage)(book, safeBestAsk, 0.02)
        : estimateDepthFromLiquidity(Number(dbMarket?.liquidity?.toString() ?? "0"), 0.02);
    const slippage = hasBook
        ? (0, limitlessOrderClient_1.estimateSlippage)(book, 5_000)
        : estimateSlippageFromLiquidity(Number(dbMarket?.liquidity?.toString() ?? "0"));
    // ── Liquidity & volume ───────────────────────────────────────────────────
    const bookLiquidity = hasBook
        ? book.bids.reduce((s, b) => s + b.price * b.size, 0) +
            book.asks.reduce((s, a) => s + a.price * a.size, 0)
        : 0;
    const dbLiquidity = Number(dbMarket?.liquidity?.toString() ?? "0");
    const liquidity = dbLiquidity > 0 ? dbLiquidity : bookLiquidity;
    // volume from the `volume` field is total lifetime — approximate 24h as 5%.
    const totalVolume = Number(dbMarket?.volume?.toString() ?? "0");
    const volume24h = totalVolume * 0.05;
    // ── Days to resolution ───────────────────────────────────────────────────
    let daysToResolution = 14;
    if (dbMarket?.endDate) {
        const endMs = new Date(dbMarket.endDate).getTime();
        if (Number.isFinite(endMs)) {
            daysToResolution = Math.max(0, (endMs - Date.now()) / 86_400_000);
        }
    }
    // ── Market status ────────────────────────────────────────────────────────
    const status = String(dbMarket?.status ?? "ACTIVE").toUpperCase();
    const marketStatus = status === "ACTIVE" ? "open" : "closed";
    return {
        conditionId: resolvedConditionId,
        price: midpoint,
        bestBid: safeBestBid,
        bestAsk: safeBestAsk,
        midpoint,
        spread,
        liquidity,
        volume24h,
        depthAt2PctSlippage: depthAt2Pct,
        estimatedSlippage: slippage,
        daysToResolution,
        marketStatus,
        historicalPrices,
    };
}
/**
 * Batch variant — fetches market data for multiple markets in parallel.
 * Returns a Map keyed by conditionId (= marketId unless overridden).
 */
async function fetchLimitlessMarketDataBatch(env, marketIds) {
    const results = await Promise.all(marketIds.map(id => fetchLimitlessMarketData(env, id).then(d => [id, d])));
    return new Map(results);
}
// ─── Private helpers ──────────────────────────────────────────────────────────
/** Pull historical prices from limitless_prices table and convert to engine format. */
async function fetchHistoricalPrices(marketId, outcomeIndex = 0, limit = 200) {
    try {
        const rows = await prisma_1.prisma.limitless_prices.findMany({
            where: { marketId, outcomeIndex },
            orderBy: { timestamp: "asc" },
            take: limit,
            select: { timestamp: true, price: true },
        });
        return rows.map(r => ({
            t: Math.floor(new Date(r.timestamp).getTime() / 1000),
            p: Number(r.price.toString()),
        })).filter(r => Number.isFinite(r.t) && Number.isFinite(r.p) && r.p > 0 && r.p < 1);
    }
    catch {
        return [];
    }
}
/**
 * Rough depth estimate when no live order book is available.
 * Assumes 5% of total liquidity is available within 2% of mid.
 */
function estimateDepthFromLiquidity(liquidityUsdc, _slippagePct) {
    return liquidityUsdc * 0.05;
}
/**
 * Rough slippage estimate when no live order book is available.
 * Low liquidity → high slippage, high liquidity → near-zero slippage.
 */
function estimateSlippageFromLiquidity(liquidityUsdc) {
    if (liquidityUsdc <= 0)
        return 0.10;
    // Heuristic: slippage ≈ 500 / liquidity (caps at 10%, floors at 0.1%)
    return Math.min(0.10, Math.max(0.001, 500 / liquidityUsdc));
}
