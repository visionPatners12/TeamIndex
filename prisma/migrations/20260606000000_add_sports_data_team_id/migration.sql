ALTER TABLE "club_pools"
  ADD COLUMN IF NOT EXISTS "sportsDataTeamId" UUID;

CREATE INDEX IF NOT EXISTS "club_pools_sportsDataTeamId_idx"
  ON "club_pools"("sportsDataTeamId");
