import { Contract, formatUnits, keccak256, toUtf8Bytes } from "ethers";
import type { Env } from "../config/env";
import { prisma } from "../db/prisma";
import { getPolygonProvider, getPusdVaultV2, recordPoolExternalValuation } from "../onchain/polygonV2";
import { createPoolClobClient } from "./poolClobClient";
import { decimalToBaseUnits, decimalToSdkNumber } from "./money";
import { stableJson } from "./stableJson";

const erc20Abi = ["function balanceOf(address account) view returns (uint256)"] as const;

type DataApiPosition = {
  asset?: string;
  conditionId?: string;
  size?: number | string;
  avgPrice?: number | string;
  curPrice?: number | string;
  currentValue?: number | string;
  cashPnl?: number | string;
  realizedPnl?: number | string;
  outcome?: string;
  redeemable?: boolean;
  mergeable?: boolean;
  [key: string]: unknown;
};

function safeNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function fetchDataApiPositions(env: Env, address: string): Promise<DataApiPosition[]> {
  const url = new URL("/positions", env.POLYMARKET_DATA_API_URL);
  url.searchParams.set("user", address);
  url.searchParams.set("sizeThreshold", "0");
  url.searchParams.set("limit", "500");
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Polymarket positions API failed (${response.status})`);
  const payload = await response.json();
  return Array.isArray(payload) ? payload : [];
}

function tradeOrderId(trade: any): string | null {
  return trade?.taker_order_id ?? trade?.maker_orders?.[0]?.order_id ?? null;
}

export async function reconcilePoolPolymarket(env: Env, poolId: string) {
  const account = await prisma.pool_polymarket_accounts.findUnique({ where: { poolId } });
  if (!account) throw new Error("Pool Polymarket account not found");
  const clob = createPoolClobClient(env, account);
  const [positions, openOrders, trades] = await Promise.all([
    fetchDataApiPositions(env, account.depositWalletAddress),
    clob.getOpenOrders({}, true),
    clob.getTrades({}, true),
  ]);
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    const activeTokenIds = new Set<string>();
    for (const position of positions) {
      const tokenId = String(position.asset ?? "");
      const conditionId = String(position.conditionId ?? "");
      if (!tokenId || !conditionId) continue;
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
          rawJson: position as any,
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
          rawJson: position as any,
        },
      });
    }
    await tx.pool_polymarket_positions.updateMany({
      where: { poolId, tokenId: { notIn: [...activeTokenIds] }, status: "OPEN" },
      data: { status: "CLOSED", quantity: 0, currentValue: 0, lastReconciledAt: now },
    });

    const openOrderIds = new Set<string>();
    for (const order of openOrders) {
      openOrderIds.add(order.id);
      await tx.pool_polymarket_orders.updateMany({
        where: { externalOrderId: order.id, poolId },
        data: {
          status: String(order.status ?? "OPEN").toUpperCase(),
          matchedSize: order.size_matched,
          rawJson: order as any,
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
      if (!externalTradeId) continue;
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
          rawJson: trade as any,
        },
        update: {
          status: String(trade.status ?? "MATCHED").toUpperCase(),
          rawJson: trade as any,
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

export async function refreshPoolAccounting(env: Env, poolId: string) {
  const account = await prisma.pool_polymarket_accounts.findUnique({ where: { poolId } });
  if (!account) throw new Error("Pool Polymarket account not found");
  const vault = getPusdVaultV2(env, account.vaultAddress);
  const pUSD = new Contract(env.POLYMARKET_PUSD_ADDRESS, erc20Abi, getPolygonProvider(env));
  const [positions, openOrders, depositWalletCash, currentSequence] = await Promise.all([
    prisma.pool_polymarket_positions.findMany({ where: { poolId, status: "OPEN" } }),
    prisma.pool_polymarket_orders.findMany({
      where: { poolId, status: { in: ["OPEN", "LIVE", "SUBMITTED"] } },
    }),
    (pUSD as any).balanceOf(account.depositWalletAddress) as Promise<bigint>,
    (vault as any).valuationSequence() as Promise<bigint>,
  ]);
  const positionsValue = positions.reduce((sum, position) => sum + safeNumber(position.currentValue), 0);
  const reservedCollateral = openOrders.reduce((sum, order) => {
    const remaining = Math.max(0, safeNumber(order.originalSize) - safeNumber(order.matchedSize));
    return sum + remaining * safeNumber(order.price);
  }, 0);
  const externalAssetsBaseUnits = depositWalletCash + decimalToBaseUnits(positionsValue.toFixed(6));
  const reservedBaseUnits = decimalToBaseUnits(reservedCollateral.toFixed(6));
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
  const snapshotHash = keccak256(toUtf8Bytes(stableJson(snapshotBody)));
  const valuationTxHash = await recordPoolExternalValuation(env, account.vaultAddress, {
    sequence,
    externalAssetsBaseUnits,
    reservedCollateralBaseUnits: reservedBaseUnits,
    valuedAt,
    snapshotHash,
  });

  const [vaultCash, totalAssets, totalSupply] = (await Promise.all([
    (vault as any).totalCash(),
    (vault as any).totalAssets(),
    (vault as any).totalSupply(),
  ])) as [bigint, bigint, bigint];
  const cash = decimalToSdkNumber(formatUnits(vaultCash + depositWalletCash, 6), "cash");
  const totalPoolValue = decimalToSdkNumber(formatUnits(totalAssets, 6), "total assets");
  const totalSupplyHuman = decimalToSdkNumber(formatUnits(totalSupply, 6), "total supply");
  const officialTokenPrice = totalSupplyHuman > 0 ? totalPoolValue / totalSupplyHuman : 1;

  await prisma.$transaction([
    prisma.pool_valuation_snapshots.create({
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
    prisma.club_pools.update({
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

export async function reconcileAndValuePool(env: Env, poolId: string) {
  const reconciliation = await reconcilePoolPolymarket(env, poolId);
  const valuation = await refreshPoolAccounting(env, poolId);
  return { reconciliation, valuation };
}
