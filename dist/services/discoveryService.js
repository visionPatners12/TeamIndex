"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.discoverClubCandidates = discoverClubCandidates;
const gammaClient_1 = require("../polymarket/gammaClient");
const prisma_1 = require("../db/prisma");
const clobClient_1 = require("../polymarket/clobClient");
function asString(x) {
    if (x === undefined || x === null)
        return undefined;
    if (typeof x === "string")
        return x;
    if (typeof x === "number")
        return String(x);
    if (typeof x === "bigint")
        return x.toString();
    return String(x);
}
function safeDate(x) {
    const s = asString(x);
    if (!s)
        return undefined;
    const d = new Date(s);
    if (Number.isNaN(d.getTime()))
        return undefined;
    return d;
}
function getTokenIdsFromMarket(market) {
    // Gamma shape can vary; support a few common patterns.
    const tokenIds = market.tokenIds ?? market.token_ids ?? market.tokens?.map?.((t) => t.tokenId);
    if (Array.isArray(tokenIds) && tokenIds.length >= 2) {
        return { yesTokenId: asString(tokenIds[0]), noTokenId: asString(tokenIds[1]) };
    }
    return { yesTokenId: asString(market.tokenId), noTokenId: asString(market.otherTokenId) };
}
function selectWinTokenFromMarket(market, clubName, yesTokenId, noTokenId) {
    const clubLower = clubName.toLowerCase();
    const outcomes = market?.outcomes ?? market?.outcomeTitles ?? market?.outcome_titles;
    if (Array.isArray(outcomes) && outcomes.length >= 2 && (yesTokenId || noTokenId)) {
        const o0 = String(outcomes[0] ?? "").toLowerCase();
        const o1 = String(outcomes[1] ?? "").toLowerCase();
        if (o0.includes(clubLower) && yesTokenId)
            return { tokenId: yesTokenId, side: "YES" };
        if (o1.includes(clubLower) && noTokenId)
            return { tokenId: noTokenId, side: "NO" };
    }
    // Fallback: if the market question/title suggests this is the club "win" market,
    // assume the YES token corresponds to the win side.
    const text = String(market?.question ?? market?.title ?? market?.slug ?? "").toLowerCase();
    if (text.includes(clubLower) && yesTokenId)
        return { tokenId: yesTokenId, side: "YES" };
    return { tokenId: yesTokenId, side: "YES" };
}
async function discoverClubCandidates(inputs) {
    const { poolId, clubName, env } = inputs;
    // Clear older candidates for this pool to avoid duplicates in MVP.
    await prisma_1.prisma.club_market_candidates.deleteMany({ where: { poolId } });
    let resolvedTeamPolymarketId = inputs.teamPolymarketId;
    if (!resolvedTeamPolymarketId) {
        const m = await prisma_1.prisma.club_teams_map.findFirst({ where: { internalClubName: clubName } });
        resolvedTeamPolymarketId = m?.polymarketTeamId;
    }
    const q = resolvedTeamPolymarketId ? `${resolvedTeamPolymarketId} win` : `${clubName} win`;
    const result = await (0, gammaClient_1.searchPublic)(env, q, 20);
    const markets = Array.isArray(result?.markets) ? result.markets : Array.isArray(result?.results?.markets) ? result.results.markets : [];
    for (const m of markets) {
        const marketId = asString(m.id ?? m.marketId ?? m.slugKey);
        if (!marketId)
            continue;
        // Only tradable markets.
        if (m.enableOrderBook === false)
            continue;
        if (m.tradingActive === false)
            continue;
        // Fetch full market to improve "win side" mapping.
        const fullMarket = await (0, gammaClient_1.getMarketById)(env, marketId).catch(() => m);
        const { yesTokenId, noTokenId } = getTokenIdsFromMarket(fullMarket);
        const selected = selectWinTokenFromMarket(fullMarket, clubName, yesTokenId, noTokenId);
        if (!selected.tokenId)
            continue;
        // Determine kickoffTime via event if possible.
        const kickoffTime = safeDate(m.startDate) ??
            (await (async () => {
                const eventId = asString(m.eventId ?? m.event_id ?? m.event?.id);
                if (!eventId)
                    return undefined;
                const e = await (0, gammaClient_1.getEventById)(env, eventId).catch(() => undefined);
                return e ? safeDate(e.startDate ?? e.start_date) : undefined;
            })());
        // Liquidity: best-effort check with first tokenId (YES).
        let liquidityUsd = 0;
        try {
            const books = await (0, clobClient_1.getBooks)(env, [selected.tokenId]);
            const book = books[0];
            const bestBid = book?.bids?.[0]?.price;
            const bestBidSize = book?.bids?.[0]?.size;
            // MVP heuristic: size * price.
            liquidityUsd = (Number(bestBid) || 0) * (Number(bestBidSize) || 0);
        }
        catch {
            // If liquidity fetch fails, we still keep candidate with 0 liquidity; risk engine can skip later.
            liquidityUsd = 0;
        }
        // Planned rule: skip if liquidity too low (basic on discovery).
        if (liquidityUsd < inputs.liquidityMinUsd)
            continue;
        await prisma_1.prisma.club_market_candidates.create({
            data: {
                poolId,
                clubName,
                eventId: asString(m.eventId ?? m.event_id ?? m.event?.id) ?? "",
                marketId,
                tokenId: selected.tokenId,
                side: selected.side,
                kickoffTime: kickoffTime ?? undefined,
                entryWindow: kickoffTime ? new Date(kickoffTime.getTime() - 48 * 3600 * 1000) : undefined,
                liquidityUsd: liquidityUsd.toString(),
                status: "CANDIDATE"
            }
        });
    }
}
