"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeCursorWorkerId = makeCursorWorkerId;
exports.cursorBlockNumber = cursorBlockNumber;
exports.claimChainEventCursor = claimChainEventCursor;
exports.completeChainEventCursor = completeChainEventCursor;
exports.failChainEventCursor = failChainEventCursor;
const prisma_1 = require("../db/prisma");
function chainEventCursorsModel() {
    return prisma_1.prisma.chain_event_cursors;
}
function lockStaleBefore() {
    const raw = process.env.CHAIN_EVENT_CURSOR_LOCK_STALE_MS;
    const ms = raw ? Number(raw) : 120_000;
    const safeMs = Number.isFinite(ms) && ms > 0 ? ms : 120_000;
    return new Date(Date.now() - safeMs);
}
function truncateError(err) {
    const e = err;
    const message = e?.message ?? e?.shortMessage ?? String(err);
    return String(message).slice(0, 500);
}
function makeCursorWorkerId(prefix) {
    return `${prefix}:${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}
function cursorBlockNumber(cursor) {
    const value = cursor.lastProcessedBlock;
    const n = typeof value === "bigint" ? Number(value) : Number(value ?? 0);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}
async function claimChainEventCursor(identity, workerId) {
    const now = new Date();
    await chainEventCursorsModel().upsert({
        where: { key: identity.key },
        create: {
            key: identity.key,
            chain: identity.chain,
            contractAddress: identity.contractAddress.toLowerCase(),
            eventName: identity.eventName,
            lastProcessedBlock: BigInt(Math.max(0, Math.floor(identity.startBlock)))
        },
        update: {
            chain: identity.chain,
            contractAddress: identity.contractAddress.toLowerCase(),
            eventName: identity.eventName
        }
    });
    const result = await chainEventCursorsModel().updateMany({
        where: {
            key: identity.key,
            AND: [
                {
                    OR: [
                        { cooldownUntil: null },
                        { cooldownUntil: { lte: now } }
                    ]
                },
                {
                    OR: [
                        { lockedAt: null },
                        { lockedAt: { lt: lockStaleBefore() } }
                    ]
                }
            ]
        },
        data: {
            lockedAt: now,
            lockedBy: workerId
        }
    });
    if (result.count !== 1)
        return null;
    return chainEventCursorsModel().findUnique({ where: { key: identity.key } });
}
async function completeChainEventCursor(params) {
    return chainEventCursorsModel().updateMany({
        where: { key: params.key, lockedBy: params.workerId },
        data: {
            lastProcessedBlock: BigInt(Math.max(0, Math.floor(params.lastProcessedBlock))),
            lockedAt: null,
            lockedBy: null,
            cooldownUntil: null,
            lastError: null
        }
    });
}
async function failChainEventCursor(params) {
    return chainEventCursorsModel().updateMany({
        where: { key: params.key, lockedBy: params.workerId },
        data: {
            lockedAt: null,
            lockedBy: null,
            cooldownUntil: params.cooldownUntil ?? null,
            lastError: truncateError(params.err)
        }
    });
}
