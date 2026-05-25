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
exports.getOrderResultStatus = getOrderResultStatus;
exports.isAcceptedOrderResult = isAcceptedOrderResult;
exports.getOrderRejectMessage = getOrderRejectMessage;
exports.getClobClient = getClobClient;
exports.getOrder = getOrder;
exports.getPricesHistory = getPricesHistory;
exports.calculateDepthAtSlippage = calculateDepthAtSlippage;
exports.estimateSlippage = estimateSlippage;
exports.getBestBidAsk = getBestBidAsk;
const polymarketWallet_1 = require("./polymarketWallet");
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
    const { AssetType, OrderType, Side } = await Promise.resolve().then(() => __importStar(require("@polymarket/clob-client-v2")));
    const [tickSize, negRisk] = await Promise.all([
        sdk.getTickSize(params.tokenId),
        sdk.getNegRisk(params.tokenId)
    ]);
    await sdk.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const result = await sdk.createAndPostOrder({
        tokenID: params.tokenId,
        price: Number(params.price),
        size: Number(params.size),
        side: params.side === "BUY" ? Side.BUY : Side.SELL
    }, { tickSize, negRisk }, OrderType.GTC);
    return result;
}
function getOrderResultStatus(result) {
    const status = result?.status ?? result?.order?.status;
    return typeof status === "string" ? status.toLowerCase() : undefined;
}
function isAcceptedOrderResult(result) {
    if (result?.success === false)
        return false;
    const status = getOrderResultStatus(result);
    return status === "live" || status === "matched" || status === "delayed";
}
function getOrderRejectMessage(result) {
    const status = getOrderResultStatus(result) ?? "unknown";
    const errorMsg = result?.errorMsg ?? result?.error ?? result?.message;
    return errorMsg ? `CLOB rejected order (${status}): ${errorMsg}` : `CLOB rejected order (${status})`;
}
async function getClobClient(env) {
    (0, polymarketWallet_1.assertPolymarketClobConfig)(env);
    const { Chain, ClobClient, SignatureTypeV2 } = await Promise.resolve().then(() => __importStar(require("@polymarket/clob-client-v2")));
    const [signer, funderAddress] = await Promise.all([
        (0, polymarketWallet_1.createPolymarketWalletClient)(env),
        (0, polymarketWallet_1.resolvePolymarketFunderAddress)(env)
    ]);
    if (SignatureTypeV2.POLY_1271 !== polymarketWallet_1.POLY_1271_SIGNATURE_TYPE) {
        throw new Error("Unexpected @polymarket/clob-client-v2 POLY_1271 signature type");
    }
    return new ClobClient({
        host: clobBaseUrl(env),
        chain: Chain.POLYGON,
        signer,
        creds: {
            key: env.POLY_API_KEY,
            passphrase: env.POLY_PASSPHRASE,
            secret: env.POLY_SIGNATURE_SECRET
        },
        signatureType: SignatureTypeV2.POLY_1271,
        funderAddress,
        useServerTime: true,
        throwOnError: true
    });
}
async function getOrder(env, orderId) {
    const sdk = await getClobClient(env);
    return sdk.getOrder(orderId);
}
// ─── Read-only data helpers (no auth needed) ──────────────────────────────────
/**
 * Fetch price history for a token from CLOB.
 * Returns array of { t: unix_seconds, p: price }.
 */
async function getPricesHistory(env, tokenId, interval = "1d") {
    try {
        const url = `${clobBaseUrl(env)}/prices-history?market=${encodeURIComponent(tokenId)}&interval=${interval}`;
        const raw = await getJson(url);
        return raw.history ?? [];
    }
    catch {
        return [];
    }
}
/**
 * Calculate how much USDC can be bought at ≤ slippagePct price impact.
 * Uses bids (for YES buys) or asks.
 */
function calculateDepthAtSlippage(book, refPrice, slippagePct = 0.02) {
    const asks = book.asks ?? [];
    const maxPrice = refPrice * (1 + slippagePct);
    let depth = 0;
    for (const level of asks) {
        const p = parseFloat(level.price);
        const s = parseFloat(level.size);
        if (p > maxPrice)
            break;
        depth += p * s; // approx USDC value
    }
    return depth;
}
/**
 * Estimate slippage for a target buy of `targetUsdc` at current ask prices.
 */
function estimateSlippage(book, targetUsdc) {
    const asks = book.asks ?? [];
    if (!asks.length)
        return 0.05;
    const bestAsk = parseFloat(asks[0]?.price ?? "0.5");
    let remaining = targetUsdc;
    let worstPrice = bestAsk;
    for (const level of asks) {
        const p = parseFloat(level.price);
        const s = parseFloat(level.size);
        const levelUsdc = p * s;
        if (remaining <= 0)
            break;
        worstPrice = p;
        remaining -= Math.min(levelUsdc, remaining);
    }
    return Math.abs(worstPrice - bestAsk) / bestAsk;
}
/**
 * Get best bid and best ask from an order book summary.
 */
function getBestBidAsk(book) {
    const bids = book.bids ?? [];
    const asks = book.asks ?? [];
    const bestBid = bids.length ? parseFloat(bids[0].price) : 0;
    const bestAsk = asks.length ? parseFloat(asks[0].price) : 1;
    return { bestBid, bestAsk };
}
