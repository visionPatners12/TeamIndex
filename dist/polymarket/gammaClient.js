"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.gammaBaseUrl = gammaBaseUrl;
exports.listTeams = listTeams;
exports.searchPublic = searchPublic;
exports.listEvents = listEvents;
exports.listMarkets = listMarkets;
exports.getEventById = getEventById;
exports.getMarketById = getMarketById;
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
    return getJson(`${env.GAMMA_BASE_URL}/teams`, { limit, offset });
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
