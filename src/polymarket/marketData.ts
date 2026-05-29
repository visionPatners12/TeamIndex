import type { Env } from "../config/env";
import type { MarketClobData } from "./allocationTypes";
import {
  getBooks,
  getMidpoint,
  getSpreadMap,
  getPricesHistory,
  calculateDepthAtSlippage,
  estimateSlippage,
  getBestBidAsk,
} from "./clobClient";
import { getMarketByConditionId } from "./gammaClient";

/**
 * Fetch a complete, engine-ready market-data snapshot for one market by
 * combining the CLOB order book / midpoint / spread / price-history with the
 * Gamma metadata (volume24h, liquidity, end date, closed status).
 *
 * Resilient by construction: every upstream call is guarded, and price /
 * bid / ask always come back finite so the allocation engine never sees NaN.
 */
export async function fetchMarketData(
  env: Env,
  conditionId: string,
  tokenId: string
): Promise<MarketClobData> {
  const [books, midStr, spreadMap, history, gammaMarket] = await Promise.all([
    getBooks(env, [tokenId]).catch(() => []),
    getMidpoint(env, tokenId).catch(() => "0.5"),
    getSpreadMap(env, [tokenId]).catch(() => ({} as Record<string, string>)),
    getPricesHistory(env, tokenId, "1d").catch(() => []),
    // Gamma metadata must be resolved by conditionId (0x…), not numeric id.
    getMarketByConditionId(env, conditionId).catch(() => null),
  ]);

  const book      = (books as any[])[0];
  const parsedMid = parseFloat(midStr as string);
  const { bestBid, bestAsk } = book
    ? getBestBidAsk(book)
    : { bestBid: NaN, bestAsk: NaN };

  const bookMid = Number.isFinite(bestBid) && Number.isFinite(bestAsk)
    ? (bestBid + bestAsk) / 2
    : NaN;
  const midpoint = Number.isFinite(parsedMid)
    ? parsedMid
    : (Number.isFinite(bookMid) ? bookMid : 0.5);

  const spread = parseFloat((spreadMap as Record<string, string>)[tokenId] ?? "0");

  const safeBestBid = Number.isFinite(bestBid) ? bestBid : Math.max(0, midpoint - 0.01);
  const safeBestAsk = Number.isFinite(bestAsk) ? bestAsk : Math.min(1, midpoint + 0.01);

  const depthAt2Pct = book ? calculateDepthAtSlippage(book, safeBestAsk, 0.02) : 0;
  const slippage    = book ? estimateSlippage(book, 5_000) : 0.03;

  const bookLiquidity = book
    ? ((book.bids ?? []) as any[]).reduce((s: number, b: any) => s + parseFloat(b.price) * parseFloat(b.size), 0) +
      ((book.asks ?? []) as any[]).reduce((s: number, a: any) => s + parseFloat(a.price) * parseFloat(a.size), 0)
    : 0;

  const gamma     = gammaMarket as Record<string, any> | null;
  const gammaLiq  = Number(gamma?.liquidityAmountUSD ?? gamma?.liquidity ?? 0);
  const liquidity = gammaLiq > 0 ? gammaLiq : bookLiquidity;
  const volume24h = Number(gamma?.volume24hr ?? gamma?.oneDayVolume ?? gamma?.volume24h ?? 0);
  const isClosed  = Boolean(gamma?.closed ?? false);
  const endDateIso: string | null = gamma?.endDate ?? gamma?.resolutionTime ?? null;

  let daysToResolution = 14;
  if (endDateIso) {
    const endMs = new Date(endDateIso).getTime();
    if (Number.isFinite(endMs)) {
      daysToResolution = Math.max(0, Math.round((endMs - Date.now()) / 86_400_000));
    }
  }

  return {
    conditionId,
    price:               midpoint,
    bestBid:             safeBestBid,
    bestAsk:             safeBestAsk,
    midpoint,
    spread:              spread || Math.abs(safeBestAsk - safeBestBid),
    liquidity,
    volume24h,
    depthAt2PctSlippage: depthAt2Pct,
    estimatedSlippage:   slippage,
    daysToResolution,
    marketStatus:        isClosed ? "closed" : "open",
    historicalPrices:    history,
  };
}
