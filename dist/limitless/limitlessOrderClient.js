"use strict";
/**
 * limitlessOrderClient.ts
 *
 * Trading layer for Limitless Exchange on Base (chainId 8453).
 * Equivalent of clobClient.ts for Polymarket.
 *
 * Order signing:
 *   EIP-712 with domain name "Limitless CTF Exchange", version "1".
 *   verifyingContract = market.venue.exchange (per-market, fetched on demand).
 *
 * 12-field order type (mirrors limitless-exchange-ts-sdk signer.ts):
 *   salt, maker, signer, taker, tokenId, makerAmount, takerAmount,
 *   expiration, nonce, feeRateBps, side, signatureType
 *
 * Amount scaling: 1e6 (USDC has 6 decimals on Base).
 *
 * Auth: X-API-Key header for REST calls.
 * Docs: https://docs.limitless.exchange
 */
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
exports.getOrderBook = void 0;
exports.getBestBidAsk = getBestBidAsk;
exports.getMidpointFromBook = getMidpointFromBook;
exports.calculateDepthAtSlippage = calculateDepthAtSlippage;
exports.estimateSlippage = estimateSlippage;
exports.getSpread = getSpread;
exports.getMidpoint = getMidpoint;
exports.postLimitlessOrder = postLimitlessOrder;
exports.getLimitlessOrder = getLimitlessOrder;
exports.isAcceptedOrderResult = isAcceptedOrderResult;
exports.getOrderRejectMessage = getOrderRejectMessage;
exports.assertLimitlessTradingConfig = assertLimitlessTradingConfig;
exports.isLimitlessTradingReady = isLimitlessTradingReady;
const limitlessClient_1 = require("./limitlessClient");
Object.defineProperty(exports, "getOrderBook", { enumerable: true, get: function () { return limitlessClient_1.getOrderBook; } });
const BASE_CHAIN_ID = 8453;
const SCALE = 1000000n; // 1e6 (USDC 6 decimals)
/** Side enum values used in EIP-712 (uint8). */
const SIDE_BUY = 0;
const SIDE_SELL = 1;
/** signatureType: EOA = 0 (standard EOA sig). */
const SIGNATURE_TYPE_EOA = 0;
// ─── HTTP helpers ─────────────────────────────────────────────────────────────
function limitlessBase(env) {
    return env.LIMITLESS_BASE_URL ?? "https://api.limitless.exchange";
}
function authHeaders(env) {
    const key = env.LIMITLESS_API_KEY;
    return key ? { "X-API-Key": key } : {};
}
async function getJson(env, path, params) {
    const u = new URL(`${limitlessBase(env)}${path}`);
    if (params)
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined && v !== null)
                u.searchParams.set(k, String(v));
        }
    const res = await fetch(u.toString(), {
        headers: { Accept: "application/json", ...authHeaders(env) },
    });
    if (!res.ok)
        throw new Error(`Limitless API ${res.status} ${path}`);
    return (await res.json());
}
async function postJson(env, path, body) {
    const res = await fetch(`${limitlessBase(env)}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...authHeaders(env) },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Limitless API ${res.status} ${path}: ${text}`);
    }
    return (await res.json());
}
/**
 * Get best bid and best ask from an order book.
 */
function getBestBidAsk(book) {
    const bids = book.bids.map(b => b.price).filter(Number.isFinite);
    const asks = book.asks.map(a => a.price).filter(Number.isFinite);
    const bestBid = bids.length ? Math.max(...bids) : 0;
    const bestAsk = asks.length ? Math.min(...asks) : 1;
    return { bestBid, bestAsk };
}
/**
 * Compute the mid-price: prefer `adjustedMidpoint` from Limitless, then (bid+ask)/2.
 */
function getMidpointFromBook(book) {
    if (book.adjustedMidpoint && Number.isFinite(book.adjustedMidpoint)) {
        return book.adjustedMidpoint;
    }
    const { bestBid, bestAsk } = getBestBidAsk(book);
    if (Number.isFinite(bestBid) && Number.isFinite(bestAsk) && bestBid > 0) {
        return (bestBid + bestAsk) / 2;
    }
    return 0.5;
}
/**
 * Calculate USDC depth available within `slippagePct` of the best ask.
 */
function calculateDepthAtSlippage(book, refPrice, slippagePct = 0.02) {
    const maxPrice = refPrice * (1 + slippagePct);
    const asks = [...book.asks].sort((a, b) => a.price - b.price);
    let depth = 0;
    for (const { price, size } of asks) {
        if (price > maxPrice)
            break;
        depth += price * size;
    }
    return depth;
}
/**
 * Estimate price impact of buying `targetUsdc` by walking the ask side.
 */
function estimateSlippage(book, targetUsdc) {
    const asks = [...book.asks].sort((a, b) => a.price - b.price);
    if (!asks.length)
        return 0.05;
    const bestAsk = asks[0].price;
    let remaining = targetUsdc;
    let worstPrice = bestAsk;
    for (const { price, size } of asks) {
        if (remaining <= 0)
            break;
        worstPrice = price;
        remaining -= Math.min(price * size, remaining);
    }
    return bestAsk > 0 ? Math.abs(worstPrice - bestAsk) / bestAsk : 0.05;
}
function getSpread(book) {
    const { bestBid, bestAsk } = getBestBidAsk(book);
    if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk))
        return 0.05;
    return Math.max(0, bestAsk - bestBid);
}
// ─── Mid-price via API ────────────────────────────────────────────────────────
/**
 * Fetch the live mid-price for a market outcome.
 * Uses adjustedMidpoint from the order book.
 */
async function getMidpoint(env, marketSlug, outcome = "yes") {
    try {
        const book = await (0, limitlessClient_1.getOrderBook)(env, marketSlug);
        if (outcome === "yes") {
            return getMidpointFromBook(book);
        }
        // NO outcome: mid-price ≈ 1 − YES mid (for binary markets)
        return 1 - getMidpointFromBook(book);
    }
    catch {
        return 0.5;
    }
}
// ─── Order placement ──────────────────────────────────────────────────────────
/**
 * Fetch the current user profile to get the numeric `ownerId`.
 * GET /profile
 */
async function getOwnerId(env) {
    const profile = await getJson(env, "/profile");
    const id = Number(profile.id ?? profile.profileId);
    if (!Number.isFinite(id) || id <= 0)
        throw new Error("Could not resolve Limitless ownerId from /profile");
    return id;
}
/**
 * Build EIP-712 typed-data for a Limitless GTC limit order.
 *
 * EIP-712 domain:
 *   name: "Limitless CTF Exchange"
 *   version: "1"
 *   chainId: 8453 (Base)
 *   verifyingContract: market.venue.exchange
 *
 * Order type (12 fields, matches limitless-exchange-ts-sdk signer.ts):
 *   salt, maker, signer, taker, tokenId, makerAmount, takerAmount,
 *   expiration, nonce, feeRateBps, side, signatureType
 */
function buildEip712Order(params) {
    const domain = {
        name: "Limitless CTF Exchange",
        version: "1",
        chainId: params.chainId ?? BASE_CHAIN_ID,
        verifyingContract: params.verifyingContract,
    };
    const types = {
        Order: [
            { name: "salt", type: "uint256" },
            { name: "maker", type: "address" },
            { name: "signer", type: "address" },
            { name: "taker", type: "address" },
            { name: "tokenId", type: "uint256" },
            { name: "makerAmount", type: "uint256" },
            { name: "takerAmount", type: "uint256" },
            { name: "expiration", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "feeRateBps", type: "uint256" },
            { name: "side", type: "uint8" },
            { name: "signatureType", type: "uint8" },
        ],
    };
    const salt = Math.floor(Math.random() * 1e15);
    const zeroAddr = "0x0000000000000000000000000000000000000000";
    const order = {
        salt: BigInt(salt),
        maker: params.maker,
        signer: params.maker,
        taker: zeroAddr,
        tokenId: BigInt(params.tokenId),
        makerAmount: params.makerAmount,
        takerAmount: params.takerAmount,
        expiration: BigInt(params.expiration),
        nonce: BigInt(params.nonce),
        feeRateBps: BigInt(params.feeRateBps),
        side: params.side,
        signatureType: SIGNATURE_TYPE_EOA,
    };
    return { domain, types, order, salt };
}
/**
 * Compute makerAmount / takerAmount for a GTC BUY order.
 *
 * BUY:  maker pays collateral (USDC) → receives shares
 *   makerAmount = ceil(shares × price × 1e6 / 1e6)  = ceil(size × price × 1e6)  [USDC scaled]
 *   takerAmount = size × 1e6                                                       [shares scaled]
 *
 * SELL: maker gives shares → receives collateral
 *   makerAmount = size × 1e6                                                       [shares]
 *   takerAmount = floor(size × price × 1e6)                                       [USDC]
 */
function computeAmounts(price, size, side) {
    const sharesBig = BigInt(Math.round(size * 1e6)); // shares × 1e6
    const priceBig = BigInt(Math.round(price * 1e6)); // price × 1e6
    // collateral = shares × price (both scaled by 1e6, so divide by 1e6 once)
    const collateralBig_raw = sharesBig * priceBig; // × 1e12 intermediate
    const collateralBig_ceil = (collateralBig_raw + SCALE - 1n) / SCALE; // ceil divide by 1e6 → 1e6 scale
    const collateralBig_floor = collateralBig_raw / SCALE;
    if (side === "BUY") {
        return { makerAmount: collateralBig_ceil, takerAmount: sharesBig };
    }
    else {
        return { makerAmount: sharesBig, takerAmount: collateralBig_floor };
    }
}
/**
 * Post a GTC limit order to Limitless Exchange.
 *
 * Required env vars:
 *   LIMITLESS_API_KEY          — REST auth
 *   LIMITLESS_TRADER_PRIVATE_KEY — EOA private key for EIP-712 signing
 *   LIMITLESS_TRADER_ADDRESS   — must match the private key's address
 *   LIMITLESS_FEE_RATE_BPS     — fee rate in basis points (default 200 = 2%)
 */
async function postLimitlessOrder(env, params) {
    assertLimitlessTradingConfig(env);
    const { Wallet } = await Promise.resolve().then(() => __importStar(require("ethers")));
    const privateKey = env.LIMITLESS_TRADER_PRIVATE_KEY;
    const wallet = new Wallet(privateKey);
    // ── Resolve market venue + tokenId ───────────────────────────────────────
    const market = await (0, limitlessClient_1.getMarketBySlug)(env, params.marketSlug);
    if (!market)
        throw new Error(`Market not found: ${params.marketSlug}`);
    if (!market.venue?.exchange)
        throw new Error(`Market ${params.marketSlug} has no venue.exchange address`);
    if (!market.tokens)
        throw new Error(`Market ${params.marketSlug} has no token IDs`);
    const tokenId = params.outcome === "yes" ? market.tokens.yes : market.tokens.no;
    const verifyingContract = market.venue.exchange;
    // ── Compute amounts ───────────────────────────────────────────────────────
    const { makerAmount, takerAmount } = computeAmounts(params.price, params.size, params.side);
    // ── Resolve ownerId ───────────────────────────────────────────────────────
    const ownerId = await getOwnerId(env);
    // ── Build + sign ──────────────────────────────────────────────────────────
    const expiration = params.expiration ?? Math.floor(Date.now() / 1000) + 300; // 5 min
    const nonce = Date.now();
    const feeRateBps = Number(env.LIMITLESS_FEE_RATE_BPS ?? 200);
    const sideInt = params.side === "BUY" ? SIDE_BUY : SIDE_SELL;
    const chainId = Number(env.LIMITLESS_CHAIN_ID ?? BASE_CHAIN_ID);
    const { domain, types, order, salt } = buildEip712Order({
        maker: wallet.address,
        tokenId,
        makerAmount,
        takerAmount,
        side: sideInt,
        expiration,
        nonce,
        feeRateBps,
        verifyingContract,
        chainId,
    });
    const signature = await wallet.signTypedData(domain, types, order);
    // ── POST /orders ──────────────────────────────────────────────────────────
    const body = {
        ownerId,
        orderType: params.orderType ?? "GTC",
        marketSlug: params.marketSlug,
        order: {
            salt: String(salt),
            maker: wallet.address,
            signer: wallet.address,
            taker: "0x0000000000000000000000000000000000000000",
            tokenId: String(tokenId),
            makerAmount: String(makerAmount),
            takerAmount: String(takerAmount),
            expiration: String(expiration),
            nonce: String(nonce),
            feeRateBps: String(feeRateBps),
            side: sideInt,
            signatureType: SIGNATURE_TYPE_EOA,
            signature,
        },
    };
    return postJson(env, "/orders", body);
}
// ─── Order status ─────────────────────────────────────────────────────────────
/**
 * GET /orders/status?ids=... — batch order status.
 */
async function getLimitlessOrder(env, orderId) {
    try {
        const raw = await getJson(env, `/orders/status`, { ids: orderId });
        if (raw?.orders?.length)
            return raw.orders[0];
        if (raw?.data?.length)
            return raw.data[0];
        if (raw?.status || raw?.orderId)
            return raw;
        return null;
    }
    catch {
        return null;
    }
}
// ─── Result helpers ───────────────────────────────────────────────────────────
function isAcceptedOrderResult(result) {
    if (!result)
        return false;
    if (result.success === false)
        return false;
    const s = String(result.status ?? "").toLowerCase();
    return s === "live" || s === "matched" || s === "open" || s === "delayed";
}
function getOrderRejectMessage(result) {
    if (!result)
        return "No order result";
    const status = String(result.status ?? "unknown");
    const msg = result.errorMsg ?? result.error ?? result.message;
    return msg ? `Order rejected (${status}): ${msg}` : `Order rejected (${status})`;
}
// ─── Config helpers ───────────────────────────────────────────────────────────
function assertLimitlessTradingConfig(env) {
    const missing = [];
    if (!env.LIMITLESS_API_KEY)
        missing.push("LIMITLESS_API_KEY");
    if (!env.LIMITLESS_TRADER_PRIVATE_KEY)
        missing.push("LIMITLESS_TRADER_PRIVATE_KEY");
    if (missing.length > 0) {
        throw new Error(`Limitless trading not configured. Missing: ${missing.join(", ")}`);
    }
}
function isLimitlessTradingReady(env) {
    const reasons = [];
    if (!env.LIMITLESS_API_KEY)
        reasons.push("LIMITLESS_API_KEY not set");
    if (!env.LIMITLESS_TRADER_PRIVATE_KEY)
        reasons.push("LIMITLESS_TRADER_PRIVATE_KEY not set");
    return { ready: reasons.length === 0, reasons };
}
