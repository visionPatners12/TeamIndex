import { Chain, ClobClient, type OrderBookSummary } from "@polymarket/clob-client-v2";
import type { Env } from "../config/env";
import type { MarketClobData, SelectedMarket } from "./allocationTypes";

function n(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function gammaMarket(env: Env, marketId: string, conditionId: string): Promise<any | null> {
  const direct = new URL(`/markets/${encodeURIComponent(marketId)}`, env.POLYMARKET_GAMMA_URL);
  const response = await fetch(direct, { signal: AbortSignal.timeout(10_000) });
  if (response.ok) return response.json();
  const list = new URL("/markets", env.POLYMARKET_GAMMA_URL);
  list.searchParams.set("condition_ids", conditionId);
  const fallback = await fetch(list, { signal: AbortSignal.timeout(10_000) });
  if (!fallback.ok) return null;
  const payload = await fallback.json();
  return Array.isArray(payload) ? payload[0] ?? null : payload;
}

function orderRows(rows: Array<{ price: string; size: string }> | undefined) {
  return (rows ?? []).map((row) => ({ price: n(row.price), size: n(row.size) }));
}

function slippageForBuy(asks: Array<{ price: number; size: number }>, notional = 1_000) {
  if (asks.length === 0) return 1;
  const sorted = [...asks].sort((a, b) => a.price - b.price);
  let remaining = notional;
  let shares = 0;
  let spent = 0;
  for (const ask of sorted) {
    const availableNotional = ask.price * ask.size;
    const used = Math.min(remaining, availableNotional);
    spent += used;
    shares += ask.price > 0 ? used / ask.price : 0;
    remaining -= used;
    if (remaining <= 0) break;
  }
  if (shares === 0) return 1;
  return Math.max(0, spent / shares - sorted[0].price);
}

function depthWithinTwoPercent(book: OrderBookSummary) {
  const bids = orderRows(book.bids);
  const asks = orderRows(book.asks);
  const bestBid = bids.reduce((best, row) => Math.max(best, row.price), 0);
  const bestAsk = asks.reduce((best, row) => Math.min(best, row.price), 1);
  const bidDepth = bids
    .filter((row) => row.price >= bestBid * 0.98)
    .reduce((sum, row) => sum + row.price * row.size, 0);
  const askDepth = asks
    .filter((row) => row.price <= bestAsk * 1.02)
    .reduce((sum, row) => sum + row.price * row.size, 0);
  return bidDepth + askDepth;
}

export async function fetchPolymarketMarketData(
  env: Env,
  market: SelectedMarket,
): Promise<MarketClobData> {
  const client = new ClobClient({ host: env.POLYMARKET_CLOB_URL, chain: Chain.POLYGON });
  const [book, history, tickSize, negRisk, feeRateBps, details, gamma] = await Promise.all([
    client.getOrderBook(market.tokenId),
    client.getPricesHistory({ market: market.tokenId, interval: "max" as any, fidelity: 60 }),
    client.getTickSize(market.tokenId),
    client.getNegRisk(market.tokenId),
    client.getFeeRateBps(market.tokenId),
    client.getClobMarketInfo(market.conditionId),
    gammaMarket(env, market.marketId, market.conditionId),
  ]);
  const bids = orderRows(book.bids);
  const asks = orderRows(book.asks);
  const bestBid = bids.reduce((best, row) => Math.max(best, row.price), 0);
  const bestAsk = asks.reduce((best, row) => Math.min(best, row.price), 1);
  const gammaPrices = Array.isArray(gamma?.outcomePrices)
    ? gamma.outcomePrices
    : typeof gamma?.outcomePrices === "string"
      ? JSON.parse(gamma.outcomePrices)
      : [];
  const gammaPrice = n(gammaPrices[market.selectedSide === "NO" ? 1 : 0], NaN);
  const midpoint = bestBid > 0 && bestAsk < 1
    ? (bestBid + bestAsk) / 2
    : gammaPrice;
  if (!Number.isFinite(midpoint) || midpoint <= 0 || midpoint >= 1) {
    throw new Error(`No valid price for Polymarket token ${market.tokenId}`);
  }
  const endDate = gamma?.endDate ? new Date(gamma.endDate).getTime() : Date.now() + 30 * 86_400_000;
  const daysToResolution = Math.max(0, (endDate - Date.now()) / 86_400_000);

  return {
    conditionId: market.conditionId,
    price: midpoint,
    bestBid,
    bestAsk,
    midpoint,
    spread: Math.max(0, bestAsk - bestBid),
    liquidity: n(gamma?.liquidityNum ?? gamma?.liquidity),
    volume24h: n(gamma?.volume24hr ?? gamma?.volume24h),
    depthAt2PctSlippage: depthWithinTwoPercent(book),
    estimatedSlippage: slippageForBuy(asks),
    daysToResolution,
    marketStatus: gamma?.closed || gamma?.active === false ? "closed" : "open",
    historicalPrices: history.map((point) => ({ t: n(point.t), p: n(point.p) })),
    tickSize,
    minOrderSize: n(details.mos ?? details.mts),
    feeRateBps,
    negRisk,
  };
}
