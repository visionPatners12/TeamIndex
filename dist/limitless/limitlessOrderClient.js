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
 * Auth: HMAC (lmts-api-key / lmts-timestamp / lmts-signature) via limitlessAuth.
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
exports.extractExpectedExchangeAddress = extractExpectedExchangeAddress;
exports.quoteLimitlessOrderAmounts = quoteLimitlessOrderAmounts;
exports.postLimitlessOrder = postLimitlessOrder;
exports.getLimitlessOrder = getLimitlessOrder;
exports.isAcceptedOrderResult = isAcceptedOrderResult;
exports.getOrderRejectMessage = getOrderRejectMessage;
exports.assertLimitlessTradingConfig = assertLimitlessTradingConfig;
exports.isLimitlessTradingReady = isLimitlessTradingReady;
const limitlessClient_1 = require("./limitlessClient");
Object.defineProperty(exports, "getOrderBook", { enumerable: true, get: function () { return limitlessClient_1.getOrderBook; } });
const limitlessAuth_1 = require("./limitlessAuth");
const BASE_CHAIN_ID = 8453;
const SCALE = 1000000n; // 1e6 (USDC 6 decimals)
/** Side enum values used in EIP-712 (uint8). */
const SIDE_BUY = 0;
const SIDE_SELL = 1;
/** signatureType: EOA = 0 (standard EOA sig). */
const SIGNATURE_TYPE_EOA = 0;
/** signatureType: smart contract wallet / ERC-1271-compatible signature. */
const SIGNATURE_TYPE_ERC1271 = 2;
const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const noopLogger = { info: () => { }, warn: () => { }, error: () => { } };
async function getJson(env, path, params) {
    return (0, limitlessAuth_1.limitlessGetJson)(env, path, params);
}
async function postJson(env, path, body) {
    return (0, limitlessAuth_1.limitlessRequestJson)(env, "POST", path, body);
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
 * Prefers GET /profiles/me (current docs); falls back to legacy GET /profile.
 * Only used as a fallback — pool bets pass an explicit per-account ownerId.
 */
async function getOwnerId(env) {
    let profile;
    try {
        profile = await getJson(env, "/profiles/me");
    }
    catch {
        profile = await getJson(env, "/profile");
    }
    const id = Number(profile?.id ?? profile?.profileId);
    if (!Number.isFinite(id) || id <= 0)
        throw new Error("Could not resolve Limitless ownerId from /profiles/me");
    return id;
}
/** ERC-1271 signatureType value, overridable via env if Limitless changes it. */
function erc1271SignatureType(env) {
    const raw = env.LIMITLESS_SIGNATURE_TYPE;
    const n = Number(raw);
    return Number.isFinite(n) && raw !== undefined && raw !== "" ? n : SIGNATURE_TYPE_ERC1271;
}
/** Clamp a price into Limitless' accepted GTC range [0.01, 0.99]. */
function clampOrderPrice(price) {
    if (!Number.isFinite(price))
        return 0.5;
    return Math.min(0.99, Math.max(0.01, price));
}
function extractExpectedExchangeAddress(errorMessage) {
    const match = errorMessage.match(/Exchange address for this market:\s*(0x[a-fA-F0-9]{40})/i);
    return match?.[1] ?? null;
}
function isInvalidSignatureError(errorMessage) {
    return /Invalid signature/i.test(errorMessage);
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
        signatureType: params.signatureType,
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
function quoteLimitlessOrderAmounts(price, size, side) {
    const clampedPrice = clampOrderPrice(price);
    return {
        price: clampedPrice,
        ...computeAmounts(clampedPrice, size, side),
    };
}
/**
 * Post a GTC limit order to Limitless Exchange.
 *
 * Required env vars:
 *   LIMITLESS_API_KEY          — REST auth
 *   LIMITLESS_ORDER_SIGNER_PRIVATE_KEY — EOA authorized by each vault via setOrderSigner
 *   LIMITLESS_TRADER_PRIVATE_KEY       — legacy fallback for EIP-712 signing
 *   LIMITLESS_FEE_RATE_BPS     — fee ceiling in basis points (default 300 = 3%)
 */
async function postLimitlessOrder(env, params) {
    const log = params.log ?? noopLogger;
    assertLimitlessTradingConfig(env);
    const signingMode = params.signingMode ?? "signed";
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
    const { price, makerAmount, takerAmount } = quoteLimitlessOrderAmounts(params.price, params.size, params.side);
    // ── Build + sign ──────────────────────────────────────────────────────────
    // Limitless GTC requires expiration "0" and nonce 0 (non-zero values are rejected).
    const expiration = 0;
    const nonce = 0;
    const feeRateBps = Number(params.feeRateBps ?? env.LIMITLESS_FEE_RATE_BPS ?? 300);
    if (!Number.isInteger(feeRateBps) || feeRateBps <= 0) {
        throw new Error(`Invalid Limitless feeRateBps: ${feeRateBps}`);
    }
    const sideInt = params.side === "BUY" ? SIDE_BUY : SIDE_SELL;
    if (signingMode === "server-wallet") {
        const ownerId = params.onBehalfOf ?? params.ownerId;
        if (!ownerId || !Number.isFinite(ownerId) || ownerId <= 0) {
            throw new Error("Limitless server-wallet mode requires onBehalfOf/profileId");
        }
        const makerAddress = params.makerAddress;
        if (!makerAddress || !ETH_ADDRESS_RE.test(makerAddress)) {
            throw new Error("Limitless server-wallet mode requires makerAddress/server wallet address");
        }
        const salt = Math.floor(Math.random() * 1e15);
        const requestBody = {
            ownerId,
            onBehalfOf: ownerId,
            orderType: params.orderType ?? "GTC",
            marketSlug: params.marketSlug,
            order: {
                salt: String(salt),
                maker: makerAddress,
                signer: makerAddress,
                taker: "0x0000000000000000000000000000000000000000",
                tokenId: String(tokenId),
                makerAmount: Number(makerAmount),
                takerAmount: Number(takerAmount),
                expiration: String(expiration),
                nonce,
                price,
                feeRateBps,
                side: sideInt,
            },
        };
        log.info({
            marketSlug: params.marketSlug,
            outcome: params.outcome,
            side: params.side,
            ownerId,
            maker: makerAddress,
            signingMode,
            tokenId: String(tokenId),
            price,
            sizeUsd: params.size,
            makerAmount: String(makerAmount),
            takerAmount: String(takerAmount),
            feeRateBps,
        }, "limitless order: posting delegated server-wallet order");
        try {
            const result = await postJson(env, "/orders", requestBody);
            log.info({
                marketSlug: params.marketSlug,
                ownerId,
                maker: makerAddress,
                signingMode,
                status: result?.status,
                orderId: result?.orderId ?? result?.id,
            }, "limitless order: delegated server-wallet order posted");
            return result;
        }
        catch (e) {
            const baseMessage = e instanceof Error ? e.message : String(e);
            throw new Error(`${baseMessage} | orderPostAttempts=${JSON.stringify([
                {
                    signingMode,
                    ownerId,
                    onBehalfOf: ownerId,
                    maker: makerAddress,
                    tokenId: String(tokenId),
                    price,
                    makerAmount: String(makerAmount),
                    takerAmount: String(takerAmount),
                    error: e?.message ?? String(e),
                },
            ])}`);
        }
    }
    const { Wallet, verifyTypedData } = await Promise.resolve().then(() => __importStar(require("ethers")));
    const privateKey = getLimitlessOrderSignerPrivateKey(env);
    if (!privateKey)
        throw new Error("Limitless order signer private key missing");
    const wallet = new Wallet(privateKey);
    const ownerId = params.ownerId ?? (await getOwnerId(env));
    const onBehalfOf = params.onBehalfOf ?? params.ownerId;
    const chainId = Number(env.LIMITLESS_CHAIN_ID ?? BASE_CHAIN_ID);
    const makerAddress = params.makerAddress ?? wallet.address;
    const signatureTypeOverride = params.signatureType !== undefined ||
        (env.LIMITLESS_SIGNATURE_TYPE !== undefined && env.LIMITLESS_SIGNATURE_TYPE !== "");
    const signatureType = params.signatureType ?? (params.makerAddress ? erc1271SignatureType(env) : SIGNATURE_TYPE_EOA);
    const attempts = [];
    async function signAndPost(exchangeAddress, exchangeSource, attemptSignatureType) {
        log.info({
            marketSlug: params.marketSlug,
            outcome: params.outcome,
            side: params.side,
            ownerId,
            onBehalfOf,
            maker: makerAddress,
            signerEoa: wallet.address,
            signatureType: attemptSignatureType,
            verifyingContract: exchangeAddress,
            exchangeSource,
            tokenId: String(tokenId),
            price,
            sizeUsd: params.size,
            makerAmount: String(makerAmount),
            takerAmount: String(takerAmount),
            feeRateBps,
        }, "limitless order: building + signing");
        const { domain, types, order, salt } = buildEip712Order({
            maker: makerAddress,
            tokenId,
            makerAmount,
            takerAmount,
            side: sideInt,
            expiration,
            nonce,
            feeRateBps,
            signatureType: attemptSignatureType,
            verifyingContract: exchangeAddress,
            chainId,
        });
        const signature = await wallet.signTypedData(domain, types, order);
        const recoveredSigner = verifyTypedData(domain, types, order, signature);
        const attempt = {
            exchangeSource,
            verifyingContract: exchangeAddress,
            signatureType: attemptSignatureType,
            ownerId,
            onBehalfOf,
            maker: makerAddress,
            signer: makerAddress,
            recoveredSigner,
        };
        attempts.push(attempt);
        const requestBody = {
            ownerId,
            ...(onBehalfOf !== undefined ? { onBehalfOf } : {}),
            orderType: params.orderType ?? "GTC",
            marketSlug: params.marketSlug,
            order: {
                // Limitless expects: salt/tokenId/expiration as strings, but
                // makerAmount/takerAmount/nonce/feeRateBps as NUMBERS. The EIP-712 signature is
                // over the numeric values, so the JSON representation just has to match them.
                salt: String(salt),
                maker: makerAddress,
                signer: makerAddress,
                taker: "0x0000000000000000000000000000000000000000",
                tokenId: String(tokenId),
                makerAmount: Number(makerAmount),
                takerAmount: Number(takerAmount),
                expiration: String(expiration),
                nonce: nonce,
                price,
                feeRateBps: feeRateBps,
                side: sideInt,
                signatureType: attemptSignatureType,
                signature,
            },
        };
        try {
            const result = await postJson(env, "/orders", requestBody);
            log.info({
                marketSlug: params.marketSlug,
                ownerId,
                verifyingContract: exchangeAddress,
                exchangeSource,
                signatureType: attemptSignatureType,
                recoveredSigner,
                status: result?.status,
                orderId: result?.orderId ?? result?.id,
            }, "limitless order: posted");
            return result;
        }
        catch (e) {
            attempt.error = e?.message ?? String(e);
            throw e;
        }
    }
    function withAttemptContext(error) {
        const baseMessage = error instanceof Error ? error.message : String(error);
        return new Error(`${baseMessage} | orderPostAttempts=${JSON.stringify(attempts)}`);
    }
    try {
        return await signAndPost(verifyingContract, "market", signatureType);
    }
    catch (e) {
        const expectedExchange = extractExpectedExchangeAddress(String(e?.message ?? e));
        if (expectedExchange && expectedExchange.toLowerCase() !== verifyingContract.toLowerCase()) {
            log.warn({
                marketSlug: params.marketSlug,
                ownerId,
                maker: makerAddress,
                venueExchange: verifyingContract,
                expectedExchange,
                err: e?.message ?? String(e),
            }, "limitless order: retrying with exchange address returned by API");
            try {
                return await signAndPost(expectedExchange, "api-retry", signatureType);
            }
            catch (retryErr) {
                if (params.makerAddress &&
                    !signatureTypeOverride &&
                    signatureType !== 3 &&
                    isInvalidSignatureError(String(retryErr?.message ?? retryErr))) {
                    log.warn({
                        marketSlug: params.marketSlug,
                        ownerId,
                        maker: makerAddress,
                        expectedExchange,
                        previousSignatureType: signatureType,
                        retrySignatureType: 3,
                    }, "limitless order: retrying ERC-1271 signatureType=3");
                    try {
                        return await signAndPost(expectedExchange, "signature-type-retry", 3);
                    }
                    catch (signatureTypeErr) {
                        log.error({
                            marketSlug: params.marketSlug,
                            ownerId,
                            maker: makerAddress,
                            attempts,
                            err: signatureTypeErr?.message ?? String(signatureTypeErr),
                        }, "limitless order: signatureType retry failed");
                        throw withAttemptContext(signatureTypeErr);
                    }
                }
                log.error({
                    marketSlug: params.marketSlug,
                    ownerId,
                    maker: makerAddress,
                    venueExchange: verifyingContract,
                    expectedExchange,
                    err: retryErr?.message ?? String(retryErr),
                }, "limitless order: retry with API exchange failed");
                throw withAttemptContext(retryErr);
            }
        }
        if (params.makerAddress &&
            !signatureTypeOverride &&
            signatureType !== 3 &&
            isInvalidSignatureError(String(e?.message ?? e))) {
            log.warn({
                marketSlug: params.marketSlug,
                ownerId,
                maker: makerAddress,
                verifyingContract,
                previousSignatureType: signatureType,
                retrySignatureType: 3,
            }, "limitless order: retrying ERC-1271 signatureType=3");
            try {
                return await signAndPost(verifyingContract, "signature-type-retry", 3);
            }
            catch (signatureTypeErr) {
                log.error({
                    marketSlug: params.marketSlug,
                    ownerId,
                    maker: makerAddress,
                    attempts,
                    err: signatureTypeErr?.message ?? String(signatureTypeErr),
                }, "limitless order: signatureType retry failed");
                throw withAttemptContext(signatureTypeErr);
            }
        }
        log.error({ marketSlug: params.marketSlug, ownerId, maker: makerAddress, attempts, err: e?.message ?? String(e) }, "limitless order: POST /orders failed");
        throw withAttemptContext(e);
    }
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
function getLimitlessOrderSignerPrivateKey(env) {
    return env.LIMITLESS_ORDER_SIGNER_PRIVATE_KEY || env.LIMITLESS_TRADER_PRIVATE_KEY;
}
function assertLimitlessTradingConfig(env) {
    const missing = [];
    if (!env.LIMITLESS_API_KEY)
        missing.push("LIMITLESS_API_KEY");
    if (!env.LIMITLESS_API_SECRET)
        missing.push("LIMITLESS_API_SECRET");
    if (!getLimitlessOrderSignerPrivateKey(env)) {
        missing.push("LIMITLESS_ORDER_SIGNER_PRIVATE_KEY");
    }
    if (missing.length > 0) {
        throw new Error(`Limitless trading not configured. Missing: ${missing.join(", ")}`);
    }
}
function isLimitlessTradingReady(env) {
    const reasons = [];
    if (!env.LIMITLESS_API_KEY)
        reasons.push("LIMITLESS_API_KEY not set");
    if (!env.LIMITLESS_API_SECRET)
        reasons.push("LIMITLESS_API_SECRET not set");
    if (!getLimitlessOrderSignerPrivateKey(env)) {
        reasons.push("LIMITLESS_ORDER_SIGNER_PRIVATE_KEY not set");
    }
    return { ready: reasons.length === 0, reasons };
}
