-- ============================================================================
--  0010: dashboards and conversations belong to a space.
--
--  Pipelines were space-scoped in 0008, but dashboards and chat sessions were
--  not — so switching to Staging still showed the Sandbox dashboards, and the
--  space switcher looked broken because for those pages it did nothing.
--
--  WHAT IS AND IS NOT SCOPED, deliberately:
--
--    scoped    pipeline, project (and resource, through its project),
--              dashboard, chat_session
--              — these are things PEOPLE make, and two environments should be
--                able to hold different ones.
--
--    global    object_type, link_type, action_type, kpi_definition
--              — the ontology. There is one published ontology per database,
--                generated wholesale by the pipeline. Making it per-space
--                would mean a pipeline run per space writing separate
--                ontologies, which is a far larger change than this migration,
--                and pretending otherwise by adding a column nothing enforced
--                would be worse than leaving it honest.
--
--  Existing rows go to the sandbox, which is where work that has not been
--  deliberately promoted belongs.
-- ============================================================================

ALTER TABLE platform.dashboard
    ADD COLUMN IF NOT EXISTS space_id BIGINT
        REFERENCES platform.space(space_id) ON DELETE RESTRICT;

UPDATE platform.dashboard
   SET space_id = (SELECT space_id FROM platform.space WHERE slug = 'sandbox')
 WHERE space_id IS NULL;

ALTER TABLE platform.dashboard ALTER COLUMN space_id SET NOT NULL;

-- A dashboard slug is unique within its space, not globally: the same board
-- promoted from sandbox to production is the same name in two places.
ALTER TABLE platform.dashboard DROP CONSTRAINT IF EXISTS dashboard_slug_key;
CREATE UNIQUE INDEX IF NOT EXISTS ux_dashboard_space_slug
    ON platform.dashboard (space_id, slug);

-- The seed key is likewise per space, so each space can hold its own copy of
-- the starter set without them colliding.
DROP INDEX IF EXISTS platform.ux_dashboard_seed_key;
CREATE UNIQUE INDEX IF NOT EXISTS ux_dashboard_space_seed_key
    ON platform.dashboard (space_id, seed_key);

CREATE INDEX IF NOT EXISTS ix_dashboard_space
    ON platform.dashboard (space_id, updated_at DESC);

ALTER TABLE platform.chat_session
    ADD COLUMN IF NOT EXISTS space_id BIGINT
        REFERENCES platform.space(space_id) ON DELETE RESTRICT;

UPDATE platform.chat_session
   SET space_id = (SELECT space_id FROM platform.space WHERE slug = 'sandbox')
 WHERE space_id IS NULL;

ALTER TABLE platform.chat_session ALTER COLUMN space_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS ix_chat_session_space
    ON platform.chat_session (space_id, updated_at DESC);
