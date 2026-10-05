import WebSocket from "ws";
import type { Env } from "../config/env";
import type { createLogger } from "../config/log";
import { prisma } from "../db/prisma";

type Logger = ReturnType<typeof createLogger>;
type Quote = { tokenId: string; conditionId?: string; bestBid: number | null; bestAsk: number | null };

function price(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null;
}

export function parseMarketQuotes(payload: unknown): Quote[] {
  const messages = Array.isArray(payload) ? payload : [payload];
  const quotes: Quote[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const event = message as Record<string, unknown>;
    const kind = String(event.event_type ?? event.type ?? "");
    const body = (event.payload && typeof event.payload === "object" ? event.payload : event) as Record<string, unknown>;
    const conditionId = String(body.market ?? "") || undefined;
    if (kind === "book") {
      const bids = Array.isArray(body.bids) ? body.bids : [];
      const asks = Array.isArray(body.asks) ? body.asks : [];
      const bidPrices = bids.map((row: any) => price(row?.price)).filter((n): n is number => n !== null);
      const askPrices = asks.map((row: any) => price(row?.price)).filter((n): n is number => n !== null);
      quotes.push({
        tokenId: String(body.asset_id ?? body.tokenId ?? ""),
        conditionId,
        bestBid: bidPrices.length ? Math.max(...bidPrices) : null,
        bestAsk: askPrices.length ? Math.min(...askPrices) : null,
      });
    } else if (kind === "price_change" || kind === "best_bid_ask") {
      const changes = kind === "price_change"
        ? (body.price_changes ?? body.priceChanges)
        : [body];
      if (!Array.isArray(changes)) continue;
      for (const raw of changes) {
        if (!raw || typeof raw !== "object") continue;
        const row = raw as Record<string, unknown>;
        quotes.push({
          tokenId: String(row.asset_id ?? row.tokenId ?? ""),
          conditionId,
          bestBid: price(row.best_bid ?? row.bestBid),
          bestAsk: price(row.best_ask ?? row.bestAsk),
        });
      }
    }
  }
  return quotes.filter((quote) => quote.tokenId &&
    (quote.bestBid !== null || quote.bestAsk !== null) &&
    (quote.bestBid === null || quote.bestAsk === null || quote.bestBid <= quote.bestAsk));
}

export function startPolymarketMarketWs(env: Env, logger: Logger) {
  let socket: WebSocket | null = null;
  let subscription = "";
  let reconnectAttempt = 0;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let stopped = false;
  let flushing = false;
  const pending = new Map<string, Quote & { observedAt: Date }>();

  const flush = async () => {
    if (flushing || pending.size === 0) return;
    flushing = true;
    const batch = [...pending.entries()].slice(0, 100);
    for (const [tokenId] of batch) pending.delete(tokenId);
    try {
      await Promise.all(batch.map(async ([tokenId, quote]) => {
        try {
          await prisma.polymarket_market_quotes.upsert({
            where: { tokenId },
            create: { ...quote, source: "POLYMARKET_WS" },
            update: {
              conditionId: quote.conditionId,
              ...(quote.bestBid !== null ? { bestBid: quote.bestBid } : {}),
              ...(quote.bestAsk !== null ? { bestAsk: quote.bestAsk } : {}),
              source: "POLYMARKET_WS",
              observedAt: quote.observedAt,
            },
          });
        } catch (err) { logger.error({ err, tokenId }, "Market quote write failed"); }
      }));
    } finally { flushing = false; }
  };

  const connect = async () => {
    if (stopped || socket) return;
    const [markets, positions] = await Promise.all([
      prisma.pool_selected_markets.findMany({ where: { enabled: true }, select: { tokenId: true } }),
      prisma.pool_polymarket_positions.findMany({ where: { status: "OPEN" }, select: { tokenId: true } }),
    ]);
    const tokenIds = [...new Set([...markets, ...positions].map((row) => row.tokenId))].sort();
    const nextSubscription = tokenIds.join(",");
    if (!tokenIds.length) { subscription = ""; return; }
    subscription = nextSubscription;
    const subscribed = new Set(tokenIds);
    const ws = new WebSocket(env.POLYMARKET_MARKET_WS_URL);
    socket = ws;
    ws.on("open", () => {
      reconnectAttempt = 0;
      ws.send(JSON.stringify({ assets_ids: tokenIds, type: "market", custom_feature_enabled: true }));
      logger.info({ tokens: tokenIds.length }, "Polymarket market price stream connected");
    });
    ws.on("message", (raw) => {
      let payload: unknown;
      try { payload = JSON.parse(raw.toString()); } catch { return; }
      for (const quote of parseMarketQuotes(payload)) {
        if (!subscribed.has(quote.tokenId)) continue;
        const previous = pending.get(quote.tokenId);
        pending.set(quote.tokenId, {
          tokenId: quote.tokenId,
          conditionId: quote.conditionId ?? previous?.conditionId,
          bestBid: quote.bestBid ?? previous?.bestBid ?? null,
          bestAsk: quote.bestAsk ?? previous?.bestAsk ?? null,
          observedAt: new Date(),
        });
      }
    });
    ws.on("error", (err) => { logger.warn({ err }, "Polymarket market stream error"); ws.close(); });
    ws.on("close", () => {
      if (socket === ws) socket = null;
      if (!stopped && !reconnectTimer) {
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempt++, 5));
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined;
          void connect().catch((err) => logger.error({ err }, "Market stream reconnect failed"));
        }, delay);
      }
    });
  };

  void connect().catch((err) => logger.error({ err }, "Market stream startup failed"));
  const discoveryTimer = setInterval(() => {
    void (async () => {
      const [markets, positions] = await Promise.all([
        prisma.pool_selected_markets.findMany({ where: { enabled: true }, select: { tokenId: true } }),
        prisma.pool_polymarket_positions.findMany({ where: { status: "OPEN" }, select: { tokenId: true } }),
      ]);
      const desired = [...new Set([...markets, ...positions].map((row) => row.tokenId))].sort().join(",");
      if (desired !== subscription) {
        socket?.close(1000, "subscriptions_changed");
        socket = null;
        void connect();
      }
    })().catch((err) => logger.error({ err }, "Market stream discovery failed"));
  }, 30_000);
  const heartbeatTimer = setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN) socket.send("PING");
  }, 10_000);
  const flushTimer = setInterval(() => void flush(), 1_000);
  return () => {
    stopped = true;
    clearInterval(discoveryTimer);
    clearInterval(heartbeatTimer);
    clearInterval(flushTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close(1000, "shutdown");
  };
}
