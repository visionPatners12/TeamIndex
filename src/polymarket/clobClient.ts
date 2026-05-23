import type { Env } from "../config/env";

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
  const r = await getJson<{ mid_price: string }>(url);
  return r.mid_price;
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
  // Optional: address that receives settlement/conditional tokens.
  taker?: string;
};

export async function postLimitOrder(env: Env, params: PostOrderParams): Promise<unknown> {
  const sdk = await getClobClient(env);

  // Create and post in one call (SDK signs locally + submits).
  // Tick size + negRisk must be pulled from orderbook summary or config for production.
  const result = await sdk.createAndPostOrder(
    {
      tokenID: params.tokenId,
      price: Number(params.price),
      size: Number(params.size),
      side: params.side,
      taker: params.taker
    },
    { tickSize: "0.01", negRisk: false },
    "GTC"
  );

  return result;
}

async function getClobClient(env: Env) {
  // Recommended: use official clob-client SDK (handles signing + L2 auth).
  // To keep the code compile-safe without hard dependency, we dynamically import.
  let clobClientMod: any;
  try {
    clobClientMod = await import("@polymarket/clob-client");
  } catch (e) {
    throw new Error("Missing @polymarket/clob-client. Run: npm i @polymarket/clob-client");
  }

  const { ClobClient } = clobClientMod;
  const { Wallet } = await import("ethers");
  const chainId = 137; // Polygon

  if (!env.EXECUTOR_PRIVATE_KEY) throw new Error("EXECUTOR_PRIVATE_KEY missing");
  if (!env.POLY_API_KEY || !env.POLY_PASSPHRASE || !env.POLY_SIGNATURE_SECRET) {
    throw new Error("Missing POLY_API_KEY / POLY_PASSPHRASE / POLY_SIGNATURE_SECRET for CLOB L2 auth");
  }

  return new ClobClient(
    clobBaseUrl(env),
    chainId,
    new Wallet(env.EXECUTOR_PRIVATE_KEY),
    {
      apiKey: env.POLY_API_KEY,
      passphrase: env.POLY_PASSPHRASE,
      secret: env.POLY_SIGNATURE_SECRET
    },
    1 // signatureType: 1=POLY_PROXY (adjust to your proxy/funder type)
  );
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
  const asks = book.asks ?? [];
  const maxPrice = refPrice * (1 + slippagePct);
  let depth = 0;
  for (const level of asks) {
    const p = parseFloat(level.price);
    const s = parseFloat(level.size);
    if (p > maxPrice) break;
    depth += p * s; // approx USDC value
  }
  return depth;
}

/**
 * Estimate slippage for a target buy of `targetUsdc` at current ask prices.
 */
export function estimateSlippage(book: OrderBookSummary, targetUsdc: number): number {
  const asks = book.asks ?? [];
  if (!asks.length) return 0.05;
  const bestAsk = parseFloat(asks[0]?.price ?? "0.5");
  let remaining = targetUsdc;
  let worstPrice = bestAsk;
  for (const level of asks) {
    const p = parseFloat(level.price);
    const s = parseFloat(level.size);
    const levelUsdc = p * s;
    if (remaining <= 0) break;
    worstPrice = p;
    remaining -= Math.min(levelUsdc, remaining);
  }
  return Math.abs(worstPrice - bestAsk) / bestAsk;
}

/**
 * Get best bid and best ask from an order book summary.
 */
export function getBestBidAsk(book: OrderBookSummary): { bestBid: number; bestAsk: number } {
  const bids = book.bids ?? [];
  const asks = book.asks ?? [];
  const bestBid = bids.length ? parseFloat(bids[0].price) : 0;
  const bestAsk = asks.length ? parseFloat(asks[0].price) : 1;
  return { bestBid, bestAsk };
}

