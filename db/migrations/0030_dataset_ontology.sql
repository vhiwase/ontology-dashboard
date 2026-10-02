-- ============================================================================
--  0030: one path from a source to an ontology.
--
--  The platform had grown four ways of getting data into shape - a pipeline
--  canvas, code repositories (SQL, Python and function files), REST and
--  PostgreSQL connections with snapshot and incremental syncs, and a Python
--  generator that introspected tms_views and published an ontology on every
--  boot - plus eval suites and a generated lineage graph on top. It is cut back
--  to one path:
--
--      PostgreSQL connection --sync--> dataset --> object types
--                 ^                   (as-is)       + links, actions,
--             schedule                               metrics, functions
--        (every 20 min, 2 h, 1 day, 8 days ...)
--
--  A sync copies one view or table from the source into connection_raw exactly
--  as it is. Object types are then created FROM those datasets - by a person,
--  or by the AI-FDE - rather than generated from tms_views.
--
--  What this migration removes is platform machinery, not source data:
--  tms_raw and tms_views (the captured TMS snapshot, which the connection now
--  reads like any other source) are untouched. The generated ontology versions
--  are deactivated, not deleted, so what they held can still be read back.
-- ============================================================================

-- -- 1. the pipeline builder --------------------------------------------------

DROP TABLE IF EXISTS platform.dataset_version CASCADE;
DROP TABLE IF EXISTS platform.pipeline_node_run CASCADE;
DROP TABLE IF EXISTS platform.pipeline_run CASCADE;
DROP TABLE IF EXISTS platform.pipeline_version CASCADE;
DROP TABLE IF EXISTS platform.pipeline CASCADE;
DROP SCHEMA IF EXISTS pipeline_out CASCADE;

-- -- 2. code repositories -----------------------------------------------------

DROP TABLE IF EXISTS platform.code_build CASCADE;
DROP TABLE IF EXISTS platform.code_commit CASCADE;
DROP TABLE IF EXISTS platform.code_file CASCADE;
DROP TABLE IF EXISTS platform.code_repo CASCADE;
DROP SCHEMA IF EXISTS repo_out CASCADE;

-- -- 3. eval suites -----------------------------------------------------------

DROP TABLE IF EXISTS platform.eval_run CASCADE;
DROP TABLE IF EXISTS platform.eval_case CASCADE;
DROP TABLE IF EXISTS platform.eval_suite CASCADE;

-- -- 4. the generator's lineage graph and run log -----------------------------
--  Both were written only by the Python generator, which no longer runs. A
--  dataset's provenance is now its sync (connection, source relation, run
--  history), and an object type's is the dataset it was created from.

DROP TABLE IF EXISTS platform.lineage_edge CASCADE;
DROP TABLE IF EXISTS platform.lineage_column CASCADE;
DROP TABLE IF EXISTS platform.lineage_node CASCADE;
DROP TABLE IF EXISTS platform.generation_run CASCADE;

-- -- 5. connections: PostgreSQL, snapshot -------------------------------------
--  REST connections go, with their syncs, their landing tables and the dataset
--  cards those tables had. Collected first, because deleting the connection
--  cascades the sync rows that name the tables.

CREATE TEMP TABLE _rest_landing ON COMMIT DROP AS
SELECT s.target_table
  FROM platform.connection_sync s
  JOIN platform.resource r ON r.resource_id = s.resource_id
 WHERE s.source_schema = 'rest' OR lower(r.properties->>'engine') = 'rest';

DO $$
DECLARE
    landing text;
BEGIN
    FOR landing IN SELECT target_table FROM _rest_landing LOOP
        EXECUTE format('DROP TABLE IF EXISTS connection_raw.%I', landing);
    END LOOP;
END $$;

DELETE FROM platform.resource
 WHERE kind = 'dataset'
   AND target_ref IN (SELECT 'connection_raw.' || target_table FROM _rest_landing);

DELETE FROM platform.resource
 WHERE kind = 'connection' AND lower(properties->>'engine') = 'rest';

-- A sync is a snapshot: the landing table is rebuilt from the source on every
-- run, so the dataset is what the source holds now - "as it is". Incremental
-- syncs become snapshots; their next run rebuilds the table in full.
ALTER TABLE platform.connection_sync DROP CONSTRAINT IF EXISTS connection_sync_cursor_required;
ALTER TABLE platform.connection_sync DROP CONSTRAINT IF EXISTS connection_sync_rest_path;
ALTER TABLE platform.connection_sync DROP CONSTRAINT IF EXISTS connection_sync_mode_check;
ALTER TABLE platform.connection_sync DROP COLUMN IF EXISTS mode;
ALTER TABLE platform.connection_sync DROP COLUMN IF EXISTS cursor_column;
ALTER TABLE platform.connection_sync DROP COLUMN IF EXISTS last_cursor_value;
ALTER TABLE platform.connection_sync DROP COLUMN IF EXISTS source_path;
ALTER TABLE platform.connection_sync DROP COLUMN IF EXISTS records_path;

-- -- 6. schedules fire syncs, one cadence per sync ----------------------------

DELETE FROM platform.schedule WHERE kind <> 'sync';

-- Keep the oldest where a sync had several: two cadences on one table would
-- each rebuild it under the other.
DELETE FROM platform.schedule a
 USING platform.schedule b
 WHERE a.space_id = b.space_id
   AND a.target_ref = b.target_ref
   AND a.schedule_id > b.schedule_id;

ALTER TABLE platform.schedule DROP CONSTRAINT IF EXISTS schedule_kind_check;
ALTER TABLE platform.schedule ADD CONSTRAINT schedule_kind_check CHECK (kind = 'sync');
CREATE UNIQUE INDEX IF NOT EXISTS ux_schedule_one_per_sync
    ON platform.schedule (space_id, target_ref);

-- -- 7. workspace resources ---------------------------------------------------
--  Pipeline and repository cards go with what they pointed at. So do the
--  ontology cards (object types, links, actions, metrics) the old seed made
--  for the generated ontology, and datasets registered straight onto a
--  tms_views view: a dataset is now what a sync landed. The service re-creates
--  ontology cards for whatever is authored from here on.

DELETE FROM platform.resource
 WHERE kind IN ('pipeline', 'codeRepo', 'objectType', 'linkType', 'actionType', 'kpi');

DELETE FROM platform.resource
 WHERE kind = 'dataset' AND coalesce(properties->>'backing', '') <> 'sync';

ALTER TABLE platform.resource DROP CONSTRAINT IF EXISTS resource_kind_check;
ALTER TABLE platform.resource ADD CONSTRAINT resource_kind_check
    CHECK (kind IN ('connection', 'dataset', 'objectType', 'linkType', 'actionType', 'kpi', 'dashboard'));

-- -- 8. retire the generated ontology -----------------------------------------
--  Deactivated rather than deleted: the versions keep their object types, links
--  and actions, so the old model can still be read back if it is ever wanted.
--  The ontology service creates an empty active version per space at boot, and
--  object types are authored into it from datasets.

UPDATE platform.ontology_version SET is_active = false WHERE is_active;

-- The generated metric catalogue read tms_views directly. Metrics are now
-- defined over object types, whose data is a synced dataset.
DELETE FROM platform.kpi_definition WHERE source_view LIKE 'tms\_views.%';

-- The seeded boards were built on that catalogue and would render nothing but
-- missing-metric errors. Boards people or the assistant built are kept.
DELETE FROM platform.dashboard WHERE seed_key IS NOT NULL;

-- Metrics are authored now, so they are journalled like everything else.
ALTER TABLE platform.ontology_edit DROP CONSTRAINT IF EXISTS ontology_edit_target_kind_check;
ALTER TABLE platform.ontology_edit ADD CONSTRAINT ontology_edit_target_kind_check
    CHECK (target_kind IN ('objectType', 'property', 'linkType', 'actionType', 'metric'));

COMMENT ON COLUMN platform.object_type.source_view IS
    'The dataset this object type was created from: connection_raw.<table>, '
    'landed by a connection sync.';
