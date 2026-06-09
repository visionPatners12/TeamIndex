"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.listCategories = listCategories;
exports.listActiveMarkets = listActiveMarkets;
exports.listActiveSlugs = listActiveSlugs;
exports.getMarketBySlug = getMarketBySlug;
exports.searchMarkets = searchMarkets;
exports.iterateAllMarkets = iterateAllMarkets;
exports.getOrderBook = getOrderBook;
exports.getHistoricalPrices = getHistoricalPrices;
exports.extractPrices = extractPrices;
exports.detectSportHints = detectSportHints;
// ─── HTTP helpers ─────────────────────────────────────────────────────────────
function limitlessBase(env) {
    return env.LIMITLESS_BASE_URL ?? "https://api.limitless.exchange";
}
function authHeaders(env) {
    const key = env.LIMITLESS_API_KEY;
    return key ? { "X-API-Key": key } : {};
}
async function getJson(env, path, params) {
    const base = limitlessBase(env);
    const u = new URL(`${base}${path}`);
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            if (v === undefined || v === null)
                continue;
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
    return (await res.json());
}
// ─── Categories ───────────────────────────────────────────────────────────────
/**
 * GET /markets/categories
 * Returns a list of market categories.
 */
async function listCategories(env) {
    const raw = await getJson(env, "/markets/categories");
    if (Array.isArray(raw))
        return raw;
    return raw?.categories ?? raw?.data ?? [];
}
// ─── Markets ──────────────────────────────────────────────────────────────────
/**
 * GET /markets/active — paginated list of active markets.
 */
async function listActiveMarkets(env, params = {}) {
    const query = { limit: params.limit ?? 100 };
    if (params.cursor)
        query.cursor = params.cursor;
    if (params.category)
        query.category = params.category;
    const raw = await getJson(env, "/markets/active", query);
    if (Array.isArray(raw))
        return { data: raw, hasMore: false };
    const r = raw;
    return {
        data: r.data ?? r.markets ?? [],
        nextCursor: r.nextCursor ?? null,
        hasMore: r.hasMore ?? false,
    };
}
/**
 * GET /markets/active-slugs — just the slugs of all active markets.
 */
async function listActiveSlugs(env) {
    const raw = await getJson(env, "/markets/active-slugs");
    if (Array.isArray(raw))
        return raw;
    return raw.slugs ?? raw.data ?? [];
}
/**
 * GET /markets/{slug} — full market details (includes venue + tokens).
 */
async function getMarketBySlug(env, slug) {
    try {
        const raw = await getJson(env, `/markets/${encodeURIComponent(slug)}`);
        if (raw?.market)
            return raw.market;
        return raw;
    }
    catch {
        return null;
    }
}
/**
 * GET /markets/search — search markets by keyword.
 */
async function searchMarkets(env, query, limit = 50) {
    try {
        const raw = await getJson(env, "/markets/search", { q: query, limit });
        if (Array.isArray(raw))
            return raw;
        return raw.data ?? [];
    }
    catch {
        return [];
    }
}
/**
 * Async generator: iterate ALL markets across pages.
 */
async function* iterateAllMarkets(env, params = {}) {
    let cursor;
    while (true) {
        const page = await listActiveMarkets(env, { ...params, cursor });
        if (page.data.length > 0)
            yield page.data;
        const next = page.nextCursor ?? null;
        if (!next || !page.hasMore)
            break;
        cursor = next;
    }
}
// ─── Order book ───────────────────────────────────────────────────────────────
/**
 * GET /markets/{slug}/orderbook
 * Returns the CLOB order book for a market.
 */
async function getOrderBook(env, slug) {
    try {
        const raw = await getJson(env, `/markets/${encodeURIComponent(slug)}/orderbook`);
        return {
            adjustedMidpoint: raw.adjustedMidpoint,
            bids: (raw.bids ?? []).map(l => ({ price: Number(l.price), size: Number(l.size) })),
            asks: (raw.asks ?? []).map(l => ({ price: Number(l.price), size: Number(l.size) })),
            lastTradePrice: raw.lastTradePrice,
            tokenId: raw.tokenId,
            minSize: raw.minSize,
        };
    }
    catch {
        return { bids: [], asks: [] };
    }
}
// ─── Price history ────────────────────────────────────────────────────────────
/**
 * GET /markets/{slug}/historical-price
 * Returns price series for each outcome (YES at index 0, NO at index 1).
 */
async function getHistoricalPrices(env, slug) {
    try {
        const raw = await getJson(env, `/markets/${encodeURIComponent(slug)}/historical-price`);
        if (Array.isArray(raw))
            return raw;
        return raw.data ?? [];
    }
    catch {
        return [];
    }
}
// ─── Helpers used by sync service ────────────────────────────────────────────
/**
 * Extract YES/NO prices from a market's `prices` array.
 * `prices[0]` = YES, `prices[1]` = NO.
 */
function extractPrices(market) {
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
function detectSportHints(market) {
    const title = String(market.title ?? "").toLowerCase();
    const sportsKeywords = [
        "soccer", "football", "basketball", "tennis", "mma", "nba", "nfl", "epl",
        "premier league", "champions league", "la liga", "bundesliga", "serie a",
        "ligue 1", "nhl", "mlb", "cricket", "rugby", "vs", " v ",
    ];
    const isSports = sportsKeywords.some(k => title.includes(k));
    if (!isSports)
        return null;
    // League detection
    const leagueMap = [
        ["premier league", "Premier League"], ["champions league", "Champions League"],
        ["europa league", "Europa League"], ["la liga", "La Liga"],
        ["bundesliga", "Bundesliga"], ["serie a", "Serie A"],
        ["ligue 1", "Ligue 1"], [" nba ", "NBA"], [" nfl ", "NFL"],
        [" nhl ", "NHL"], [" mlb ", "MLB"], [" mls ", "MLS"],
        ["roland garros", "Roland Garros"], ["wimbledon", "Wimbledon"],
        ["us open", "US Open"], ["australian open", "Australian Open"],
    ];
    let league = null;
    for (const [pat, name] of leagueMap) {
        if (title.includes(pat)) {
            league = name;
            break;
        }
    }
    // Sport detection
    let sport = null;
    if (/soccer|football|premier|liga|bundesliga|serie a|ligue|epl|mls|euros|world cup/i.test(title))
        sport = "soccer";
    else if (/basketball|nba/i.test(title))
        sport = "basketball";
    else if (/tennis|roland|wimbledon|us open|australian/i.test(title))
        sport = "tennis";
    else if (/nfl|american football/i.test(title))
        sport = "american_football";
    else if (/nhl|hockey/i.test(title))
        sport = "hockey";
    else if (/mlb|baseball/i.test(title))
        sport = "baseball";
    else if (/mma|ufc/i.test(title))
        sport = "mma";
    else if (/cricket/i.test(title))
        sport = "cricket";
    else if (/rugby/i.test(title))
        sport = "rugby";
    // Team extraction from "Team A vs Team B"
    let homeTeam = null;
    let awayTeam = null;
    const vsMatch = (market.title ?? "").match(/^(.+?)\s+(?:vs?\.?)\s+(.+?)(?:\s*[\?\-\|]|$)/i);
    if (vsMatch) {
        homeTeam = vsMatch[1].trim();
        awayTeam = vsMatch[2].trim();
    }
    return { sport, league, homeTeam, awayTeam };
}
