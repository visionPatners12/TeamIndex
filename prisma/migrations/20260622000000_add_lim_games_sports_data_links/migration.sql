ALTER TABLE "lim_games"
  ADD COLUMN IF NOT EXISTS "sportsDataGameId" TEXT,
  ADD COLUMN IF NOT EXISTS "homeSportsDataTeamId" UUID,
  ADD COLUMN IF NOT EXISTS "awaySportsDataTeamId" UUID;

CREATE INDEX IF NOT EXISTS "lim_games_sportsDataGameId_idx"
  ON "lim_games"("sportsDataGameId");

CREATE INDEX IF NOT EXISTS "lim_games_homeSportsDataTeamId_idx"
  ON "lim_games"("homeSportsDataTeamId");

CREATE INDEX IF NOT EXISTS "lim_games_awaySportsDataTeamId_idx"
  ON "lim_games"("awaySportsDataTeamId");

DO $$
BEGIN
  IF to_regclass('sports_data.games') IS NOT NULL THEN
    UPDATE "lim_games" lg
    SET
      "sportsDataGameId" = g.id::text,
      "homeSportsDataTeamId" = g.home_id,
      "awaySportsDataTeamId" = g.away_id
    FROM "limitless_markets" lm
    JOIN sports_data.games g
      ON (
        lm.id LIKE '%' || g.id::text || '%'
        OR coalesce(lm."rawJson"::text, '') LIKE '%' || g.id::text || '%'
      )
    WHERE lm.id = lg."marketId"
      AND lg."sportsDataGameId" IS NULL;
  END IF;
EXCEPTION
  WHEN undefined_column THEN
    NULL;
END $$;
