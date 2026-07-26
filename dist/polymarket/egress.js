"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertPolymarketEgressAllowed = assertPolymarketEgressAllowed;
function enabled(raw) {
    return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}
/** Checks Railway's own egress, never the end user's IP. */
async function assertPolymarketEgressAllowed(env) {
    if (!enabled(env.POLYMARKET_EGRESS_CHECK_ENABLED))
        return;
    const response = await fetch("https://polymarket.com/api/geoblock", {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok)
        throw new Error(`Polymarket egress check failed (${response.status})`);
    const payload = (await response.json());
    if (payload.blocked) {
        throw new Error(`Railway egress is blocked by Polymarket (${payload.country ?? "unknown"}/${payload.region ?? "unknown"})`);
    }
}
