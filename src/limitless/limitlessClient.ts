/**
 * limitlessClient.ts
 *
 * HTTP client for the Limitless Exchange REST API (Base chain).
 * Mirrors the role of gammaClient.ts for Polymarket.
 *
 * Base URL  : https://api.limitless.exchange
 * Chain     : Base (chainId 8453)
 * Auth      : X-API-Key header for authenticated endpoints
 * Docs      : https://docs.limitless.exchange
 */

import type { Env } from "../config/env";

// ─── Raw API types ────────────────────────────────────────────────────────────

export interface LimitlessCategory {
  id?: string | number;
  name?: string;
  slug?: string;
  label?: string;
  count?: number;
  [k: string]: unknown;
}

/** Venue (on-chain contract addresses) attached to each CLOB market. */
export interface LimitlessVenue {
  exchange: string;   // verifyingContract for EIP-712 signing
  adapter?: string;
  [k: string]: unknown;
}

/** Token IDs for YES/NO outcome tokens (uint256 as string). */
export interface LimitlessTokens {
  yes: string;
  no: string;
}

/**
 * Market as returned by GET /markets/active.
 * `slug` is the canonical identifier used for ALL subsequent API calls.
 * `prices` = [yesPrice, noPrice], values in (0, 1).
 */
export interface LimitlessMarket {
  id?: number;
  slug: string;
  title?: string;
  description?: string;
  status?: string;                  // "ACTIVE" | "CLOSED" | "RESOLVED"
  resolution?: string;
  /** [yesPrice, noPrice] — implied probabilities, each in (0, 1). */
  prices?: [number, number];
  liquidity?: string | number;
  volume?: string | number;
  /** Unix timestamp (seconds) when the market expires. */
  expirationTimestamp?: number;
  /** tradeType: "amm" | "clob" | "group" */
  tradeType?: string;
  /** Outcome token IDs (only present in full market detail response). */
  tokens?: LimitlessTokens;
  /** Venue contract addresses (only in full market detail). */
  venue?: LimitlessVenue;
  /** winningOutcomeIndex: 0=YES won, 1=NO won, null=unresolved */
  winningOutcomeIndex?: number | null;
  [k: string]: unknown;
}

/** One historical price entry from GET /markets/{slug}/historical-price. */
export interface LimitlessPriceTick {
  price: number;
  timestamp: string; // ISO-8601
}

/** One outcome series from the historical-price endpoint. */
export interface LimitlessPriceSeries {
  title: string;          // e.g. "Yes" | "No"
  prices: LimitlessPriceTick[];
}

/** GET /markets/{slug}/orderbook response. */
export interface LimitlessOrderBook {
  adjustedMidpoint?: number;
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  lastTradePrice?: number;
  tokenId?: string;
  minSize?: number;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function limitlessBase(env: Env): string {
  return (env as any).LIMITLESS_BASE_URL ?? "https://api.limitless.exchange";
}

function authHeaders(env: Env): Record<string, string> {
  const key = (env as any).LIMITLESS_API_KEY as string | undefined;
  return key ? { "X-API-Key": key } : {};
}

async function getJson<T>(
  env: Env,
  path: string,
  params?: Record<string, unknown>
): Promise<T> {
  const base = limitlessBase(env);
  const u = new URL(`${base}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      u.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(u.toString(), {
    headers: { Accept: "application/json", ...authHeaders(env) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Limitless API ${res.status} ${path}: ${text}`);
  }
  return (await res.json()) as T;
}

// ─── Categories ───────────────────────────────────────────────────────────────

/**
 * GET /markets/categories
 * Returns a list of market categories.
 */
export async function listCategories(env: Env): Promise<LimitlessCategory[]> {
  const raw = await getJson<
    LimitlessCategory[] | { categories?: LimitlessCategory[]; data?: LimitlessCategory[] }
  >(env, "/markets/categories");

  if (Array.isArray(raw)) return raw;
  return raw?.categories ?? raw?.data ?? [];
}

// ─── Markets ──────────────────────────────────────────────────────────────────

/**
 * GET /markets/active — paginated list of active markets.
 */
export async function listActiveMarkets(
  env: Env,
  params: { limit?: number; cursor?: string; category?: string } = {}
): Promise<{ data: LimitlessMarket[]; nextCursor?: string | null; hasMore?: boolean }> {
  const query: Record<string, unknown> = { limit: params.limit ?? 100 };
  if (params.cursor) query.cursor = params.cursor;
  if (params.category) query.category = params.category;

  const raw = await getJson<
    | { data?: LimitlessMarket[]; markets?: LimitlessMarket[]; nextCursor?: string; hasMore?: boolean }
    | LimitlessMarket[]
  >(env, "/markets/active", query);

  if (Array.isArray(raw)) return { data: raw, hasMore: false };
  const r = raw as { data?: LimitlessMarket[]; markets?: LimitlessMarket[]; nextCursor?: string; hasMore?: boolean };
  return {
    data: r.data ?? r.markets ?? [],
    nextCursor: r.nextCursor ?? null,
    hasMore: r.hasMore ?? false,
  };
}

/**
 * GET /markets/active-slugs — just the slugs of all active markets.
 */
export async function listActiveSlugs(env: Env): Promise<string[]> {
  const raw = await getJson<string[] | { slugs?: string[]; data?: string[] }>(env, "/markets/active-slugs");
  if (Array.isArray(raw)) return raw;
  return (raw as any).slugs ?? (raw as any).data ?? [];
}

/**
 * GET /markets/{slug} — full market details (includes venue + tokens).
 */
export async function getMarketBySlug(env: Env, slug: string): Promise<LimitlessMarket | null> {
  try {
    const raw = await getJson<LimitlessMarket | { market?: LimitlessMarket }>(
      env,
      `/markets/${encodeURIComponent(slug)}`
    );
    if ((raw as any)?.market) return (raw as any).market as LimitlessMarket;
    return raw as LimitlessMarket;
  } catch {
    return null;
  }
}

/**
 * GET /markets/search — search markets by keyword.
 */
export async function searchMarkets(
  env: Env,
  query: string,
  limit = 50
): Promise<LimitlessMarket[]> {
  try {
    const raw = await getJson<{ data?: LimitlessMarket[] } | LimitlessMarket[]>(
      env,
      "/markets/search",
      { q: query, limit }
    );
    if (Array.isArray(raw)) return raw;
    return (raw as any).data ?? [];
  } catch {
    return [];
  }
}

/**
 * Async generator: iterate ALL markets across pages.
 */
export async function* iterateAllMarkets(
  env: Env,
  params: { limit?: number; category?: string } = {}
): AsyncGenerator<LimitlessMarket[]> {
  let cursor: string | undefined;

  while (true) {
    const page = await listActiveMarkets(env, { ...params, cursor });
    if (page.data.length > 0) yield page.data;
    const next = page.nextCursor ?? null;
    if (!next || !page.hasMore) break;
    cursor = next;
  }
}

// ─── Order book ───────────────────────────────────────────────────────────────

/**
 * GET /markets/{slug}/orderbook
 * Returns the CLOB order book for a market.
 */
export async function getOrderBook(env: Env, slug: string): Promise<LimitlessOrderBook> {
  try {
    const raw = await getJson<LimitlessOrderBook>(env, `/markets/${encodeURIComponent(slug)}/orderbook`);
    return {
      adjustedMidpoint: raw.adjustedMidpoint,
      bids: (raw.bids ?? []).map(l => ({ price: Number(l.price), size: Number(l.size) })),
      asks: (raw.asks ?? []).map(l => ({ price: Number(l.price), size: Number(l.size) })),
      lastTradePrice: raw.lastTradePrice,
      tokenId: raw.tokenId,
      minSize: raw.minSize,
    };
  } catch {
    return { bids: [], asks: [] };
  }
}

// ─── Price history ────────────────────────────────────────────────────────────

/**
 * GET /markets/{slug}/historical-price
 * Returns price series for each outcome (YES at index 0, NO at index 1).
 */
export async function getHistoricalPrices(
  env: Env,
  slug: string
): Promise<LimitlessPriceSeries[]> {
  try {
    const raw = await getJson<LimitlessPriceSeries[] | { data?: LimitlessPriceSeries[] }>(
      env,
      `/markets/${encodeURIComponent(slug)}/historical-price`
    );
    if (Array.isArray(raw)) return raw;
    return (raw as any).data ?? [];
  } catch {
    return [];
  }
}

// ─── Helpers used by sync service ────────────────────────────────────────────

/**
 * Extract YES/NO prices from a market's `prices` array.
 * `prices[0]` = YES, `prices[1]` = NO.
 */
export function extractPrices(market: LimitlessMarket): { yesPrice: number; noPrice: number } {
  const prices = market.prices;
  if (Array.isArray(prices) && prices.length >= 2) {
    return { yesPrice: Number(prices[0]), noPrice: Number(prices[1]) };
  }
  // Fallback: infer from the other
  const yes = Array.isArray(prices) && prices.length >= 1 ? Number(prices[0]) : 0.5;
  return { yesPrice: yes, noPrice: 1 - yes };
}

/**
 * Detect sport/league/team from market title.
 * Returns null if the market is not identifiable as a sports fixture.
 */
export function detectSportHints(market: LimitlessMarket): {
  sport: string | null;
  league: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
} | null {
  const title = String(market.title ?? "").toLowerCase();

  const sportsKeywords = [
    "soccer", "football", "basketball", "tennis", "mma", "nba", "nfl", "epl",
    "premier league", "champions league", "la liga", "bundesliga", "serie a",
    "ligue 1", "nhl", "mlb", "cricket", "rugby", "vs", " v ",
  ];

  const isSports = sportsKeywords.some(k => title.includes(k));
  if (!isSports) return null;

  // League detection
  const leagueMap: [string, string][] = [
    ["premier league", "Premier League"], ["champions league", "Champions League"],
    ["europa league", "Europa League"], ["la liga", "La Liga"],
    ["bundesliga", "Bundesliga"], ["serie a", "Serie A"],
    ["ligue 1", "Ligue 1"], [" nba ", "NBA"], [" nfl ", "NFL"],
    [" nhl ", "NHL"], [" mlb ", "MLB"], [" mls ", "MLS"],
    ["roland garros", "Roland Garros"], ["wimbledon", "Wimbledon"],
    ["us open", "US Open"], ["australian open", "Australian Open"],
  ];
  let league: string | null = null;
  for (const [pat, name] of leagueMap) {
    if (title.includes(pat)) { league = name; break; }
  }

  // Sport detection
  let sport: string | null = null;
  if (/soccer|football|premier|liga|bundesliga|serie a|ligue|epl|mls|euros|world cup/i.test(title)) sport = "soccer";
  else if (/basketball|nba/i.test(title)) sport = "basketball";
  else if (/tennis|roland|wimbledon|us open|australian/i.test(title)) sport = "tennis";
  else if (/nfl|american football/i.test(title)) sport = "american_football";
  else if (/nhl|hockey/i.test(title)) sport = "hockey";
  else if (/mlb|baseball/i.test(title)) sport = "baseball";
  else if (/mma|ufc/i.test(title)) sport = "mma";
  else if (/cricket/i.test(title)) sport = "cricket";
  else if (/rugby/i.test(title)) sport = "rugby";

  // Team extraction from "Team A vs Team B"
  let homeTeam: string | null = null;
  let awayTeam: string | null = null;
  const vsMatch = (market.title ?? "").match(/^(.+?)\s+(?:vs?\.?)\s+(.+?)(?:\s*[\?\-\|]|$)/i);
  if (vsMatch) {
    homeTeam = vsMatch[1].trim();
    awayTeam = vsMatch[2].trim();
  }

  return { sport, league, homeTeam, awayTeam };
}
