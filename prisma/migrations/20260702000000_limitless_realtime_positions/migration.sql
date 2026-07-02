CREATE TABLE IF NOT EXISTS "pool_limitless_orders" (
  "id" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "accountId" TEXT,
  "orderId" TEXT NOT NULL,
  "clientOrderId" TEXT,
  "marketId" TEXT,
  "marketSlug" TEXT,
  "tokenId" TEXT,
  "side" TEXT,
  "outcome" TEXT,
  "orderSide" TEXT,
  "price" DECIMAL(78,18),
  "originalSize" DECIMAL(78,18),
  "remainingSize" DECIMAL(78,18),
  "filledSize" DECIMAL(78,18) NOT NULL DEFAULT 0,
  "collateral" DECIMAL(78,18) NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "source" TEXT,
  "lastEventType" TEXT,
  "lastEventId" TEXT,
  "lastEventAt" TIMESTAMP(3),
  "rawJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pool_limitless_orders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "pool_limitless_orders_poolId_orderId_key"
  ON "pool_limitless_orders"("poolId", "orderId");
CREATE INDEX IF NOT EXISTS "pool_limitless_orders_poolId_status_idx"
  ON "pool_limitless_orders"("poolId", "status");
CREATE INDEX IF NOT EXISTS "pool_limitless_orders_marketSlug_idx"
  ON "pool_limitless_orders"("marketSlug");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pool_limitless_orders_poolId_fkey'
  ) THEN
    ALTER TABLE "pool_limitless_orders"
      ADD CONSTRAINT "pool_limitless_orders_poolId_fkey"
      FOREIGN KEY ("poolId") REFERENCES "club_pools"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "pool_limitless_order_events" (
  "id" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "accountId" TEXT,
  "orderId" TEXT,
  "clientOrderId" TEXT,
  "eventId" TEXT NOT NULL,
  "tradeEventId" TEXT,
  "source" TEXT,
  "type" TEXT,
  "status" TEXT,
  "marketId" TEXT,
  "marketSlug" TEXT,
  "tokenId" TEXT,
  "side" TEXT,
  "outcome" TEXT,
  "price" DECIMAL(78,18),
  "amountContracts" DECIMAL(78,18),
  "amountCollateral" DECIMAL(78,18),
  "fee" DECIMAL(78,18),
  "txHash" TEXT,
  "isEstimate" BOOLEAN NOT NULL DEFAULT false,
  "occurredAt" TIMESTAMP(3),
  "rawJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pool_limitless_order_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "pool_limitless_order_events_poolId_eventId_key"
  ON "pool_limitless_order_events"("poolId", "eventId");
CREATE INDEX IF NOT EXISTS "pool_limitless_order_events_poolId_occurredAt_idx"
  ON "pool_limitless_order_events"("poolId", "occurredAt");
CREATE INDEX IF NOT EXISTS "pool_limitless_order_events_orderId_idx"
  ON "pool_limitless_order_events"("orderId");
CREATE INDEX IF NOT EXISTS "pool_limitless_order_events_marketSlug_idx"
  ON "pool_limitless_order_events"("marketSlug");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pool_limitless_order_events_poolId_fkey'
  ) THEN
    ALTER TABLE "pool_limitless_order_events"
      ADD CONSTRAINT "pool_limitless_order_events_poolId_fkey"
      FOREIGN KEY ("poolId") REFERENCES "club_pools"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION notify_pool_positions_change()
RETURNS trigger AS $$
DECLARE
  pool_id text;
  row_id text;
BEGIN
  pool_id := COALESCE(NEW."poolId", OLD."poolId");
  row_id := COALESCE(NEW."id", OLD."id");

  IF pool_id IS NOT NULL THEN
    PERFORM pg_notify(
      'team_index_pool_positions',
      json_build_object(
        'poolId', pool_id,
        'table', TG_TABLE_NAME,
        'op', TG_OP,
        'rowId', row_id,
        'version', floor(extract(epoch from clock_timestamp()) * 1000)::bigint
      )::text
    );
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION notify_pool_row_change()
RETURNS trigger AS $$
DECLARE
  pool_id text;
BEGIN
  pool_id := COALESCE(NEW."id", OLD."id");

  IF pool_id IS NOT NULL THEN
    PERFORM pg_notify(
      'team_index_pool_positions',
      json_build_object(
        'poolId', pool_id,
        'table', TG_TABLE_NAME,
        'op', TG_OP,
        'rowId', pool_id,
        'version', floor(extract(epoch from clock_timestamp()) * 1000)::bigint
      )::text
    );
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS club_pool_positions_notify_pool_positions ON "club_pool_positions";
CREATE TRIGGER club_pool_positions_notify_pool_positions
AFTER INSERT OR UPDATE OR DELETE ON "club_pool_positions"
FOR EACH ROW EXECUTE FUNCTION notify_pool_positions_change();

DROP TRIGGER IF EXISTS pool_limitless_orders_notify_pool_positions ON "pool_limitless_orders";
CREATE TRIGGER pool_limitless_orders_notify_pool_positions
AFTER INSERT OR UPDATE OR DELETE ON "pool_limitless_orders"
FOR EACH ROW EXECUTE FUNCTION notify_pool_positions_change();

DROP TRIGGER IF EXISTS pool_limitless_order_events_notify_pool_positions ON "pool_limitless_order_events";
CREATE TRIGGER pool_limitless_order_events_notify_pool_positions
AFTER INSERT OR UPDATE OR DELETE ON "pool_limitless_order_events"
FOR EACH ROW EXECUTE FUNCTION notify_pool_positions_change();

DROP TRIGGER IF EXISTS pool_limitless_trades_notify_pool_positions ON "pool_limitless_trades";
CREATE TRIGGER pool_limitless_trades_notify_pool_positions
AFTER INSERT OR UPDATE OR DELETE ON "pool_limitless_trades"
FOR EACH ROW EXECUTE FUNCTION notify_pool_positions_change();

DROP TRIGGER IF EXISTS club_pools_notify_pool_positions ON "club_pools";
CREATE TRIGGER club_pools_notify_pool_positions
AFTER UPDATE ON "club_pools"
FOR EACH ROW EXECUTE FUNCTION notify_pool_row_change();
