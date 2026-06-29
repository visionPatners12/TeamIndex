"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.limitlessBase = limitlessBase;
exports.limitlessWsBase = limitlessWsBase;
exports.hasLimitlessHmacConfig = hasLimitlessHmacConfig;
exports.requireLimitlessHmacConfig = requireLimitlessHmacConfig;
exports.signLimitlessMessage = signLimitlessMessage;
exports.buildPathWithQuery = buildPathWithQuery;
exports.limitlessRestAuthHeaders = limitlessRestAuthHeaders;
exports.limitlessWebsocketAuthHeaders = limitlessWebsocketAuthHeaders;
exports.limitlessGetJson = limitlessGetJson;
exports.limitlessRequestJson = limitlessRequestJson;
const crypto_1 = require("crypto");
function limitlessBase(env) {
    return env.LIMITLESS_BASE_URL ?? "https://api.limitless.exchange";
}
function limitlessWsBase(env) {
    return env.LIMITLESS_WS_URL ?? "wss://ws.limitless.exchange/markets";
}
function hasLimitlessHmacConfig(env) {
    return Boolean(env.LIMITLESS_API_KEY && env.LIMITLESS_API_SECRET);
}
function requireLimitlessHmacConfig(env) {
    const tokenId = env.LIMITLESS_API_KEY;
    const secret = env.LIMITLESS_API_SECRET;
    if (!tokenId || !secret) {
        throw new Error("LIMITLESS_API_KEY and LIMITLESS_API_SECRET are required for Limitless HMAC auth");
    }
    return { tokenId, secret };
}
function signLimitlessMessage(secret, message) {
    return (0, crypto_1.createHmac)("sha256", Buffer.from(secret, "base64"))
        .update(message)
        .digest("base64");
}
function buildPathWithQuery(path, params) {
    const url = new URL(path, "https://placeholder.local");
    for (const [key, value] of Object.entries(params ?? {})) {
        if (value !== undefined && value !== null && value !== "")
            url.searchParams.set(key, String(value));
    }
    return `${url.pathname}${url.search}`;
}
function limitlessRestAuthHeaders(env, method, pathWithQuery, body = "") {
    const { tokenId, secret } = requireLimitlessHmacConfig(env);
    const timestamp = new Date().toISOString();
    const message = `${timestamp}\n${method.toUpperCase()}\n${pathWithQuery}\n${body}`;
    return {
        "lmts-api-key": tokenId,
        "lmts-timestamp": timestamp,
        "lmts-signature": signLimitlessMessage(secret, message),
    };
}
function limitlessWebsocketAuthHeaders(env) {
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
async function limitlessGetJson(env, path, params, extraHeaders) {
    const pathWithQuery = buildPathWithQuery(path, params);
    const res = await fetch(`${limitlessBase(env)}${pathWithQuery}`, {
        headers: {
            Accept: "application/json",
            ...limitlessRestAuthHeaders(env, "GET", pathWithQuery),
            ...extraHeaders,
        },
    });
    const text = await res.text();
    if (!res.ok)
        throw new Error(`Limitless API ${res.status} ${pathWithQuery}: ${text}`);
    return (text ? JSON.parse(text) : {});
}
async function limitlessRequestJson(env, method, path, payload, extraHeaders) {
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
    if (!res.ok)
        throw new Error(`Limitless API ${res.status} ${path}: ${text}`);
    return (text ? JSON.parse(text) : {});
}
