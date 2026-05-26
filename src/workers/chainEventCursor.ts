import { prisma } from "../db/prisma";

type CursorIdentity = {
  key: string;
  chain: string;
  contractAddress: string;
  eventName: string;
  startBlock: number;
};

type CursorRow = {
  key: string;
  lastProcessedBlock: bigint | number | string;
};

function chainEventCursorsModel() {
  return (prisma as any).chain_event_cursors;
}

function lockStaleBefore() {
  const raw = process.env.CHAIN_EVENT_CURSOR_LOCK_STALE_MS;
  const ms = raw ? Number(raw) : 120_000;
  const safeMs = Number.isFinite(ms) && ms > 0 ? ms : 120_000;
  return new Date(Date.now() - safeMs);
}

function truncateError(err: unknown): string {
  const e = err as any;
  const message = e?.message ?? e?.shortMessage ?? String(err);
  return String(message).slice(0, 500);
}

export function makeCursorWorkerId(prefix: string) {
  return `${prefix}:${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

export function cursorBlockNumber(cursor: CursorRow): number {
  const value = cursor.lastProcessedBlock;
  const n = typeof value === "bigint" ? Number(value) : Number(value ?? 0);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export async function claimChainEventCursor(identity: CursorIdentity, workerId: string) {
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

  if (result.count !== 1) return null;
  return chainEventCursorsModel().findUnique({ where: { key: identity.key } });
}

export async function completeChainEventCursor(params: {
  key: string;
  workerId: string;
  lastProcessedBlock: number;
}) {
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

export async function failChainEventCursor(params: {
  key: string;
  workerId: string;
  err: unknown;
  cooldownUntil?: Date | null;
}) {
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
