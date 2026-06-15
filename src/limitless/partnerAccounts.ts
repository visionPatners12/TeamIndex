import { createHmac } from "crypto";
import type { Env } from "../config/env";

type JsonRecord = Record<string, unknown>;

export type PartnerAccountResult = {
  limitlessProfileId: string | null;
  accountAddress: string | null;
  displayName: string;
  rawJson: JsonRecord;
};

function limitlessBase(env: Env): string {
  return (env as any).LIMITLESS_BASE_URL ?? "https://api.limitless.exchange";
}

function requiredPartnerAuth(env: Env) {
  const apiKey = (env as any).LIMITLESS_API_KEY as string | undefined;
  const apiSecret = (env as any).LIMITLESS_API_SECRET as string | undefined;
  if (!apiKey || !apiSecret) {
    throw new Error("LIMITLESS_API_KEY and LIMITLESS_API_SECRET are required for partner accounts");
  }
  return { apiKey, apiSecret };
}

function signaturePayload(method: string, path: string, timestamp: string, body: string) {
  return `${timestamp}${method.toUpperCase()}${path}${body}`;
}

function hmacHeaders(env: Env, method: string, path: string, body: string) {
  const { apiKey, apiSecret } = requiredPartnerAuth(env);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", apiSecret)
    .update(signaturePayload(method, path, timestamp, body))
    .digest("hex");

  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "lmts-api-key": apiKey,
    "lmts-timestamp": timestamp,
    "lmts-signature": signature,
  };
}

async function limitlessJson<T>(
  env: Env,
  method: "GET" | "POST",
  path: string,
  payload?: JsonRecord
): Promise<T> {
  const body = payload ? JSON.stringify(payload) : "";
  const res = await fetch(`${limitlessBase(env)}${path}`, {
    method,
    headers: hmacHeaders(env, method, path, body),
    body: body || undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(`Limitless partner account ${res.status} ${path}: ${text}`);
  }
  return json as T;
}

function pickString(raw: JsonRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

export async function createPartnerServerAccount(
  env: Env,
  displayName: string
): Promise<PartnerAccountResult> {
  const raw = await limitlessJson<JsonRecord>(env, "POST", "/profiles/partner-accounts", {
    displayName,
    createServerWallet: true,
  });

  const account = (raw.account && typeof raw.account === "object" ? raw.account : raw) as JsonRecord;
  return {
    limitlessProfileId: pickString(raw, ["profileId", "id"]) ?? pickString(account, ["profileId", "id"]),
    accountAddress: pickString(raw, ["accountAddress", "address", "walletAddress"]) ??
      pickString(account, ["accountAddress", "address", "walletAddress"]),
    displayName,
    rawJson: raw,
  };
}

export async function checkPartnerAccountAllowances(
  env: Env,
  profileIdOrAccount: string
): Promise<JsonRecord> {
  return limitlessJson<JsonRecord>(
    env,
    "GET",
    `/profiles/partner-accounts/${encodeURIComponent(profileIdOrAccount)}/allowances`
  );
}

export async function retryPartnerAccountAllowances(
  env: Env,
  profileIdOrAccount: string
): Promise<JsonRecord> {
  return limitlessJson<JsonRecord>(
    env,
    "POST",
    `/profiles/partner-accounts/${encodeURIComponent(profileIdOrAccount)}/allowances/retry`,
    {}
  );
}

export function partnerAccountCreationEnabled(env: Env) {
  return String((env as any).LIMITLESS_PARTNER_ACCOUNT_CREATION_ENABLED ?? "false").toLowerCase() === "true";
}
