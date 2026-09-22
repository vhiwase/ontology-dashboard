-- ============================================================================
--  0012: the ontology belongs to a space.
--
--  I previously treated the ontology as global — one published version per
--  database, shared by every space — and that was wrong. An ontology is
--  PUBLISHED BY A PIPELINE, and pipelines are space-scoped (0008). So the
--  ontology currently in this database was produced by a pipeline in the
--  sandbox, and it belongs to the sandbox. Showing it under Development,
--  Staging and Production presented sandbox work as though it were live in
--  three environments it had never been promoted to, which is the exact
--  confusion spaces exist to prevent.
--
--  After this, a space with no published ontology honestly has none, and the
--  UI says so instead of borrowing somebody else's.
--
--  FOUR tables need a space, not one. object_type, object_property, link_type
--  and action_type hang off ontology_version by foreign key and follow it for
--  free. But kpi_definition and the three lineage tables are keyed by RID
--  alone with no version column at all, so a second space publishing would
--  collide on the primary key and — for lineage, which the pipeline truncates
--  before writing — silently delete the first space's graph. Their keys become
--  composite with space_id, which is what makes two spaces able to hold their
--  own copy of kpi:on_time_delivery_pct at the same time.
-- ============================================================================

-- ── the ontology version itself ─────────────────────────────────────────────

ALTER TABLE platform.ontology_version
    ADD COLUMN IF NOT EXISTS space_id BIGINT
        REFERENCES platform.space(space_id) ON DELETE RESTRICT;

UPDATE platform.ontology_version
   SET space_id = (SELECT space_id FROM platform.space WHERE slug = 'sandbox')
 WHERE space_id IS NULL;

ALTER TABLE platform.ontology_version ALTER COLUMN space_id SET NOT NULL;

-- One ACTIVE ontology per space, not one per database. The partial unique
-- index is what enforces that promoting a version into a space supersedes the
-- one already there rather than sitting alongside it.
DROP INDEX IF EXISTS platform.ux_ontology_single_active;
CREATE UNIQUE INDEX IF NOT EXISTS ux_ontology_version_active_per_space
    ON platform.ontology_version (space_id)
 WHERE is_active;

CREATE INDEX IF NOT EXISTS ix_ontology_version_space
    ON platform.ontology_version (space_id, created_at DESC);

-- ── the KPI catalogue ───────────────────────────────────────────────────────
--  Not versioned by the pipeline (it upserts on kpi_rid), so it takes a space
--  directly rather than an ontology_version_id.

ALTER TABLE platform.kpi_definition
    ADD COLUMN IF NOT EXISTS space_id BIGINT
        REFERENCES platform.space(space_id) ON DELETE CASCADE;

UPDATE platform.kpi_definition
   SET space_id = (SELECT space_id FROM platform.space WHERE slug = 'sandbox')
 WHERE space_id IS NULL;

ALTER TABLE platform.kpi_definition ALTER COLUMN space_id SET NOT NULL;

-- kpi_rid was the primary key and api_name was globally unique. Both have to
-- become per-space, or staging cannot publish the same metric the sandbox has.
ALTER TABLE platform.kpi_definition DROP CONSTRAINT IF EXISTS kpi_definition_pkey CASCADE;
ALTER TABLE platform.kpi_definition DROP CONSTRAINT IF EXISTS kpi_definition_api_name_key CASCADE;
ALTER TABLE platform.kpi_definition
    ADD CONSTRAINT kpi_definition_pkey PRIMARY KEY (space_id, kpi_rid);
CREATE UNIQUE INDEX IF NOT EXISTS ux_kpi_api_name_per_space
    ON platform.kpi_definition (space_id, api_name);

-- ── lineage ─────────────────────────────────────────────────────────────────
--  The pipeline TRUNCATES these before every write. Without a space column a
--  publish into development would wipe the sandbox's graph, which is a data
--  loss bug and not merely a display one.

ALTER TABLE platform.lineage_node
    ADD COLUMN IF NOT EXISTS space_id BIGINT
        REFERENCES platform.space(space_id) ON DELETE CASCADE;
ALTER TABLE platform.lineage_edge
    ADD COLUMN IF NOT EXISTS space_id BIGINT
        REFERENCES platform.space(space_id) ON DELETE CASCADE;
ALTER TABLE platform.lineage_column
    ADD COLUMN IF NOT EXISTS space_id BIGINT
        REFERENCES platform.space(space_id) ON DELETE CASCADE;

UPDATE platform.lineage_node
   SET space_id = (SELECT space_id FROM platform.space WHERE slug = 'sandbox')
 WHERE space_id IS NULL;
UPDATE platform.lineage_edge
   SET space_id = (SELECT space_id FROM platform.space WHERE slug = 'sandbox')
 WHERE space_id IS NULL;
UPDATE platform.lineage_column
   SET space_id = (SELECT space_id FROM platform.space WHERE slug = 'sandbox')
 WHERE space_id IS NULL;

ALTER TABLE platform.lineage_node   ALTER COLUMN space_id SET NOT NULL;
ALTER TABLE platform.lineage_edge   ALTER COLUMN space_id SET NOT NULL;
ALTER TABLE platform.lineage_column ALTER COLUMN space_id SET NOT NULL;

-- Rekey node first: the edge foreign keys point at it, so they have to be
-- dropped and re-pointed at the composite key in the same step.
ALTER TABLE platform.lineage_edge DROP CONSTRAINT IF EXISTS lineage_edge_source_node_rid_fkey;
ALTER TABLE platform.lineage_edge DROP CONSTRAINT IF EXISTS lineage_edge_target_node_rid_fkey;

ALTER TABLE platform.lineage_node DROP CONSTRAINT IF EXISTS lineage_node_pkey CASCADE;
ALTER TABLE platform.lineage_node
    ADD CONSTRAINT lineage_node_pkey PRIMARY KEY (space_id, lineage_node_rid);

ALTER TABLE platform.lineage_edge DROP CONSTRAINT IF EXISTS lineage_edge_pkey CASCADE;
ALTER TABLE platform.lineage_edge
    ADD CONSTRAINT lineage_edge_pkey PRIMARY KEY (space_id, lineage_edge_rid);

-- An edge may only join nodes IN ITS OWN SPACE. Carrying space_id into the
-- foreign key is what makes that structural instead of a convention.
ALTER TABLE platform.lineage_edge
    ADD CONSTRAINT lineage_edge_source_fkey
        FOREIGN KEY (space_id, source_node_rid)
        REFERENCES platform.lineage_node (space_id, lineage_node_rid) ON DELETE CASCADE;
ALTER TABLE platform.lineage_edge
    ADD CONSTRAINT lineage_edge_target_fkey
        FOREIGN KEY (space_id, target_node_rid)
        REFERENCES platform.lineage_node (space_id, lineage_node_rid) ON DELETE CASCADE;

ALTER TABLE platform.lineage_column
    DROP CONSTRAINT IF EXISTS lineage_column_target_view_target_column_source_table_sourc_key;
CREATE UNIQUE INDEX IF NOT EXISTS ux_lineage_column_per_space
    ON platform.lineage_column (space_id, target_view, target_column, source_table, source_column);

CREATE INDEX IF NOT EXISTS ix_lineage_node_space ON platform.lineage_node (space_id, layer);
CREATE INDEX IF NOT EXISTS ix_lineage_edge_space ON platform.lineage_edge (space_id);
