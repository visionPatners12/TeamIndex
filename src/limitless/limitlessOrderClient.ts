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

import type { Env } from "../config/env";
import { getOrderBook, getMarketBySlug } from "./limitlessClient";
import type { LimitlessOrderBook } from "./limitlessClient";
import { limitlessGetJson, limitlessRequestJson } from "./limitlessAuth";

// ─── Re-export LimitlessOrderBook for consumers ───────────────────────────────
export type { LimitlessOrderBook };

const BASE_CHAIN_ID = 8453;
const SCALE = 1_000_000n; // 1e6 (USDC 6 decimals)

// ─── Order types ──────────────────────────────────────────────────────────────

export type LimitlessOrderSide = "BUY" | "SELL";
export type LimitlessOrderType = "GTC" | "FOK";

/** Side enum values used in EIP-712 (uint8). */
const SIDE_BUY = 0;
const SIDE_SELL = 1;

/** signatureType: EOA = 0 (standard EOA sig). */
const SIGNATURE_TYPE_EOA = 0;
/** signatureType: ERC-1271 = 3 (smart contract wallet / vault sig). */
const SIGNATURE_TYPE_ERC1271 = 3;

export interface PostLimitlessOrderParams {
  /** Market slug (e.g. "will-eth-hit-4000-by-june-30"). */
  marketSlug: string;
  /** "yes" or "no" — which outcome to trade. */
  outcome: "yes" | "no";
  /** Entry price as a decimal in (0, 1), e.g. 0.65. */
  price: number;
  /** Size in USDC (human units), e.g. 100 for $100. */
  size: number;
  side: LimitlessOrderSide;
  orderType: LimitlessOrderType;
  /** Expiration unix timestamp (seconds). Default: now + 5 min. */
  expiration?: number;
  /** Optional smart-contract maker. When set, orders use ERC-1271 signatureType=3. */
  makerAddress?: string;
  /**
   * Limitless profile id that owns the order. For pool vaults this must be the
   * pool's partner-account profileId (pool_limitless_accounts.limitlessProfileId).
   * Falls back to the global /profiles/me id when omitted.
   */
  ownerId?: number;
  /** Override the signatureType (defaults: maker set → ERC-1271, else EOA). */
  signatureType?: number;
  /** Optional structured logger for order tracing. */
  log?: OrderLogger;
}

/** Minimal logger shape — satisfied by pino. */
export interface OrderLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

const noopLogger: OrderLogger = { info: () => {}, warn: () => {}, error: () => {} };

export interface LimitlessOrderResult {
  orderId?: string;
  id?: string;
  status?: string;   // "live" | "matched" | "rejected" | "cancelled" | "open"
  success?: boolean;
  errorMsg?: string;
  [k: string]: unknown;
}

async function getJson<T>(env: Env, path: string, params?: Record<string, unknown>): Promise<T> {
  return limitlessGetJson<T>(env, path, params);
}

async function postJson<T>(env: Env, path: string, body: unknown): Promise<T> {
  return limitlessRequestJson<T>(env, "POST", path, body);
}

// ─── Order book helpers ───────────────────────────────────────────────────────

export { getOrderBook };

/**
 * Get best bid and best ask from an order book.
 */
export function getBestBidAsk(book: LimitlessOrderBook): { bestBid: number; bestAsk: number } {
  const bids = book.bids.map(b => b.price).filter(Number.isFinite);
  const asks = book.asks.map(a => a.price).filter(Number.isFinite);
  const bestBid = bids.length ? Math.max(...bids) : 0;
  const bestAsk = asks.length ? Math.min(...asks) : 1;
  return { bestBid, bestAsk };
}

/**
 * Compute the mid-price: prefer `adjustedMidpoint` from Limitless, then (bid+ask)/2.
 */
export function getMidpointFromBook(book: LimitlessOrderBook): number {
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
export function calculateDepthAtSlippage(
  book: LimitlessOrderBook,
  refPrice: number,
  slippagePct = 0.02
): number {
  const maxPrice = refPrice * (1 + slippagePct);
  const asks = [...book.asks].sort((a, b) => a.price - b.price);
  let depth = 0;
  for (const { price, size } of asks) {
    if (price > maxPrice) break;
    depth += price * size;
  }
  return depth;
}

/**
 * Estimate price impact of buying `targetUsdc` by walking the ask side.
 */
export function estimateSlippage(book: LimitlessOrderBook, targetUsdc: number): number {
  const asks = [...book.asks].sort((a, b) => a.price - b.price);
  if (!asks.length) return 0.05;
  const bestAsk = asks[0].price;
  let remaining = targetUsdc;
  let worstPrice = bestAsk;
  for (const { price, size } of asks) {
    if (remaining <= 0) break;
    worstPrice = price;
    remaining -= Math.min(price * size, remaining);
  }
  return bestAsk > 0 ? Math.abs(worstPrice - bestAsk) / bestAsk : 0.05;
}

export function getSpread(book: LimitlessOrderBook): number {
  const { bestBid, bestAsk } = getBestBidAsk(book);
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return 0.05;
  return Math.max(0, bestAsk - bestBid);
}

// ─── Mid-price via API ────────────────────────────────────────────────────────

/**
 * Fetch the live mid-price for a market outcome.
 * Uses adjustedMidpoint from the order book.
 */
export async function getMidpoint(
  env: Env,
  marketSlug: string,
  outcome: "yes" | "no" = "yes"
): Promise<number> {
  try {
    const book = await getOrderBook(env, marketSlug);
    if (outcome === "yes") {
      return getMidpointFromBook(book);
    }
    // NO outcome: mid-price ≈ 1 − YES mid (for binary markets)
    return 1 - getMidpointFromBook(book);
  } catch {
    return 0.5;
  }
}

// ─── Order placement ──────────────────────────────────────────────────────────

/**
 * Fetch the current user profile to get the numeric `ownerId`.
 * Prefers GET /profiles/me (current docs); falls back to legacy GET /profile.
 * Only used as a fallback — pool bets pass an explicit per-account ownerId.
 */
async function getOwnerId(env: Env): Promise<number> {
  let profile: { id?: number; profileId?: number } | undefined;
  try {
    profile = await getJson<{ id?: number; profileId?: number }>(env, "/profiles/me");
  } catch {
    profile = await getJson<{ id?: number; profileId?: number }>(env, "/profile");
  }
  const id = Number(profile?.id ?? profile?.profileId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Could not resolve Limitless ownerId from /profiles/me");
  return id;
}

/** ERC-1271 signatureType value, overridable via env while the SDK value is confirmed. */
function erc1271SignatureType(env: Env): number {
  const raw = (env as any).LIMITLESS_SIGNATURE_TYPE;
  const n = Number(raw);
  return Number.isFinite(n) && raw !== undefined && raw !== "" ? n : SIGNATURE_TYPE_ERC1271;
}

/** Clamp a price into Limitless' accepted GTC range [0.01, 0.99]. */
function clampOrderPrice(price: number): number {
  if (!Number.isFinite(price)) return 0.5;
  return Math.min(0.99, Math.max(0.01, price));
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
function buildEip712Order(params: {
  maker: string;
  tokenId: string;        // uint256 as string
  makerAmount: bigint;
  takerAmount: bigint;
  side: 0 | 1;            // 0=BUY, 1=SELL
  expiration: number;
  nonce: number;
  feeRateBps: number;
  signatureType: number;
  verifyingContract: string;
  chainId?: number;
}) {
  const domain = {
    name: "Limitless CTF Exchange",
    version: "1",
    chainId: params.chainId ?? BASE_CHAIN_ID,
    verifyingContract: params.verifyingContract,
  };

  const types = {
    Order: [
      { name: "salt",            type: "uint256" },
      { name: "maker",           type: "address" },
      { name: "signer",          type: "address" },
      { name: "taker",           type: "address" },
      { name: "tokenId",         type: "uint256" },
      { name: "makerAmount",     type: "uint256" },
      { name: "takerAmount",     type: "uint256" },
      { name: "expiration",      type: "uint256" },
      { name: "nonce",           type: "uint256" },
      { name: "feeRateBps",      type: "uint256" },
      { name: "side",            type: "uint8"   },
      { name: "signatureType",   type: "uint8"   },
    ],
  };

  const salt = Math.floor(Math.random() * 1e15);
  const zeroAddr = "0x0000000000000000000000000000000000000000";

  const order = {
    salt:          BigInt(salt),
    maker:         params.maker,
    signer:        params.maker,
    taker:         zeroAddr,
    tokenId:       BigInt(params.tokenId),
    makerAmount:   params.makerAmount,
    takerAmount:   params.takerAmount,
    expiration:    BigInt(params.expiration),
    nonce:         BigInt(params.nonce),
    feeRateBps:    BigInt(params.feeRateBps),
    side:          params.side,
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
function computeAmounts(
  price: number,
  size: number,
  side: LimitlessOrderSide
): { makerAmount: bigint; takerAmount: bigint } {
  const sharesBig = BigInt(Math.round(size * 1e6));                        // shares × 1e6
  const priceBig  = BigInt(Math.round(price * 1e6));                       // price × 1e6
  // collateral = shares × price (both scaled by 1e6, so divide by 1e6 once)
  const collateralBig_raw = sharesBig * priceBig;                          // × 1e12 intermediate
  const collateralBig_ceil = (collateralBig_raw + SCALE - 1n) / SCALE;    // ceil divide by 1e6 → 1e6 scale
  const collateralBig_floor = collateralBig_raw / SCALE;

  if (side === "BUY") {
    return { makerAmount: collateralBig_ceil, takerAmount: sharesBig };
  } else {
    return { makerAmount: sharesBig, takerAmount: collateralBig_floor };
  }
}

/**
 * Post a GTC limit order to Limitless Exchange.
 *
 * Required env vars:
 *   LIMITLESS_API_KEY          — REST auth
 *   LIMITLESS_ORDER_SIGNER_PRIVATE_KEY — EOA authorized by each vault via setOrderSigner
 *   LIMITLESS_TRADER_PRIVATE_KEY       — legacy fallback for EIP-712 signing
 *   LIMITLESS_FEE_RATE_BPS     — fee rate in basis points (default 200 = 2%)
 */
export async function postLimitlessOrder(
  env: Env,
  params: PostLimitlessOrderParams
): Promise<LimitlessOrderResult> {
  const log = params.log ?? noopLogger;
  assertLimitlessTradingConfig(env);

  const { Wallet } = await import("ethers");
  const privateKey = getLimitlessOrderSignerPrivateKey(env);
  if (!privateKey) throw new Error("Limitless order signer private key missing");
  const wallet = new Wallet(privateKey);

  // ── Resolve market venue + tokenId ───────────────────────────────────────
  const market = await getMarketBySlug(env, params.marketSlug);
  if (!market) throw new Error(`Market not found: ${params.marketSlug}`);
  if (!market.venue?.exchange) throw new Error(`Market ${params.marketSlug} has no venue.exchange address`);
  if (!market.tokens) throw new Error(`Market ${params.marketSlug} has no token IDs`);

  const tokenId = params.outcome === "yes" ? market.tokens.yes : market.tokens.no;
  const verifyingContract = market.venue.exchange;

  // ── Compute amounts ───────────────────────────────────────────────────────
  const price = clampOrderPrice(params.price);
  const { makerAmount, takerAmount } = computeAmounts(price, params.size, params.side);

  // ── Resolve ownerId (per-pool partner account preferred) ──────────────────
  const ownerId = params.ownerId ?? (await getOwnerId(env));

  // ── Build + sign ──────────────────────────────────────────────────────────
  // Limitless GTC requires expiration "0" and nonce 0 (non-zero values are rejected).
  const expiration = 0;
  const nonce = 0;
  const feeRateBps = Number((env as any).LIMITLESS_FEE_RATE_BPS ?? 200);
  const sideInt: 0 | 1 = params.side === "BUY" ? SIDE_BUY : SIDE_SELL;

  const chainId = Number((env as any).LIMITLESS_CHAIN_ID ?? BASE_CHAIN_ID);
  const makerAddress = params.makerAddress ?? wallet.address;
  const signatureType =
    params.signatureType ?? (params.makerAddress ? erc1271SignatureType(env) : SIGNATURE_TYPE_EOA);

  log.info(
    {
      marketSlug: params.marketSlug,
      outcome: params.outcome,
      side: params.side,
      ownerId,
      maker: makerAddress,
      signerEoa: wallet.address,
      signatureType,
      verifyingContract,
      tokenId: String(tokenId),
      price,
      sizeUsd: params.size,
      makerAmount: String(makerAmount),
      takerAmount: String(takerAmount),
      feeRateBps,
    },
    "limitless order: building + signing"
  );

  const { domain, types, order, salt } = buildEip712Order({
    maker: makerAddress,
    tokenId,
    makerAmount,
    takerAmount,
    side: sideInt,
    expiration,
    nonce,
    feeRateBps,
    signatureType,
    verifyingContract,
    chainId,
  });

  const signature = await wallet.signTypedData(domain, types, order);

  // ── POST /orders ──────────────────────────────────────────────────────────
  const requestBody = {
    ownerId,
    orderType: params.orderType ?? "GTC",
    marketSlug: params.marketSlug,
    order: {
      salt: String(salt),
      maker: makerAddress,
      signer: makerAddress,
      taker: "0x0000000000000000000000000000000000000000",
      tokenId: String(tokenId),
      makerAmount: String(makerAmount),
      takerAmount: String(takerAmount),
      expiration: String(expiration),
      nonce: String(nonce),
      price,
      feeRateBps: String(feeRateBps),
      side: sideInt,
      signatureType,
      signature,
    },
  };

  try {
    const result = await postJson<LimitlessOrderResult>(env, "/orders", requestBody);
    log.info(
      { marketSlug: params.marketSlug, ownerId, status: result?.status, orderId: result?.orderId ?? result?.id },
      "limitless order: posted"
    );
    return result;
  } catch (e: any) {
    log.error(
      { marketSlug: params.marketSlug, ownerId, maker: makerAddress, err: e?.message ?? String(e) },
      "limitless order: POST /orders failed"
    );
    throw e;
  }
}

// ─── Order status ─────────────────────────────────────────────────────────────

/**
 * GET /orders/status?ids=... — batch order status.
 */
export async function getLimitlessOrder(
  env: Env,
  orderId: string
): Promise<LimitlessOrderResult | null> {
  try {
    const raw = await getJson<
      LimitlessOrderResult | { orders?: LimitlessOrderResult[]; data?: LimitlessOrderResult[] }
    >(env, `/orders/status`, { ids: orderId });

    if ((raw as any)?.orders?.length) return (raw as any).orders[0];
    if ((raw as any)?.data?.length) return (raw as any).data[0];
    if ((raw as any)?.status || (raw as any)?.orderId) return raw as LimitlessOrderResult;
    return null;
  } catch {
    return null;
  }
}

// ─── Result helpers ───────────────────────────────────────────────────────────

export function isAcceptedOrderResult(result: LimitlessOrderResult | null): boolean {
  if (!result) return false;
  if (result.success === false) return false;
  const s = String(result.status ?? "").toLowerCase();
  return s === "live" || s === "matched" || s === "open" || s === "delayed";
}

export function getOrderRejectMessage(result: LimitlessOrderResult | null): string {
  if (!result) return "No order result";
  const status = String(result.status ?? "unknown");
  const msg = result.errorMsg ?? (result as any).error ?? (result as any).message;
  return msg ? `Order rejected (${status}): ${msg}` : `Order rejected (${status})`;
}

// ─── Config helpers ───────────────────────────────────────────────────────────

function getLimitlessOrderSignerPrivateKey(env: Env): string | undefined {
  return (env as any).LIMITLESS_ORDER_SIGNER_PRIVATE_KEY || (env as any).LIMITLESS_TRADER_PRIVATE_KEY;
}

export function assertLimitlessTradingConfig(env: Env): void {
  const missing: string[] = [];
  if (!(env as any).LIMITLESS_API_KEY) missing.push("LIMITLESS_API_KEY");
  if (!(env as any).LIMITLESS_API_SECRET) missing.push("LIMITLESS_API_SECRET");
  if (!getLimitlessOrderSignerPrivateKey(env)) {
    missing.push("LIMITLESS_ORDER_SIGNER_PRIVATE_KEY");
  }
  if (missing.length > 0) {
    throw new Error(`Limitless trading not configured. Missing: ${missing.join(", ")}`);
  }
}

export function isLimitlessTradingReady(env: Env): { ready: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!(env as any).LIMITLESS_API_KEY) reasons.push("LIMITLESS_API_KEY not set");
  if (!(env as any).LIMITLESS_API_SECRET) reasons.push("LIMITLESS_API_SECRET not set");
  if (!getLimitlessOrderSignerPrivateKey(env)) {
    reasons.push("LIMITLESS_ORDER_SIGNER_PRIVATE_KEY not set");
  }
  return { ready: reasons.length === 0, reasons };
}
