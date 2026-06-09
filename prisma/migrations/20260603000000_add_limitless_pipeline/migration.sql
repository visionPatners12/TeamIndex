-- Migration: Add Limitless pipeline tables
-- Migrates pipeline data source from Polymarket (Gamma) to Limitless Exchange.
--
-- Tables:
--   limitless_sync_state   → singleton row tracking sync cursor + provider migration state
--   limitless_categories   → raw categories fetched from Limitless API
--   limitless_markets      → raw markets fetched from Limitless API
--   limitless_prices       → historical price ticks per market outcome
--   lim_games              → sport/league/team enrichment layer on top of limitless_markets

-- ─────────────────────────────────────────────────────────────────────────────
-- limitless_sync_state
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "limitless_sync_state" (
  "id"             TEXT NOT NULL DEFAULT 'default',
  -- 'polymarket' or 'limitless' — tracks which provider is currently active
  "provider"       TEXT NOT NULL DEFAULT 'limitless',
  -- pagination cursor returned by last Limitless API page (market slug or offset)
  "cursor"         TEXT,
  "lastSyncedAt"   TIMESTAMP(3),
  "marketsSynced"  INTEGER NOT NULL DEFAULT 0,
  -- IDLE | SYNCING | ERROR
  "status"         TEXT NOT NULL DEFAULT 'IDLE',
  "lastError"      TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "limitless_sync_state_pkey" PRIMARY KEY ("id")
);

-- Seed the default row so the sync service always has a state to upsert against.
INSERT INTO "limitless_sync_state" ("id", "provider", "status")
VALUES ('default', 'limitless', 'IDLE')
ON CONFLICT ("id") DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- limitless_categories
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "limitless_categories" (
  "id"        TEXT NOT NULL,
  "slug"      TEXT NOT NULL,
  "label"     TEXT NOT NULL,
  -- full raw JSON from Limitless API (kept for zero-loss pipeline)
  "rawJson"   JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "limitless_categories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "limitless_categories_slug_key"
  ON "limitless_categories"("slug");

-- ─────────────────────────────────────────────────────────────────────────────
-- limitless_markets
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "limitless_markets" (
  "id"          TEXT NOT NULL,
  "categoryId"  TEXT,
  "title"       TEXT NOT NULL,
  "description" TEXT,
  -- ACTIVE | CLOSED | RESOLVED
  "status"      TEXT NOT NULL DEFAULT 'ACTIVE',
  -- winning outcome title when resolved
  "resolution"  TEXT,
  -- current implied probability for outcome[0] (YES / first outcome)
  "yesPrice"    DECIMAL(10,6) NOT NULL DEFAULT 0,
  -- current implied probability for outcome[1] (NO / second outcome)
  "noPrice"     DECIMAL(10,6) NOT NULL DEFAULT 0,
  "liquidity"   DECIMAL(20,6) NOT NULL DEFAULT 0,
  "volume"      DECIMAL(20,6) NOT NULL DEFAULT 0,
  "endDate"     TIMESTAMP(3),
  -- full raw JSON from Limitless API
  "rawJson"     JSONB,
  -- when this row was last refreshed by the sync pipeline
  "syncedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "limitless_markets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "limitless_markets_categoryId_idx"
  ON "limitless_markets"("categoryId");

CREATE INDEX IF NOT EXISTS "limitless_markets_status_idx"
  ON "limitless_markets"("status");

CREATE INDEX IF NOT EXISTS "limitless_markets_endDate_idx"
  ON "limitless_markets"("endDate");

ALTER TABLE "limitless_markets"
  ADD CONSTRAINT "limitless_markets_categoryId_fkey"
  FOREIGN KEY ("categoryId")
  REFERENCES "limitless_categories"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- limitless_prices
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "limitless_prices" (
  "id"           BIGSERIAL NOT NULL,
  "marketId"     TEXT NOT NULL,
  -- 0 = YES / first outcome, 1 = NO / second outcome
  "outcomeIndex" INTEGER NOT NULL DEFAULT 0,
  "price"        DECIMAL(10,6) NOT NULL,
  -- the point-in-time this price was observed (from API or pipeline tick)
  "timestamp"    TIMESTAMP(3) NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "limitless_prices_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "limitless_prices_marketId_timestamp_idx"
  ON "limitless_prices"("marketId", "timestamp" DESC);

-- Prevent duplicate ticks for the same market+outcome+timestamp
CREATE UNIQUE INDEX IF NOT EXISTS "limitless_prices_market_outcome_ts_key"
  ON "limitless_prices"("marketId", "outcomeIndex", "timestamp");

ALTER TABLE "limitless_prices"
  ADD CONSTRAINT "limitless_prices_marketId_fkey"
  FOREIGN KEY ("marketId")
  REFERENCES "limitless_markets"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- lim_games
-- Sport/league/team enrichment layer on top of limitless_markets.
-- Populated by the /sports pipeline; one row per market that has been
-- identified as a sports fixture.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "lim_games" (
  "id"        TEXT NOT NULL,
  "marketId"  TEXT NOT NULL,
  -- e.g. "soccer", "basketball", "tennis"
  "sport"     TEXT,
  -- e.g. "Premier League", "NBA", "Roland Garros"
  "league"    TEXT,
  -- home / first team or player
  "homeTeam"  TEXT,
  -- away / second team or player
  "awayTeam"  TEXT,
  -- expected kick-off / start time of the fixture
  "gameTime"  TIMESTAMP(3),
  -- raw enrichment payload (from sports API or LLM extraction)
  "rawJson"   JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "lim_games_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "lim_games_marketId_key"
  ON "lim_games"("marketId");

CREATE INDEX IF NOT EXISTS "lim_games_sport_league_idx"
  ON "lim_games"("sport", "league");

CREATE INDEX IF NOT EXISTS "lim_games_gameTime_idx"
  ON "lim_games"("gameTime");

ALTER TABLE "lim_games"
  ADD CONSTRAINT "lim_games_marketId_fkey"
  FOREIGN KEY ("marketId")
  REFERENCES "limitless_markets"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;
