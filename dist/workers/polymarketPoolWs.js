"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startPolymarketPoolWs = startPolymarketPoolWs;
const ws_1 = __importDefault(require("ws"));
const prisma_1 = require("../db/prisma");
const accountingService_1 = require("../polymarket/accountingService");
const poolClobClient_1 = require("../polymarket/poolClobClient");
function eventType(raw) {
    const text = raw.toString().trim();
    if (!text || ["PING", "PONG", '"PING"', '"PONG"'].includes(text.toUpperCase()))
        return null;
    try {
        const parsed = JSON.parse(text);
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        return rows.some((row) => ["order", "trade"].includes(String(row?.event_type ?? "").toLowerCase()))
            ? "user-event"
            : null;
    }
    catch {
        return null;
    }
}
function startPolymarketPoolWs(env, logger) {
    const connections = new Map();
    let discoveryTimer;
    let heartbeatTimer;
    const scheduleReconcile = (connection) => {
        if (connection.reconcileTimer)
            return;
        connection.reconcileTimer = setTimeout(() => {
            connection.reconcileTimer = undefined;
            void (0, accountingService_1.reconcilePoolPolymarket)(env, connection.poolId).catch((error) => logger.error({ poolId: connection.poolId, err: error }, "Pool WS reconciliation failed"));
        }, 750);
    };
    const scheduleReconnect = (connection) => {
        if (connection.stopped || connection.reconnectTimer)
            return;
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(connection.reconnectAttempt, 5))
            + Math.floor(Math.random() * 500);
        connection.reconnectAttempt += 1;
        connection.reconnectTimer = setTimeout(() => {
            connection.reconnectTimer = undefined;
            if (!connection.stopped)
                void connect(connection);
        }, delay);
    };
    const connect = async (connection) => {
        const account = await prisma_1.prisma.pool_polymarket_accounts.findUnique({ where: { poolId: connection.poolId } });
        if (!account || account.status !== "READY" || connection.stopped)
            return;
        const markets = await prisma_1.prisma.pool_selected_markets.findMany({
            where: { poolId: connection.poolId, enabled: true },
            select: { conditionId: true },
        });
        const credentials = (0, poolClobClient_1.readPoolClobCredentials)(env, account);
        const socket = new ws_1.default(env.POLYMARKET_USER_WS_URL);
        connection.socket = socket;
        socket.on("open", () => {
            connection.reconnectAttempt = 0;
            socket.send(JSON.stringify({
                auth: {
                    apiKey: credentials.key,
                    secret: credentials.secret,
                    passphrase: credentials.passphrase,
                },
                ...(markets.length ? { markets: markets.map((market) => market.conditionId) } : {}),
                type: "user",
            }));
            logger.info({ poolId: connection.poolId, markets: markets.length }, "Polymarket pool user WS connected");
        });
        socket.on("message", (raw) => {
            if (eventType(raw))
                scheduleReconcile(connection);
        });
        socket.on("error", (error) => {
            logger.warn({ poolId: connection.poolId, err: error }, "Polymarket pool user WS error");
            socket.close();
        });
        socket.on("close", (code, reason) => {
            if (connection.socket === socket)
                connection.socket = null;
            if (!connection.stopped) {
                logger.warn({ poolId: connection.poolId, code, reason: reason.toString().slice(0, 120) }, "Polymarket pool user WS closed");
                scheduleReconnect(connection);
            }
        });
    };
    const discover = async () => {
        const accounts = await prisma_1.prisma.pool_polymarket_accounts.findMany({
            where: { status: "READY" },
            select: { poolId: true, credentialsVersion: true, updatedAt: true },
        });
        const desired = new Set(accounts.map((account) => account.poolId));
        for (const account of accounts) {
            const fingerprint = `${account.credentialsVersion}:${account.updatedAt.toISOString()}`;
            const current = connections.get(account.poolId);
            if (current?.fingerprint === fingerprint)
                continue;
            if (current) {
                current.stopped = true;
                current.socket?.close(1000, "credentials_updated");
            }
            const connection = {
                poolId: account.poolId,
                fingerprint,
                socket: null,
                reconnectAttempt: 0,
                stopped: false,
            };
            connections.set(account.poolId, connection);
            void connect(connection);
        }
        for (const [poolId, connection] of connections) {
            if (desired.has(poolId))
                continue;
            connection.stopped = true;
            connection.socket?.close(1000, "account_disabled");
            connections.delete(poolId);
        }
    };
    void discover().catch((error) => logger.error({ err: error }, "Pool WS account discovery failed"));
    discoveryTimer = setInterval(() => void discover().catch((error) => logger.error({ err: error }, "Pool WS account discovery failed")), 10_000);
    heartbeatTimer = setInterval(() => {
        for (const connection of connections.values()) {
            if (connection.socket?.readyState === ws_1.default.OPEN)
                connection.socket.send("PING");
        }
    }, 10_000);
    return () => {
        if (discoveryTimer)
            clearInterval(discoveryTimer);
        if (heartbeatTimer)
            clearInterval(heartbeatTimer);
        for (const connection of connections.values()) {
            connection.stopped = true;
            if (connection.reconnectTimer)
                clearTimeout(connection.reconnectTimer);
            if (connection.reconcileTimer)
                clearTimeout(connection.reconcileTimer);
            connection.socket?.close(1000, "shutdown");
        }
    };
}
