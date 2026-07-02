import { EventEmitter } from "events";
import { Client } from "pg";
import { serializeError } from "../config/log";

type Logger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

export type PoolPositionsChange = {
  poolId: string;
  table?: string;
  op?: string;
  rowId?: string;
  version: number;
};

const CHANNEL = "team_index_pool_positions";
const emitter = new EventEmitter();
emitter.setMaxListeners(500);

let started = false;
let client: Client | null = null;

function normalizeChange(raw: unknown): PoolPositionsChange | null {
  const payload = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const poolId = typeof payload.poolId === "string" && payload.poolId.trim() ? payload.poolId : null;
  if (!poolId) return null;
  return {
    poolId,
    table: typeof payload.table === "string" ? payload.table : undefined,
    op: typeof payload.op === "string" ? payload.op : undefined,
    rowId: typeof payload.rowId === "string" ? payload.rowId : undefined,
    version: Number.isFinite(Number(payload.version)) ? Number(payload.version) : Date.now(),
  };
}

export function publishPoolPositionsChange(change: Omit<PoolPositionsChange, "version"> & { version?: number }) {
  const normalized = normalizeChange({ ...change, version: change.version ?? Date.now() });
  if (!normalized) return;
  emitter.emit(normalized.poolId, normalized);
}

export function subscribePoolPositions(poolId: string, handler: (change: PoolPositionsChange) => void) {
  emitter.on(poolId, handler);
  return () => emitter.off(poolId, handler);
}

export function startPoolPositionsRealtimeListener({
  databaseUrl,
  logger,
}: {
  databaseUrl: string;
  logger: Logger;
}) {
  if (started) return;
  started = true;

  const connect = async () => {
    try {
      client = new Client({ connectionString: databaseUrl });
      client.on("notification", (message) => {
        if (message.channel !== CHANNEL || !message.payload) return;
        try {
          const change = normalizeChange(JSON.parse(message.payload));
          if (change) emitter.emit(change.poolId, change);
        } catch (err) {
          logger.warn({ err: serializeError(err), payload: message.payload }, "pool realtime notification parse failed");
        }
      });
      client.on("error", (err) => {
        logger.error({ err: serializeError(err) }, "pool realtime pg listener error");
      });
      client.on("end", () => {
        client = null;
        setTimeout(connect, 2000).unref();
      });
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      logger.info({ channel: CHANNEL }, "pool realtime listener started");
    } catch (err) {
      logger.error({ err: serializeError(err) }, "pool realtime listener start failed");
      client = null;
      setTimeout(connect, 5000).unref();
    }
  };

  void connect();
}
