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

/**
 * Like pickString, but also accepts numeric ids — the Limitless profile id is
 * returned as a number (e.g. `id: 12345`), which pickString would silently drop.
 */
function pickIdString(raw: JsonRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

export async function createPartnerServerAccount(
  env: Env,
  displayName: string
): Promise<PartnerAccountResult> {
  const raw = await limitlessJson<JsonRecord>(env, "POST", "/profiles/partner-accounts", {
    displayName,
    createServerWallet: true,
  });

  // The id/address may live at the top level or nested under account/profile/data.
  const containers: JsonRecord[] = [
    raw,
    asRecord(raw.account),
    asRecord(raw.profile),
    asRecord(raw.data),
  ];

  let limitlessProfileId: string | null = null;
  let accountAddress: string | null = null;
  for (const c of containers) {
    limitlessProfileId = limitlessProfileId ?? pickIdString(c, ["profileId", "id"]);
    accountAddress = accountAddress ?? pickString(c, ["accountAddress", "address", "walletAddress"]);
  }

  return { limitlessProfileId, accountAddress, displayName, rawJson: raw };
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
