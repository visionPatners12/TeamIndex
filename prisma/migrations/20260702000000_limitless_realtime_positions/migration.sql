-- Enable Supabase Realtime for pool state that the client can subscribe to.
--
-- The migration is intentionally idempotent because some linked Supabase
-- projects may have had individual tables added manually while local vanilla
-- Postgres instances do not have the supabase_realtime publication at all.
DO $$
DECLARE
  realtime_table text;
  realtime_tables text[] := ARRAY[
    'club_pools',
    'club_pool_users',
    'club_pool_positions',
    'pool_limitless_position_snapshots',
    'pool_limitless_trades',
    'pool_limitless_pnl_snapshots',
    'pool_valuation_snapshots'
  ];
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication
    WHERE pubname = 'supabase_realtime'
  ) THEN
    RAISE NOTICE 'Publication supabase_realtime does not exist; skipping realtime table registration.';
    RETURN;
  END IF;

  FOREACH realtime_table IN ARRAY realtime_tables LOOP
    IF to_regclass(format('public.%I', realtime_table)) IS NULL THEN
      RAISE NOTICE 'Table public.% does not exist; skipping realtime registration.', realtime_table;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I REPLICA IDENTITY FULL', realtime_table);

    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = realtime_table
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', realtime_table);
    END IF;
  END LOOP;
END $$;
