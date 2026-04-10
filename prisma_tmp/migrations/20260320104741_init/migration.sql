-- CreateEnum
CREATE TYPE "PoolStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ERROR');

-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('OPEN', 'SETTLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "QueueStatus" AS ENUM ('SCHEDULED', 'EXECUTED', 'SKIPPED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "Side" AS ENUM ('YES', 'NO');

-- CreateTable
CREATE TABLE "club_pools" (
    "id" TEXT NOT NULL,
    "clubName" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "cash" DECIMAL(78,18) NOT NULL DEFAULT 0,
    "openPositionsValue" DECIMAL(78,18) NOT NULL DEFAULT 0,
    "realizedPnl" DECIMAL(78,18) NOT NULL DEFAULT 0,
    "totalPoolValue" DECIMAL(78,18) NOT NULL DEFAULT 0,
    "totalTokenSupply" DECIMAL(78,18) NOT NULL DEFAULT 0,
    "officialTokenPrice" DECIMAL(78,18) NOT NULL DEFAULT 0,
    "riskParams" JSONB NOT NULL DEFAULT '{}',
    "status" "PoolStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "club_pools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "club_pool_users" (
    "id" TEXT NOT NULL,
    "poolId" TEXT NOT NULL,
    "userAddress" TEXT NOT NULL,
    "tokenBalance" DECIMAL(78,18) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "club_pool_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "club_pool_transactions" (
    "id" TEXT NOT NULL,
    "poolId" TEXT NOT NULL,
    "userAddress" TEXT NOT NULL,
    "depositAmount" DECIMAL(78,18) NOT NULL,
    "netPoolAmount" DECIMAL(78,18) NOT NULL,
    "feeAmount" DECIMAL(78,18) NOT NULL,
    "tokenPriceAtMint" DECIMAL(78,18) NOT NULL,
    "tokensMinted" DECIMAL(78,18) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "club_pool_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "club_pool_positions" (
    "id" TEXT NOT NULL,
    "poolId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "clobOrderId" TEXT,
    "side" "Side" NOT NULL,
    "entryPrice" DECIMAL(78,18) NOT NULL,
    "plannedStake" DECIMAL(78,18) NOT NULL DEFAULT 0,
    "plannedQuantity" DECIMAL(78,18) NOT NULL DEFAULT 0,
    "stake" DECIMAL(78,18) NOT NULL DEFAULT 0,
    "quantity" DECIMAL(78,18) NOT NULL DEFAULT 0,
    "investedAmount" DECIMAL(78,18) NOT NULL DEFAULT 0,
    "currentValue" DECIMAL(78,18) NOT NULL DEFAULT 0,
    "realizedPnl" DECIMAL(78,18) NOT NULL DEFAULT 0,
    "status" "PositionStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "club_pool_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "club_pool_price_snapshots" (
    "id" TEXT NOT NULL,
    "poolId" TEXT NOT NULL,
    "cash" DECIMAL(78,18) NOT NULL,
    "positionsValue" DECIMAL(78,18) NOT NULL,
    "realizedPnl" DECIMAL(78,18) NOT NULL,
    "totalPoolValue" DECIMAL(78,18) NOT NULL,
    "officialTokenPrice" DECIMAL(78,18) NOT NULL,
    "snapshotTime" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "club_pool_price_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "club_teams_map" (
    "id" TEXT NOT NULL,
    "internalClubName" TEXT NOT NULL,
    "polymarketTeamId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "club_teams_map_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "club_market_candidates" (
    "id" TEXT NOT NULL,
    "poolId" TEXT NOT NULL,
    "clubName" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "side" "Side" NOT NULL,
    "kickoffTime" TIMESTAMP(3),
    "entryWindow" TIMESTAMP(3),
    "liquidityUsd" DECIMAL(78,18) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'CANDIDATE',
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "club_market_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "club_match_queue" (
    "id" TEXT NOT NULL,
    "poolId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "executionTime" TIMESTAMP(3) NOT NULL,
    "tranche" INTEGER NOT NULL,
    "stakeUsd" DECIMAL(78,18) NOT NULL,
    "status" "QueueStatus" NOT NULL DEFAULT 'SCHEDULED',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "club_match_queue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "club_pool_users_userAddress_idx" ON "club_pool_users"("userAddress");

-- CreateIndex
CREATE UNIQUE INDEX "club_pool_users_poolId_userAddress_key" ON "club_pool_users"("poolId", "userAddress");

-- CreateIndex
CREATE INDEX "club_pool_transactions_poolId_userAddress_idx" ON "club_pool_transactions"("poolId", "userAddress");

-- CreateIndex
CREATE INDEX "club_pool_positions_poolId_tokenId_idx" ON "club_pool_positions"("poolId", "tokenId");

-- CreateIndex
CREATE INDEX "club_pool_price_snapshots_poolId_snapshotTime_idx" ON "club_pool_price_snapshots"("poolId", "snapshotTime");

-- CreateIndex
CREATE UNIQUE INDEX "club_teams_map_internalClubName_polymarketTeamId_key" ON "club_teams_map"("internalClubName", "polymarketTeamId");

-- CreateIndex
CREATE INDEX "club_market_candidates_poolId_eventId_tokenId_idx" ON "club_market_candidates"("poolId", "eventId", "tokenId");

-- CreateIndex
CREATE INDEX "club_match_queue_poolId_executionTime_status_idx" ON "club_match_queue"("poolId", "executionTime", "status");

-- AddForeignKey
ALTER TABLE "club_pool_users" ADD CONSTRAINT "club_pool_users_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "club_pools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "club_pool_transactions" ADD CONSTRAINT "club_pool_transactions_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "club_pools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "club_pool_positions" ADD CONSTRAINT "club_pool_positions_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "club_pools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "club_pool_price_snapshots" ADD CONSTRAINT "club_pool_price_snapshots_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "club_pools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "club_market_candidates" ADD CONSTRAINT "club_market_candidates_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "club_pools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "club_match_queue" ADD CONSTRAINT "club_match_queue_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "club_pools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
