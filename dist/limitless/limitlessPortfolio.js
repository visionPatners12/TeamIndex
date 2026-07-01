"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.humanOrBase6 = humanOrBase6;
exports.normalizePortfolioPositions = normalizePortfolioPositions;
exports.extractRealizedPnl = extractRealizedPnl;
exports.fetchPortfolioPositions = fetchPortfolioPositions;
exports.fetchPortfolioHistory = fetchPortfolioHistory;
exports.fetchPortfolioPnlChart = fetchPortfolioPnlChart;
exports.applyNormalizedPortfolioPositions = applyNormalizedPortfolioPositions;
exports.syncLimitlessPortfolioForPool = syncLimitlessPortfolioForPool;
const prisma_1 = require("../db/prisma");
const priceEngine_1 = require("../services/priceEngine");
const limitlessAuth_1 = require("./limitlessAuth");
function asArray(raw) {
    if (Array.isArray(raw))
        return raw.filter((x) => !!x && typeof x === "object" && !Array.isArray(x));
    if (raw && typeof raw === "object") {
        const record = raw;
        for (const key of ["data", "positions", "trades", "points", "pnl", "history"]) {
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
function humanOrBase6(value, fallback = 0) {
    const n = num(value, fallback);
    if (!Number.isFinite(n))
        return fallback;
    if (typeof value === "string" && value.includes("."))
        return n;
    if (Math.abs(n) >= 10_000)
        return n / 1e6;
    return n;
}
function priceNumber(value, fallback = 0) {
    const n = num(value, fallback);
    if (!Number.isFinite(n))
        return fallback;
    return Math.abs(n) > 1 ? n / 1e6 : n;
}
function nestedValue(row, key) {
    const parts = key.split(".");
    let value = row;
    for (const part of parts) {
        value = value && typeof value === "object" && !Array.isArray(value)
            ? value[part]
            : undefined;
    }
    return value;
}
function pickString(row, keys) {
    for (const key of keys) {
        const value = nestedValue(row, key);
        if (typeof value === "string" && value.trim())
            return value;
        if (typeof value === "number" && Number.isFinite(value))
            return String(value);
    }
    return null;
}
function pickNumber(row, keys, parser = num) {
    for (const key of keys) {
        const value = nestedValue(row, key);
        if (value !== undefined && value !== null)
            return parser(value);
    }
    return 0;
}
function pickDate(row, keys) {
    for (const key of keys) {
        const value = nestedValue(row, key);
        if (value === undefined || value === null || value === "")
            continue;
        const date = typeof value === "number" && value < 10_000_000_000
            ? new Date(value * 1000)
            : new Date(String(value));
        if (Number.isFinite(date.getTime()))
            return date;
    }
    return null;
}
function positionSidePayload(raw, side) {
    const positions = raw.positions;
    if (!positions || typeof positions !== "object" || Array.isArray(positions))
        return null;
    const payload = positions[side];
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
}
function normalizePortfolioPositions(raw) {
    const root = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const normalized = [];
    for (const row of asArray(root.clob)) {
        const marketSlug = pickString(row, ["market.slug", "market.id", "market.address"]);
        for (const [side, outcomeIndex] of [["yes", 0], ["no", 1]]) {
            const payload = positionSidePayload(row, side);
            if (!payload)
                continue;
            const marketValue = pickNumber(payload, ["marketValue", "value", "currentValue"], humanOrBase6);
            const cost = pickNumber(payload, ["cost", "costBasis", "collateralAmount"], humanOrBase6);
            const unrealizedPnl = pickNumber(payload, ["unrealizedPnl", "unrealizedPNL"], humanOrBase6);
            const realizedPnl = pickNumber(payload, ["realisedPnl", "realizedPnl", "realizedPNL"], humanOrBase6);
            const fillPrice = pickNumber(payload, ["fillPrice", "averageFillPrice"], priceNumber);
            const quantity = pickNumber(payload, ["quantity", "ctfBalance", "balance", "outcomeTokenAmount"], humanOrBase6) ||
                (fillPrice > 0 && cost > 0 ? cost / fillPrice : 0);
            if (marketValue === 0 && cost === 0 && unrealizedPnl === 0 && realizedPnl === 0 && quantity === 0)
                continue;
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
function extractRealizedPnl(raw, positions = []) {
    const root = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const current = root.current && typeof root.current === "object" && !Array.isArray(root.current)
        ? root.current
        : {};
    const fromCurrent = pickNumber(current, ["realizedPnl", "realisedPnl", "realized"]);
    if (fromCurrent !== 0)
        return fromCurrent;
    const currentValue = pickNumber(root, ["currentValue"]);
    if (currentValue !== 0)
        return currentValue;
    return positions.reduce((sum, pos) => sum + pos.realizedPnl, 0);
}
async function fetchPortfolioPositions(env, profileId) {
    return (0, limitlessAuth_1.limitlessGetJson)(env, "/portfolio/positions", undefined, profileId ? { "x-on-behalf-of": profileId } : undefined);
}
async function fetchPortfolioHistory(env, profileId, limit = 100) {
    return (0, limitlessAuth_1.limitlessGetJson)(env, "/portfolio/history", { limit }, profileId ? { "x-on-behalf-of": profileId } : undefined);
}
async function fetchPortfolioPnlChart(env, profileId, timeframe = "7d") {
    return (0, limitlessAuth_1.limitlessGetJson)(env, "/portfolio/pnl-chart", { timeframe }, profileId ? { "x-on-behalf-of": profileId } : undefined);
}
async function applyNormalizedPortfolioPositions(poolId, positions) {
    if (!positions.length)
        return { updated: 0 };
    const localPositions = await prisma_1.prisma.club_pool_positions.findMany({
        where: { poolId, status: "OPEN", tokenId: { contains: ":" } },
    });
    let updated = 0;
    for (const remote of positions) {
        if (!remote.marketSlug && !remote.marketId)
            continue;
        const local = localPositions.find((pos) => {
            const localOutcome = pos.side === "YES" ? "yes" : pos.side === "NO" ? "no" : null;
            return (pos.marketId === remote.marketSlug || pos.marketId === remote.marketId) &&
                (remote.outcome == null || localOutcome === remote.outcome);
        });
        if (!local)
            continue;
        const previousInvested = num(local.investedAmount?.toString?.() ?? local.investedAmount);
        const nextInvested = remote.cost > 0 ? remote.cost : previousInvested;
        const data = {
            currentValue: remote.marketValue.toString(),
        };
        if (remote.quantity > 0)
            data.quantity = remote.quantity.toString();
        if (nextInvested > 0) {
            data.stake = nextInvested.toString();
            data.investedAmount = nextInvested.toString();
        }
        if (remote.realizedPnl !== 0)
            data.realizedPnl = remote.realizedPnl.toString();
        await prisma_1.prisma.$transaction(async (tx) => {
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
async function syncLimitlessPortfolioForPool(env, poolId) {
    const pool = await prisma_1.prisma.club_pools.findUnique({ where: { id: poolId } });
    if (!pool)
        throw new Error(`Pool not found: ${poolId}`);
    const account = await prisma_1.prisma.pool_limitless_accounts.findUnique({ where: { poolId } });
    const accountId = account?.limitlessProfileId ?? account?.accountAddress;
    if (!accountId)
        throw new Error(`Pool ${poolId} has no Limitless account address/profile id`);
    const fetchStep = async (step, fn) => {
        try {
            return await fn();
        }
        catch (cause) {
            throw new Error(`Limitless portfolio ${step} sync failed for pool ${poolId} account ${accountId}`, { cause });
        }
    };
    const [positionsRaw, historyRaw, pnlRaw] = await Promise.all([
        fetchStep("positions", () => fetchPortfolioPositions(env, accountId)),
        fetchStep("history", () => fetchPortfolioHistory(env, accountId)),
        fetchStep("pnl", () => fetchPortfolioPnlChart(env, accountId)),
    ]);
    const positions = normalizePortfolioPositions(positionsRaw);
    const trades = asArray(historyRaw);
    const marketValue = positions.reduce((sum, row) => sum + row.marketValue, 0);
    const unrealizedPnl = positions.reduce((sum, row) => sum + row.unrealizedPnl, 0);
    const realizedPnl = extractRealizedPnl(pnlRaw, positions);
    await prisma_1.prisma.pool_limitless_position_snapshots.create({
        data: {
            poolId,
            accountId,
            positionsJson: positions.map(({ raw: _raw, ...position }) => position),
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
                marketId: pickString(trade, ["marketId", "market.slug", "market.id", "slug"]),
                side: pickString(trade, ["side", "outcome", "direction", "strategy"]),
                outcomeIndex: trade.outcomeIndex == null ? undefined : Math.trunc(num(trade.outcomeIndex)),
                price: (trade.price ?? trade.outcomeTokenPrice) == null ? undefined : num(trade.price ?? trade.outcomeTokenPrice).toString(),
                size: (trade.size ?? trade.outcomeTokenAmount) == null ? undefined : humanOrBase6(trade.size ?? trade.outcomeTokenAmount).toString(),
                fee: trade.fee == null ? undefined : humanOrBase6(trade.fee).toString(),
                executedAt: pickDate(trade, ["executedAt", "createdAt", "timestamp", "blockTimestamp"]) ?? undefined,
                rawJson: trade,
            },
        });
    }
    await prisma_1.prisma.pool_limitless_pnl_snapshots.create({
        data: {
            poolId,
            accountId,
            pnlJson: asArray(pnlRaw),
            realizedPnl: realizedPnl.toString(),
            unrealizedPnl: unrealizedPnl.toString(),
            rawJson: pnlRaw,
        },
    });
    await applyNormalizedPortfolioPositions(poolId, positions);
    await prisma_1.prisma.club_pools.update({
        where: { id: poolId },
        data: { realizedPnl: realizedPnl.toString() },
    });
    const { valuation, valuationSnapshot } = await (0, priceEngine_1.recalculateOfficialPriceForPool)(env, poolId, {
        valuationSnapshot: {
            source: "LIMITLESS_REST",
            rawJson: { positions: positionsRaw, pnl: pnlRaw, history: historyRaw },
        },
    });
    return { poolId, accountId, positions: positions.length, trades: trades.length, valuation: valuationSnapshot ?? valuation };
}
