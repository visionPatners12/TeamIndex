-- Migration: Add pool_selected_markets and pool_allocation_proposals tables
-- Run: npx prisma migrate dev --name add_polymarket_features
-- OR apply manually: psql $DATABASE_URL -f migration_polymarket_features.sql

CREATE TABLE IF NOT EXISTS "pool_selected_markets" (
  "id"              TEXT NOT NULL,
  "poolId"          TEXT NOT NULL,
  "marketId"        TEXT NOT NULL,
  "conditionId"     TEXT NOT NULL,
  "tokenId"         TEXT NOT NULL,
  "eventId"         TEXT NOT NULL DEFAULT '',
  "question"        TEXT NOT NULL,
  "marketType"      TEXT NOT NULL DEFAULT 'game',
  "selectedSide"    "Side" NOT NULL DEFAULT 'YES',
  "manualClusterId" TEXT,
  "endDateIso"      TEXT,
  "liquidity"       DECIMAL(78,18) NOT NULL DEFAULT 0,
  "yesPrice"        DECIMAL(78,18) NOT NULL DEFAULT 0,
  "enabled"         BOOLEAN NOT NULL DEFAULT true,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "pool_selected_markets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "pool_selected_markets_poolId_conditionId_key"
  ON "pool_selected_markets"("poolId", "conditionId");

CREATE INDEX IF NOT EXISTS "pool_selected_markets_poolId_idx"
  ON "pool_selected_markets"("poolId");

ALTER TABLE "pool_selected_markets"
  ADD CONSTRAINT "pool_selected_markets_poolId_fkey"
  FOREIGN KEY ("poolId") REFERENCES "club_pools"("id") ON DELETE CASCADE ON UPDATE CASCADE;


CREATE TABLE IF NOT EXISTS "pool_allocation_proposals" (
  "id"                 TEXT NOT NULL,
  "poolId"             TEXT NOT NULL,
  "nav"                DECIMAL(78,18) NOT NULL,
  "targetExposure"     DECIMAL(78,18) NOT NULL,
  "cashWeight"         DECIMAL(78,18) NOT NULL,
  "cashAmount"         DECIMAL(78,18) NOT NULL,
  "portfolioQuality"   DECIMAL(78,18) NOT NULL DEFAULT 0,
  "proposalJson"       JSONB NOT NULL,
  "selectedMarketsJson" JSONB NOT NULL,
  "status"             TEXT NOT NULL DEFAULT 'ACCEPTED',
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "pool_allocation_proposals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "pool_allocation_proposals_poolId_createdAt_idx"
  ON "pool_allocation_proposals"("poolId", "createdAt");

ALTER TABLE "pool_allocation_proposals"
  ADD CONSTRAINT "pool_allocation_proposals_poolId_fkey"
  FOREIGN KEY ("poolId") REFERENCES "club_pools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
