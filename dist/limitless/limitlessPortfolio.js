"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchPortfolioPositions = fetchPortfolioPositions;
exports.fetchPortfolioTrades = fetchPortfolioTrades;
exports.fetchPortfolioPnlChart = fetchPortfolioPnlChart;
exports.syncLimitlessPortfolioForPool = syncLimitlessPortfolioForPool;
const prisma_1 = require("../db/prisma");
function limitlessBase(env) {
    return env.LIMITLESS_BASE_URL ?? "https://api.limitless.exchange";
}
function authHeaders(env) {
    const key = env.LIMITLESS_API_KEY;
    return key ? { "X-API-Key": key, Accept: "application/json" } : { Accept: "application/json" };
}
async function getJson(env, path, params) {
    const url = new URL(`${limitlessBase(env)}${path}`);
    for (const [key, value] of Object.entries(params ?? {})) {
        if (value !== undefined && value !== null && value !== "")
            url.searchParams.set(key, String(value));
    }
    const res = await fetch(url, { headers: authHeaders(env) });
    const text = await res.text();
    if (!res.ok)
        throw new Error(`Limitless portfolio ${res.status} ${path}: ${text}`);
    return (text ? JSON.parse(text) : {});
}
function asArray(raw) {
    if (Array.isArray(raw))
        return raw.filter((x) => !!x && typeof x === "object" && !Array.isArray(x));
    if (raw && typeof raw === "object") {
        const record = raw;
        for (const key of ["data", "positions", "trades", "points", "pnl"]) {
            const value = record[key];
            if (Array.isArray(value))
                return asArray(value);
        }
    }
    return [];
}
function num(value, fallback = 0) {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
}
function pickNumber(row, keys) {
    for (const key of keys) {
        if (row[key] !== undefined && row[key] !== null)
            return num(row[key]);
    }
    return 0;
}
function pickString(row, keys) {
    for (const key of keys) {
        const value = row[key];
        if (typeof value === "string" && value.trim())
            return value;
    }
    return null;
}
function pickDate(row, keys) {
    const value = pickString(row, keys);
    if (!value)
        return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
}
async function fetchPortfolioPositions(env, account) {
    return getJson(env, "/portfolio/positions", { account });
}
async function fetchPortfolioTrades(env, account) {
    return getJson(env, "/portfolio/trades", { account });
}
async function fetchPortfolioPnlChart(env, account) {
    return getJson(env, "/portfolio/pnl-chart", { account });
}
async function syncLimitlessPortfolioForPool(env, poolId) {
    const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: poolId } });
    if (!pool)
        throw new Error(`Pool not found: ${poolId}`);
    const account = await prisma_1.prisma.pool_limitless_accounts.findUnique({ where: { poolId } });
    const accountId = account?.accountAddress ?? account?.limitlessProfileId;
    if (!accountId)
        throw new Error(`Pool ${poolId} has no Limitless account address/profile id`);
    const [positionsRaw, tradesRaw, pnlRaw] = await Promise.all([
        fetchPortfolioPositions(env, accountId),
        fetchPortfolioTrades(env, accountId),
        fetchPortfolioPnlChart(env, accountId),
    ]);
    const positions = asArray(positionsRaw);
    const trades = asArray(tradesRaw);
    const pnl = asArray(pnlRaw);
    const marketValue = positions.reduce((sum, row) => sum + pickNumber(row, ["marketValue", "value", "currentValue", "notional"]), 0);
    const unrealizedPnl = positions.reduce((sum, row) => sum + pickNumber(row, ["unrealizedPnl", "unrealizedPNL", "pnl"]), 0);
    const realizedPnl = pnl.reduce((sum, row) => sum + pickNumber(row, ["realizedPnl", "realizedPNL", "realized"]), 0);
    await prisma_1.prisma.pool_limitless_position_snapshots.create({
        data: {
            poolId,
            accountId,
            positionsJson: positions,
            marketValue: marketValue.toString(),
            unrealizedPnl: unrealizedPnl.toString(),
            rawJson: positionsRaw,
        },
    });
    for (const trade of trades) {
        const externalTradeId = pickString(trade, ["id", "tradeId", "orderId", "transactionHash"]) ??
            `${poolId}:${JSON.stringify(trade).slice(0, 120)}`;
        await prisma_1.prisma.pool_limitless_trades.upsert({
            where: {
                pool_limitless_trades_poolId_externalTradeId_key: {
                    poolId,
                    externalTradeId,
                },
            },
            update: { rawJson: trade },
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
                rawJson: trade,
            },
        });
    }
    await prisma_1.prisma.pool_limitless_pnl_snapshots.create({
        data: {
            poolId,
            accountId,
            pnlJson: pnl,
            realizedPnl: realizedPnl.toString(),
            unrealizedPnl: unrealizedPnl.toString(),
            rawJson: pnlRaw,
        },
    });
    const cash = num(pool.cash?.toString?.() ?? pool.cash);
    const totalTokenSupply = num(pool.totalTokenSupply?.toString?.() ?? pool.totalTokenSupply);
    const totalPoolValue = cash + marketValue + realizedPnl;
    const officialTokenPrice = totalTokenSupply > 0 ? totalPoolValue / totalTokenSupply : 1;
    const valuation = await prisma_1.prisma.pool_valuation_snapshots.create({
        data: {
            poolId,
            cash: cash.toString(),
            positionsValue: marketValue.toString(),
            realizedPnl: realizedPnl.toString(),
            totalPoolValue: totalPoolValue.toString(),
            totalTokenSupply: totalTokenSupply.toString(),
            officialTokenPrice: officialTokenPrice.toString(),
            source: "LIMITLESS_REST",
            rawJson: { positions: positionsRaw, pnl: pnlRaw },
        },
    });
    await prisma_1.prisma.club_pools.update({
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
