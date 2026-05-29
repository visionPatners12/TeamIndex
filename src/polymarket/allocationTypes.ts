// Types shared by the server-side allocation engine.
// Mirrors the frontend `src/types/polymarket.ts` so the engine output is
// byte-for-byte compatible with what the UI already renders.

export type MarketType = "game" | "future";
export type MarketSide = "YES" | "NO";
export type MarketStatus = "open" | "closed" | "settled";

/** Market selected by admin, ready to be fed to the engine. */
export interface SelectedMarket {
  marketId: string;
  conditionId: string;
  tokenId: string;
  eventId: string;
  question: string;
  marketType: MarketType;
  selectedSide: MarketSide;
  manualClusterId?: string;
}

/** Live data fetched from Polymarket CLOB/Gamma for a selected market. */
export interface MarketClobData {
  conditionId: string;
  price: number;
  bestBid: number;
  bestAsk: number;
  midpoint: number;
  spread: number;
  liquidity: number;
  volume24h: number;
  depthAt2PctSlippage: number;
  estimatedSlippage: number;
  daysToResolution: number;
  marketStatus: "open" | "closed";
  historicalPrices: Array<{ t: number; p: number }>;
}

/** Allocation result for a single market (passed). */
export interface ScoredAllocation {
  marketId: string;
  conditionId: string;
  question: string;
  selectedSide: MarketSide;
  price: number;
  qualityScore: number;
  adjustedScore: number;
  correlationRisk: "Low" | "Medium" | "High";
  historicalRisk: "Low" | "Medium" | "High";
  allocationWeight: number;
  allocationAmount: number;
  reasons: string[];
  rejected: false;

  // Quant diagnostics
  impliedProb?: number;
  edgeBps?: number;
  kellyFraction?: number;
  riskContributionPct?: number;
  periodVolPct?: number;
  momentumZ?: number;
  trendPersistence?: number;
  bindingConstraint?:
    | "per-market"
    | "liquidity"
    | "depth"
    | "per-event"
    | "per-cluster"
    | "total-exposure"
    | null;
}

/** Market rejected by the engine. */
export interface RejectedMarket {
  marketId: string;
  conditionId: string;
  question: string;
  reason: string;
  rejected: true;
}

/** Full output of the allocation engine. */
export interface AllocationProposal {
  nav: number;
  targetExposure: number;
  cashWeight: number;
  cashAmount: number;
  portfolioQuality: number;
  goodMarketsCount: number;
  independentGoodMarketsCount: number;
  allocations: ScoredAllocation[];
  rejectedMarkets: RejectedMarket[];
  clusterExposure: Record<string, number>;

  // Portfolio-level quant diagnostics
  expectedReturnPct?: number;
  expectedVolPct?: number;
  targetVolPct?: number;
  riskAdjustedReturn?: number;
  diversificationRatio?: number;
  effectiveBets?: number;
  signalConfidence?: number;
  methodology?: string;
}
