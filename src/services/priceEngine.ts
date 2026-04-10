import type { Env } from "../config/env";
import { getMidpoint } from "../polymarket/clobClient";
import { prisma } from "../db/prisma";
import { getVaultContract } from "../onchain/vaultExecutor";

function decToNumber(d: any): number {
  // Prisma Decimal -> string
  if (typeof d === "number") return d;
  if (typeof d === "string") return Number(d);
  if (d && typeof d.toString === "function") return Number(d.toString());
  return 0;
}

export async function recalculateOfficialPrices(env: Env) {
  const pools = await prisma.club_pools.findMany({ where: { status: "ACTIVE" } });

  for (const pool of pools) {
    const openPositions = await prisma.club_pool_positions.findMany({
      where: { poolId: pool.id, status: "OPEN" }
    });

    let positionsValue = 0;
    const positionUpdates: Promise<any>[] = [];
    for (const pos of openPositions) {
      // For MVP: use midpoint price for each open token and value by current quantity.
      // Polymarket binary token price is an implied probability; if your settlement differs,
      // adjust valuation formula accordingly.
      const mid = await getMidpoint(env, pos.tokenId).catch(() => "0");
      const midNum = Number(mid);
      const quantity = decToNumber(pos.quantity);
      const currentValue = midNum * quantity;
      positionsValue += currentValue;

      // Keep position-level mark-to-market currentValue in sync.
      positionUpdates.push(
        prisma.club_pool_positions.update({
          where: { id: pos.id },
          data: { currentValue: currentValue.toString() }
        })
      );
    }
    await Promise.all(positionUpdates);

    const cash = decToNumber(pool.cash);
    const realizedPnl = decToNumber(pool.realizedPnl);
    const totalPoolValue = cash + positionsValue + realizedPnl;
    const totalSupply = decToNumber(pool.totalTokenSupply);

    const officialTokenPrice = totalSupply > 0 ? totalPoolValue / totalSupply : 0;

    await prisma.club_pools.update({
      where: { id: pool.id },
      data: {
        openPositionsValue: positionsValue.toString(),
        totalPoolValue: totalPoolValue.toString(),
        officialTokenPrice: officialTokenPrice.toString()
      }
    });

    await prisma.club_pool_price_snapshots.create({
      data: {
        poolId: pool.id,
        cash: pool.cash,
        positionsValue: positionsValue.toString(),
        realizedPnl: pool.realizedPnl,
        totalPoolValue: totalPoolValue.toString(),
        officialTokenPrice: officialTokenPrice.toString()
      }
    });

    // Keep onchain valuation inputs in sync with offchain calculations.
    // This makes ERC4626 conversions use the same "official token price" basis.
    if (env.RPC_URL) {
      try {
        const vault = await getVaultContract(env, undefined, { clubName: pool.clubName, vaultAddress: pool.vaultAddress ?? undefined });
        await (vault as any).setPoolValuation(positionsValue.toString(), realizedPnl.toString());
      } catch {
        // Optional: onchain valuation update failure should not block price recalculation.
      }
    }
  }
}

