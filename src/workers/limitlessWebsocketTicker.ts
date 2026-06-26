import { io, type Socket } from "socket.io-client";
import type { Env } from "../config/env";
import { prisma } from "../db/prisma";
import {
  hasLimitlessHmacConfig,
  limitlessWebsocketAuthHeaders,
  limitlessWsBase,
} from "../limitless/limitlessAuth";
import {
  applyNormalizedPortfolioPositions,
  humanOrBase6,
  syncLimitlessPortfolioForPool,
  type NormalizedPortfolioPosition,
} from "../limitless/limitlessPortfolio";
import { recalculateOfficialPrices } from "../services/priceEngine";

type Logger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

type JsonRecord = Record<string, unknown>;

type PoolContext = {
  poolId: string;
  profileId: string | null;
  accountAddress: string | null;
};

type WsContext = {
  pools: PoolContext[];
  marketSlugs: string[];
  poolByAccount: Map<string, PoolContext>;
  poolIdsByMarketSlug: Map<string, string[]>;
};

function num(value: unknown, fallback = 0) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function isFinancialSettlementEvent(raw: unknown): boolean {
  const event = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as JsonRecord : {};
  return event.source === "SETTLEMENT" && event.type === "MINED";
}

export function isIgnoredProvisionalEvent(raw: unknown): boolean {
  const event = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as JsonRecord : {};
  return event.source === "SETTLEMENT" && event.type === "MATCHED";
}

export function orderEventFinancialAction(raw: unknown): "apply" | "failed" | "ignore" {
  const event = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as JsonRecord : {};
  if (event.source !== "SETTLEMENT") return "ignore";
  if (event.type === "MINED") return "apply";
  if (event.type === "FAILED") return "failed";
  return "ignore";
}

async function loadWsContext(): Promise<WsContext> {
  const pools = await (prisma as any).pool_limitless_accounts.findMany({
    where: {
      pool: { status: "ACTIVE" },
      OR: [{ limitlessProfileId: { not: null } }, { accountAddress: { not: null } }],
    },
    select: { poolId: true, limitlessProfileId: true, accountAddress: true },
  }) as PoolContext[];

  const poolIds = pools.map((pool) => pool.poolId);
  const openPositions = poolIds.length
    ? await prisma.club_pool_positions.findMany({
        where: { poolId: { in: poolIds }, status: "OPEN", tokenId: { contains: ":" } },
        select: { poolId: true, marketId: true },
      })
    : [];

  const poolByAccount = new Map<string, PoolContext>();
  for (const pool of pools) {
    if (pool.accountAddress) poolByAccount.set(pool.accountAddress.toLowerCase(), pool);
  }

  const poolIdsByMarketSlug = new Map<string, string[]>();
  for (const pos of openPositions) {
    const marketSlug = pos.marketId;
    const current = poolIdsByMarketSlug.get(marketSlug) ?? [];
    if (!current.includes(pos.poolId)) current.push(pos.poolId);
    poolIdsByMarketSlug.set(marketSlug, current);
  }

  return {
    pools,
    marketSlugs: [...poolIdsByMarketSlug.keys()],
    poolByAccount,
    poolIdsByMarketSlug,
  };
}

function subscribe(socket: Socket, context: WsContext, logger: Logger) {
  socket.emit("subscribe_order_events");
  socket.emit("subscribe_market_lifecycle");
  if (context.marketSlugs.length) {
    socket.emit("subscribe_positions", { marketSlugs: context.marketSlugs });
    socket.emit("subscribe_market_prices", { marketSlugs: context.marketSlugs });
  }
  logger.info(
    { pools: context.pools.length, marketSlugs: context.marketSlugs.length },
    "Limitless websocket subscriptions sent"
  );
}

async function syncPools(env: Env, logger: Logger, poolIds: string[]) {
  for (const poolId of [...new Set(poolIds)]) {
    try {
      await syncLimitlessPortfolioForPool(env, poolId);
    } catch (err) {
      logger.warn({ err, poolId }, "Limitless REST reconciliation failed");
    }
  }
  try {
    await recalculateOfficialPrices(env);
  } catch (err) {
    logger.warn({ err }, "Limitless websocket NAV recalculation failed");
  }
}

async function resolveOutcomeIndexForToken(marketSlug: string, tokenId: string | null): Promise<number | null> {
  if (!tokenId) return null;
  const market = await (prisma as any).limitless_markets.findUnique({
    where: { id: marketSlug },
    select: { rawJson: true },
  });
  const raw = market?.rawJson && typeof market.rawJson === "object" ? market.rawJson as JsonRecord : {};
  const tokens = raw.tokens && typeof raw.tokens === "object" && !Array.isArray(raw.tokens)
    ? raw.tokens as JsonRecord
    : {};
  if (String(tokens.yes ?? "") === tokenId) return 0;
  if (String(tokens.no ?? "") === tokenId) return 1;
  const positionIds = Array.isArray(raw.position_ids) ? raw.position_ids.map(String) : [];
  const idx = positionIds.indexOf(tokenId);
  return idx === 0 || idx === 1 ? idx : null;
}

async function poolIdForEvent(context: WsContext, event: JsonRecord): Promise<string | null> {
  const orderId = str(event.orderId);
  if (orderId) {
    const pos = await prisma.club_pool_positions.findFirst({
      where: { clobOrderId: orderId },
      select: { poolId: true },
    });
    if (pos?.poolId) return pos.poolId;
  }

  const account = str(event.account) ?? str(event.takerAccount);
  if (account) {
    const byAccount = context.poolByAccount.get(account.toLowerCase());
    if (byAccount) return byAccount.poolId;
  }

  const marketSlug = str(event.marketSlug);
  if (marketSlug) {
    const poolIds = context.poolIdsByMarketSlug.get(marketSlug) ?? [];
    if (poolIds.length === 1) return poolIds[0];
  }
  return null;
}

async function handlePositionEvent(env: Env, context: WsContext, logger: Logger, raw: unknown) {
  const event = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as JsonRecord : {};
  if (event.type !== "CLOB") return;
  const marketSlug = str(event.marketSlug);
  if (!marketSlug) return;

  const account = str(event.account);
  const pool = account ? context.poolByAccount.get(account.toLowerCase()) : null;
  const poolIds = pool ? [pool.poolId] : context.poolIdsByMarketSlug.get(marketSlug) ?? [];
  if (poolIds.length !== 1) return;

  const normalized: NormalizedPortfolioPosition[] = [];
  for (const payload of Array.isArray(event.positions) ? event.positions : []) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    const row = payload as JsonRecord;
    const tokenId = str(row.tokenId);
    const outcomeIndex = row.outcomeIndex == null
      ? await resolveOutcomeIndexForToken(marketSlug, tokenId)
      : Math.trunc(num(row.outcomeIndex));
    const cost = humanOrBase6(row.costBasis);
    const marketValue = humanOrBase6(row.marketValue);
    normalized.push({
      marketSlug,
      marketId: marketSlug,
      outcome: outcomeIndex === 0 ? "yes" : outcomeIndex === 1 ? "no" : null,
      outcomeIndex,
      tokenId,
      quantity: humanOrBase6(row.ctfBalance ?? row.balance),
      cost,
      marketValue,
      unrealizedPnl: marketValue - cost,
      realizedPnl: 0,
      raw: row,
    });
  }

  if (!normalized.length) return;
  await applyNormalizedPortfolioPositions(poolIds[0], normalized);
  await syncPools(env, logger, poolIds);
}

async function upsertWsTrade(poolId: string, accountId: string | null, event: JsonRecord) {
  const externalTradeId =
    str(event.tradeEventId) ??
    str(event.eventId) ??
    str(event.orderId) ??
    `${poolId}:${JSON.stringify(event).slice(0, 120)}`;

  await (prisma as any).pool_limitless_trades.upsert({
    where: {
      pool_limitless_trades_poolId_externalTradeId_key: {
        poolId,
        externalTradeId,
      },
    },
    update: { rawJson: event as any },
    create: {
      poolId,
      accountId,
      externalTradeId,
      marketId: str(event.marketSlug) ?? str(event.marketId),
      side: str(event.side),
      price: event.price == null ? undefined : num(event.price).toString(),
      size: event.amountContracts == null ? undefined : num(event.amountContracts).toString(),
      fee: (event.feeAmountCollateral ?? event.feeAmountContracts) == null
        ? undefined
        : num(event.feeAmountCollateral ?? event.feeAmountContracts).toString(),
      executedAt: str(event.timestamp) ? new Date(String(event.timestamp)) : undefined,
      rawJson: event as any,
    },
  });
}

async function handleOrderEvent(env: Env, context: WsContext, logger: Logger, raw: unknown) {
  const event = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as JsonRecord : {};
  if (isIgnoredProvisionalEvent(event) || event.source !== "SETTLEMENT") return;

  const poolId = await poolIdForEvent(context, event);
  if (!poolId) return;
  const account = await (prisma as any).pool_limitless_accounts.findUnique({ where: { poolId } });
  await upsertWsTrade(poolId, account?.limitlessProfileId ?? account?.accountAddress ?? null, event);

  if (event.type === "FAILED") {
    logger.warn({ poolId, eventId: event.eventId, orderId: event.orderId }, "Limitless settlement failed");
    return;
  }
  if (!isFinancialSettlementEvent(event)) return;

  const orderId = str(event.orderId);
  const marketSlug = str(event.marketSlug);
  const tokenOutcome = String(event.token ?? "").toUpperCase();
  const outcome = tokenOutcome === "YES" ? "yes" : tokenOutcome === "NO" ? "no" : null;
  const amountCollateral = num(event.amountCollateral);
  const amountContracts = num(event.amountContracts);
  const price = num(event.price);

  const local = await prisma.club_pool_positions.findFirst({
    where: {
      poolId,
      status: "OPEN",
      OR: [
        ...(orderId ? [{ clobOrderId: orderId }] : []),
        ...(marketSlug ? [{
          marketId: marketSlug,
          ...(outcome ? { side: outcome === "yes" ? "YES" as const : "NO" as const } : {}),
        }] : []),
      ],
    },
  });

  if (local) {
    const previousInvested = num((local as any).investedAmount?.toString?.() ?? local.investedAmount);
    const nextInvested = Math.max(previousInvested, amountCollateral || previousInvested);
    const currentValue = amountContracts > 0 && price > 0 ? amountContracts * price : num((local as any).currentValue?.toString?.() ?? local.currentValue);
    await prisma.$transaction(async (tx) => {
      const deltaInvested = nextInvested - previousInvested;
      if (deltaInvested > 0) {
        await tx.club_pools.update({ where: { id: poolId }, data: { cash: { decrement: deltaInvested.toString() } } });
      }
      await tx.club_pool_positions.update({
        where: { id: local.id },
        data: {
          quantity: amountContracts > 0 ? amountContracts.toString() : local.quantity,
          stake: nextInvested.toString(),
          investedAmount: nextInvested.toString(),
          currentValue: currentValue.toString(),
        },
      });
    });
  }

  await syncPools(env, logger, [poolId]);
}

async function handleMarketResolved(env: Env, context: WsContext, logger: Logger, raw: unknown) {
  const event = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as JsonRecord : {};
  const slug = str(event.slug);
  if (!slug) return;
  await (prisma as any).limitless_markets.updateMany({
    where: { id: slug },
    data: {
      status: "RESOLVED",
      resolution: str(event.winningOutcome),
    },
  });
  await syncPools(env, logger, context.poolIdsByMarketSlug.get(slug) ?? []);
}

export function startLimitlessWebsocketTicker({ env, logger }: { env: Env; logger: Logger }) {
  if (String((env as any).LIMITLESS_WS_ENABLED ?? "true").toLowerCase() === "false") {
    logger.warn({}, "Limitless websocket disabled");
    return;
  }
  if (!hasLimitlessHmacConfig(env)) {
    logger.warn({}, "Limitless websocket disabled: HMAC credentials missing");
    return;
  }

  const reconcileIntervalMs = Number((env as any).LIMITLESS_WS_RECONCILE_INTERVAL_MS ?? process.env.LIMITLESS_WS_RECONCILE_INTERVAL_MS ?? 10 * 60 * 1000);
  let context: WsContext = { pools: [], marketSlugs: [], poolByAccount: new Map(), poolIdsByMarketSlug: new Map() };
  const socket = io(limitlessWsBase(env), {
    transports: ["websocket"],
    extraHeaders: limitlessWebsocketAuthHeaders(env),
    reconnection: true,
  });

  const refresh = async () => {
    context = await loadWsContext();
    if (socket.connected) subscribe(socket, context, logger);
    return context;
  };

  refresh()
    .then((ctx) => syncPools(env, logger, ctx.pools.map((pool) => pool.poolId)))
    .catch((err) => logger.error({ err }, "Limitless websocket initial sync failed"));

  socket.on("connect", () => {
    refresh().catch((err) => logger.error({ err }, "Limitless websocket subscribe failed"));
  });
  socket.on("disconnect", (reason) => logger.warn({ reason }, "Limitless websocket disconnected"));
  socket.on("connect_error", (err) => logger.error({ err }, "Limitless websocket connect error"));
  socket.on("exception", (err) => logger.error({ err }, "Limitless websocket exception"));
  socket.on("positions", (data) => handlePositionEvent(env, context, logger, data).catch((err) => logger.error({ err }, "Limitless position event failed")));
  socket.on("orderEvent", (data) => handleOrderEvent(env, context, logger, data).catch((err) => logger.error({ err }, "Limitless order event failed")));
  socket.on("marketResolved", (data) => handleMarketResolved(env, context, logger, data).catch((err) => logger.error({ err }, "Limitless market resolution event failed")));
  socket.on("system", (data) => logger.info({ data }, "Limitless websocket system event"));
  socket.on("authenticated", (data) => logger.info({ data }, "Limitless websocket authenticated"));

  setInterval(() => {
    refresh()
      .then((ctx) => syncPools(env, logger, ctx.pools.map((pool) => pool.poolId)))
      .catch((err) => logger.error({ err }, "Limitless websocket fallback sync failed"));
  }, reconcileIntervalMs);

  logger.info({ reconcileIntervalMs }, "Limitless websocket ticker started");
}
