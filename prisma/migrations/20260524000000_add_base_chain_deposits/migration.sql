DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CrossChainDepositStatus') THEN
    CREATE TYPE "CrossChainDepositStatus" AS ENUM ('RECEIVED', 'BRIDGING', 'DEPOSITING', 'MINTING_SHARES', 'COMPLETED', 'FAILED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "base_chain_deposits" (
    "id" TEXT NOT NULL,
    "poolIdHash" TEXT NOT NULL,
    "clubPoolId" TEXT,
    "userAddress" TEXT NOT NULL,
    "sourceToken" TEXT NOT NULL,
    "sourceAmount" DECIMAL(78,18) NOT NULL,
    "baseDepositId" BIGINT NOT NULL,
    "baseTxHash" TEXT,
    "releaseTxHash" TEXT,
    "lifiBridgeTxHash" TEXT,
    "usdcAmount" DECIMAL(78,18),
    "polygonDepositTxHash" TEXT,
    "sharesMinted" DECIMAL(78,18),
    "baseMintTxHash" TEXT,
    "status" "CrossChainDepositStatus" NOT NULL DEFAULT 'RECEIVED',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "base_chain_deposits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "base_chain_deposits_poolIdHash_userAddress_idx" ON "base_chain_deposits"("poolIdHash", "userAddress");
CREATE INDEX IF NOT EXISTS "base_chain_deposits_clubPoolId_idx" ON "base_chain_deposits"("clubPoolId");
CREATE INDEX IF NOT EXISTS "base_chain_deposits_status_idx" ON "base_chain_deposits"("status");
CREATE UNIQUE INDEX IF NOT EXISTS "base_chain_deposits_baseDepositId_key" ON "base_chain_deposits"("baseDepositId");
