import type { Env } from "../config/env";
import { limitlessRequestJson } from "./limitlessAuth";
import { getMarketBySlug } from "./limitlessClient";
import { prisma } from "../db/prisma";

/**
 * Claim the USDC payout of a RESOLVED Limitless market for the pool's server
 * wallet. Mirrors POST /portfolio/redeem { conditionId } with the pool's
 * sub-account targeted via x-on-behalf-of (partner flow). Requires HMAC auth
 * with the `trading` scope (LIMITLESS_API_KEY / LIMITLESS_API_SECRET).
 *
 * The market must be resolved with a redeemable on-chain balance, otherwise
 * Limitless rejects the request.
 */
export async function redeemResolvedPosition(
  env: Env,
  conditionId: string,
  profileId?: string | null,
): Promise<unknown> {
  return limitlessRequestJson(
    env,
    "POST",
    "/portfolio/redeem",
    { conditionId },
    profileId ? { "x-on-behalf-of": String(profileId) } : undefined,
  );
}

/**
 * Resolve the on-chain CTF `conditionId` (bytes32, `0x…`) for a pool market.
 * The redeem API needs the real bytes32 — `club_pool_positions.marketId` is a
 * slug, so we read `pool_selected_markets.conditionId` first, then fall back to
 * the live Limitless market payload.
 */
export async function resolveConditionId(
  env: Env,
  poolId: string,
  marketId: string,
): Promise<string | null> {
  const isBytes32 = (v: unknown): v is string =>
    typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v.trim());

  const selected = (prisma as any).pool_selected_markets
    ? await (prisma as any).pool_selected_markets.findFirst({ where: { poolId, marketId } })
    : null;
  if (isBytes32(selected?.conditionId)) return selected.conditionId;

  try {
    const market = await getMarketBySlug(env, marketId);
    const candidate =
      (market as any)?.conditionId ??
      (market as any)?.condition_id ??
      (market as any)?.venue?.conditionId;
    if (isBytes32(candidate)) return candidate;
  } catch {
    /* best-effort — fall through */
  }
  return null;
}
