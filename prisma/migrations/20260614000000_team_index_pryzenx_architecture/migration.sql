CREATE SCHEMA IF NOT EXISTS team_index;

ALTER TABLE "club_pools"
  ADD COLUMN IF NOT EXISTS "primarySportsDataTeamId" UUID;

CREATE INDEX IF NOT EXISTS "club_pools_primarySportsDataTeamId_idx"
  ON "club_pools"("primarySportsDataTeamId");

CREATE TABLE IF NOT EXISTS "pool_teams" (
  "id" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "sportsDataTeamId" UUID NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'PRIMARY',
  "weight" DECIMAL(20,8) NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pool_teams_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "pool_teams_poolId_sportsDataTeamId_key"
  ON "pool_teams"("poolId", "sportsDataTeamId");
CREATE INDEX IF NOT EXISTS "pool_teams_sportsDataTeamId_idx"
  ON "pool_teams"("sportsDataTeamId");
CREATE INDEX IF NOT EXISTS "pool_teams_poolId_role_idx"
  ON "pool_teams"("poolId", "role");
CREATE UNIQUE INDEX IF NOT EXISTS "pool_teams_one_primary_per_pool_key"
  ON "pool_teams"("poolId")
  WHERE "role" = 'PRIMARY';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pool_teams_poolId_fkey'
  ) THEN
    ALTER TABLE "pool_teams"
      ADD CONSTRAINT "pool_teams_poolId_fkey"
      FOREIGN KEY ("poolId") REFERENCES "club_pools"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "pool_limitless_accounts" (
  "id" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "limitlessProfileId" TEXT,
  "accountAddress" TEXT,
  "displayName" TEXT NOT NULL,
  "serverWallet" BOOLEAN NOT NULL DEFAULT true,
  "allowanceStatus" TEXT NOT NULL DEFAULT 'PENDING',
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "rawJson" JSONB,
  "lastAllowanceCheckAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pool_limitless_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "pool_limitless_accounts_poolId_key"
  ON "pool_limitless_accounts"("poolId");
CREATE UNIQUE INDEX IF NOT EXISTS "pool_limitless_accounts_limitlessProfileId_key"
  ON "pool_limitless_accounts"("limitlessProfileId");
CREATE UNIQUE INDEX IF NOT EXISTS "pool_limitless_accounts_accountAddress_key"
  ON "pool_limitless_accounts"("accountAddress");
CREATE INDEX IF NOT EXISTS "pool_limitless_accounts_status_idx"
  ON "pool_limitless_accounts"("status");
CREATE INDEX IF NOT EXISTS "pool_limitless_accounts_allowanceStatus_idx"
  ON "pool_limitless_accounts"("allowanceStatus");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pool_limitless_accounts_poolId_fkey'
  ) THEN
    ALTER TABLE "pool_limitless_accounts"
      ADD CONSTRAINT "pool_limitless_accounts_poolId_fkey"
      FOREIGN KEY ("poolId") REFERENCES "club_pools"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "club_pool_users"
  ADD COLUMN IF NOT EXISTS "userId" UUID,
  ADD COLUMN IF NOT EXISTS "sharesRaw" DECIMAL(78,18) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lastTransferTxHash" TEXT,
  ADD COLUMN IF NOT EXISTS "lastTransferLogIndex" INTEGER,
  ADD COLUMN IF NOT EXISTS "lastSyncedBlock" BIGINT,
  ADD COLUMN IF NOT EXISTS "lastSyncedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "club_pool_users_poolId_userId_key"
  ON "club_pool_users"("poolId", "userId");
CREATE INDEX IF NOT EXISTS "club_pool_users_userId_idx"
  ON "club_pool_users"("userId");

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'users'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'club_pool_users_userId_fkey'
  ) THEN
    ALTER TABLE "club_pool_users"
      ADD CONSTRAINT "club_pool_users_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES public.users("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "onchain_events" (
  "id" TEXT NOT NULL,
  "network" TEXT NOT NULL,
  "transactionHash" TEXT NOT NULL,
  "logIndex" INTEGER NOT NULL,
  "blockNumber" BIGINT,
  "blockHash" TEXT,
  "contractAddress" TEXT NOT NULL,
  "eventName" TEXT NOT NULL,
  "eventSignature" TEXT,
  "timestamp" TIMESTAMP(3),
  "parametersJson" JSONB,
  "rawJson" JSONB NOT NULL,
  "processingStatus" TEXT NOT NULL DEFAULT 'PENDING',
  "processedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "onchain_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "onchain_events_network_transactionHash_logIndex_key"
  ON "onchain_events"("network", "transactionHash", "logIndex");
CREATE INDEX IF NOT EXISTS "onchain_events_contractAddress_eventName_idx"
  ON "onchain_events"("contractAddress", "eventName");
CREATE INDEX IF NOT EXISTS "onchain_events_processingStatus_idx"
  ON "onchain_events"("processingStatus");
CREATE INDEX IF NOT EXISTS "onchain_events_blockNumber_idx"
  ON "onchain_events"("blockNumber");

ALTER TABLE "club_pool_transactions"
  ADD COLUMN IF NOT EXISTS "userId" UUID,
  ADD COLUMN IF NOT EXISTS "onchainEventId" TEXT,
  ADD COLUMN IF NOT EXISTS "type" TEXT NOT NULL DEFAULT 'DEPOSIT';

CREATE INDEX IF NOT EXISTS "club_pool_transactions_userId_idx"
  ON "club_pool_transactions"("userId");
CREATE INDEX IF NOT EXISTS "club_pool_transactions_onchainEventId_idx"
  ON "club_pool_transactions"("onchainEventId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'club_pool_transactions_onchainEventId_fkey'
  ) THEN
    ALTER TABLE "club_pool_transactions"
      ADD CONSTRAINT "club_pool_transactions_onchainEventId_fkey"
      FOREIGN KEY ("onchainEventId") REFERENCES "onchain_events"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'users'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'club_pool_transactions_userId_fkey'
  ) THEN
    ALTER TABLE "club_pool_transactions"
      ADD CONSTRAINT "club_pool_transactions_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES public.users("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "pool_limitless_position_snapshots" (
  "id" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "accountId" TEXT,
  "asOf" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "positionsJson" JSONB NOT NULL,
  "marketValue" DECIMAL(78,18) NOT NULL DEFAULT 0,
  "unrealizedPnl" DECIMAL(78,18) NOT NULL DEFAULT 0,
  "rawJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pool_limitless_position_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "pool_limitless_position_snapshots_poolId_asOf_idx"
  ON "pool_limitless_position_snapshots"("poolId", "asOf");

CREATE TABLE IF NOT EXISTS "pool_limitless_trades" (
  "id" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "accountId" TEXT,
  "externalTradeId" TEXT,
  "marketId" TEXT,
  "side" TEXT,
  "outcomeIndex" INTEGER,
  "price" DECIMAL(78,18),
  "size" DECIMAL(78,18),
  "fee" DECIMAL(78,18),
  "executedAt" TIMESTAMP(3),
  "rawJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pool_limitless_trades_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "pool_limitless_trades_poolId_externalTradeId_key"
  ON "pool_limitless_trades"("poolId", "externalTradeId");
CREATE INDEX IF NOT EXISTS "pool_limitless_trades_poolId_executedAt_idx"
  ON "pool_limitless_trades"("poolId", "executedAt");
CREATE INDEX IF NOT EXISTS "pool_limitless_trades_marketId_idx"
  ON "pool_limitless_trades"("marketId");

CREATE TABLE IF NOT EXISTS "pool_limitless_pnl_snapshots" (
  "id" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "accountId" TEXT,
  "asOf" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "pnlJson" JSONB NOT NULL,
  "realizedPnl" DECIMAL(78,18) NOT NULL DEFAULT 0,
  "unrealizedPnl" DECIMAL(78,18) NOT NULL DEFAULT 0,
  "rawJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pool_limitless_pnl_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "pool_limitless_pnl_snapshots_poolId_asOf_idx"
  ON "pool_limitless_pnl_snapshots"("poolId", "asOf");

CREATE TABLE IF NOT EXISTS "pool_valuation_snapshots" (
  "id" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "cash" DECIMAL(78,18) NOT NULL DEFAULT 0,
  "positionsValue" DECIMAL(78,18) NOT NULL DEFAULT 0,
  "realizedPnl" DECIMAL(78,18) NOT NULL DEFAULT 0,
  "totalPoolValue" DECIMAL(78,18) NOT NULL DEFAULT 0,
  "totalTokenSupply" DECIMAL(78,18) NOT NULL DEFAULT 0,
  "officialTokenPrice" DECIMAL(78,18) NOT NULL DEFAULT 1,
  "source" TEXT NOT NULL DEFAULT 'LIMITLESS_REST',
  "rawJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pool_valuation_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "pool_valuation_snapshots_poolId_createdAt_idx"
  ON "pool_valuation_snapshots"("poolId", "createdAt");

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'pool_limitless_position_snapshots',
    'pool_limitless_trades',
    'pool_limitless_pnl_snapshots',
    'pool_valuation_snapshots'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = table_name || '_poolId_fkey'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("poolId") REFERENCES "club_pools"("id") ON DELETE CASCADE ON UPDATE CASCADE',
        table_name,
        table_name || '_poolId_fkey'
      );
    END IF;
  END LOOP;
END $$;
