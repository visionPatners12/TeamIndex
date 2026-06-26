import type { Env } from "../config/env";
import { limitlessRequestJson } from "./limitlessAuth";

type JsonRecord = Record<string, unknown>;

export type PartnerAccountResult = {
  limitlessProfileId: string | null;
  accountAddress: string | null;
  displayName: string;
  rawJson: JsonRecord;
};

async function limitlessJson<T>(
  env: Env,
  method: "GET" | "POST",
  path: string,
  payload?: JsonRecord
): Promise<T> {
  return limitlessRequestJson<T>(env, method, path, payload);
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
