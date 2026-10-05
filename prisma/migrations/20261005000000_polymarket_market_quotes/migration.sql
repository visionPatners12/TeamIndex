CREATE TABLE "polymarket_market_quotes" (
  "tokenId" TEXT NOT NULL,
  "conditionId" TEXT,
  "bestBid" DECIMAL(20,8),
  "bestAsk" DECIMAL(20,8),
  "source" TEXT NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "polymarket_market_quotes_pkey" PRIMARY KEY ("tokenId")
);

CREATE INDEX "polymarket_market_quotes_observedAt_idx" ON "polymarket_market_quotes"("observedAt");
