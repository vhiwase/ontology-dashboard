-- ============================================================================
--  0005: repair seed_key for dashboards renamed before 0004 existed.
--
--  0004 backfilled seed_key from the CURRENT slug, which is right for a
--  dashboard nobody had renamed. A dashboard renamed between 0003 (which
--  introduced renaming) and 0004 got its post-rename slug as its seed_key, so
--  the seeder still could not recognise it and seeded a second copy.
--
--  In a deployment that applies 0003 and 0004 in the same pass this cannot
--  happen. It can happen where they were applied separately, which is exactly
--  the case migrations have to survive.
--
--  platform.dashboard_rename records previous_slug, so the original name is
--  recoverable: take the earliest rename for each dashboard.
-- ============================================================================

-- Any duplicate the old behaviour already created: the seeded copy is the one
-- with no rename history and default content, so the renamed original wins and
-- the untouched duplicate goes.
DELETE FROM platform.dashboard d
 WHERE d.created_by = 'pipeline'
   AND NOT EXISTS (
       SELECT 1 FROM platform.dashboard_rename r WHERE r.dashboard_id = d.dashboard_id
   )
   AND EXISTS (
       -- Another pipeline dashboard whose rename history starts at this slug,
       -- which means this row is the re-seeded copy of that one.
       SELECT 1
         FROM platform.dashboard_rename r
        WHERE r.previous_slug = d.slug
          AND r.dashboard_id <> d.dashboard_id
   );

-- Point each renamed dashboard's seed_key back at the slug it was seeded under.
UPDATE platform.dashboard d
   SET seed_key = origin.previous_slug
  FROM (
      SELECT DISTINCT ON (dashboard_id) dashboard_id, previous_slug
        FROM platform.dashboard_rename
       ORDER BY dashboard_id, renamed_at ASC
  ) AS origin
 WHERE origin.dashboard_id = d.dashboard_id
   AND d.created_by = 'pipeline'
   AND d.seed_key IS DISTINCT FROM origin.previous_slug;
