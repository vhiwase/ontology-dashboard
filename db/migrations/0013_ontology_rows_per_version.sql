-- ============================================================================
--  0013: the ontology's rows are keyed by VERSION, not by RID alone.
--
--  0012 gave each space its own ontology_version, and then two spaces could
--  not actually hold one at the same time. object_type, link_type and
--  action_type are keyed on their RID alone — 'tms:Order' is the primary key —
--  and the pipeline upserts on that key. So publishing into staging did not
--  insert staging's object types: it UPDATED the sandbox's rows and moved them
--  onto staging's version. The sandbox was left with an active version that
--  owned nothing, and its Object Types page went empty.
--
--  This also quietly broke the promise made where ontology_version is defined:
--  "a new version supersedes the old one rather than overwriting it, so an
--  ontology change is reviewable and revertible". Nothing was revertible. The
--  superseded version kept its row and lost every object type to the new one,
--  so there was never more than one version's worth of rows in the database.
--
--  Keying on (ontology_version_id, rid) fixes both at once: spaces stop
--  colliding, and a version keeps the shape it was published with.
--
--  object_property hangs off object_type, so it takes the version through its
--  foreign key and its own key widens to match.
-- ============================================================================

-- ── object_type, and object_property which references it ────────────────────

ALTER TABLE platform.object_property
    ADD COLUMN IF NOT EXISTS ontology_version_id BIGINT;

UPDATE platform.object_property p
   SET ontology_version_id = t.ontology_version_id
  FROM platform.object_type t
 WHERE t.object_type_rid = p.object_type_rid
   AND p.ontology_version_id IS NULL;

-- A property whose object type has already gone cannot be attributed to a
-- version, and describes a type nothing can reach. Removing it is the only
-- honest option; NOT NULL below would otherwise fail on it.
DELETE FROM platform.object_property WHERE ontology_version_id IS NULL;

ALTER TABLE platform.object_property ALTER COLUMN ontology_version_id SET NOT NULL;
ALTER TABLE platform.object_property
    ADD CONSTRAINT object_property_version_fkey
        FOREIGN KEY (ontology_version_id)
        REFERENCES platform.ontology_version (ontology_version_id) ON DELETE CASCADE;

-- Drop the old FK before rekeying the table it points at.
ALTER TABLE platform.object_property
    DROP CONSTRAINT IF EXISTS object_property_object_type_rid_fkey;

ALTER TABLE platform.object_type DROP CONSTRAINT IF EXISTS object_type_pkey CASCADE;
ALTER TABLE platform.object_type
    ADD CONSTRAINT object_type_pkey PRIMARY KEY (ontology_version_id, object_type_rid);

ALTER TABLE platform.object_property
    ADD CONSTRAINT object_property_object_type_fkey
        FOREIGN KEY (ontology_version_id, object_type_rid)
        REFERENCES platform.object_type (ontology_version_id, object_type_rid)
        ON DELETE CASCADE;

ALTER TABLE platform.object_property DROP CONSTRAINT IF EXISTS object_property_pkey CASCADE;
ALTER TABLE platform.object_property
    ADD CONSTRAINT object_property_pkey
        PRIMARY KEY (ontology_version_id, object_property_rid);

ALTER TABLE platform.object_property
    DROP CONSTRAINT IF EXISTS object_property_object_type_rid_api_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS ux_object_property_api_name
    ON platform.object_property (ontology_version_id, object_type_rid, api_name);

-- ── link_type and action_type ───────────────────────────────────────────────

ALTER TABLE platform.link_type DROP CONSTRAINT IF EXISTS link_type_pkey CASCADE;
ALTER TABLE platform.link_type
    ADD CONSTRAINT link_type_pkey PRIMARY KEY (ontology_version_id, link_type_rid);

ALTER TABLE platform.action_type DROP CONSTRAINT IF EXISTS action_type_pkey CASCADE;
ALTER TABLE platform.action_type
    ADD CONSTRAINT action_type_pkey PRIMARY KEY (ontology_version_id, action_type_rid);
