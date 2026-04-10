"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.clobBaseUrl = clobBaseUrl;
exports.getBooks = getBooks;
exports.getMidpoint = getMidpoint;
exports.getSpreadMap = getSpreadMap;
exports.postLimitOrder = postLimitOrder;
exports.getOrder = getOrder;
function clobBaseUrl(env) {
    return env.CLOB_BASE_URL;
}
async function postJson(url, body) {
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body)
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`CLOB request failed: ${res.status} ${text}`);
    }
    return (await res.json());
}
async function getJson(url) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`CLOB request failed: ${res.status} ${text}`);
    }
    return (await res.json());
}
async function getBooks(env, tokenIds) {
    if (tokenIds.length === 0)
        return [];
    const url = `${clobBaseUrl(env)}/books`;
    return postJson(url, tokenIds.map((token_id) => ({ token_id })));
}
async function getMidpoint(env, tokenId) {
    const url = `${clobBaseUrl(env)}/midpoint?token_id=${encodeURIComponent(tokenId)}`;
    const r = await getJson(url);
    return r.mid_price;
}
async function getSpreadMap(env, tokenIds) {
    if (tokenIds.length === 0)
        return {};
    const url = `${clobBaseUrl(env)}/spreads`;
    return postJson(url, tokenIds.map((token_id) => ({ token_id })));
}
async function postLimitOrder(env, params) {
    const sdk = await getClobClient(env);
    // Create and post in one call (SDK signs locally + submits).
    // Tick size + negRisk must be pulled from orderbook summary or config for production.
    const result = await sdk.createAndPostOrder({
        tokenID: params.tokenId,
        price: Number(params.price),
        size: Number(params.size),
        side: params.side,
        taker: params.taker
    }, { tickSize: "0.01", negRisk: false }, "GTC");
    return result;
}
async function getClobClient(env) {
    // Recommended: use official clob-client SDK (handles signing + L2 auth).
    // To keep the code compile-safe without hard dependency, we dynamically import.
    let clobClientMod;
    try {
        clobClientMod = await Promise.resolve().then(() => __importStar(require("@polymarket/clob-client")));
    }
    catch (e) {
        throw new Error("Missing @polymarket/clob-client. Run: npm i @polymarket/clob-client");
    }
    const { ClobClient } = clobClientMod;
    const { Wallet } = await Promise.resolve().then(() => __importStar(require("ethers")));
    const chainId = 137; // Polygon
    if (!env.EXECUTOR_PRIVATE_KEY)
        throw new Error("EXECUTOR_PRIVATE_KEY missing");
    if (!env.POLY_API_KEY || !env.POLY_PASSPHRASE || !env.POLY_SIGNATURE_SECRET) {
        throw new Error("Missing POLY_API_KEY / POLY_PASSPHRASE / POLY_SIGNATURE_SECRET for CLOB L2 auth");
    }
    return new ClobClient(clobBaseUrl(env), chainId, new Wallet(env.EXECUTOR_PRIVATE_KEY), {
        apiKey: env.POLY_API_KEY,
        passphrase: env.POLY_PASSPHRASE,
        secret: env.POLY_SIGNATURE_SECRET
    }, 1 // signatureType: 1=POLY_PROXY (adjust to your proxy/funder type)
    );
}
async function getOrder(env, orderId) {
    const sdk = await getClobClient(env);
    return sdk.getOrder(orderId);
}
