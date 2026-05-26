CREATE TABLE IF NOT EXISTS "chain_event_cursors" (
  "key" TEXT NOT NULL,
  "chain" TEXT NOT NULL,
  "contractAddress" TEXT NOT NULL,
  "eventName" TEXT NOT NULL,
  "lastProcessedBlock" BIGINT NOT NULL DEFAULT 0,
  "lockedAt" TIMESTAMP(3),
  "lockedBy" TEXT,
  "cooldownUntil" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "chain_event_cursors_pkey" PRIMARY KEY ("key")
);

CREATE INDEX IF NOT EXISTS "chain_event_cursors_chain_contractAddress_eventName_idx"
  ON "chain_event_cursors"("chain", "contractAddress", "eventName");

CREATE INDEX IF NOT EXISTS "chain_event_cursors_lockedAt_idx"
  ON "chain_event_cursors"("lockedAt");

CREATE INDEX IF NOT EXISTS "chain_event_cursors_cooldownUntil_idx"
  ON "chain_event_cursors"("cooldownUntil");
