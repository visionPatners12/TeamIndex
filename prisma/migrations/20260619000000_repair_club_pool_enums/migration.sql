CREATE SCHEMA IF NOT EXISTS club_pool;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'club_pool' AND t.typname = 'PoolStatus'
  ) THEN
    CREATE TYPE club_pool."PoolStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ERROR');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'club_pool' AND t.typname = 'PositionStatus'
  ) THEN
    CREATE TYPE club_pool."PositionStatus" AS ENUM ('OPEN', 'SETTLED', 'CANCELLED');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'club_pool' AND t.typname = 'QueueStatus'
  ) THEN
    CREATE TYPE club_pool."QueueStatus" AS ENUM ('SCHEDULED', 'PROCESSING', 'EXECUTED', 'SKIPPED', 'FAILED', 'CANCELLED');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'club_pool' AND t.typname = 'Side'
  ) THEN
    CREATE TYPE club_pool."Side" AS ENUM ('YES', 'NO');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'club_pool' AND t.typname = 'CrossChainDepositStatus'
  ) THEN
    CREATE TYPE club_pool."CrossChainDepositStatus" AS ENUM (
      'RECEIVED',
      'BRIDGING',
      'DEPOSITING',
      'MINTING_SHARES',
      'COMPLETED',
      'FAILED',
      'NEEDS_MANUAL_RECONCILIATION'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'club_pool' AND t.typname = 'CrossChainRedemptionStatus'
  ) THEN
    CREATE TYPE club_pool."CrossChainRedemptionStatus" AS ENUM (
      'BURN_REQUESTED',
      'BURNED',
      'WITHDRAWING',
      'SETTLING',
      'COMPLETED',
      'FAILED'
    );
  END IF;
END $$;

ALTER TABLE IF EXISTS club_pool.club_pools
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE club_pool."PoolStatus" USING "status"::text::club_pool."PoolStatus",
  ALTER COLUMN "status" SET DEFAULT 'ACTIVE'::club_pool."PoolStatus";

ALTER TABLE IF EXISTS club_pool.club_pool_positions
  ALTER COLUMN "side" TYPE club_pool."Side" USING "side"::text::club_pool."Side",
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE club_pool."PositionStatus" USING "status"::text::club_pool."PositionStatus",
  ALTER COLUMN "status" SET DEFAULT 'OPEN'::club_pool."PositionStatus";

ALTER TABLE IF EXISTS club_pool.club_market_candidates
  ALTER COLUMN "side" TYPE club_pool."Side" USING "side"::text::club_pool."Side";

ALTER TABLE IF EXISTS club_pool.pool_selected_markets
  ALTER COLUMN "selectedSide" DROP DEFAULT,
  ALTER COLUMN "selectedSide" TYPE club_pool."Side" USING "selectedSide"::text::club_pool."Side",
  ALTER COLUMN "selectedSide" SET DEFAULT 'YES'::club_pool."Side";

ALTER TABLE IF EXISTS club_pool.club_match_queue
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE club_pool."QueueStatus" USING "status"::text::club_pool."QueueStatus",
  ALTER COLUMN "status" SET DEFAULT 'SCHEDULED'::club_pool."QueueStatus";

ALTER TABLE IF EXISTS club_pool.cross_chain_deposits
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE club_pool."CrossChainDepositStatus" USING "status"::text::club_pool."CrossChainDepositStatus",
  ALTER COLUMN "status" SET DEFAULT 'RECEIVED'::club_pool."CrossChainDepositStatus";

ALTER TABLE IF EXISTS club_pool.base_chain_deposits
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE club_pool."CrossChainDepositStatus" USING "status"::text::club_pool."CrossChainDepositStatus",
  ALTER COLUMN "status" SET DEFAULT 'RECEIVED'::club_pool."CrossChainDepositStatus";

ALTER TABLE IF EXISTS club_pool.cross_chain_redemptions
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE club_pool."CrossChainRedemptionStatus" USING "status"::text::club_pool."CrossChainRedemptionStatus",
  ALTER COLUMN "status" SET DEFAULT 'BURN_REQUESTED'::club_pool."CrossChainRedemptionStatus";
