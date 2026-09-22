-- ============================================================================
--  0008: pipelines belong to a space.
--
--  The pipeline table carried a free-text `environment` column that predated
--  spaces, so a pipeline said "development" while the workspace it lived in
--  said "sandbox" and nothing reconciled the two. The space is now the single
--  answer to "which environment is this", and environment is derived from it.
--
--  Existing pipelines move to the sandbox, which is where work that has not
--  been deliberately promoted belongs - not to whatever the old free-text
--  column happened to say.
-- ============================================================================

-- The pipeline's environment CHECK predates spaces and allowed only
-- development/staging/production. Spaces added 'sandbox', so moving pipelines
-- there violated it. The two lists have to agree, and the space table is the
-- one that defines them.
ALTER TABLE platform.pipeline DROP CONSTRAINT IF EXISTS pipeline_environment_check;
ALTER TABLE platform.pipeline
    ADD CONSTRAINT pipeline_environment_check
    CHECK (environment IN ('sandbox','development','staging','production'));

ALTER TABLE platform.pipeline
    ADD COLUMN IF NOT EXISTS space_id BIGINT
        REFERENCES platform.space(space_id) ON DELETE RESTRICT;

UPDATE platform.pipeline
   SET space_id = (SELECT space_id FROM platform.space WHERE slug = 'sandbox')
 WHERE space_id IS NULL;

-- environment is kept in step with the space rather than set independently.
UPDATE platform.pipeline p
   SET environment = s.environment
  FROM platform.space s
 WHERE s.space_id = p.space_id
   AND p.environment IS DISTINCT FROM s.environment;

ALTER TABLE platform.pipeline ALTER COLUMN space_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS ix_pipeline_space ON platform.pipeline (space_id, updated_at DESC);

-- A pipeline name is unique within its space, not globally: the same pipeline
-- promoted from sandbox to production is the same name in two places.
ALTER TABLE platform.pipeline DROP CONSTRAINT IF EXISTS pipeline_slug_key;
CREATE UNIQUE INDEX IF NOT EXISTS ux_pipeline_space_slug
    ON platform.pipeline (space_id, slug);
