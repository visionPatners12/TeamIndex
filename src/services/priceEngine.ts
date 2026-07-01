import type { Env } from "../config/env";
import { prisma } from "../db/prisma";
import { withBaseRpcRetry } from "../onchain/rpc";
import { isRpcRateLimitError } from "../onchain/ethersLogChunks";
import { getErc20Balance, getVaultContract } from "../onchain/vaultExecutor";
import { formatUnits, parseUnits } from "ethers";

export function decToNumber(d: any): number {
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

type PoolForValuation = {
  id: string;
  clubName: string;
  vaultAddress?: string | null;
  cash: any;
  realizedPnl: any;
  totalTokenSupply: any;
};

export type PoolCashBreakdown = {
  vaultCash: number;
  serverWalletCash: number;
  totalCash: number;
  readVaultCash: boolean;
  readServerWalletCash: boolean;
  vaultCashSource: "onchain" | "db" | "db-derived";
  serverWalletAddress: string | null;
  serverWalletProfileId: string | null;
  serverWalletStatus: string | null;
  allowanceStatus: string | null;
};

export type PoolValuationInputs = {
  vaultCash: number;
  serverWalletCash: number;
  openPositionsValue: number;
  realizedPnl: number;
  totalTokenSupplyRaw: number;
};

export type PoolValuation = PoolValuationInputs & {
  cash: number;
  syntheticOnchainPositionsValue: number;
  totalPoolValue: number;
  totalSupplyHuman: number;
  officialTokenPrice: number;
};

export function calculatePoolValuation(inputs: PoolValuationInputs): PoolValuation {
  const vaultCash = Number.isFinite(inputs.vaultCash) && inputs.vaultCash > 0 ? inputs.vaultCash : 0;
  const serverWalletCash =
    Number.isFinite(inputs.serverWalletCash) && inputs.serverWalletCash > 0 ? inputs.serverWalletCash : 0;
  const openPositionsValue =
    Number.isFinite(inputs.openPositionsValue) && inputs.openPositionsValue > 0 ? inputs.openPositionsValue : 0;
  const realizedPnl = Number.isFinite(inputs.realizedPnl) ? inputs.realizedPnl : 0;
  const totalTokenSupplyRaw =
    Number.isFinite(inputs.totalTokenSupplyRaw) && inputs.totalTokenSupplyRaw > 0 ? inputs.totalTokenSupplyRaw : 0;
  const cash = vaultCash + serverWalletCash;
  const syntheticOnchainPositionsValue = serverWalletCash + openPositionsValue;
  const totalPoolValue = cash + openPositionsValue + realizedPnl;
  const totalSupplyHuman = totalTokenSupplyRaw / 10 ** VAULT_SHARE_DECIMALS;
  const officialTokenPrice = totalSupplyHuman > 0 ? totalPoolValue / totalSupplyHuman : 0;

  return {
    vaultCash,
    serverWalletCash,
    openPositionsValue,
    realizedPnl,
    totalTokenSupplyRaw,
    cash,
    syntheticOnchainPositionsValue,
    totalPoolValue,
    totalSupplyHuman,
    officialTokenPrice
  };
}

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

async function readPoolCashBreakdown(env: Env, pool: PoolForValuation) {
  let vaultCash = vaultCashDbToHuman(pool.cash);
  let readVaultCash = false;

  try {
    const vaultCashRaw = await withBaseRpcRetry(
      env,
      async (provider) => {
        const vault = await getVaultContract(env, provider, {
          clubName: pool.clubName,
          vaultAddress: pool.vaultAddress ?? undefined
        });
        return (await (vault as any).totalCash()) as bigint;
      },
      { maxRetriesPerUrl: 1 }
    );
    vaultCash = Number(formatUnits(vaultCashRaw, 6));
    readVaultCash = true;
  } catch {
    // Fall back to the DB's last idle-cash value. It may already include server
    // wallet cash from a previous canonical recalc, so don't add server cash too.
  }

  let serverWalletCash = 0;
  if (readVaultCash && env.BASE_USDC_ADDRESS) {
    const account = await (prisma as any).pool_limitless_accounts.findUnique({
      where: { poolId: pool.id },
      select: { accountAddress: true }
    });
    const accountAddress = account?.accountAddress ? String(account.accountAddress) : "";
    if (accountAddress) {
      try {
        const serverWalletCashRaw = await getErc20Balance(env, env.BASE_USDC_ADDRESS, accountAddress);
        serverWalletCash = Number(formatUnits(serverWalletCashRaw, 6));
      } catch {
        serverWalletCash = 0;
      }
    }
  }

  return { vaultCash, serverWalletCash, readVaultCash };
}

export async function readPoolBalanceBreakdown(env: Env, pool: PoolForValuation): Promise<PoolCashBreakdown> {
  const dbCash = vaultCashDbToHuman(pool.cash);
  let vaultCash = dbCash;
  let readVaultCash = false;
  let vaultCashSource: PoolCashBreakdown["vaultCashSource"] = "db";

  try {
    const vaultCashRaw = await withBaseRpcRetry(
      env,
      async (provider) => {
        const vault = await getVaultContract(env, provider, {
          clubName: pool.clubName,
          vaultAddress: pool.vaultAddress ?? undefined
        });
        return (await (vault as any).totalCash()) as bigint;
      },
      { maxRetriesPerUrl: 1 }
    );
    vaultCash = Number(formatUnits(vaultCashRaw, 6));
    readVaultCash = true;
    vaultCashSource = "onchain";
  } catch {
    vaultCash = dbCash;
  }

  const account = await (prisma as any).pool_limitless_accounts.findUnique({
    where: { poolId: pool.id },
    select: {
      accountAddress: true,
      limitlessProfileId: true,
      status: true,
      allowanceStatus: true
    }
  });

  const serverWalletAddress = account?.accountAddress ? String(account.accountAddress) : null;
  const serverWalletProfileId = account?.limitlessProfileId ? String(account.limitlessProfileId) : null;
  let serverWalletCash = 0;
  let readServerWalletCash = false;

  if (env.BASE_USDC_ADDRESS && serverWalletAddress) {
    try {
      const serverWalletCashRaw = await getErc20Balance(env, env.BASE_USDC_ADDRESS, serverWalletAddress);
      serverWalletCash = Number(formatUnits(serverWalletCashRaw, 6));
      readServerWalletCash = true;
    } catch {
      serverWalletCash = 0;
    }
  }

  let totalCash = vaultCash;
  if (readVaultCash) {
    totalCash = vaultCash + serverWalletCash;
  } else if (readServerWalletCash) {
    // DB cash is the last aggregate value written by the price engine. If we can
    // still read the server wallet, split that aggregate for UI purposes.
    totalCash = Math.max(dbCash, serverWalletCash);
    vaultCash = Math.max(0, totalCash - serverWalletCash);
    vaultCashSource = "db-derived";
  }

  return {
    vaultCash,
    serverWalletCash,
    totalCash,
    readVaultCash,
    readServerWalletCash,
    vaultCashSource,
    serverWalletAddress,
    serverWalletProfileId,
    serverWalletStatus: account?.status ? String(account.status) : null,
    allowanceStatus: account?.allowanceStatus ? String(account.allowanceStatus) : null
  };
}

export async function recalculateOfficialPriceForPool(
  env: Env,
  poolId: string,
  options?: {
    valuationSnapshot?: {
      source: string;
      rawJson?: unknown;
    };
  }
) {
  const pool = await prisma.club_pools.findUnique({ where: { id: poolId } });
  if (!pool) throw new Error(`Pool not found: ${poolId}`);

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

  const { vaultCash, serverWalletCash, readVaultCash } = await readPoolCashBreakdown(env, pool);
  const valuation = calculatePoolValuation({
    vaultCash,
    serverWalletCash,
    openPositionsValue: positionsValue,
    realizedPnl: decToNumber(pool.realizedPnl),
    totalTokenSupplyRaw: decToNumber(pool.totalTokenSupply)
  });

  await prisma.club_pools.update({
    where: { id: pool.id },
    data: {
      cash: valuation.cash.toString(),
      openPositionsValue: valuation.openPositionsValue.toString(),
      totalPoolValue: valuation.totalPoolValue.toString(),
      officialTokenPrice: valuation.officialTokenPrice.toString()
    }
  });

  await prisma.club_pool_price_snapshots.create({
    data: {
      poolId: pool.id,
      cash: valuation.cash.toString(),
      positionsValue: valuation.openPositionsValue.toString(),
      realizedPnl: valuation.realizedPnl.toString(),
      totalPoolValue: valuation.totalPoolValue.toString(),
      officialTokenPrice: valuation.officialTokenPrice.toString()
    }
  });

  let valuationSnapshot: unknown = null;
  if (options?.valuationSnapshot) {
    valuationSnapshot = await (prisma as any).pool_valuation_snapshots.create({
      data: {
        poolId: pool.id,
        cash: valuation.cash.toString(),
        positionsValue: valuation.openPositionsValue.toString(),
        realizedPnl: valuation.realizedPnl.toString(),
        totalPoolValue: valuation.totalPoolValue.toString(),
        totalTokenSupply: valuation.totalTokenSupplyRaw.toString(),
        officialTokenPrice: valuation.officialTokenPrice.toString(),
        source: options.valuationSnapshot.source,
        rawJson: options.valuationSnapshot.rawJson as any
      }
    });
  }

  // Keep onchain valuation inputs in sync with offchain calculations so ERC4626
  // conversions use the same "official token price" basis. The vault already
  // includes its own `totalCash()`, so only push server-wallet cash plus positions
  // as the synthetic external NAV component.
  const posBase = humanUsdToUsdcBaseUnits(valuation.syntheticOnchainPositionsValue);
  // realizedPnl is `int256` onchain — preserve sign so losses are reflected in NAV.
  const rPnLBase = valuation.realizedPnl >= 0
    ? humanUsdToUsdcBaseUnits(valuation.realizedPnl)
    : -humanUsdToUsdcBaseUnits(-valuation.realizedPnl);

  const lastPushed = lastOnchainNavValue.get(pool.id);
  const navChanged = !lastPushed || lastPushed.pos !== posBase || lastPushed.pnl !== rPnLBase;
  const navPushDue =
    Date.now() - (lastOnchainNavPushAt.get(pool.id) ?? 0) >= onchainNavPushIntervalMs(env);

  if (readVaultCash && onchainNavPushEnabled(env) && env.BASE_EXECUTOR_PRIVATE_KEY && navPushDue && navChanged) {
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

  return { valuation, valuationSnapshot };
}

export async function recalculateOfficialPrices(env: Env) {
  const pools = await prisma.club_pools.findMany({ where: { status: "ACTIVE" }, select: { id: true } });

  for (const pool of pools) {
    await recalculateOfficialPriceForPool(env, pool.id);
  }
}
