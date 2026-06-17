"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPartnerServerAccount = createPartnerServerAccount;
exports.checkPartnerAccountAllowances = checkPartnerAccountAllowances;
exports.retryPartnerAccountAllowances = retryPartnerAccountAllowances;
exports.partnerAccountCreationEnabled = partnerAccountCreationEnabled;
const crypto_1 = require("crypto");
function limitlessBase(env) {
    return env.LIMITLESS_BASE_URL ?? "https://api.limitless.exchange";
}
function requiredPartnerAuth(env) {
    const apiKey = env.LIMITLESS_API_KEY;
    const apiSecret = env.LIMITLESS_API_SECRET;
    if (!apiKey || !apiSecret) {
        throw new Error("LIMITLESS_API_KEY and LIMITLESS_API_SECRET are required for partner accounts");
    }
    return { apiKey, apiSecret };
}
function signaturePayload(method, path, timestamp, body) {
    return `${timestamp}${method.toUpperCase()}${path}${body}`;
}
function hmacHeaders(env, method, path, body) {
    const { apiKey, apiSecret } = requiredPartnerAuth(env);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = (0, crypto_1.createHmac)("sha256", apiSecret)
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
async function limitlessJson(env, method, path, payload) {
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
    return json;
}
function pickString(raw, keys) {
    for (const key of keys) {
        const value = raw[key];
        if (typeof value === "string" && value.trim())
            return value;
    }
    return null;
}
async function createPartnerServerAccount(env, displayName) {
    const raw = await limitlessJson(env, "POST", "/profiles/partner-accounts", {
        displayName,
        createServerWallet: true,
    });
    const account = (raw.account && typeof raw.account === "object" ? raw.account : raw);
    return {
        limitlessProfileId: pickString(raw, ["profileId", "id"]) ?? pickString(account, ["profileId", "id"]),
        accountAddress: pickString(raw, ["accountAddress", "address", "walletAddress"]) ??
            pickString(account, ["accountAddress", "address", "walletAddress"]),
        displayName,
        rawJson: raw,
    };
}
async function checkPartnerAccountAllowances(env, profileIdOrAccount) {
    return limitlessJson(env, "GET", `/profiles/partner-accounts/${encodeURIComponent(profileIdOrAccount)}/allowances`);
}
async function retryPartnerAccountAllowances(env, profileIdOrAccount) {
    return limitlessJson(env, "POST", `/profiles/partner-accounts/${encodeURIComponent(profileIdOrAccount)}/allowances/retry`, {});
}
function partnerAccountCreationEnabled(env) {
    return String(env.LIMITLESS_PARTNER_ACCOUNT_CREATION_ENABLED ?? "false").toLowerCase() === "true";
}
