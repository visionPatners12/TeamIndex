import { Wallet } from "ethers";
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

export function normalizeAddress(address: string | null | undefined): string | null {
  const trimmed = address?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  const aa = normalizeAddress(a);
  const bb = normalizeAddress(b);
  return !!aa && !!bb && aa === bb;
}

function vaultRegistrationMessage(vaultAddress: string): string {
  return `Limitless partner account registration | account=${vaultAddress} | ts=${Date.now()}`;
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

/** Pull a profileId out of a Limitless response, top-level or nested. */
function extractProfileId(raw: JsonRecord): string | null {
  const containers: JsonRecord[] = [
    raw,
    asRecord(raw.account),
    asRecord(raw.profile),
    asRecord(raw.data),
    ...(Array.isArray((raw as any).accounts) ? (raw as any).accounts.map(asRecord) : []),
  ];
  for (const c of containers) {
    const id = pickIdString(c, ["profileId", "id"]);
    if (id) return id;
  }
  return null;
}

/**
 * Register an on-chain address (e.g. a pool vault) as a Limitless partner sub-account
 * so it gets a profileId usable as `ownerId` when that address is the order maker.
 *
 * Proves ownership via x-account / x-signing-message / x-signature: the order-signer
 * EOA signs an arbitrary message; for a contract vault Limitless validates it through
 * the vault's ERC-1271 `isValidSignature` (which recovers the signer and checks that it
 * is an authorized order signer). The EOA must already be authorized via setOrderSigner.
 *
 * NOTE: the exact `x-signing-message` format is not publicly documented — best-effort,
 * confirm with Limitless Builders if the API rejects it.
 */
export async function registerVaultPartnerAccount(
  env: Env,
  vaultAddress: string,
  displayName: string
): Promise<PartnerAccountResult> {
  const signerKey = (env as any).LIMITLESS_ORDER_SIGNER_PRIVATE_KEY || (env as any).LIMITLESS_TRADER_PRIVATE_KEY;
  if (!signerKey) throw new Error("LIMITLESS_ORDER_SIGNER_PRIVATE_KEY required to register a vault profile");

  const wallet = new Wallet(signerKey);
  const message = vaultRegistrationMessage(vaultAddress);
  const signature = await wallet.signMessage(message); // EIP-191 personal_sign

  const extraHeaders = {
    "x-account": vaultAddress,
    "x-signing-message": message,
    "x-signature": signature,
  };

  try {
    const raw = await limitlessRequestJson<JsonRecord>(
      env,
      "POST",
      "/profiles/partner-accounts",
      { displayName },
      extraHeaders
    );
    return {
      limitlessProfileId: extractProfileId(raw),
      accountAddress: vaultAddress,
      displayName,
      rawJson: raw,
    };
  } catch (e: any) {
    // 409 Conflict = profile already exists for this address → resolve and reuse it.
    if (/\b409\b/.test(String(e?.message ?? ""))) {
      const existing = await resolveProfileIdForAddress(env, vaultAddress);
      return { limitlessProfileId: existing, accountAddress: vaultAddress, displayName, rawJson: { conflict: true } };
    }
    throw e;
  }
}

/**
 * Resolve the Limitless profileId that owns orders for a given on-chain address
 * (used as `ownerId` when that address is the order maker — e.g. a pool vault).
 *
 * Tries the partner sub-account lookup first, then the public profile-by-address
 * endpoint. Returns null if no profile is registered for the address.
 */
export async function resolveProfileIdForAddress(env: Env, address: string): Promise<string | null> {
  const collect = (raw: JsonRecord): string | null => extractProfileId(raw);

  // 1) Partner sub-account by wallet.
  try {
    const raw = await limitlessJson<JsonRecord>(
      env,
      "GET",
      `/profiles/partner-accounts?account=${encodeURIComponent(address)}`
    );
    const id = collect(raw);
    if (id) return id;
  } catch {
    // not found / not a partner account — fall through
  }

  // 2) Public profile by address.
  try {
    const raw = await limitlessJson<JsonRecord>(env, "GET", `/profiles/${encodeURIComponent(address)}`);
    const id = collect(raw);
    if (id) return id;
  } catch {
    // no profile for this address
  }

  return null;
}
