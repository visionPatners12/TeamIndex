/**
 * Polymarket Allocation Proposal Engine — v2 (quant pipeline)
 *
 * Multi-Factor Risk-Budgeted Allocation:
 *   0. Time-series feature extraction in LOGIT space (vol, momentum t-stat,
 *      variance-ratio persistence, drawdown) — the correct transform for
 *      probability series.
 *   1. Elimination hypotheses (documented hard gates).
 *   2. Edge model → implied probability q (favorite-longshot prior +
 *      momentum/volume confirmation − round-trip cost). f* = (q−p)/(1−p).
 *   3. Risk model: position vols + shrunk logit-return correlation → Σ.
 *   4. Sizing: ERC backbone (equal risk contribution) tilted toward the
 *      Kelly/Markowitz direction Σ⁻¹μ, by an edge-confidence weight.
 *   5. Gross exposure via volatility targeting, clamped to [MIN, MAX].
 *   6. Constraint projection (per-market / event / cluster / liquidity /
 *      depth / total) with water-filling.
 *
 * Does NOT execute trades — display only.
 */

import type {
  SelectedMarket,
  MarketClobData,
  MarketSide,
  ScoredAllocation,
  RejectedMarket,
  AllocationProposal,
} from "./allocationTypes";

// ─── Config ────────────────────────────────────────────────────────────────

// Exposure & concentration limits
const MAX_EXPOSURE     = 0.80;  // max invested fraction of NAV
const MIN_EXPOSURE     = 0.30;  // min invested fraction of NAV
const MAX_PER_MARKET   = 0.08;  // 8% NAV
const MAX_PER_EVENT    = 0.15;  // 15% NAV
const MAX_PER_CLUSTER  = 0.25;  // 25% NAV
const MAX_BY_LIQUIDITY = 0.10;  // 10% of market liquidity
const MAX_BY_DEPTH_PCT = 0.50;  // 50% of depth @ 2% slippage

// Elimination thresholds
const MIN_DAYS_TO_RESOLUTION = 0.5;     // reject if resolving within ~12h
const MAX_SPREAD             = 0.06;    // 6¢
const MAX_SLIPPAGE           = 0.04;    // 4%
const MIN_LIQUIDITY          = 5_000;   // USDC
const MIN_DEPTH              = 1_000;   // USDC @ 2% slippage
const MIN_VOLUME_24H         = 500;     // USDC
const PRICE_BAND_LOW         = 0.05;    // longshot floor
const PRICE_BAND_HIGH        = 0.97;    // favorite ceiling
const MIN_HISTORY_OBS        = 4;       // points needed to trust time series
const MAX_REALIZED_VOL       = 1.20;    // logit-vol/step ceiling
const MAX_DRAWDOWN_REJECT    = 0.60;

// Edge model (all small, documented priors)
const FLB_KAPPA      = 0.015;  // max favorite-longshot probability tilt (≈1.5¢)
const MOM_GAMMA      = 0.020;  // max momentum probability tilt (≈2¢)
const TAKER_FEE      = 0.0;    // Polymarket taker fee hook (currently 0)
const MAX_EDGE_DELTA = 0.05;   // cap |q − p| at 5¢
// Max lean toward the Kelly direction (< 1 ⇒ fractional Kelly; rest stays ERC).
// True fractional-Kelly conservatism also lives in the conservative TARGET_VOL.
const TILT_MAX       = 0.60;

// Risk model
const TARGET_VOL       = 0.12;  // holding-period portfolio vol target on NAV
const VOL_FLOOR        = 0.02;
const VOL_CAP          = 1.50;
const HORIZON_CAP_DAYS = 30;
const SHRINK_K         = 8;     // correlation shrinkage pseudo-count
const RIDGE_EPS        = 1e-4;  // covariance ridge

const QUALITY_THRESHOLD = 0.55;
const CORRELATION_INDEPENDENT_THRESHOLD = 0.50;

const EPS = 1e-4;

// ─── Scalar helpers ──────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
  return Math.sqrt(Math.max(0, v));
}
function logit(p: number): number {
  const q = clamp(p, EPS, 1 - EPS);
  return Math.log(q / (1 - q));
}

// ─── Linear algebra (n is small: a handful of markets) ────────────────────────

/** Solve A·x = b via Gaussian elimination w/ partial pivoting. null if singular. */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  if (n === 0) return [];
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / d;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}
function matVec(A: number[][], x: number[]): number[] {
  return A.map(row => row.reduce((s, a, j) => s + a * x[j], 0));
}
function quadForm(A: number[][], x: number[]): number {
  const Ax = matVec(A, x);
  return x.reduce((s, xi, i) => s + xi * Ax[i], 0);
}

// ─── Time-series features (logit space) ───────────────────────────────────────

interface TsSeries { t: number[]; p: number[]; } // chosen-side prices, sorted by t

function chosenSideSeries(history: Array<{ t: number; p: number }>, side: MarketSide): TsSeries {
  const cleaned = (history ?? [])
    .filter(h => Number.isFinite(h.t) && Number.isFinite(h.p) && h.p > 0 && h.p < 1)
    .slice()
    .sort((a, b) => a.t - b.t);
  return {
    t: cleaned.map(h => h.t),
    p: cleaned.map(h => (side === "YES" ? h.p : 1 - h.p)),
  };
}

interface TsFeatures {
  obs: number;
  realizedVol: number;    // stdev of per-step logit returns
  momentumZ: number;      // drift t-stat (signed toward chosen side)
  varianceRatio: number;  // >1 trending, <1 mean-reverting, ~1 random walk
  maxDrawdown: number;    // in chosen-side price space
  hasData: boolean;
}

function computeTsFeatures(s: TsSeries): TsFeatures {
  const obs = s.p.length;
  if (obs < 2) {
    return { obs, realizedVol: 0, momentumZ: 0, varianceRatio: 1, maxDrawdown: 0, hasData: false };
  }
  const r: number[] = [];
  for (let i = 1; i < obs; i++) r.push(logit(s.p[i]) - logit(s.p[i - 1]));
  const vol = stdev(r);
  const steps = r.length;

  const totalDrift = logit(s.p[obs - 1]) - logit(s.p[0]);
  const momentumZ = vol > 1e-9 && steps > 0 ? totalDrift / (vol * Math.sqrt(steps)) : 0;

  let varianceRatio = 1;
  const k = Math.max(2, Math.min(5, Math.floor(steps / 3)));
  if (steps >= k * 2 && vol > 1e-9) {
    const kret: number[] = [];
    for (let i = k; i < obs; i++) kret.push(logit(s.p[i]) - logit(s.p[i - k]));
    const varK = stdev(kret) ** 2;
    const var1 = vol * vol;
    varianceRatio = var1 > 1e-12 ? varK / (k * var1) : 1;
  }

  let peak = s.p[0], mdd = 0;
  for (const x of s.p) {
    if (x > peak) peak = x;
    const dd = peak > 0 ? (peak - x) / peak : 0;
    if (dd > mdd) mdd = dd;
  }

  return { obs, realizedVol: vol, momentumZ, varianceRatio, maxDrawdown: mdd, hasData: obs >= MIN_HISTORY_OBS };
}

function resolutionScore(days: number): number {
  if (days <= 0)   return 0;
  if (days <= 1)   return 0.35;
  if (days <= 7)   return 0.90;
  if (days <= 21)  return 1.00;
  if (days <= 60)  return 0.75;
  if (days <= 120) return 0.55;
  return 0.35;
}

// ─── Elimination hypotheses ────────────────────────────────────────────────────

function getRejectionReason(clob: MarketClobData, entryPrice: number, ts: TsFeatures): string | null {
  if (clob.marketStatus === "closed")                  return "Market is closed";
  if (clob.daysToResolution <= MIN_DAYS_TO_RESOLUTION) return "Resolves too soon (< 12h)";
  if (clob.spread > MAX_SPREAD)                        return `Spread too wide (> ${(MAX_SPREAD * 100).toFixed(0)}¢)`;
  if (clob.estimatedSlippage > MAX_SLIPPAGE)           return `Slippage too high (> ${(MAX_SLIPPAGE * 100).toFixed(0)}%)`;
  if (clob.liquidity < MIN_LIQUIDITY)                  return "Liquidity below tradeable floor";
  if (clob.depthAt2PctSlippage < MIN_DEPTH)            return "Order-book depth too thin";
  if (clob.volume24h < MIN_VOLUME_24H)                 return "Stale market (low 24h volume)";
  if (entryPrice < PRICE_BAND_LOW)                     return "Longshot outside investable band (< 5¢)";
  if (entryPrice > PRICE_BAND_HIGH)                    return "No upside: priced near-certain (> 97¢)";
  if (ts.hasData && ts.realizedVol > MAX_REALIZED_VOL) return "Excessive price volatility";
  if (ts.hasData && ts.maxDrawdown > MAX_DRAWDOWN_REJECT) return "Severe historical drawdown (> 60%)";
  return null;
}

// ─── Edge model ────────────────────────────────────────────────────────────────

/** Favorite-longshot prior: + for favorites, − for longshots, 0 at 0.5 & extremes. */
function favLongshotEdge(p: number): number {
  const x = 2 * p - 1;                 // ∈ [-1, 1]
  return FLB_KAPPA * 4 * x * (1 - Math.abs(x));
}

/** Momentum tilt, confirmed by volume and trend persistence. */
function momentumEdge(ts: TsFeatures, volume24h: number): number {
  if (!ts.hasData) return 0;
  const volConfirm   = clamp(volume24h / 20_000, 0, 1);
  const persistFactor = clamp(ts.varianceRatio, 0.5, 1.5); // 1 = neutral
  const signal       = Math.tanh(ts.momentumZ / 2);        // squashed t-stat
  return MOM_GAMMA * signal * volConfirm * persistFactor;
}

/** Round-trip transaction cost in price units. */
function roundTripCost(clob: MarketClobData): number {
  return clob.spread + clob.estimatedSlippage + 2 * TAKER_FEE;
}

interface Edge { delta: number; impliedQ: number; kelly: number; edgeReturn: number; }

function computeEdge(entryPrice: number, ts: TsFeatures, clob: MarketClobData): Edge {
  const flb  = favLongshotEdge(entryPrice);
  const mom  = momentumEdge(ts, clob.volume24h);
  const cost = roundTripCost(clob);
  const delta = clamp(flb + mom - cost, -MAX_EDGE_DELTA, MAX_EDGE_DELTA);
  const impliedQ = clamp(entryPrice + delta, 1e-3, 1 - 1e-3);
  const kelly = (impliedQ - entryPrice) / (1 - entryPrice); // exact binary Kelly
  const edgeReturn = (impliedQ - entryPrice) / entryPrice;  // expected return / $ staked
  return { delta, impliedQ, kelly, edgeReturn };
}

// ─── Per-market quality composite (display only) ───────────────────────────────

function qualityComposite(entryPrice: number, clob: MarketClobData, ts: TsFeatures, edgeReturn: number): number {
  const costEff   = 1 - clamp((clob.spread + clob.estimatedSlippage) / 0.08, 0, 1);
  const liqAdq    = clamp(clob.liquidity / 50_000, 0, 1);
  const depthAdq  = clamp(clob.depthAt2PctSlippage / 5_000, 0, 1);
  const volAdq    = clamp(clob.volume24h / 20_000, 0, 1);
  const timing    = resolutionScore(clob.daysToResolution);
  const stability = ts.hasData ? clamp(1 - ts.realizedVol / 0.6, 0, 1) : 0.5;
  const ddPenalty = ts.hasData ? clamp(ts.maxDrawdown / 0.5, 0, 1) : 0.3;
  const edgeBonus = clamp(edgeReturn * 5, -0.2, 0.2);
  const raw =
    0.20 * costEff + 0.15 * liqAdq + 0.15 * depthAdq + 0.12 * volAdq +
    0.10 * timing + 0.18 * stability - 0.10 * ddPenalty + edgeBonus;
  return clamp(raw, 0, 1);
}

// ─── Position vol & correlation ────────────────────────────────────────────────

function positionVol(entryPrice: number, ts: TsFeatures, daysToResolution: number): number {
  const horizon = clamp(Math.min(daysToResolution, HORIZON_CAP_DAYS), 1, HORIZON_CAP_DAYS);
  // mark-to-market vol: price-return vol ≈ (1−p)·σ_logit, scaled by √horizon
  const tsVol = ts.hasData ? (1 - entryPrice) * ts.realizedVol * Math.sqrt(horizon) : NaN;
  // terminal binary payoff vol per $ as a floor
  const terminal = Math.sqrt(entryPrice * (1 - entryPrice)) / Math.max(entryPrice, 0.05);
  const base = Number.isFinite(tsVol) ? Math.max(tsVol, 0.3 * terminal) : 0.6 * terminal;
  return clamp(base, VOL_FLOOR, VOL_CAP);
}

/** Sample correlation of timestamp-aligned logit returns. */
function alignedLogitReturnCorr(a: TsSeries, b: TsSeries): { corr: number; n: number } | null {
  const ma = new Map(a.t.map((t, i) => [t, a.p[i]]));
  const mb = new Map(b.t.map((t, i) => [t, b.p[i]]));
  const common = [...ma.keys()].filter(t => mb.has(t)).sort((x, y) => x - y);
  if (common.length < MIN_HISTORY_OBS + 1) return null;
  const ra: number[] = [], rb: number[] = [];
  for (let i = 1; i < common.length; i++) {
    ra.push(logit(ma.get(common[i])!) - logit(ma.get(common[i - 1])!));
    rb.push(logit(mb.get(common[i])!) - logit(mb.get(common[i - 1])!));
  }
  const n = ra.length;
  const mra = mean(ra), mrb = mean(rb);
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const da = ra[i] - mra, db = rb[i] - mrb;
    cov += da * db; va += da * da; vb += db * db;
  }
  const d = Math.sqrt(va * vb);
  if (d < 1e-12) return null;
  return { corr: clamp(cov / d, -1, 1), n };
}

function structuralCorr(a: SelectedMarket, b: SelectedMarket): number {
  if (a.conditionId === b.conditionId) return a.selectedSide !== b.selectedSide ? -0.95 : 0.95;
  if (a.eventId && a.eventId === b.eventId) return 0.55;
  if (a.manualClusterId && b.manualClusterId && a.manualClusterId === b.manualClusterId) return 0.45;
  return 0.05;
}

/** Shrink sample correlation toward the structural prior (more shrinkage = fewer obs). */
function blendedCorr(a: SelectedMarket, b: SelectedMarket, sa: TsSeries, sb: TsSeries): number {
  const struct = structuralCorr(a, b);
  const sample = alignedLogitReturnCorr(sa, sb);
  if (!sample) return struct;
  const phi = SHRINK_K / (SHRINK_K + sample.n);
  return clamp((1 - phi) * sample.corr + phi * struct, -0.99, 0.99);
}

function buildCovariance(vols: number[], corr: number[][]): number[][] {
  const n = vols.length;
  const S = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) S[i][j] = corr[i][j] * vols[i] * vols[j];
  const ridge = RIDGE_EPS * mean(vols.map(v => v * v)) + 1e-9;
  for (let i = 0; i < n; i++) S[i][i] += ridge;
  return S;
}

// ─── Sizing: ERC backbone + Kelly tilt ─────────────────────────────────────────

/** Equal-Risk-Contribution weights via cyclical coordinate descent. Sums to 1. */
function ercWeights(S: number[][]): number[] {
  const n = S.length;
  if (n === 0) return [];
  if (n === 1) return [1];
  let w = new Array(n).fill(1 / n);
  const lambda = 1 / n;
  for (let iter = 0; iter < 250; iter++) {
    let maxChange = 0;
    for (let i = 0; i < n; i++) {
      const a = S[i][i];
      let b = 0;
      for (let j = 0; j < n; j++) if (j !== i) b += w[j] * S[i][j];
      const wi = a > 1e-12 ? (-b + Math.sqrt(Math.max(0, b * b + 4 * a * lambda))) / (2 * a) : w[i];
      maxChange = Math.max(maxChange, Math.abs(wi - w[i]));
      w[i] = Math.max(wi, 1e-9);
    }
    if (maxChange < 1e-8) break;
  }
  const sum = w.reduce((a, b) => a + b, 0);
  return sum > 0 ? w.map(x => x / sum) : new Array(n).fill(1 / n);
}

/** Long-only Kelly/Markowitz direction Σ⁻¹μ (active-set for negatives). Sums to 1 or 0. */
function kellyDirection(S: number[][], mu: number[]): number[] {
  const n = mu.length;
  if (n === 0) return [];
  let w = new Array(n).fill(0);
  let active = mu.map((_, i) => i);
  for (let pass = 0; pass < 4 && active.length > 0; pass++) {
    const subS = active.map(i => active.map(j => S[i][j]));
    const subMu = active.map(i => mu[i]);
    const sol = solveLinear(subS, subMu);
    if (!sol) {
      w = new Array(n).fill(0);
      for (const i of active) w[i] = S[i][i] > 1e-12 ? Math.max(0, mu[i] / S[i][i]) : 0;
      break;
    }
    w = new Array(n).fill(0);
    active.forEach((idx, k) => { w[idx] = sol[k]; });
    const survivors = active.filter(idx => w[idx] > 1e-9);
    if (survivors.length === active.length) break;
    active = survivors;
  }
  w = w.map(x => Math.max(0, x));
  const sum = w.reduce((a, b) => a + b, 0);
  return sum > 1e-12 ? w.map(x => x / sum) : new Array(n).fill(0);
}

// ─── Reasons ───────────────────────────────────────────────────────────────────

function buildReasons(entryPrice: number, clob: MarketClobData, ts: TsFeatures, edge: Edge): string[] {
  const r: string[] = [];
  if (edge.edgeReturn > 0.02) r.push("Positive modeled edge");
  else if (edge.edgeReturn < -0.01) r.push("Edge eroded by costs");

  if (ts.hasData) {
    if (ts.momentumZ > 1) r.push("Upward momentum (confirmed)");
    else if (ts.momentumZ < -1) r.push("Downward momentum");
    if (ts.varianceRatio > 1.2) r.push("Trending regime");
    else if (ts.varianceRatio < 0.8) r.push("Mean-reverting regime");
    if (ts.realizedVol < 0.15) r.push("Stable price");
    else if (ts.realizedVol > 0.40) r.push("Volatile price");
    if (ts.maxDrawdown >= 0.30) r.push("Notable drawdown");
  } else {
    r.push("Limited price history");
  }

  if (clob.spread <= 0.02) r.push("Tight spread");
  else if (clob.spread > 0.04) r.push("Wide spread");
  if (clob.liquidity >= 20_000) r.push("Deep liquidity");

  if (clob.daysToResolution <= 7) r.push("Resolves soon");
  else if (clob.daysToResolution > 60) r.push("Long-dated");

  if (entryPrice >= 0.75) r.push("Strong favorite");
  else if (entryPrice <= 0.35) r.push("Underdog bet");

  return r;
}

function riskLevel(v: number, med: number, high: number): "Low" | "Medium" | "High" {
  return v >= high ? "High" : v >= med ? "Medium" : "Low";
}

// ─── Main engine ────────────────────────────────────────────────────────────────

interface Prepared {
  market: SelectedMarket;
  clob: MarketClobData;
  series: TsSeries;
  ts: TsFeatures;
  entryPrice: number;
  edge: Edge;
  quality: number;
  vol: number;
}

const METHODOLOGY = "ERC + fractional-Kelly tilt, logit time-series, shrunk covariance, vol-targeted";

function emptyProposal(nav: number, rejected: RejectedMarket[]): AllocationProposal {
  return {
    nav,
    targetExposure: MIN_EXPOSURE,
    cashWeight: 1,
    cashAmount: nav,
    portfolioQuality: 0,
    goodMarketsCount: 0,
    independentGoodMarketsCount: 0,
    allocations: [],
    rejectedMarkets: rejected,
    clusterExposure: { cash: 1 },
    expectedReturnPct: 0,
    expectedVolPct: 0,
    targetVolPct: TARGET_VOL,
    riskAdjustedReturn: 0,
    diversificationRatio: 1,
    effectiveBets: 0,
    signalConfidence: 0,
    methodology: METHODOLOGY,
  };
}

export function runAllocationEngine(
  selectedMarkets: SelectedMarket[],
  clobData: Map<string, MarketClobData>,
  nav: number
): AllocationProposal {
  if (selectedMarkets.length === 0 || nav <= 0) return emptyProposal(Math.max(nav, 0), []);

  const rejected: RejectedMarket[] = [];
  const prepared: Prepared[] = [];

  // ── Step 1: features + elimination ──
  for (const market of selectedMarkets) {
    const clob = clobData.get(market.conditionId);
    if (!clob) {
      rejected.push({
        marketId: market.marketId, conditionId: market.conditionId,
        question: market.question, reason: "Market data unavailable", rejected: true,
      });
      continue;
    }
    const series = chosenSideSeries(clob.historicalPrices, market.selectedSide);
    const ts = computeTsFeatures(series);
    const entryPrice = clamp(market.selectedSide === "YES" ? clob.price : 1 - clob.price, EPS, 1 - EPS);

    const reason = getRejectionReason(clob, entryPrice, ts);
    if (reason) {
      rejected.push({
        marketId: market.marketId, conditionId: market.conditionId,
        question: market.question, reason, rejected: true,
      });
      continue;
    }

    const edge = computeEdge(entryPrice, ts, clob);
    const quality = qualityComposite(entryPrice, clob, ts, edge.edgeReturn);
    const vol = positionVol(entryPrice, ts, clob.daysToResolution);
    prepared.push({ market, clob, series, ts, entryPrice, edge, quality, vol });
  }

  if (prepared.length === 0) return emptyProposal(nav, rejected);

  const n = prepared.length;

  // ── Step 2: correlation & covariance ──
  const corr: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) =>
      i === j ? 1 : blendedCorr(prepared[i].market, prepared[j].market, prepared[i].series, prepared[j].series)
    )
  );
  const vols = prepared.map(p => p.vol);
  const S = buildCovariance(vols, corr);

  // ── Step 3: sizing direction ──
  const wRP = ercWeights(S);
  const mu = prepared.map(p => p.edge.edgeReturn);
  const wKelly = kellyDirection(S, mu);

  // ── Step 4: edge confidence → tilt + gross ──
  const dataFrac   = mean(prepared.map(p => (p.ts.hasData ? 1 : 0)));
  const avgQuality = mean(prepared.map(p => p.quality));
  const avgPosEdge = mean(prepared.map(p => clamp(p.edge.edgeReturn, 0, 0.2) / 0.2));
  const avgMomSig  = mean(prepared.map(p => clamp(Math.abs(p.ts.momentumZ) / 2, 0, 1)));
  const confidence = clamp(0.40 * dataFrac + 0.30 * avgQuality + 0.20 * avgPosEdge + 0.10 * avgMomSig, 0, 1);

  const tilt = TILT_MAX * confidence; // lean toward Kelly only as far as edge confidence warrants
  const wDir = wRP.map((rp, i) => (1 - tilt) * rp + tilt * wKelly[i]);
  const sumDir = wDir.reduce((a, b) => a + b, 0);
  const wUnit = sumDir > 1e-12 ? wDir.map(x => x / sumDir) : wRP;

  const sigmaUnit = Math.sqrt(Math.max(0, quadForm(S, wUnit)));
  const volGross = sigmaUnit > 1e-9 ? clamp(TARGET_VOL / sigmaUnit, MIN_EXPOSURE, MAX_EXPOSURE) : MIN_EXPOSURE;
  const gross = clamp(MIN_EXPOSURE + (volGross - MIN_EXPOSURE) * confidence, MIN_EXPOSURE, MAX_EXPOSURE);

  // ── Step 5: constraint projection (water-filling + group caps) ──
  const { amounts, binding } = projectConstraints(prepared, wUnit, nav, gross);

  // ── Step 6: diagnostics & output ──
  const a = amounts.map(x => x / nav);                  // weights on NAV
  const Sa = matVec(S, a);
  const portVar = a.reduce((s, ai, i) => s + ai * Sa[i], 0);
  const portVol = Math.sqrt(Math.max(0, portVar));
  const expectedReturn = a.reduce((s, ai, i) => s + ai * prepared[i].edge.edgeReturn, 0);
  const investedGross = a.reduce((x, y) => x + y, 0);
  const sumWeightedVol = a.reduce((s, ai, i) => s + ai * vols[i], 0);
  const diversificationRatio = portVol > 1e-9 ? sumWeightedVol / portVol : 1;
  const investedW = a.map(ai => (investedGross > 1e-12 ? ai / investedGross : 0));
  const effectiveBets = investedW.some(x => x > 0)
    ? 1 / investedW.reduce((s, w) => s + w * w, 0)
    : 0;

  const allocations: ScoredAllocation[] = prepared.map((p, i) => {
    const rc = portVar > 1e-12 ? (a[i] * Sa[i]) / portVar : 0;
    // weighted positive-correlation burden vs other invested positions
    let burdenNum = 0, burdenDen = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      burdenNum += a[j] * Math.max(corr[i][j], 0);
      burdenDen += a[j];
    }
    const corrBurden = burdenDen > 1e-9 ? burdenNum / burdenDen : 0;
    const adjustedScore = clamp(p.quality + clamp(p.edge.edgeReturn * 2, -0.3, 0.3), 0, 1);

    return {
      marketId: p.market.marketId,
      conditionId: p.market.conditionId,
      question: p.market.question,
      selectedSide: p.market.selectedSide,
      price: p.entryPrice,
      qualityScore: p.quality,
      adjustedScore,
      correlationRisk: riskLevel(corrBurden, 0.30, 0.60),
      historicalRisk: riskLevel(p.ts.maxDrawdown, 0.15, 0.35),
      allocationWeight: a[i],
      allocationAmount: amounts[i],
      reasons: buildReasons(p.entryPrice, p.clob, p.ts, p.edge),
      rejected: false,
      impliedProb: p.edge.impliedQ,
      edgeBps: Math.round(p.edge.edgeReturn * 10_000),
      kellyFraction: p.edge.kelly,
      riskContributionPct: rc,
      periodVolPct: p.vol,
      momentumZ: p.ts.hasData ? p.ts.momentumZ : undefined,
      trendPersistence: p.ts.hasData ? p.ts.varianceRatio : undefined,
      bindingConstraint: binding[i],
    };
  });

  // cluster exposure (+ cash)
  const clusterExposure: Record<string, number> = {};
  prepared.forEach((p, i) => {
    const cid = p.market.manualClusterId?.trim();
    if (cid) clusterExposure[cid] = (clusterExposure[cid] ?? 0) + a[i];
  });
  clusterExposure.cash = clamp(1 - investedGross, 0, 1);

  // good / independent-good counts
  const goodIdx = prepared.map((p, i) => ({ p, i })).filter(({ p }) => p.quality >= QUALITY_THRESHOLD);
  const goodMarketsCount = goodIdx.length;
  let independentGoodMarketsCount = 0;
  for (const { i } of goodIdx) {
    const dependent = goodIdx.some(({ i: j }) => i !== j && corr[i][j] >= CORRELATION_INDEPENDENT_THRESHOLD);
    if (!dependent) independentGoodMarketsCount++;
  }

  const portfolioQuality = clamp(0.5 * avgQuality + 0.3 * confidence + 0.2 * clamp(diversificationRatio / 2, 0, 1), 0, 1);

  return {
    nav,
    targetExposure: investedGross,
    cashWeight: clamp(1 - investedGross, 0, 1),
    cashAmount: Math.max(0, nav - amounts.reduce((x, y) => x + y, 0)),
    portfolioQuality,
    goodMarketsCount,
    independentGoodMarketsCount,
    allocations,
    rejectedMarkets: rejected,
    clusterExposure,
    expectedReturnPct: expectedReturn,
    expectedVolPct: portVol,
    targetVolPct: TARGET_VOL,
    riskAdjustedReturn: portVol > 1e-9 ? expectedReturn / portVol : 0,
    diversificationRatio,
    effectiveBets,
    signalConfidence: confidence,
    methodology: METHODOLOGY,
  };
}

// ─── Constraint projection ───────────────────────────────────────────────────

function projectConstraints(
  prepared: Prepared[],
  wUnit: number[],
  nav: number,
  gross: number
): { amounts: number[]; binding: (ScoredAllocation["bindingConstraint"])[] } {
  const n = prepared.length;
  const totalBudget = nav * gross;
  const binding: (ScoredAllocation["bindingConstraint"])[] = new Array(n).fill(null);

  // per-market caps (and which term binds)
  const caps = prepared.map(p => {
    const cMarket = nav * MAX_PER_MARKET;
    const cLiq    = p.clob.liquidity * MAX_BY_LIQUIDITY;
    const cDepth  = p.clob.depthAt2PctSlippage * MAX_BY_DEPTH_PCT;
    const cap = Math.min(cMarket, cLiq, cDepth);
    const src: ScoredAllocation["bindingConstraint"] =
      cap === cLiq ? "liquidity" : cap === cDepth ? "depth" : "per-market";
    return { cap, src };
  });

  // water-fill totalBudget into per-market caps, proportional to wUnit
  const amounts = new Array(n).fill(0);
  const capped = new Array(n).fill(false);
  let remaining = totalBudget;
  for (let iter = 0; iter <= n; iter++) {
    let sumW = 0;
    const active: number[] = [];
    for (let i = 0; i < n; i++) if (!capped[i] && wUnit[i] > 0) { active.push(i); sumW += wUnit[i]; }
    if (active.length === 0 || sumW <= 1e-12 || remaining <= 1e-6) break;
    let newlyCapped = false;
    for (const i of active) {
      const give = remaining * (wUnit[i] / sumW);
      const room = caps[i].cap - amounts[i];
      if (give >= room - 1e-9) {
        amounts[i] = caps[i].cap;
        capped[i] = true;
        binding[i] = caps[i].src;
        newlyCapped = true;
      } else {
        amounts[i] += give;
      }
    }
    remaining = totalBudget - amounts.reduce((x, y) => x + y, 0);
    if (!newlyCapped) break;
  }

  // group caps: scale a group down if it exceeds its budget
  const applyGroup = (key: (p: Prepared) => string | undefined, budget: number, label: ScoredAllocation["bindingConstraint"]) => {
    const groups = new Map<string, number[]>();
    prepared.forEach((p, i) => {
      const g = key(p)?.trim();
      if (g) { const arr = groups.get(g) ?? []; arr.push(i); groups.set(g, arr); }
    });
    for (const idxs of groups.values()) {
      const sum = idxs.reduce((s, i) => s + amounts[i], 0);
      if (sum > budget + 1e-9 && sum > 0) {
        const scale = budget / sum;
        for (const i of idxs) { amounts[i] *= scale; binding[i] = label; }
      }
    }
  };
  applyGroup(p => p.market.eventId, nav * MAX_PER_EVENT, "per-event");
  applyGroup(p => p.market.manualClusterId, nav * MAX_PER_CLUSTER, "per-cluster");

  // total exposure safety scale-down
  const total = amounts.reduce((x, y) => x + y, 0);
  const totalCap = nav * MAX_EXPOSURE;
  if (total > totalCap + 1e-9 && total > 0) {
    const scale = totalCap / total;
    for (let i = 0; i < n; i++) { amounts[i] *= scale; binding[i] = "total-exposure"; }
  }

  return { amounts, binding };
}
