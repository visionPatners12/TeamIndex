"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeAddress = normalizeAddress;
exports.sameAddress = sameAddress;
exports.encodeLimitlessSigningMessage = encodeLimitlessSigningMessage;
exports.createPartnerServerAccount = createPartnerServerAccount;
exports.checkPartnerAccountAllowances = checkPartnerAccountAllowances;
exports.retryPartnerAccountAllowances = retryPartnerAccountAllowances;
exports.ensurePartnerAccountAllowances = ensurePartnerAccountAllowances;
exports.partnerAccountAllowanceReady = partnerAccountAllowanceReady;
exports.partnerAccountCreationEnabled = partnerAccountCreationEnabled;
exports.registerVaultPartnerAccount = registerVaultPartnerAccount;
exports.resolveProfileIdForAddress = resolveProfileIdForAddress;
const ethers_1 = require("ethers");
const limitlessAuth_1 = require("./limitlessAuth");
async function limitlessJson(env, method, path, payload) {
    return (0, limitlessAuth_1.limitlessRequestJson)(env, method, path, payload);
}
function pickString(raw, keys) {
    for (const key of keys) {
        const value = raw[key];
        if (typeof value === "string" && value.trim())
            return value;
    }
    return null;
}
/**
 * Like pickString, but also accepts numeric ids — the Limitless profile id is
 * returned as a number (e.g. `id: 12345`), which pickString would silently drop.
 */
function pickIdString(raw, keys) {
    for (const key of keys) {
        const value = raw[key];
        if (typeof value === "string" && value.trim())
            return value.trim();
        if (typeof value === "number" && Number.isFinite(value))
            return String(value);
    }
    return null;
}
function asRecord(value) {
    return value && typeof value === "object" ? value : {};
}
function normalizeAddress(address) {
    const trimmed = address?.trim();
    return trimmed ? trimmed.toLowerCase() : null;
}
function sameAddress(a, b) {
    const aa = normalizeAddress(a);
    const bb = normalizeAddress(b);
    return !!aa && !!bb && aa === bb;
}
function encodeLimitlessSigningMessage(message) {
    return (0, ethers_1.hexlify)((0, ethers_1.toUtf8Bytes)(message));
}
async function fetchLimitlessSigningMessage(env) {
    const res = await (0, limitlessAuth_1.limitlessFetch)(env, `${(0, limitlessAuth_1.limitlessBase)(env)}/auth/signing-message`, {
        headers: { Accept: "text/plain" },
    });
    const text = await res.text();
    if (!res.ok)
        throw new Error(`Limitless API ${res.status} /auth/signing-message: ${text}`);
    if (!text.trim())
        throw new Error("Limitless signing message is empty");
    return text;
}
async function createPartnerServerAccount(env, displayName) {
    const raw = await limitlessJson(env, "POST", "/profiles/partner-accounts", {
        displayName,
        createServerWallet: true,
    });
    // The id/address may live at the top level or nested under account/profile/data.
    const containers = [
        raw,
        asRecord(raw.account),
        asRecord(raw.profile),
        asRecord(raw.data),
    ];
    let limitlessProfileId = null;
    let accountAddress = null;
    for (const c of containers) {
        limitlessProfileId = limitlessProfileId ?? pickIdString(c, ["profileId", "id"]);
        accountAddress = accountAddress ?? pickString(c, ["accountAddress", "account", "address", "walletAddress"]);
    }
    return { limitlessProfileId, accountAddress, displayName, rawJson: raw };
}
async function checkPartnerAccountAllowances(env, profileIdOrAccount) {
    return limitlessJson(env, "GET", `/profiles/partner-accounts/${encodeURIComponent(profileIdOrAccount)}/allowances`);
}
async function retryPartnerAccountAllowances(env, profileIdOrAccount) {
    return limitlessJson(env, "POST", `/profiles/partner-accounts/${encodeURIComponent(profileIdOrAccount)}/allowances/retry`, {});
}
function hasRetryableAllowanceIssue(value) {
    if (!value || typeof value !== "object")
        return false;
    if (Array.isArray(value))
        return value.some(hasRetryableAllowanceIssue);
    const record = value;
    const status = typeof record.status === "string" ? record.status.toLowerCase() : "";
    if (record.retryable === true && (status === "missing" || status === "failed"))
        return true;
    return Object.values(record).some(hasRetryableAllowanceIssue);
}
function collectAllowanceStatuses(value, statuses = []) {
    if (!value || typeof value !== "object")
        return statuses;
    if (Array.isArray(value)) {
        for (const item of value)
            collectAllowanceStatuses(item, statuses);
        return statuses;
    }
    const record = value;
    for (const key of ["status", "allowanceStatus"]) {
        const status = record[key];
        if (typeof status === "string" && status.trim())
            statuses.push(status.trim().toLowerCase());
    }
    for (const nested of Object.values(record))
        collectAllowanceStatuses(nested, statuses);
    return statuses;
}
async function ensurePartnerAccountAllowances(env, profileIdOrAccount) {
    const checked = await checkPartnerAccountAllowances(env, profileIdOrAccount);
    if (!hasRetryableAllowanceIssue(checked))
        return { checked, retried: false };
    const retryResult = await retryPartnerAccountAllowances(env, profileIdOrAccount);
    const final = await checkPartnerAccountAllowances(env, profileIdOrAccount);
    return { checked, retried: true, retryResult, final };
}
function partnerAccountAllowanceReady(value) {
    if (hasRetryableAllowanceIssue(value))
        return false;
    const statuses = collectAllowanceStatuses(value);
    if (statuses.length === 0)
        return true;
    const ready = new Set(["active", "approved", "complete", "completed", "ok", "ready", "success", "valid"]);
    const pending = new Set(["error", "failed", "missing", "pending", "required", "unapproved"]);
    return statuses.every((status) => ready.has(status) || (!pending.has(status) && status.includes("success")));
}
function partnerAccountCreationEnabled(env) {
    return String(env.LIMITLESS_PARTNER_ACCOUNT_CREATION_ENABLED ?? "false").toLowerCase() === "true";
}
/** Pull a profileId out of a Limitless response, top-level or nested. */
function extractProfileId(raw) {
    const containers = [
        raw,
        asRecord(raw.account),
        asRecord(raw.profile),
        asRecord(raw.data),
        ...(Array.isArray(raw.accounts) ? raw.accounts.map(asRecord) : []),
    ];
    for (const c of containers) {
        const id = pickIdString(c, ["profileId", "id"]);
        if (id)
            return id;
    }
    return null;
}
/**
 * Register an on-chain address (e.g. a pool vault) as a Limitless partner sub-account
 * so it gets a profileId usable as `ownerId` when that address is the order maker.
 *
 * Proves ownership via x-account / x-signing-message / x-signature: the order-signer
 * EOA signs Limitless' canonical /auth/signing-message text; the message header is
 * sent as UTF-8 hex. For a contract vault Limitless validates the proof through
 * the vault's ERC-1271 `isValidSignature` (which recovers the signer and checks that it
 * is an authorized order signer). The EOA must already be authorized via setOrderSigner.
 */
async function registerVaultPartnerAccount(env, vaultAddress, displayName) {
    const signerKey = env.LIMITLESS_ORDER_SIGNER_PRIVATE_KEY || env.LIMITLESS_TRADER_PRIVATE_KEY;
    if (!signerKey)
        throw new Error("LIMITLESS_ORDER_SIGNER_PRIVATE_KEY required to register a vault profile");
    const wallet = new ethers_1.Wallet(signerKey);
    const message = await fetchLimitlessSigningMessage(env);
    const signature = await wallet.signMessage(message); // EIP-191 personal_sign
    const extraHeaders = {
        "x-account": vaultAddress,
        "x-signing-message": encodeLimitlessSigningMessage(message),
        "x-signature": signature,
    };
    try {
        const raw = await (0, limitlessAuth_1.limitlessRequestJson)(env, "POST", "/profiles/partner-accounts", { displayName }, extraHeaders);
        return {
            limitlessProfileId: extractProfileId(raw),
            accountAddress: vaultAddress,
            displayName,
            rawJson: raw,
        };
    }
    catch (e) {
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
async function resolveProfileIdForAddress(env, address) {
    const collect = (raw) => extractProfileId(raw);
    // 1) Partner sub-account by wallet.
    try {
        const raw = await limitlessJson(env, "GET", `/profiles/partner-accounts?account=${encodeURIComponent(address)}`);
        const id = collect(raw);
        if (id)
            return id;
    }
    catch {
        // not found / not a partner account — fall through
    }
    // 2) Public profile by address.
    try {
        const raw = await limitlessJson(env, "GET", `/profiles/${encodeURIComponent(address)}`);
        const id = collect(raw);
        if (id)
            return id;
    }
    catch {
        // no profile for this address
    }
    return null;
}
