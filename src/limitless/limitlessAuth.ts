import { createHmac } from "crypto";
import type { Env } from "../config/env";

export function limitlessBase(env: Env): string {
  return (env as any).LIMITLESS_BASE_URL ?? "https://api.limitless.exchange";
}

export function limitlessWsBase(env: Env): string {
  return (env as any).LIMITLESS_WS_URL ?? "wss://ws.limitless.exchange/markets";
}

export function hasLimitlessHmacConfig(env: Env): boolean {
  return Boolean((env as any).LIMITLESS_API_KEY && (env as any).LIMITLESS_API_SECRET);
}

export function requireLimitlessHmacConfig(env: Env): { tokenId: string; secret: string } {
  const tokenId = (env as any).LIMITLESS_API_KEY as string | undefined;
  const secret = (env as any).LIMITLESS_API_SECRET as string | undefined;
  if (!tokenId || !secret) {
    throw new Error("LIMITLESS_API_KEY and LIMITLESS_API_SECRET are required for Limitless HMAC auth");
  }
  return { tokenId, secret };
}

export function signLimitlessMessage(secret: string, message: string): string {
  return createHmac("sha256", Buffer.from(secret, "base64"))
    .update(message)
    .digest("base64");
}

export function buildPathWithQuery(path: string, params?: Record<string, unknown>): string {
  const url = new URL(path, "https://placeholder.local");
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}

export function limitlessRestAuthHeaders(
  env: Env,
  method: string,
  pathWithQuery: string,
  body = ""
): Record<string, string> {
  const { tokenId, secret } = requireLimitlessHmacConfig(env);
  const timestamp = new Date().toISOString();
  const message = `${timestamp}\n${method.toUpperCase()}\n${pathWithQuery}\n${body}`;
  return {
    "lmts-api-key": tokenId,
    "lmts-timestamp": timestamp,
    "lmts-signature": signLimitlessMessage(secret, message),
  };
}

export function limitlessWebsocketAuthHeaders(env: Env): Record<string, string> {
  const { tokenId, secret } = requireLimitlessHmacConfig(env);
  const timestamp = new Date().toISOString();
  const path = "/socket.io/?EIO=4&transport=websocket";
  const message = `${timestamp}\nGET\n${path}\n`;
  return {
    "lmts-api-key": tokenId,
    "lmts-timestamp": timestamp,
    "lmts-signature": signLimitlessMessage(secret, message),
  };
}

export async function limitlessGetJson<T>(
  env: Env,
  path: string,
  params?: Record<string, unknown>,
  extraHeaders?: Record<string, string>
): Promise<T> {
  const pathWithQuery = buildPathWithQuery(path, params);
  const res = await fetch(`${limitlessBase(env)}${pathWithQuery}`, {
    headers: {
      Accept: "application/json",
      ...limitlessRestAuthHeaders(env, "GET", pathWithQuery),
      ...extraHeaders,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Limitless API ${res.status} ${pathWithQuery}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export async function limitlessRequestJson<T>(
  env: Env,
  method: "GET" | "POST" | "DELETE",
  path: string,
  payload?: unknown,
  extraHeaders?: Record<string, string>
): Promise<T> {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const res = await fetch(`${limitlessBase(env)}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...limitlessRestAuthHeaders(env, method, path, body),
      ...extraHeaders,
    },
    body: body || undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Limitless API ${res.status} ${path}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}
