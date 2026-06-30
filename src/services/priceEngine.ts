import type { Env } from "../config/env";
import { prisma } from "../db/prisma";
import { withBaseRpcRetry } from "../onchain/rpc";
import { isRpcRateLimitError } from "../onchain/ethersLogChunks";
import { getVaultContract } from "../onchain/vaultExecutor";
import { parseUnits } from "ethers";

function decToNumber(d: any): number {
  // Prisma Decimal -> string
  if (typeof d === "number") return d;
  if (typeof d === "string") return Number(d);
  if (d && typeof d.toString === "function") return Number(d.toString());
  return 0;
}

function dbStr(raw: any): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw.trim();
  if (typeof raw === "number") return String(raw);
  if (raw && typeof raw.toString === "function") return String(raw).trim();
  return "";
}

/** `club_pools.cash`: new rows are human USD strings; legacy rows may be raw USDC (6dp) integers. */
function vaultCashDbToHuman(cashRaw: any): number {
  const s = dbStr(cashRaw);
  if (!s || s === "0") return 0;
  if (s.includes(".") || /[eE]/i.test(s)) return Number(s);
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (/^\d+$/.test(s)) return n / 1e6;
  return n;
}

function humanUsdToUsdcBaseUnits(h: number): bigint {
  if (!Number.isFinite(h) || h <= 0) return 0n;
  return parseUnits(h.toFixed(6), 6);
}

/** Must match `USDC4626Vault.decimals()` — raw `totalSupply()` is in these base units. */
const VAULT_SHARE_DECIMALS = 6;

/**
 * Last time we pushed NAV on-chain per pool (epoch ms). In-memory: on restart the
 * first cycle re-pushes for every pool, which is the desired resync-after-downtime.
 */
const lastOnchainNavPushAt = new Map<string, number>();

/** Last NAV values (USDC base units) actually pushed on-chain per pool, to skip no-op writes. */
const lastOnchainNavValue = new Map<string, { pos: bigint; pnl: bigint }>();

/** Min delay between on-chain `setPoolValuation` writes per pool (default 1h). */
function onchainNavPushIntervalMs(env: Env): number {
  const n = Number((env as any).ONCHAIN_NAV_PUSH_INTERVAL_MS);
  return Number.isFinite(n) && n > 0 ? n : 3_600_000;
}

function onchainNavPushEnabled(env: Env): boolean {
  const raw = String((env as any).ONCHAIN_NAV_PUSH_ENABLED ?? "true").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

export async function recalculateOfficialPrices(env: Env) {
  const pools = await prisma.club_pools.findMany({ where: { status: "ACTIVE" } });

  for (const pool of pools) {
    const openPositions = await prisma.club_pool_positions.findMany({
      where: { poolId: pool.id, status: "OPEN" }
    });

    let positionsValue = 0;
    for (const pos of openPositions) {
      // `currentValue` is the marked-to-market value maintained by
      // `syncLimitlessFillsAndSettle` (Limitless mid-price × matched quantity),
      // which runs immediately before this recalc in the price ticker. We treat it
      // as the single source of truth instead of re-fetching mid-prices here.
      positionsValue += decToNumber(pos.currentValue);
    }

    const cashHuman = vaultCashDbToHuman(pool.cash);
    const realizedPnl = decToNumber(pool.realizedPnl);
    const totalPoolValue = cashHuman + positionsValue + realizedPnl;
    const totalSupplyRaw = decToNumber(pool.totalTokenSupply);
    const sharesHuman = totalSupplyRaw / 10 ** VAULT_SHARE_DECIMALS;

    // USD (or pool accounting unit) per **1.0** vault share — not per raw 1e-6 share unit.
    const officialTokenPrice = sharesHuman > 0 ? totalPoolValue / sharesHuman : 0;

    await prisma.club_pools.update({
      where: { id: pool.id },
      data: {
        cash: String(cashHuman),
        openPositionsValue: positionsValue.toString(),
        totalPoolValue: totalPoolValue.toString(),
        officialTokenPrice: officialTokenPrice.toString()
      }
    });

    await prisma.club_pool_price_snapshots.create({
      data: {
        poolId: pool.id,
        cash: String(cashHuman),
        positionsValue: positionsValue.toString(),
        realizedPnl: pool.realizedPnl,
        totalPoolValue: totalPoolValue.toString(),
        officialTokenPrice: officialTokenPrice.toString()
      }
    });

    // Keep onchain valuation inputs in sync with offchain calculations so ERC4626
    // conversions use the same "official token price" basis. The DB (above) is refreshed
    // every cycle (real-time); the on-chain `setPoolValuation` write is throttled to
    // ONCHAIN_NAV_PUSH_INTERVAL_MS (default 1h) per pool to bound gas spend. The vault
    // lives on Base and `getVaultContract` returns a contract bound to the Base executor
    // signer. Pools are processed sequentially, so nonces from the shared executor wallet
    // don't collide (each `tx.wait()` mines before the next pool).
    // Compute the on-chain valuation inputs up front so we can skip the write when the
    // value hasn't changed since the last push (no-op pushes just waste gas).
    const posBase = humanUsdToUsdcBaseUnits(positionsValue);
    // realizedPnl is `int256` onchain — preserve sign so losses are reflected in NAV.
    const rPnLBase = realizedPnl >= 0
      ? humanUsdToUsdcBaseUnits(realizedPnl)
      : -humanUsdToUsdcBaseUnits(-realizedPnl);

    const lastPushed = lastOnchainNavValue.get(pool.id);
    const navChanged = !lastPushed || lastPushed.pos !== posBase || lastPushed.pnl !== rPnLBase;
    const navPushDue =
      Date.now() - (lastOnchainNavPushAt.get(pool.id) ?? 0) >= onchainNavPushIntervalMs(env);

    if (onchainNavPushEnabled(env) && env.BASE_EXECUTOR_PRIVATE_KEY && navPushDue && navChanged) {
      try {
        await withBaseRpcRetry(env, async (provider) => {
          const vault = await getVaultContract(env, provider, {
            clubName: pool.clubName,
            vaultAddress: pool.vaultAddress ?? undefined
          });
          const tx = await (vault as any).setPoolValuation(posBase.toString(), rPnLBase.toString());
          try {
            await tx.wait(); // serialize when the RPC can confirm the tx
          } catch (err) {
            if (!isRpcRateLimitError(err)) throw err;
          }
        }, { maxRetriesPerUrl: 1 });
        // Only record on success so failures retry on the next cycle.
        lastOnchainNavPushAt.set(pool.id, Date.now());
        lastOnchainNavValue.set(pool.id, { pos: posBase, pnl: rPnLBase });
      } catch {
        // Onchain valuation update failure shouldn't block price recalculation.
      }
    }
  }
}
