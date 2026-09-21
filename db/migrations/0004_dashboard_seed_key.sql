-- ============================================================================
--  0004: a stable identity for pipeline-seeded dashboards.
--
--  The seeder matched on slug, which was the dashboard's identity only for as
--  long as nobody could rename one. Now that they can: renaming a seeded
--  dashboard frees its original slug, the next pipeline run sees that slug
--  missing and seeds a second copy, and the user ends up with both.
--
--  seed_key is the identity instead. It never changes, so a renamed seeded
--  dashboard is still recognised as the same one and is left alone.
-- ============================================================================

ALTER TABLE platform.dashboard
    ADD COLUMN IF NOT EXISTS seed_key TEXT;

-- Backfill: the existing seeded rows are identified by their current slug,
-- which is still correct for any that have not been renamed yet.
UPDATE platform.dashboard
   SET seed_key = slug
 WHERE created_by = 'pipeline'
   AND seed_key IS NULL;

-- A plain unique index, not a partial one. Postgres treats NULLs as distinct,
-- so user-created and AI-created dashboards can all leave seed_key NULL
-- without colliding - and ON CONFLICT (seed_key) can infer this index, which
-- it cannot do for a partial one ("no unique or exclusion constraint matching
-- the ON CONFLICT specification").
CREATE UNIQUE INDEX IF NOT EXISTS ux_dashboard_seed_key
    ON platform.dashboard (seed_key);
