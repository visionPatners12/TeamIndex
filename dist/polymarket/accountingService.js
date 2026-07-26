"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reconcilePoolPolymarket = reconcilePoolPolymarket;
exports.refreshPoolAccounting = refreshPoolAccounting;
exports.reconcileAndValuePool = reconcileAndValuePool;
const ethers_1 = require("ethers");
const prisma_1 = require("../db/prisma");
const polygonV2_1 = require("../onchain/polygonV2");
const poolClobClient_1 = require("./poolClobClient");
const money_1 = require("./money");
const stableJson_1 = require("./stableJson");
const erc20Abi = ["function balanceOf(address account) view returns (uint256)"];
function safeNumber(value) {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
}
async function fetchDataApiPositions(env, address) {
    const url = new URL("/positions", env.POLYMARKET_DATA_API_URL);
    url.searchParams.set("user", address);
    url.searchParams.set("sizeThreshold", "0");
    url.searchParams.set("limit", "500");
    const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
        throw new Error(`Polymarket positions API failed (${response.status})`);
    const payload = await response.json();
    return Array.isArray(payload) ? payload : [];
}
function tradeOrderId(trade) {
    return trade?.taker_order_id ?? trade?.maker_orders?.[0]?.order_id ?? null;
}
async function reconcilePoolPolymarket(env, poolId) {
    const account = await prisma_1.prisma.pool_polymarket_accounts.findUnique({ where: { poolId } });
    if (!account)
        throw new Error("Pool Polymarket account not found");
    const clob = (0, poolClobClient_1.createPoolClobClient)(env, account);
    const [positions, openOrders, trades] = await Promise.all([
        fetchDataApiPositions(env, account.depositWalletAddress),
        clob.getOpenOrders({}, true),
        clob.getTrades({}, true),
    ]);
    const now = new Date();
    await prisma_1.prisma.$transaction(async (tx) => {
        const activeTokenIds = new Set();
        for (const position of positions) {
            const tokenId = String(position.asset ?? "");
            const conditionId = String(position.conditionId ?? "");
            if (!tokenId || !conditionId)
                continue;
            activeTokenIds.add(tokenId);
            const quantity = safeNumber(position.size);
            const averagePrice = safeNumber(position.avgPrice);
            const currentPrice = safeNumber(position.curPrice);
            const currentValue = safeNumber(position.currentValue) || quantity * currentPrice;
            const realizedPnl = safeNumber(position.realizedPnl);
            const cashPnl = safeNumber(position.cashPnl);
            await tx.pool_polymarket_positions.upsert({
                where: { poolId_tokenId: { poolId, tokenId } },
                create: {
                    poolId,
                    conditionId,
                    tokenId,
                    outcome: position.outcome ? String(position.outcome) : null,
                    quantity,
                    averagePrice,
                    currentPrice,
                    currentValue,
                    realizedPnl,
                    unrealizedPnl: cashPnl - realizedPnl,
                    status: quantity > 0 ? "OPEN" : "CLOSED",
                    lastReconciledAt: now,
                    rawJson: position,
                },
                update: {
                    conditionId,
                    outcome: position.outcome ? String(position.outcome) : null,
                    quantity,
                    averagePrice,
                    currentPrice,
                    currentValue,
                    realizedPnl,
                    unrealizedPnl: cashPnl - realizedPnl,
                    status: quantity > 0 ? "OPEN" : "CLOSED",
                    lastReconciledAt: now,
                    rawJson: position,
                },
            });
        }
        await tx.pool_polymarket_positions.updateMany({
            where: { poolId, tokenId: { notIn: [...activeTokenIds] }, status: "OPEN" },
            data: { status: "CLOSED", quantity: 0, currentValue: 0, lastReconciledAt: now },
        });
        const openOrderIds = new Set();
        for (const order of openOrders) {
            openOrderIds.add(order.id);
            await tx.pool_polymarket_orders.updateMany({
                where: { externalOrderId: order.id, poolId },
                data: {
                    status: String(order.status ?? "OPEN").toUpperCase(),
                    matchedSize: order.size_matched,
                    rawJson: order,
                },
            });
        }
        await tx.pool_polymarket_orders.updateMany({
            where: {
                poolId,
                externalOrderId: { notIn: [...openOrderIds] },
                status: { in: ["OPEN", "LIVE", "SUBMITTED"] },
            },
            data: { status: "CLOSED", closedAt: now },
        });
        for (const trade of trades) {
            const externalTradeId = String(trade.id ?? "");
            if (!externalTradeId)
                continue;
            const externalOrderId = tradeOrderId(trade);
            const order = externalOrderId
                ? await tx.pool_polymarket_orders.findUnique({ where: { externalOrderId } })
                : null;
            await tx.pool_polymarket_trades.upsert({
                where: { externalTradeId },
                create: {
                    poolId,
                    accountId: account.id,
                    orderId: order?.id,
                    externalTradeId,
                    conditionId: String(trade.market ?? order?.conditionId ?? ""),
                    tokenId: String(trade.asset_id ?? order?.tokenId ?? ""),
                    side: order?.side ?? "YES",
                    price: safeNumber(trade.price),
                    size: safeNumber(trade.size),
                    fee: safeNumber(trade.fee_rate_bps) * safeNumber(trade.price) * safeNumber(trade.size) / 10_000,
                    status: String(trade.status ?? "MATCHED").toUpperCase(),
                    executedAt: trade.match_time ? new Date(`${trade.match_time}Z`) : now,
                    rawJson: trade,
                },
                update: {
                    status: String(trade.status ?? "MATCHED").toUpperCase(),
                    rawJson: trade,
                },
            });
        }
        await tx.pool_polymarket_accounts.update({
            where: { id: account.id },
            data: { lastReconciledAt: now },
        });
    });
    return { positions: positions.length, openOrders: openOrders.length, trades: trades.length };
}
async function refreshPoolAccounting(env, poolId) {
    const account = await prisma_1.prisma.pool_polymarket_accounts.findUnique({ where: { poolId } });
    if (!account)
        throw new Error("Pool Polymarket account not found");
    const vault = (0, polygonV2_1.getPusdVaultV2)(env, account.vaultAddress);
    const pUSD = new ethers_1.Contract(env.POLYMARKET_PUSD_ADDRESS, erc20Abi, (0, polygonV2_1.getPolygonProvider)(env));
    const [positions, openOrders, depositWalletCash, currentSequence] = await Promise.all([
        prisma_1.prisma.pool_polymarket_positions.findMany({ where: { poolId, status: "OPEN" } }),
        prisma_1.prisma.pool_polymarket_orders.findMany({
            where: { poolId, status: { in: ["OPEN", "LIVE", "SUBMITTED"] } },
        }),
        pUSD.balanceOf(account.depositWalletAddress),
        vault.valuationSequence(),
    ]);
    const positionsValue = positions.reduce((sum, position) => sum + safeNumber(position.currentValue), 0);
    const reservedCollateral = openOrders.reduce((sum, order) => {
        const remaining = Math.max(0, safeNumber(order.originalSize) - safeNumber(order.matchedSize));
        return sum + remaining * safeNumber(order.price);
    }, 0);
    const externalAssetsBaseUnits = depositWalletCash + (0, money_1.decimalToBaseUnits)(positionsValue.toFixed(6));
    const reservedBaseUnits = (0, money_1.decimalToBaseUnits)(reservedCollateral.toFixed(6));
    const sequence = currentSequence + 1n;
    const valuedAt = Math.floor(Date.now() / 1000);
    const snapshotBody = {
        poolId,
        sequence: sequence.toString(),
        depositWalletAddress: account.depositWalletAddress,
        depositWalletCash: depositWalletCash.toString(),
        positions: positions.map((position) => ({
            tokenId: position.tokenId,
            quantity: position.quantity.toString(),
            currentPrice: position.currentPrice.toString(),
            currentValue: position.currentValue.toString(),
        })),
        reservedCollateral: reservedBaseUnits.toString(),
        valuedAt,
    };
    const snapshotHash = (0, ethers_1.keccak256)((0, ethers_1.toUtf8Bytes)((0, stableJson_1.stableJson)(snapshotBody)));
    const valuationTxHash = await (0, polygonV2_1.recordPoolExternalValuation)(env, account.vaultAddress, {
        sequence,
        externalAssetsBaseUnits,
        reservedCollateralBaseUnits: reservedBaseUnits,
        valuedAt,
        snapshotHash,
    });
    const [vaultCash, totalAssets, totalSupply] = (await Promise.all([
        vault.totalCash(),
        vault.totalAssets(),
        vault.totalSupply(),
    ]));
    const cash = (0, money_1.decimalToSdkNumber)((0, ethers_1.formatUnits)(vaultCash + depositWalletCash, 6), "cash");
    const totalPoolValue = (0, money_1.decimalToSdkNumber)((0, ethers_1.formatUnits)(totalAssets, 6), "total assets");
    const totalSupplyHuman = (0, money_1.decimalToSdkNumber)((0, ethers_1.formatUnits)(totalSupply, 6), "total supply");
    const officialTokenPrice = totalSupplyHuman > 0 ? totalPoolValue / totalSupplyHuman : 1;
    await prisma_1.prisma.$transaction([
        prisma_1.prisma.pool_valuation_snapshots.create({
            data: {
                poolId,
                sequence,
                snapshotHash,
                valuedAt: new Date(valuedAt * 1000),
                cash,
                positionsValue,
                reservedCollateral,
                realizedPnl: positions.reduce((sum, position) => sum + safeNumber(position.realizedPnl), 0),
                totalPoolValue,
                totalTokenSupply: totalSupplyHuman,
                officialTokenPrice,
                source: "POLYMARKET_V2",
                rawJson: { ...snapshotBody, valuationTxHash },
            },
        }),
        prisma_1.prisma.club_pools.update({
            where: { id: poolId },
            data: {
                cash,
                openPositionsValue: positionsValue,
                realizedPnl: positions.reduce((sum, position) => sum + safeNumber(position.realizedPnl), 0),
                totalPoolValue,
                totalTokenSupply: totalSupplyHuman,
                officialTokenPrice,
            },
        }),
    ]);
    return {
        sequence: sequence.toString(),
        snapshotHash,
        valuationTxHash,
        externalAssetsBaseUnits: externalAssetsBaseUnits.toString(),
        totalPoolValue,
        officialTokenPrice,
    };
}
async function reconcileAndValuePool(env, poolId) {
    const reconciliation = await reconcilePoolPolymarket(env, poolId);
    const valuation = await refreshPoolAccounting(env, poolId);
    return { reconciliation, valuation };
}
