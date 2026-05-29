import type { Env } from "../config/env";
import {
  assertPolymarketClobConfig,
  createPolymarketWalletClient,
  POLY_1271_SIGNATURE_TYPE,
  resolvePolymarketFunderAddress
} from "./polymarketWallet";

type OrderBookSummary = {
  market: string;
  asset_id: string;
  timestamp: string;
  hash: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  min_order_size: string;
  tick_size: string;
  neg_risk: boolean;
  last_trade_price: string;
};

export function clobBaseUrl(env: Env) {
  return env.CLOB_BASE_URL;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`CLOB request failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`CLOB request failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

export async function getBooks(env: Env, tokenIds: string[]): Promise<OrderBookSummary[]> {
  if (tokenIds.length === 0) return [];
  const url = `${clobBaseUrl(env)}/books`;
  return postJson<OrderBookSummary[]>(url, tokenIds.map((token_id) => ({ token_id })));
}

export async function getMidpoint(env: Env, tokenId: string): Promise<string> {
  const url = `${clobBaseUrl(env)}/midpoint?token_id=${encodeURIComponent(tokenId)}`;
  // CLOB returns `{"mid":"0.305"}`; some deployments use `mid_price`. Handle both.
  const r = await getJson<{ mid?: string; mid_price?: string }>(url);
  return r.mid ?? r.mid_price ?? "0.5";
}

export async function getSpreadMap(env: Env, tokenIds: string[]): Promise<Record<string, string>> {
  if (tokenIds.length === 0) return {};
  const url = `${clobBaseUrl(env)}/spreads`;
  return postJson<Record<string, string>>(url, tokenIds.map((token_id) => ({ token_id })));
}

export type LimitOrderSide = "BUY" | "SELL";

export type PostOrderParams = {
  tokenId: string;
  price: string; // string decimal, SDK expects decimal values
  size: string; // size in token units
  side: LimitOrderSide;
};

export async function postLimitOrder(env: Env, params: PostOrderParams): Promise<unknown> {
  const sdk = await getClobClient(env);
  const { AssetType, OrderType, Side } = await import("@polymarket/clob-client-v2");
  const [tickSize, negRisk] = await Promise.all([
    sdk.getTickSize(params.tokenId),
    sdk.getNegRisk(params.tokenId)
  ]);

  await sdk.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });

  const result = await sdk.createAndPostOrder(
    {
      tokenID: params.tokenId,
      price: Number(params.price),
      size: Number(params.size),
      side: params.side === "BUY" ? Side.BUY : Side.SELL
    },
    { tickSize, negRisk },
    OrderType.GTC
  );

  return result;
}

export function getOrderResultStatus(result: unknown): string | undefined {
  const status = (result as any)?.status ?? (result as any)?.order?.status;
  return typeof status === "string" ? status.toLowerCase() : undefined;
}

export function isAcceptedOrderResult(result: unknown): boolean {
  if ((result as any)?.success === false) return false;
  const status = getOrderResultStatus(result);
  return status === "live" || status === "matched" || status === "delayed";
}

export function getOrderRejectMessage(result: unknown): string {
  const status = getOrderResultStatus(result) ?? "unknown";
  const errorMsg = (result as any)?.errorMsg ?? (result as any)?.error ?? (result as any)?.message;
  return errorMsg ? `CLOB rejected order (${status}): ${errorMsg}` : `CLOB rejected order (${status})`;
}

export async function getClobClient(env: Env) {
  assertPolymarketClobConfig(env);

  const { Chain, ClobClient, SignatureTypeV2 } = await import("@polymarket/clob-client-v2");
  const [signer, funderAddress] = await Promise.all([
    createPolymarketWalletClient(env),
    resolvePolymarketFunderAddress(env)
  ]);

  if (SignatureTypeV2.POLY_1271 !== POLY_1271_SIGNATURE_TYPE) {
    throw new Error("Unexpected @polymarket/clob-client-v2 POLY_1271 signature type");
  }

  return new ClobClient({
    host: clobBaseUrl(env),
    chain: Chain.POLYGON,
    signer,
    creds: {
      key: env.POLY_API_KEY!,
      passphrase: env.POLY_PASSPHRASE!,
      secret: env.POLY_SIGNATURE_SECRET!
    },
    signatureType: SignatureTypeV2.POLY_1271,
    funderAddress,
    useServerTime: true,
    throwOnError: true
  });
}

export async function getOrder(env: Env, orderId: string): Promise<any> {
  const sdk = await getClobClient(env);
  return sdk.getOrder(orderId);
}

// ─── Read-only data helpers (no auth needed) ──────────────────────────────────

/**
 * Fetch price history for a token from CLOB.
 * Returns array of { t: unix_seconds, p: price }.
 */
export async function getPricesHistory(
  env: Env,
  tokenId: string,
  interval: "1m" | "1h" | "1d" = "1d"
): Promise<Array<{ t: number; p: number }>> {
  try {
    const url = `${clobBaseUrl(env)}/prices-history?market=${encodeURIComponent(tokenId)}&interval=${interval}`;
    const raw = await getJson<{ history?: Array<{ t: number; p: number }> }>(url);
    return raw.history ?? [];
  } catch {
    return [];
  }
}

/**
 * Calculate how much USDC can be bought at ≤ slippagePct price impact.
 * Uses bids (for YES buys) or asks.
 */
export function calculateDepthAtSlippage(
  book: OrderBookSummary,
  refPrice: number,
  slippagePct = 0.02
): number {
  // Polymarket returns asks in DESCENDING price order (best/lowest ask is last),
  // so we must sort ascending before walking out from the best ask.
  const asks = (book.asks ?? [])
    .map((l) => ({ p: parseFloat(l.price), s: parseFloat(l.size) }))
    .filter((l) => Number.isFinite(l.p) && Number.isFinite(l.s))
    .sort((a, b) => a.p - b.p);
  const maxPrice = refPrice * (1 + slippagePct);
  let depth = 0;
  for (const { p, s } of asks) {
    if (p > maxPrice) break;
    depth += p * s; // approx USDC value
  }
  return depth;
}

/**
 * Estimate slippage for a target buy of `targetUsdc` at current ask prices.
 */
export function estimateSlippage(book: OrderBookSummary, targetUsdc: number): number {
  // Sort ascending: best (lowest) ask first, then walk up the book.
  const asks = (book.asks ?? [])
    .map((l) => ({ p: parseFloat(l.price), s: parseFloat(l.size) }))
    .filter((l) => Number.isFinite(l.p) && Number.isFinite(l.s))
    .sort((a, b) => a.p - b.p);
  if (!asks.length) return 0.05;
  const bestAsk = asks[0].p;
  let remaining = targetUsdc;
  let worstPrice = bestAsk;
  for (const { p, s } of asks) {
    if (remaining <= 0) break;
    worstPrice = p;
    remaining -= Math.min(p * s, remaining);
  }
  return bestAsk > 0 ? Math.abs(worstPrice - bestAsk) / bestAsk : 0.05;
}

/**
 * Get best bid and best ask from an order book summary.
 */
export function getBestBidAsk(book: OrderBookSummary): { bestBid: number; bestAsk: number } {
  const bids = (book.bids ?? [])
    .map((b) => parseFloat(b.price))
    .filter((p) => Number.isFinite(p));
  const asks = (book.asks ?? [])
    .map((a) => parseFloat(a.price))
    .filter((p) => Number.isFinite(p));
  // Best bid = highest buy price; best ask = lowest sell price.
  // CLOB book ordering is not guaranteed, so reduce instead of taking index 0.
  const bestBid = bids.length ? Math.max(...bids) : 0;
  const bestAsk = asks.length ? Math.min(...asks) : 1;
  return { bestBid, bestAsk };
}
