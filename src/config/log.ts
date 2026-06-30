import pino from "pino";

export type SerializedError = {
  name?: string;
  message: string;
  stack?: string;
  cause?: SerializedError | unknown;
  [key: string]: unknown;
};

export function serializeError(err: unknown): SerializedError | unknown {
  if (err instanceof Error) {
    return {
      ...Object.fromEntries(Object.entries(err)),
      name: err.name,
      message: err.message,
      stack: err.stack,
      cause: err.cause ? serializeError(err.cause) : undefined,
    };
  }
  if (err && typeof err === "object") return err;
  return { message: String(err) };
}

export function createLogger() {
  return pino({ level: process.env.LOG_LEVEL || "info" });
}
