import type { Env } from "../config/env";

type GammaResponse<T> = { data: T };

async function getJson<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  const u = new URL(url);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      u.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(u.toString(), { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gamma request failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

export type Team = { id: string; slug?: string; name?: string; slugKey?: string; [k: string]: unknown };
export type Market = {
  id: string;
  tokenId?: string;
  questionId?: string;
  conditionId?: string;
  slug?: string;
  outcomes?: string[];
  outcomePrices?: string[];
  enableOrderBook?: boolean;
  tradingActive?: boolean;
  [k: string]: unknown;
};
export type Event = { id: string; title?: string; startDate?: string; [k: string]: unknown };

export function gammaBaseUrl(env: Env) {
  return env.GAMMA_BASE_URL;
}

export async function listTeams(env: Env, limit = 100, offset = 0) {
  const raw = await getJson<Team[] | { teams?: Team[] }>(`${env.GAMMA_BASE_URL}/teams`, { limit, offset });
  const teams = Array.isArray(raw) ? raw : raw?.teams ?? [];
  return { teams };
}

export async function searchPublic(env: Env, q: string, limitPerType = 10) {
  return getJson<any>(`${env.GAMMA_BASE_URL}/public-search`, {
    q,
    limit_per_type: limitPerType
  });
}

export async function listEvents(env: Env, params?: Record<string, unknown>) {
  return getJson<any>(`${env.GAMMA_BASE_URL}/events`, params);
}

export async function listMarkets(env: Env, params?: Record<string, unknown>) {
  return getJson<any>(`${env.GAMMA_BASE_URL}/markets`, params);
}

export async function getEventById(env: Env, eventId: string) {
  return getJson<any>(`${env.GAMMA_BASE_URL}/events/${eventId}`);
}

export async function getMarketById(env: Env, marketId: string) {
  return getJson<any>(`${env.GAMMA_BASE_URL}/markets/${marketId}`);
}

