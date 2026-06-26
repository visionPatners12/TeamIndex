import type { Env } from "../config/env";
import { prisma } from "../db/prisma";
import { limitlessGetJson } from "./limitlessAuth";

type JsonRecord = Record<string, unknown>;

export type NormalizedPortfolioPosition = {
  marketSlug: string | null;
  marketId: string | null;
  outcome: "yes" | "no" | null;
  outcomeIndex: number | null;
  tokenId: string | null;
  quantity: number;
  cost: number;
  marketValue: number;
  unrealizedPnl: number;
  realizedPnl: number;
  raw: JsonRecord;
};

const VAULT_SHARE_DECIMALS = 6;

function asArray(raw: unknown): JsonRecord[] {
  if (Array.isArray(raw)) return raw.filter((x): x is JsonRecord => !!x && typeof x === "object" && !Array.isArray(x));
  if (raw && typeof raw === "object") {
    const record = raw as JsonRecord;
    for (const key of ["data", "positions", "trades", "points", "pnl", "history"]) {
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

export function humanOrBase6(value: unknown, fallback = 0) {
  const n = num(value, fallback);
  if (!Number.isFinite(n)) return fallback;
  if (typeof value === "string" && value.includes(".")) return n;
  if (Math.abs(n) >= 10_000) return n / 1e6;
  return n;
}

function priceNumber(value: unknown, fallback = 0) {
  const n = num(value, fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.abs(n) > 1 ? n / 1e6 : n;
}

function nestedValue(row: JsonRecord, key: string): unknown {
  const parts = key.split(".");
  let value: unknown = row;
  for (const part of parts) {
    value = value && typeof value === "object" && !Array.isArray(value)
      ? (value as JsonRecord)[part]
      : undefined;
  }
  return value;
}

function pickString(row: JsonRecord, keys: string[]) {
  for (const key of keys) {
    const value = nestedValue(row, key);
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function pickNumber(row: JsonRecord, keys: string[], parser: (value: unknown) => number = num) {
  for (const key of keys) {
    const value = nestedValue(row, key);
    if (value !== undefined && value !== null) return parser(value);
  }
  return 0;
}

function pickDate(row: JsonRecord, keys: string[]) {
  for (const key of keys) {
    const value = nestedValue(row, key);
    if (value === undefined || value === null || value === "") continue;
    const date = typeof value === "number" && value < 10_000_000_000
      ? new Date(value * 1000)
      : new Date(String(value));
    if (Number.isFinite(date.getTime())) return date;
  }
  return null;
}

function positionSidePayload(raw: JsonRecord, side: "yes" | "no"): JsonRecord | null {
  const positions = raw.positions;
  if (!positions || typeof positions !== "object" || Array.isArray(positions)) return null;
  const payload = (positions as JsonRecord)[side];
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload as JsonRecord : null;
}

export function normalizePortfolioPositions(raw: unknown): NormalizedPortfolioPosition[] {
  const root = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as JsonRecord : {};
  const normalized: NormalizedPortfolioPosition[] = [];

  for (const row of asArray(root.clob)) {
    const marketSlug = pickString(row, ["market.slug", "market.id", "market.address"]);
    for (const [side, outcomeIndex] of [["yes", 0], ["no", 1]] as const) {
      const payload = positionSidePayload(row, side);
      if (!payload) continue;

      const marketValue = pickNumber(payload, ["marketValue", "value", "currentValue"], humanOrBase6);
      const cost = pickNumber(payload, ["cost", "costBasis", "collateralAmount"], humanOrBase6);
      const unrealizedPnl = pickNumber(payload, ["unrealizedPnl", "unrealizedPNL"], humanOrBase6);
      const realizedPnl = pickNumber(payload, ["realisedPnl", "realizedPnl", "realizedPNL"], humanOrBase6);
      const fillPrice = pickNumber(payload, ["fillPrice", "averageFillPrice"], priceNumber);
      const quantity = pickNumber(payload, ["quantity", "ctfBalance", "balance", "outcomeTokenAmount"], humanOrBase6) ||
        (fillPrice > 0 && cost > 0 ? cost / fillPrice : 0);

      if (marketValue === 0 && cost === 0 && unrealizedPnl === 0 && realizedPnl === 0 && quantity === 0) continue;
      normalized.push({
        marketSlug,
        marketId: marketSlug,
        outcome: side,
        outcomeIndex,
        tokenId: pickString(payload, ["tokenId"]),
        quantity,
        cost,
        marketValue,
        unrealizedPnl,
        realizedPnl,
        raw: { ...row, normalizedSide: side, sidePayload: payload },
      });
    }
  }

  for (const row of asArray(root.amm)) {
    const outcomeIndexRaw = pickNumber(row, ["outcomeIndex"]);
    const outcomeIndex = Number.isFinite(outcomeIndexRaw) ? Math.trunc(outcomeIndexRaw) : null;
    const marketValue = pickNumber(row, ["collateralOutOnSell", "marketValue"], humanOrBase6) ||
      pickNumber(row, ["collateralAmount"], humanOrBase6);
    const cost = pickNumber(row, ["collateralAmount", "cost"], humanOrBase6);
    normalized.push({
      marketSlug: pickString(row, ["market.slug", "market.id", "market.address", "marketAddress"]),
      marketId: pickString(row, ["market.slug", "market.id", "market.address", "marketAddress"]),
      outcome: outcomeIndex === 0 ? "yes" : outcomeIndex === 1 ? "no" : null,
      outcomeIndex,
      tokenId: pickString(row, ["tokenId"]),
      quantity: pickNumber(row, ["outcomeTokenAmount", "balance"], humanOrBase6),
      cost,
      marketValue,
      unrealizedPnl: marketValue - cost,
      realizedPnl: 0,
      raw: row,
    });
  }

  return normalized;
}

export function extractRealizedPnl(raw: unknown, positions: NormalizedPortfolioPosition[] = []): number {
  const root = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as JsonRecord : {};
  const current = root.current && typeof root.current === "object" && !Array.isArray(root.current)
    ? root.current as JsonRecord
    : {};
  const fromCurrent = pickNumber(current, ["realizedPnl", "realisedPnl", "realized"]);
  if (fromCurrent !== 0) return fromCurrent;
  const currentValue = pickNumber(root, ["currentValue"]);
  if (currentValue !== 0) return currentValue;
  return positions.reduce((sum, pos) => sum + pos.realizedPnl, 0);
}

function vaultCashDbToHuman(cashRaw: unknown): number {
  const s = String((cashRaw as any)?.toString?.() ?? cashRaw ?? "").trim();
  if (!s || s === "0") return 0;
  if (s.includes(".") || /[eE]/i.test(s)) return Number(s);
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return /^\d+$/.test(s) ? n / 1e6 : n;
}

export async function fetchPortfolioPositions(env: Env, profileId?: string): Promise<JsonRecord> {
  return limitlessGetJson<JsonRecord>(
    env,
    "/portfolio/positions",
    undefined,
    profileId ? { "x-on-behalf-of": profileId } : undefined
  );
}

export async function fetchPortfolioHistory(env: Env, profileId?: string, limit = 100): Promise<JsonRecord> {
  return limitlessGetJson<JsonRecord>(
    env,
    "/portfolio/history",
    { limit },
    profileId ? { "x-on-behalf-of": profileId } : undefined
  );
}

export async function fetchPortfolioPnlChart(env: Env, profileId?: string, timeframe = "7d"): Promise<JsonRecord> {
  return limitlessGetJson<JsonRecord>(
    env,
    "/portfolio/pnl-chart",
    { timeframe },
    profileId ? { "x-on-behalf-of": profileId } : undefined
  );
}

export async function applyNormalizedPortfolioPositions(poolId: string, positions: NormalizedPortfolioPosition[]) {
  if (!positions.length) return { updated: 0 };
  const localPositions = await prisma.club_pool_positions.findMany({
    where: { poolId, status: "OPEN", tokenId: { contains: ":" } },
  });

  let updated = 0;
  for (const remote of positions) {
    if (!remote.marketSlug && !remote.marketId) continue;
    const local = localPositions.find((pos) => {
      const localOutcome = pos.side === "YES" ? "yes" : pos.side === "NO" ? "no" : null;
      return (pos.marketId === remote.marketSlug || pos.marketId === remote.marketId) &&
        (remote.outcome == null || localOutcome === remote.outcome);
    });
    if (!local) continue;

    const previousInvested = num((local as any).investedAmount?.toString?.() ?? local.investedAmount);
    const nextInvested = remote.cost > 0 ? remote.cost : previousInvested;
    const data: Record<string, string> = {
      currentValue: remote.marketValue.toString(),
    };
    if (remote.quantity > 0) data.quantity = remote.quantity.toString();
    if (nextInvested > 0) {
      data.stake = nextInvested.toString();
      data.investedAmount = nextInvested.toString();
    }
    if (remote.realizedPnl !== 0) data.realizedPnl = remote.realizedPnl.toString();

    await prisma.$transaction(async (tx) => {
      const deltaInvested = nextInvested - previousInvested;
      if (deltaInvested > 0) {
        await tx.club_pools.update({
          where: { id: poolId },
          data: { cash: { decrement: deltaInvested.toString() } },
        });
      }
      await tx.club_pool_positions.update({ where: { id: local.id }, data });
    });
    updated += 1;
  }
  return { updated };
}

export async function syncLimitlessPortfolioForPool(env: Env, poolId: string) {
  const pool = await prisma.club_pools.findUnique({ where: { id: poolId } });
  if (!pool) throw new Error(`Pool not found: ${poolId}`);

  const account = await (prisma as any).pool_limitless_accounts.findUnique({ where: { poolId } });
  const accountId = account?.limitlessProfileId ?? account?.accountAddress;
  if (!accountId) throw new Error(`Pool ${poolId} has no Limitless account address/profile id`);

  const [positionsRaw, historyRaw, pnlRaw] = await Promise.all([
    fetchPortfolioPositions(env, accountId),
    fetchPortfolioHistory(env, accountId),
    fetchPortfolioPnlChart(env, accountId),
  ]);

  const positions = normalizePortfolioPositions(positionsRaw);
  const trades = asArray(historyRaw);
  const marketValue = positions.reduce((sum, row) => sum + row.marketValue, 0);
  const unrealizedPnl = positions.reduce((sum, row) => sum + row.unrealizedPnl, 0);
  const realizedPnl = extractRealizedPnl(pnlRaw, positions);

  await (prisma as any).pool_limitless_position_snapshots.create({
    data: {
      poolId,
      accountId,
      positionsJson: positions.map(({ raw: _raw, ...position }) => position) as any,
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
        marketId: pickString(trade, ["marketId", "market.slug", "market.id", "slug"]),
        side: pickString(trade, ["side", "outcome", "direction", "strategy"]),
        outcomeIndex: trade.outcomeIndex == null ? undefined : Math.trunc(num(trade.outcomeIndex)),
        price: (trade.price ?? trade.outcomeTokenPrice) == null ? undefined : num(trade.price ?? trade.outcomeTokenPrice).toString(),
        size: (trade.size ?? trade.outcomeTokenAmount) == null ? undefined : humanOrBase6(trade.size ?? trade.outcomeTokenAmount).toString(),
        fee: trade.fee == null ? undefined : humanOrBase6(trade.fee).toString(),
        executedAt: pickDate(trade, ["executedAt", "createdAt", "timestamp", "blockTimestamp"]) ?? undefined,
        rawJson: trade as any,
      },
    });
  }

  await (prisma as any).pool_limitless_pnl_snapshots.create({
    data: {
      poolId,
      accountId,
      pnlJson: asArray(pnlRaw) as any,
      realizedPnl: realizedPnl.toString(),
      unrealizedPnl: unrealizedPnl.toString(),
      rawJson: pnlRaw as any,
    },
  });

  await applyNormalizedPortfolioPositions(poolId, positions);

  const freshPool = await prisma.club_pools.findUnique({ where: { id: poolId } });
  const cash = vaultCashDbToHuman((freshPool ?? pool).cash);
  const totalTokenSupply = num((freshPool ?? pool).totalTokenSupply?.toString?.() ?? (freshPool ?? pool).totalTokenSupply);
  const sharesHuman = totalTokenSupply / 10 ** VAULT_SHARE_DECIMALS;
  const totalPoolValue = cash + marketValue + realizedPnl;
  const officialTokenPrice = sharesHuman > 0 ? totalPoolValue / sharesHuman : 0;

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
      rawJson: { positions: positionsRaw, pnl: pnlRaw, history: historyRaw } as any,
    },
  });

  await prisma.club_pools.update({
    where: { id: poolId },
    data: {
      cash: cash.toString(),
      openPositionsValue: marketValue.toString(),
      realizedPnl: realizedPnl.toString(),
      totalPoolValue: totalPoolValue.toString(),
      officialTokenPrice: officialTokenPrice.toString(),
    },
  });

  return { poolId, accountId, positions: positions.length, trades: trades.length, valuation };
}
