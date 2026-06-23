/**
 * limitlessDiscoveryService.ts
 *
 * Market discovery for the allocation pipeline using canonical sports_data ids.
 *
 * The selected pool stores sportsDataTeamId (sports_data.teams.id). Discovery
 * uses sports_data market links when available, then falls back to the cached
 * Limitless pipeline tables.
 */

import type { Env } from "../config/env";
import { prisma } from "../db/prisma";
import { getLimitlessMarketsForTeam } from "../sportsData/limitlessTeams";

type DiscoverLimitlessInputs = {
  poolId: string;
  clubName: string;
  sportsDataTeamId: string;
  riskPerMatchPct: number;
  liquidityMinUsd: number;
  env: Env;
};

// ─── Main discovery function ──────────────────────────────────────────────────

/**
 * Discover active Limitless markets for a club and write them to candidates.
 */
export async function discoverLimitlessClubCandidates(inputs: DiscoverLimitlessInputs) {
  const { poolId, clubName, sportsDataTeamId } = inputs;

  // ── Clear older candidates for this pool ─────────────────────────────────
  await prisma.club_market_candidates.deleteMany({ where: { poolId } });

  const markets = await getLimitlessMarketsForTeam(prisma, sportsDataTeamId);
  let created = 0;

  for (const mkt of markets) {
    if (mkt.status && mkt.status.toUpperCase() !== "ACTIVE") continue;
    const liquidityUsdc = mkt.liquidity;
    if (liquidityUsdc < inputs.liquidityMinUsd) continue;

    const side: "YES" | "NO" = mkt.sideHint === "HOME" ? "YES" : "NO";
    const kickoffTime = mkt.endDate ? new Date(mkt.endDate) : undefined;
    const entryWindow = kickoffTime
      ? new Date(kickoffTime.getTime() - 48 * 3600 * 1000)
      : undefined;

    await prisma.club_market_candidates.create({
      data: {
        poolId,
        clubName,
        eventId: String((mkt.raw.league as string | undefined) ?? (mkt.raw.league_name as string | undefined) ?? ""),
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
export function decodeLimitlessTokenId(tokenId: string): { marketId: string; outcomeIndex: number } {
  const sep = tokenId.lastIndexOf(":");
  if (sep === -1) return { marketId: tokenId, outcomeIndex: 0 };
  return {
    marketId: tokenId.slice(0, sep),
    outcomeIndex: Number(tokenId.slice(sep + 1)) || 0,
  };
}
