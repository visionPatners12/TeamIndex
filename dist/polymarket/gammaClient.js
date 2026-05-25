"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.gammaBaseUrl = gammaBaseUrl;
exports.listTeams = listTeams;
exports.searchPublic = searchPublic;
exports.listEvents = listEvents;
exports.listMarkets = listMarkets;
exports.getEventById = getEventById;
exports.getMarketById = getMarketById;
exports.detectMarketType = detectMarketType;
exports.searchMarketsByKeyword = searchMarketsByKeyword;
async function getJson(url, params) {
    const u = new URL(url);
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            if (v === undefined || v === null)
                continue;
            u.searchParams.set(k, String(v));
        }
    }
    const res = await fetch(u.toString(), { headers: { Accept: "application/json" } });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Gamma request failed: ${res.status} ${text}`);
    }
    return (await res.json());
}
function gammaBaseUrl(env) {
    return env.GAMMA_BASE_URL;
}
async function listTeams(env, limit = 100, offset = 0) {
    const raw = await getJson(`${env.GAMMA_BASE_URL}/teams`, { limit, offset });
    const teams = Array.isArray(raw) ? raw : raw?.teams ?? [];
    return { teams };
}
async function searchPublic(env, q, limitPerType = 10) {
    return getJson(`${env.GAMMA_BASE_URL}/public-search`, {
        q,
        limit_per_type: limitPerType
    });
}
async function listEvents(env, params) {
    return getJson(`${env.GAMMA_BASE_URL}/events`, params);
}
async function listMarkets(env, params) {
    return getJson(`${env.GAMMA_BASE_URL}/markets`, params);
}
async function getEventById(env, eventId) {
    return getJson(`${env.GAMMA_BASE_URL}/events/${eventId}`);
}
async function getMarketById(env, marketId) {
    return getJson(`${env.GAMMA_BASE_URL}/markets/${marketId}`);
}
/**
 * Detect market type using Polymarket's own fields first.
 *
 * "Game"   = a specific match. Polymarket populates `gameStartTime` or `gameId`
 *            for these (e.g. "Manchester City vs Arsenal FC").
 * "Future" = season-long / aggregate outcome. No gameId.
 *            (e.g. "Will Arsenal win the Premier League?")
 *
 * We ONLY fall back to text heuristics when Polymarket gives us no structured
 * signal at all.
 */
function detectMarketType(raw) {
    // Polymarket structured fields (most reliable)
    if (raw.gameId || raw.gameStartTime)
        return "game";
    if (raw.sportsMarketType === "match" || raw.sportsMarketType === "game")
        return "game";
    if (raw.sportsMarketType === "future" || raw.sportsMarketType === "outright")
        return "future";
    // Event-level hints (event has a startDate + endDate close together → match)
    const evStart = raw.event?.startDate ?? raw.event?.gameStartTime;
    const evEnd = raw.event?.endDate;
    if (evStart && evEnd) {
        const durationMs = new Date(evEnd).getTime() - new Date(evStart).getTime();
        // Matches typically resolve within 1–2 days of kickoff
        if (durationMs > 0 && durationMs < 3 * 86_400_000)
            return "game";
    }
    // Final fallback: text heuristics
    const q = String(raw.question ?? raw.title ?? "").toLowerCase();
    const futureKeywords = [
        "win the", "premier league", "champions league", "la liga", "bundesliga",
        "ligue 1", "serie a", "top 4", "top four", "qualify", "title", "champion",
        "relegat", "golden boot", "ballon", "treble"
    ];
    for (const kw of futureKeywords) {
        if (q.includes(kw))
            return "future";
    }
    if (/\bvs\b|\bv\.?\b|beat|halftime/i.test(q))
        return "game";
    // Default: future (safer — won't mislabel video-game category markets as matches)
    return "future";
}
function formatMarket(raw) {
    let prices = [0.5, 0.5];
    try {
        const parsed = typeof raw.outcomePrices === "string"
            ? JSON.parse(raw.outcomePrices)
            : raw.outcomePrices;
        if (Array.isArray(parsed))
            prices = parsed.map(Number);
    }
    catch { }
    const tokens = Array.isArray(raw.tokens)
        ? raw.tokens.map((t) => ({ token_id: String(t.token_id ?? ""), outcome: String(t.outcome ?? "") }))
        : [];
    const eventId = String(raw.eventId ?? raw.event?.id ?? "");
    const eventSlug = String(raw.event?.slug ?? raw.eventSlug ?? "");
    const eventTitle = String(raw.event?.title ?? raw.eventTitle ?? "");
    const question = String(raw.question ?? raw.title ?? "");
    return {
        id: String(raw.id ?? ""),
        conditionId: String(raw.conditionId ?? raw.questionId ?? raw.id ?? ""),
        question,
        endDateIso: raw.endDate ?? raw.resolutionTime ?? null,
        liquidity: Number(raw.liquidityAmountUSD ?? raw.liquidityNum ?? raw.liquidity ?? 0),
        volume24h: Number(raw.volume24hr ?? raw.volume24h ?? raw.oneDayVolume ?? 0),
        yesPrice: prices[0] ?? 0.5,
        noPrice: prices[1] ?? 0.5,
        active: Boolean(raw.active ?? raw.tradingActive ?? true),
        closed: Boolean(raw.closed ?? false),
        tokens,
        eventId,
        eventSlug,
        eventTitle,
        marketType: detectMarketType(raw),
        gameId: raw.gameId ? String(raw.gameId) : null,
        gameStartTime: raw.gameStartTime ?? raw.event?.startDate ?? null,
        sportsMarketType: raw.sportsMarketType ?? null,
    };
}
/**
 * Check whether a market genuinely relates to the searched team.
 * A market qualifies if the team name appears in: question text, event title,
 * event slug, or any outcome token name (e.g. outcome = "Arsenal FC").
 */
function matchesTeam(m, query) {
    const q = query.toLowerCase();
    const haystacks = [
        m.question,
        m.eventTitle,
        m.eventSlug,
        ...m.tokens.map(t => t.outcome),
    ];
    return haystacks.some(h => (h ?? "").toLowerCase().includes(q));
}
/**
 * Check whether a market is sports-related (to exclude video-game / crypto / politics).
 * Polymarket tags events; we look at event.series, event.category, or event tags.
 */
function isSportsMarket(raw) {
    // Direct sports signals
    if (raw.gameId || raw.gameStartTime || raw.sportsMarketType)
        return true;
    // Event category / tags
    const ev = raw.event ?? {};
    const category = String(ev.category ?? ev.series ?? "").toLowerCase();
    if (["sports", "soccer", "football", "basketball", "baseball", "hockey", "tennis", "mma", "cricket"].some(s => category.includes(s))) {
        return true;
    }
    const tags = Array.isArray(ev.tags) ? ev.tags : [];
    for (const t of tags) {
        const label = String(t?.label ?? t?.slug ?? t ?? "").toLowerCase();
        if (["sports", "soccer", "epl", "premier", "la-liga", "bundesliga", "champions", "ligue-1", "serie-a"].some(s => label.includes(s))) {
            return true;
        }
    }
    return false;
}
/**
 * Search Polymarket markets by sport team name.
 *
 * Strategy:
 *   1. Use Gamma `/public-search` — Polymarket's own unified search that
 *      understands team names + returns ranked results.
 *   2. Also call `/markets?q=...&closed=false` as a secondary source.
 *   3. Strictly filter to markets whose question / event title / outcome
 *      actually contains the query (prevents "GTA VI" junk from appearing
 *      when someone searches for "Arsenal").
 *   4. Prefer sports-category markets; non-sports are excluded unless the
 *      query clearly matches them.
 */
async function searchMarketsByKeyword(env, query, limit = 50) {
    const q = query.trim();
    if (!q)
        return [];
    const results = [];
    const seen = new Set();
    const addFiltered = (rawList) => {
        for (const raw of rawList) {
            if (!raw || typeof raw !== "object")
                continue;
            // Skip closed markets
            if (raw.closed)
                continue;
            if (!isSportsMarket(raw))
                continue;
            const m = formatMarket(raw);
            if (!m.id || seen.has(m.id))
                continue;
            if (!matchesTeam(m, q))
                continue;
            seen.add(m.id);
            results.push(m);
        }
    };
    // Strategy 1: Gamma public-search — best relevance for team names
    try {
        const searchRes = await searchPublic(env, q, 50);
        const events = searchRes?.events ?? [];
        for (const ev of events) {
            const markets = ev.markets ?? [];
            for (const m of markets) {
                addFiltered([{ ...m, event: ev, eventId: ev.id ?? m.eventId }]);
            }
        }
        const directMarkets = searchRes?.markets ?? [];
        addFiltered(directMarkets);
    }
    catch { }
    // Strategy 2: /markets?q=... as secondary source
    if (results.length < 10) {
        try {
            const raw = await listMarkets(env, { q, closed: false, active: true, limit: 100 });
            const list = Array.isArray(raw) ? raw : raw?.markets ?? [];
            addFiltered(list);
        }
        catch { }
    }
    // Strategy 3: /events?search=... (some team events aren't surfaced by /markets)
    if (results.length < 5) {
        try {
            const evRes = await listEvents(env, { search: q, closed: false, active: true, limit: 50 });
            const events = Array.isArray(evRes) ? evRes : evRes?.events ?? [];
            for (const ev of events) {
                const markets = ev.markets ?? [];
                for (const m of markets) {
                    addFiltered([{ ...m, event: ev, eventId: ev.id ?? m.eventId }]);
                }
            }
        }
        catch { }
    }
    // Sort: sports "game" markets first (upcoming matches), then "future" by liquidity
    results.sort((a, b) => {
        if (a.marketType !== b.marketType)
            return a.marketType === "game" ? -1 : 1;
        return b.liquidity - a.liquidity;
    });
    return results.slice(0, limit);
}
