-- ============================================================================
--  0022: a pipeline the assistant drafted is a PROPOSAL until a person accepts.
--
--  Same reasoning as the function proposals in 0016. The assistant can now
--  build a pipeline graph from a sentence, and a graph that runs writes real
--  tables into pipeline_out that dashboards and the assistant then read. So
--  the draft arrives inert: it is saved so it can be looked at, and it cannot
--  be run until somebody has looked.
--
--  accepted_by is recorded separately from proposed_by, so the audit can say
--  "the assistant drafted this and a named person accepted it" - which is the
--  whole point of keeping the two apart.
-- ============================================================================

ALTER TABLE platform.pipeline
    ADD COLUMN IF NOT EXISTS proposed_by   TEXT,
    -- The user's own words that produced it, so a strange graph can be traced
    -- back to the request rather than guessed at.
    ADD COLUMN IF NOT EXISTS proposed_from TEXT,
    ADD COLUMN IF NOT EXISTS accepted_by   TEXT,
    ADD COLUMN IF NOT EXISTS accepted_at   TIMESTAMPTZ;

-- Everything that already exists was created by a person, so it is accepted.
-- Without this the seeded pipeline would read as an unreviewed draft.
UPDATE platform.pipeline
   SET accepted_by = COALESCE(created_by, 'platform'),
       accepted_at = COALESCE(created_at, now())
 WHERE accepted_by IS NULL;

CREATE INDEX IF NOT EXISTS ix_pipeline_pending
    ON platform.pipeline (space_id, updated_at DESC)
 WHERE accepted_by IS NULL;

COMMENT ON COLUMN platform.pipeline.accepted_by IS
    'NULL while the pipeline is an unreviewed proposal. A proposal cannot be run.';
