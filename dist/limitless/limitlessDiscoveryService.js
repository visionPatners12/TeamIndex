"use strict";
/**
 * limitlessDiscoveryService.ts
 *
 * Market discovery for the allocation pipeline using canonical sports_data ids.
 *
 * The selected pool stores sportsDataTeamId (sports_data.teams.id). Discovery
 * finds Limitless markets by sports_data.limitless_markets.home_id/away_id,
 * avoiding text searches over names or titles.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.discoverLimitlessClubCandidates = discoverLimitlessClubCandidates;
exports.decodeLimitlessTokenId = decodeLimitlessTokenId;
const prisma_1 = require("../db/prisma");
const limitlessTeams_1 = require("../sportsData/limitlessTeams");
// ─── Main discovery function ──────────────────────────────────────────────────
/**
 * Discover active Limitless markets for a club and write them to candidates.
 */
async function discoverLimitlessClubCandidates(inputs) {
    const { poolId, clubName, sportsDataTeamId } = inputs;
    // ── Clear older candidates for this pool ─────────────────────────────────
    await prisma_1.prisma.club_market_candidates.deleteMany({ where: { poolId } });
    const markets = await (0, limitlessTeams_1.getLimitlessMarketsForTeam)(prisma_1.prisma, sportsDataTeamId);
    let created = 0;
    for (const mkt of markets) {
        if (mkt.status && mkt.status.toUpperCase() !== "ACTIVE")
            continue;
        const liquidityUsdc = mkt.liquidity;
        if (liquidityUsdc < inputs.liquidityMinUsd)
            continue;
        const side = mkt.sideHint === "HOME" ? "YES" : "NO";
        const kickoffTime = mkt.endDate ? new Date(mkt.endDate) : undefined;
        const entryWindow = kickoffTime
            ? new Date(kickoffTime.getTime() - 48 * 3600 * 1000)
            : undefined;
        await prisma_1.prisma.club_market_candidates.create({
            data: {
                poolId,
                clubName,
                eventId: String(mkt.raw.league ?? mkt.raw.league_name ?? ""),
                marketId: mkt.id,
                tokenId: `${mkt.id}:${side === "YES" ? 0 : 1}`, // encode outcome index in tokenId
                side,
                kickoffTime: kickoffTime ?? undefined,
                entryWindow,
                liquidityUsd: liquidityUsdc.toString(),
                status: "CANDIDATE",
            },
        });
        created += 1;
    }
    return { created, scanned: markets.length };
}
// ─── Decode tokenId helper ────────────────────────────────────────────────────
/**
 * Extract Limitless marketId and outcomeIndex from the encoded tokenId
 * stored in club_market_candidates.
 *
 * Format: "<marketId>:<outcomeIndex>"   e.g. "0xabc...:0"
 *
 * If tokenId doesn't contain ":", treat the whole string as marketId with index 0.
 */
function decodeLimitlessTokenId(tokenId) {
    const sep = tokenId.lastIndexOf(":");
    if (sep === -1)
        return { marketId: tokenId, outcomeIndex: 0 };
    return {
        marketId: tokenId.slice(0, sep),
        outcomeIndex: Number(tokenId.slice(sep + 1)) || 0,
    };
}
