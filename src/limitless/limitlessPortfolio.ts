import type { Env } from "../config/env";
import { prisma } from "../db/prisma";

type JsonRecord = Record<string, unknown>;

function limitlessBase(env: Env): string {
  return (env as any).LIMITLESS_BASE_URL ?? "https://api.limitless.exchange";
}

function authHeaders(env: Env): Record<string, string> {
  const key = (env as any).LIMITLESS_API_KEY as string | undefined;
  return key ? { "X-API-Key": key, Accept: "application/json" } : { Accept: "application/json" };
}

async function getJson<T>(env: Env, path: string, params?: Record<string, unknown>): Promise<T> {
  const url = new URL(`${limitlessBase(env)}${path}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const res = await fetch(url, { headers: authHeaders(env) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Limitless portfolio ${res.status} ${path}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

function asArray(raw: unknown): JsonRecord[] {
  if (Array.isArray(raw)) return raw.filter((x): x is JsonRecord => !!x && typeof x === "object" && !Array.isArray(x));
  if (raw && typeof raw === "object") {
    const record = raw as JsonRecord;
    for (const key of ["data", "positions", "trades", "points", "pnl"]) {
      const value = record[key];
      if (Array.isArray(value)) return asArray(value);
    }
  }
  return [];
}

function num(value: unknown, fallback = 0) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pickNumber(row: JsonRecord, keys: string[]) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return num(row[key]);
  }
  return 0;
}

function pickString(row: JsonRecord, keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function pickDate(row: JsonRecord, keys: string[]) {
  const value = pickString(row, keys);
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export async function fetchPortfolioPositions(env: Env, account: string): Promise<JsonRecord> {
  return getJson<JsonRecord>(env, "/portfolio/positions", { account });
}

export async function fetchPortfolioTrades(env: Env, account: string): Promise<JsonRecord> {
  return getJson<JsonRecord>(env, "/portfolio/trades", { account });
}

export async function fetchPortfolioPnlChart(env: Env, account: string): Promise<JsonRecord> {
  return getJson<JsonRecord>(env, "/portfolio/pnl-chart", { account });
}

export async function syncLimitlessPortfolioForPool(env: Env, poolId: string) {
  const pool = await prisma.club_pools.findUnique({ where: { id: poolId } });
  if (!pool) throw new Error(`Pool not found: ${poolId}`);

  const account = await (prisma as any).pool_limitless_accounts.findUnique({ where: { poolId } });
  const accountId = account?.accountAddress ?? account?.limitlessProfileId;
  if (!accountId) throw new Error(`Pool ${poolId} has no Limitless account address/profile id`);

  const [positionsRaw, tradesRaw, pnlRaw] = await Promise.all([
    fetchPortfolioPositions(env, accountId),
    fetchPortfolioTrades(env, accountId),
    fetchPortfolioPnlChart(env, accountId),
  ]);

  const positions = asArray(positionsRaw);
  const trades = asArray(tradesRaw);
  const pnl = asArray(pnlRaw);

  const marketValue = positions.reduce(
    (sum, row) => sum + pickNumber(row, ["marketValue", "value", "currentValue", "notional"]),
    0
  );
  const unrealizedPnl = positions.reduce(
    (sum, row) => sum + pickNumber(row, ["unrealizedPnl", "unrealizedPNL", "pnl"]),
    0
  );
  const realizedPnl = pnl.reduce(
    (sum, row) => sum + pickNumber(row, ["realizedPnl", "realizedPNL", "realized"]),
    0
  );

  await (prisma as any).pool_limitless_position_snapshots.create({
    data: {
      poolId,
      accountId,
      positionsJson: positions as any,
      marketValue: marketValue.toString(),
      unrealizedPnl: unrealizedPnl.toString(),
      rawJson: positionsRaw as any,
    },
  });

  for (const trade of trades) {
    const externalTradeId =
      pickString(trade, ["id", "tradeId", "orderId", "transactionHash"]) ??
      `${poolId}:${JSON.stringify(trade).slice(0, 120)}`;
    await (prisma as any).pool_limitless_trades.upsert({
      where: {
        pool_limitless_trades_poolId_externalTradeId_key: {
          poolId,
          externalTradeId,
        },
      },
      update: { rawJson: trade as any },
      create: {
        poolId,
        accountId,
        externalTradeId,
        marketId: pickString(trade, ["marketId", "market", "slug"]),
        side: pickString(trade, ["side", "outcome", "direction"]),
        outcomeIndex: trade.outcomeIndex == null ? undefined : Math.trunc(num(trade.outcomeIndex)),
        price: trade.price == null ? undefined : num(trade.price).toString(),
        size: trade.size == null ? undefined : num(trade.size).toString(),
        fee: trade.fee == null ? undefined : num(trade.fee).toString(),
        executedAt: pickDate(trade, ["executedAt", "createdAt", "timestamp"]) ?? undefined,
        rawJson: trade as any,
      },
    });
  }

  await (prisma as any).pool_limitless_pnl_snapshots.create({
    data: {
      poolId,
      accountId,
      pnlJson: pnl as any,
      realizedPnl: realizedPnl.toString(),
      unrealizedPnl: unrealizedPnl.toString(),
      rawJson: pnlRaw as any,
    },
  });

  const cash = num((pool as any).cash?.toString?.() ?? (pool as any).cash);
  const totalTokenSupply = num((pool as any).totalTokenSupply?.toString?.() ?? (pool as any).totalTokenSupply);
  const totalPoolValue = cash + marketValue + realizedPnl;
  const officialTokenPrice = totalTokenSupply > 0 ? totalPoolValue / totalTokenSupply : 1;

  const valuation = await (prisma as any).pool_valuation_snapshots.create({
    data: {
      poolId,
      cash: cash.toString(),
      positionsValue: marketValue.toString(),
      realizedPnl: realizedPnl.toString(),
      totalPoolValue: totalPoolValue.toString(),
      totalTokenSupply: totalTokenSupply.toString(),
      officialTokenPrice: officialTokenPrice.toString(),
      source: "LIMITLESS_REST",
      rawJson: { positions: positionsRaw, pnl: pnlRaw } as any,
    },
  });

  await prisma.club_pools.update({
    where: { id: poolId },
    data: {
      openPositionsValue: marketValue.toString(),
      realizedPnl: realizedPnl.toString(),
      totalPoolValue: totalPoolValue.toString(),
      officialTokenPrice: officialTokenPrice.toString(),
    },
  });

  return { poolId, accountId, positions: positions.length, trades: trades.length, valuation };
}
