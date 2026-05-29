-- Snapshot of the CLOB/Gamma market data consumed by the allocation engine.
ALTER TABLE "pool_allocation_proposals"
  ADD COLUMN IF NOT EXISTS "marketDataJson" JSONB;
