ALTER TYPE "QueueStatus" ADD VALUE IF NOT EXISTS 'PROCESSING';
ALTER TYPE "CrossChainDepositStatus" ADD VALUE IF NOT EXISTS 'NEEDS_MANUAL_RECONCILIATION';

ALTER TABLE "club_match_queue"
  ADD COLUMN IF NOT EXISTS "lockedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lockedBy" TEXT,
  ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "executedAt" TIMESTAMP(3);

ALTER TABLE "club_pool_positions"
  ADD COLUMN IF NOT EXISTS "queueId" TEXT;

CREATE TABLE IF NOT EXISTS "cross_chain_deposits" (
  "id" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "userAddress" TEXT NOT NULL,
  "sourceToken" TEXT NOT NULL,
  "sourceAmount" DECIMAL(78,18) NOT NULL,
  "chilizDepositId" BIGINT NOT NULL,
  "chilizTxHash" TEXT,
  "usdcAmount" DECIMAL(78,18),
  "polygonDepositTxHash" TEXT,
  "sharesMinted" DECIMAL(78,18),
  "chilizMintTxHash" TEXT,
  "status" "CrossChainDepositStatus" NOT NULL DEFAULT 'RECEIVED',
  "processingLockedAt" TIMESTAMP(3),
  "processingLockedBy" TEXT,
  "processingStep" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "cross_chain_deposits_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "cross_chain_deposits"
  ADD COLUMN IF NOT EXISTS "processingLockedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "processingLockedBy" TEXT,
  ADD COLUMN IF NOT EXISTS "processingStep" TEXT,
  ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "base_chain_deposits"
  ADD COLUMN IF NOT EXISTS "polygonBalanceBeforeBridge" DECIMAL(78,18),
  ADD COLUMN IF NOT EXISTS "processingLockedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "processingLockedBy" TEXT,
  ADD COLUMN IF NOT EXISTS "processingStep" TEXT,
  ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS "club_match_queue_poolId_candidateId_tranche_key"
  ON "club_match_queue"("poolId", "candidateId", "tranche");

CREATE UNIQUE INDEX IF NOT EXISTS "club_pool_positions_queueId_key"
  ON "club_pool_positions"("queueId");

CREATE INDEX IF NOT EXISTS "cross_chain_deposits_status_processingLockedAt_idx"
  ON "cross_chain_deposits"("status", "processingLockedAt");

CREATE INDEX IF NOT EXISTS "cross_chain_deposits_poolId_userAddress_idx"
  ON "cross_chain_deposits"("poolId", "userAddress");

CREATE INDEX IF NOT EXISTS "cross_chain_deposits_status_idx"
  ON "cross_chain_deposits"("status");

CREATE UNIQUE INDEX IF NOT EXISTS "cross_chain_deposits_chilizDepositId_key"
  ON "cross_chain_deposits"("chilizDepositId");

CREATE INDEX IF NOT EXISTS "base_chain_deposits_status_processingLockedAt_idx"
  ON "base_chain_deposits"("status", "processingLockedAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'club_pool_positions_queueId_fkey'
  ) THEN
    ALTER TABLE "club_pool_positions"
      ADD CONSTRAINT "club_pool_positions_queueId_fkey"
      FOREIGN KEY ("queueId") REFERENCES "club_match_queue"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
