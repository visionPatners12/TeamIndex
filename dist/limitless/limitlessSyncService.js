"use strict";
/**
 * limitlessSyncService.ts
 *
 * Pipeline service: syncs Limitless Exchange data into the four pipeline tables.
 *
 *   1. syncCategories()   → upserts limitless_categories
 *   2. syncMarkets()      → upserts limitless_markets (full page-by-page crawl)
 *   3. syncPrices()       → inserts limitless_prices ticks for active markets
 *   4. enrichSportsGames() → upserts lim_games for markets that look like sports fixtures
 *
 * The limitless_sync_state singleton row is updated throughout so the admin
 * endpoint / dashboard can show live progress.
 *
 * None of this data is queried directly by the client — it feeds the internal
 * allocation engine and the /sports admin route.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncCategories = syncCategories;
exports.syncMarkets = syncMarkets;
exports.syncPrices = syncPrices;
exports.enrichSportsGames = enrichSportsGames;
exports.runFullLimitlessSync = runFullLimitlessSync;
const prisma_1 = require("../db/prisma");
const limitlessClient_1 = require("./limitlessClient");
function stringValuesDeep(value, maxDepth = 4) {
    if (value == null || maxDepth < 0)
        return [];
    if (typeof value === "string" || typeof value === "number" || typeof value === "bigint")
        return [String(value)];
    if (typeof value === "boolean")
        return [];
    if (Array.isArray(value))
        return value.flatMap((item) => stringValuesDeep(item, maxDepth - 1));
    if (typeof value === "object") {
        return Object.values(value).flatMap((item) => stringValuesDeep(item, maxDepth - 1));
    }
    return [];
}
function extractSportsDataGameId(market) {
    const candidates = [market.id, market.title, ...stringValuesDeep(market.rawJson)];
    for (const value of candidates) {
        const direct = String(value).match(/(?:game[_-]?id|gameId|match[_-]?id|matchId)["':=\s]+(\d{5,})/i);
        if (direct)
            return direct[1];
        const pathId = String(value).match(/(?:^|[/?#\s-])(\d{5,})(?:$|[/?#\s-])/);
        if (pathId)
            return pathId[1];
    }
    return null;
}
async function getSportsDataGameLink(gameId) {
    try {
        const rows = await prisma_1.prisma.$queryRaw `
      select id::text as id, home_id::text as home_id, away_id::text as away_id
      from sports_data.games
      where id::text = ${gameId}
      limit 1
    `;
        const row = rows[0];
        if (!row)
            return { sportsDataGameId: gameId, homeSportsDataTeamId: null, awaySportsDataTeamId: null };
        return {
            sportsDataGameId: row.id,
            homeSportsDataTeamId: row.home_id,
            awaySportsDataTeamId: row.away_id,
        };
    }
    catch {
        return { sportsDataGameId: gameId, homeSportsDataTeamId: null, awaySportsDataTeamId: null };
    }
}
// ─── Sync state helpers ───────────────────────────────────────────────────────
async function setSyncStatus(status, patch = {}) {
    await prisma_1.prisma.limitless_sync_state.upsert({
        where: { id: "default" },
        update: { status, updatedAt: new Date(), ...patch },
        create: { id: "default", provider: "limitless", status, ...patch },
    });
}
// ─── 1. Categories ────────────────────────────────────────────────────────────
async function syncCategories(env) {
    const raw = await (0, limitlessClient_1.listCategories)(env);
    let upserted = 0;
    for (const cat of raw) {
        if (!cat.id)
            continue;
        const slug = String(cat.slug ?? cat.id);
        const label = String(cat.name ?? cat.label ?? cat.slug ?? cat.id);
        await prisma_1.prisma.limitless_categories.upsert({
            where: { id: cat.id },
            update: { slug, label, rawJson: cat, updatedAt: new Date() },
            create: { id: cat.id, slug, label, rawJson: cat },
        });
        upserted++;
    }
    return upserted;
}
// ─── 2. Markets ───────────────────────────────────────────────────────────────
/**
 * Full crawl of Limitless markets (all statuses).
 * Upserts each market into limitless_markets.
 * Updates limitless_sync_state.cursor so a restart can resume from the last page.
 */
async function syncMarkets(env) {
    await setSyncStatus("SYNCING", { lastError: null });
    let totalSynced = 0;
    let cursor;
    try {
        // Limitless active markets only — CLOSED/RESOLVED come from the same endpoint
        // filtered by status internally; we fetch active first then rely on sync state.
        cursor = undefined;
        while (true) {
            const page = await (0, limitlessClient_1.listActiveMarkets)(env, { limit: 100, cursor });
            const markets = page.data ?? [];
            if (markets.length === 0)
                break;
            await upsertMarketBatch(markets);
            totalSynced += markets.length;
            await setSyncStatus("SYNCING", {
                cursor: page.nextCursor ?? null,
                marketsSynced: totalSynced,
            });
            const next = page.nextCursor ?? null;
            if (!next || !page.hasMore)
                break;
            cursor = next;
        }
        await setSyncStatus("IDLE", {
            lastSyncedAt: new Date(),
            cursor: null,
            marketsSynced: totalSynced,
            lastError: null,
        });
    }
    catch (err) {
        await setSyncStatus("ERROR", {
            lastError: String(err?.message ?? err),
            cursor: cursor ?? null,
            marketsSynced: totalSynced,
        });
        throw err;
    }
    return totalSynced;
}
async function upsertMarketBatch(markets) {
    const now = new Date();
    for (const m of markets) {
        // Limitless uses `slug` as the stable identifier for API calls
        if (!m.slug)
            continue;
        const { yesPrice, noPrice } = (0, limitlessClient_1.extractPrices)(m);
        // categoryId: Limitless doesn't embed a category object in list responses,
        // but may include it in the market detail. We store null and enrich later.
        const categoryId = null;
        const endDate = m.expirationTimestamp ? new Date(m.expirationTimestamp * 1000) : null;
        const status = m.status ?? (m.winningOutcomeIndex !== undefined && m.winningOutcomeIndex !== null ? "RESOLVED" : "ACTIVE");
        await prisma_1.prisma.limitless_markets.upsert({
            where: { id: m.slug },
            update: {
                title: String(m.title ?? ""),
                description: m.description ? String(m.description) : null,
                status: String(status),
                resolution: m.winningOutcomeIndex === 0 ? "yes" : m.winningOutcomeIndex === 1 ? "no" : null,
                yesPrice: yesPrice.toString(),
                noPrice: noPrice.toString(),
                liquidity: String(m.liquidity ?? 0),
                volume: String(m.volume ?? 0),
                endDate,
                categoryId,
                rawJson: m,
                syncedAt: now,
                updatedAt: now,
            },
            create: {
                id: m.slug, // slug is the stable identifier
                title: String(m.title ?? ""),
                description: m.description ? String(m.description) : null,
                status: String(status),
                resolution: m.winningOutcomeIndex === 0 ? "yes" : m.winningOutcomeIndex === 1 ? "no" : null,
                yesPrice: yesPrice.toString(),
                noPrice: noPrice.toString(),
                liquidity: String(m.liquidity ?? 0),
                volume: String(m.volume ?? 0),
                endDate,
                categoryId,
                rawJson: m,
                syncedAt: now,
            },
        });
    }
}
// ─── 3. Prices ────────────────────────────────────────────────────────────────
/**
 * Fetch and store the latest price tick for each active market.
 * Uses the last 1h of price data (resolution=1h) so we get a recent snapshot.
 *
 * @param limit - max number of active markets to process per call (default 200)
 */
async function syncPrices(env, limit = 200) {
    const activeMarkets = await prisma_1.prisma.limitless_markets.findMany({
        where: { status: "ACTIVE" },
        select: { id: true },
        orderBy: { syncedAt: "asc" },
        take: limit,
    });
    let stored = 0;
    for (const { id: marketSlug } of activeMarkets) {
        // GET /markets/{slug}/historical-price → [{ title: "Yes"|"No", prices: [{ price, timestamp }] }]
        const series = await (0, limitlessClient_1.getHistoricalPrices)(env, marketSlug);
        for (const outcome of series) {
            // outcomeIndex: "Yes" → 0, "No" → 1 (or any other outcome → index by position)
            const outcomeIndex = outcome.title?.toLowerCase() === "no" ? 1 : 0;
            for (const tick of outcome.prices ?? []) {
                const ts = new Date(tick.timestamp);
                if (isNaN(ts.getTime()))
                    continue;
                try {
                    await prisma_1.prisma.limitless_prices.upsert({
                        where: {
                            limitless_prices_market_outcome_ts_key: {
                                marketId: marketSlug,
                                outcomeIndex,
                                timestamp: ts,
                            },
                        },
                        update: {},
                        create: {
                            marketId: marketSlug,
                            outcomeIndex,
                            price: String(tick.price),
                            timestamp: ts,
                        },
                    });
                    stored++;
                }
                catch {
                    // skip duplicates
                }
            }
        }
    }
    return stored;
}
// ─── 4. Sport enrichment (lim_games) ─────────────────────────────────────────
/**
 * Scan limitless_markets and upsert lim_games rows for any market that
 * can be recognised as a sports fixture (via detectSportHints heuristics).
 *
 * This is intentionally lightweight: it only runs text heuristics on the
 * market title. A richer enrichment (e.g. calling a sports data API) can
 * be added later by replacing / augmenting detectSportHints.
 *
 * @param limit - number of markets to scan per call (default 500)
 */
async function enrichSportsGames(env, limit = 500) {
    // Process markets that don't have a lim_games row yet
    const markets = await prisma_1.prisma.limitless_markets.findMany({
        where: {
            status: { in: ["ACTIVE", "CLOSED"] },
            game: null, // no lim_games row yet
        },
        select: { id: true, title: true, rawJson: true },
        take: limit,
    });
    let enriched = 0;
    const now = new Date();
    for (const m of markets) {
        const raw = (m.rawJson ?? {});
        const hints = (0, limitlessClient_1.detectSportHints)({ ...raw, slug: m.id, title: m.title });
        if (!hints)
            continue;
        const gameTime = (() => {
            const t = raw.expirationDate ?? raw.gameStartTime ?? null;
            if (!t)
                return null;
            const d = new Date(t);
            return isNaN(d.getTime()) ? null : d;
        })();
        const sportsDataGameId = extractSportsDataGameId(m);
        const sportsDataLink = sportsDataGameId ? await getSportsDataGameLink(sportsDataGameId) : null;
        await prisma_1.prisma.lim_games.upsert({
            where: { marketId: m.id },
            update: {
                sport: hints.sport,
                league: hints.league,
                homeTeam: hints.homeTeam,
                awayTeam: hints.awayTeam,
                gameTime,
                sportsDataGameId: sportsDataLink?.sportsDataGameId ?? null,
                homeSportsDataTeamId: sportsDataLink?.homeSportsDataTeamId ?? null,
                awaySportsDataTeamId: sportsDataLink?.awaySportsDataTeamId ?? null,
                rawJson: raw,
                updatedAt: now,
            },
            create: {
                marketId: m.id,
                sport: hints.sport,
                league: hints.league,
                homeTeam: hints.homeTeam,
                awayTeam: hints.awayTeam,
                gameTime,
                sportsDataGameId: sportsDataLink?.sportsDataGameId ?? null,
                homeSportsDataTeamId: sportsDataLink?.homeSportsDataTeamId ?? null,
                awaySportsDataTeamId: sportsDataLink?.awaySportsDataTeamId ?? null,
                rawJson: raw,
            },
        });
        enriched++;
    }
    return enriched;
}
// ─── Full pipeline run ────────────────────────────────────────────────────────
/**
 * Run the complete Limitless sync pipeline in order:
 *   categories → markets → prices → sport enrichment
 *
 * Called by the scheduler ticker (e.g. every 5 minutes for prices,
 * every hour for a full market crawl).
 */
async function runFullLimitlessSync(env) {
    const categories = await syncCategories(env);
    const markets = await syncMarkets(env);
    const prices = await syncPrices(env);
    const games = await enrichSportsGames(env);
    return { categories, markets, prices, games };
}
