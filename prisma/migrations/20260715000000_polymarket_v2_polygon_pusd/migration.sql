-- Active TeamIndex trading path: Polymarket CLOB V2 on Polygon using pUSD.
-- Limitless tables are intentionally retained for historical/legacy reads.

CREATE TABLE IF NOT EXISTS "pool_polymarket_accounts" (
  "id" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "cdpAccountName" TEXT NOT NULL,
  "cdpOwnerAddress" TEXT NOT NULL,
  "depositWalletAddress" TEXT NOT NULL,
  "vaultAddress" TEXT NOT NULL,
  "clobApiKeyCiphertext" TEXT,
  "clobSecretCiphertext" TEXT,
  "clobPassphraseCiphertext" TEXT,
  "credentialsVersion" INTEGER NOT NULL DEFAULT 1,
  "approvalsReady" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "lastReconciledAt" TIMESTAMP(3),
  "rawJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pool_polymarket_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pool_polymarket_accounts_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "club_pools"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "pool_polymarket_accounts_poolId_key" ON "pool_polymarket_accounts"("poolId");
CREATE UNIQUE INDEX IF NOT EXISTS "pool_polymarket_accounts_cdpAccountName_key" ON "pool_polymarket_accounts"("cdpAccountName");
CREATE UNIQUE INDEX IF NOT EXISTS "pool_polymarket_accounts_cdpOwnerAddress_key" ON "pool_polymarket_accounts"("cdpOwnerAddress");
CREATE UNIQUE INDEX IF NOT EXISTS "pool_polymarket_accounts_depositWalletAddress_key" ON "pool_polymarket_accounts"("depositWalletAddress");
CREATE INDEX IF NOT EXISTS "pool_polymarket_accounts_status_idx" ON "pool_polymarket_accounts"("status");

CREATE TABLE IF NOT EXISTS "pool_trade_intents" (
  "id" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "proposalId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "proposalHash" TEXT NOT NULL,
  "conditionId" TEXT NOT NULL,
  "tokenId" TEXT NOT NULL,
  "side" "Side" NOT NULL,
  "orderType" TEXT NOT NULL DEFAULT 'FAK',
  "limitPrice" DECIMAL(20,8) NOT NULL,
  "amount" DECIMAL(78,18) NOT NULL,
  "maxSlippageBps" INTEGER NOT NULL,
  "reservedPusd" DECIMAL(78,18) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lockedAt" TIMESTAMP(3),
  "lockedBy" TEXT,
  "lastError" TEXT,
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pool_trade_intents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pool_trade_intents_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "club_pools"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "pool_trade_intents_idempotencyKey_key" ON "pool_trade_intents"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "pool_trade_intents_poolId_status_createdAt_idx" ON "pool_trade_intents"("poolId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "pool_trade_intents_proposalHash_idx" ON "pool_trade_intents"("proposalHash");

CREATE TABLE IF NOT EXISTS "pool_polymarket_orders" (
  "id" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "intentId" TEXT NOT NULL,
  "externalOrderId" TEXT,
  "conditionId" TEXT NOT NULL,
  "tokenId" TEXT NOT NULL,
  "side" "Side" NOT NULL,
  "orderType" TEXT NOT NULL,
  "price" DECIMAL(20,8) NOT NULL,
  "originalSize" DECIMAL(78,18) NOT NULL,
  "matchedSize" DECIMAL(78,18) NOT NULL DEFAULT 0,
  "feeRateBps" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "submittedAt" TIMESTAMP(3),
  "closedAt" TIMESTAMP(3),
  "rawJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pool_polymarket_orders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pool_polymarket_orders_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "club_pools"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pool_polymarket_orders_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "pool_polymarket_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pool_polymarket_orders_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "pool_trade_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "pool_polymarket_orders_intentId_key" ON "pool_polymarket_orders"("intentId");
CREATE UNIQUE INDEX IF NOT EXISTS "pool_polymarket_orders_externalOrderId_key" ON "pool_polymarket_orders"("externalOrderId");
CREATE INDEX IF NOT EXISTS "pool_polymarket_orders_poolId_status_idx" ON "pool_polymarket_orders"("poolId", "status");
CREATE INDEX IF NOT EXISTS "pool_polymarket_orders_tokenId_idx" ON "pool_polymarket_orders"("tokenId");

CREATE TABLE IF NOT EXISTS "pool_polymarket_trades" (
  "id" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "orderId" TEXT,
  "externalTradeId" TEXT NOT NULL,
  "conditionId" TEXT NOT NULL,
  "tokenId" TEXT NOT NULL,
  "side" "Side" NOT NULL,
  "price" DECIMAL(20,8) NOT NULL,
  "size" DECIMAL(78,18) NOT NULL,
  "fee" DECIMAL(78,18) NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL,
  "executedAt" TIMESTAMP(3) NOT NULL,
  "rawJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pool_polymarket_trades_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pool_polymarket_trades_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "club_pools"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pool_polymarket_trades_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "pool_polymarket_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pool_polymarket_trades_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "pool_polymarket_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "pool_polymarket_trades_externalTradeId_key" ON "pool_polymarket_trades"("externalTradeId");
CREATE INDEX IF NOT EXISTS "pool_polymarket_trades_poolId_executedAt_idx" ON "pool_polymarket_trades"("poolId", "executedAt");
CREATE INDEX IF NOT EXISTS "pool_polymarket_trades_tokenId_idx" ON "pool_polymarket_trades"("tokenId");

CREATE TABLE IF NOT EXISTS "pool_polymarket_positions" (
  "id" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "conditionId" TEXT NOT NULL,
  "tokenId" TEXT NOT NULL,
  "outcome" TEXT,
  "quantity" DECIMAL(78,18) NOT NULL DEFAULT 0,
  "averagePrice" DECIMAL(20,8) NOT NULL DEFAULT 0,
  "currentPrice" DECIMAL(20,8) NOT NULL DEFAULT 0,
  "currentValue" DECIMAL(78,18) NOT NULL DEFAULT 0,
  "realizedPnl" DECIMAL(78,18) NOT NULL DEFAULT 0,
  "unrealizedPnl" DECIMAL(78,18) NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "lastReconciledAt" TIMESTAMP(3) NOT NULL,
  "rawJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pool_polymarket_positions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pool_polymarket_positions_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "club_pools"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "pool_polymarket_positions_poolId_tokenId_key" ON "pool_polymarket_positions"("poolId", "tokenId");
CREATE INDEX IF NOT EXISTS "pool_polymarket_positions_poolId_status_idx" ON "pool_polymarket_positions"("poolId", "status");

CREATE TABLE IF NOT EXISTS "pool_capital_movements" (
  "id" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "amount" DECIMAL(78,18) NOT NULL,
  "proposalHash" TEXT,
  "txHash" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "rawJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pool_capital_movements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pool_capital_movements_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "club_pools"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "pool_capital_movements_idempotencyKey_key" ON "pool_capital_movements"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "pool_capital_movements_poolId_createdAt_idx" ON "pool_capital_movements"("poolId", "createdAt");
CREATE INDEX IF NOT EXISTS "pool_capital_movements_status_idx" ON "pool_capital_movements"("status");

CREATE TABLE IF NOT EXISTS "pool_deposit_intents" (
  "id" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "userAddress" TEXT NOT NULL,
  "depositWalletAddress" TEXT NOT NULL,
  "receiverAddress" TEXT NOT NULL,
  "assets" DECIMAL(78,18) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'CREATED',
  "txHash" TEXT,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pool_deposit_intents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pool_deposit_intents_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "club_pools"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "pool_deposit_intents_idempotencyKey_key" ON "pool_deposit_intents"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "pool_deposit_intents_poolId_status_idx" ON "pool_deposit_intents"("poolId", "status");
CREATE INDEX IF NOT EXISTS "pool_deposit_intents_userAddress_createdAt_idx" ON "pool_deposit_intents"("userAddress", "createdAt");

CREATE TABLE IF NOT EXISTS "pool_redemption_requests" (
  "id" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "onchainRequestId" BIGINT,
  "ownerAddress" TEXT NOT NULL,
  "receiverAddress" TEXT NOT NULL,
  "shares" DECIMAL(78,18) NOT NULL,
  "minAssets" DECIMAL(78,18) NOT NULL DEFAULT 0,
  "claimableAssets" DECIMAL(78,18) NOT NULL DEFAULT 0,
  "requestTxHash" TEXT,
  "claimTxHash" TEXT,
  "status" TEXT NOT NULL DEFAULT 'REQUESTED',
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pool_redemption_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pool_redemption_requests_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "club_pools"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "pool_redemption_requests_poolId_onchainRequestId_key" ON "pool_redemption_requests"("poolId", "onchainRequestId");
CREATE INDEX IF NOT EXISTS "pool_redemption_requests_ownerAddress_status_idx" ON "pool_redemption_requests"("ownerAddress", "status");
CREATE INDEX IF NOT EXISTS "pool_redemption_requests_poolId_status_idx" ON "pool_redemption_requests"("poolId", "status");

CREATE TABLE IF NOT EXISTS "pool_worker_leases" (
  "key" TEXT NOT NULL,
  "owner" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pool_worker_leases_pkey" PRIMARY KEY ("key")
);
CREATE INDEX IF NOT EXISTS "pool_worker_leases_expiresAt_idx" ON "pool_worker_leases"("expiresAt");

-- New valuations are sourced from reconciled Polymarket accounting, never Limitless.
ALTER TABLE "pool_valuation_snapshots" ALTER COLUMN "source" SET DEFAULT 'POLYMARKET_V2';
ALTER TABLE "pool_valuation_snapshots" ADD COLUMN IF NOT EXISTS "sequence" BIGINT;
ALTER TABLE "pool_valuation_snapshots" ADD COLUMN IF NOT EXISTS "snapshotHash" TEXT;
ALTER TABLE "pool_valuation_snapshots" ADD COLUMN IF NOT EXISTS "valuedAt" TIMESTAMP(3);
ALTER TABLE "pool_valuation_snapshots" ADD COLUMN IF NOT EXISTS "reservedCollateral" DECIMAL(78,18) NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS "pool_valuation_snapshots_poolId_sequence_key" ON "pool_valuation_snapshots"("poolId", "sequence");

-- Private pool execution tables are backend-only. Supabase service_role bypasses RLS.
ALTER TABLE "pool_polymarket_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pool_trade_intents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pool_polymarket_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pool_polymarket_trades" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pool_polymarket_positions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pool_capital_movements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pool_deposit_intents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pool_redemption_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pool_worker_leases" ENABLE ROW LEVEL SECURITY;
