-- ============================================================================
--  0017: user edits to the ontology, and why they are a journal.
--
--  The ontology is GENERATED. A pipeline run introspects the views, writes a
--  new ontology_version and shreds it into object_type / link_type /
--  action_type. Every run makes a new version; nothing carries forward.
--
--  So an Ontology Builder that wrote straight into those tables would work
--  beautifully until the next pipeline run, at which point every label someone
--  fixed, every link they drew by hand and every action they defined would
--  silently vanish. That is worse than not offering the feature: the work is
--  gone and nothing says so.
--
--  An edit is therefore recorded as an INTENTION, keyed by the RID, which is
--  stable across versions. The edit applies to the live version immediately,
--  so the UI responds at once, and the pipeline replays the journal onto each
--  new version it publishes. A hand-drawn link survives regeneration because
--  it is re-applied, not because it was lucky.
--
--  Withdrawing an edit sets is_active = false rather than deleting the row:
--  "who changed this label, when, and from what" is a question an ontology
--  needs to be able to answer.
-- ============================================================================

CREATE TABLE IF NOT EXISTS platform.ontology_edit (
    ontology_edit_id BIGSERIAL PRIMARY KEY,
    space_id      BIGINT NOT NULL
        REFERENCES platform.space(space_id) ON DELETE CASCADE,

    target_kind   TEXT NOT NULL
                  CHECK (target_kind IN ('objectType','property','linkType','actionType')),
    -- The RID, not the row id: a row id belongs to one version, the RID names
    -- the same thing in every version, which is what makes replay possible.
    target_rid    TEXT NOT NULL,
    operation     TEXT NOT NULL CHECK (operation IN ('create','update','delete')),

    -- The fields being set. Only the keys present are applied, so two edits to
    -- different fields of one object type do not overwrite each other.
    payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- What the fields held before, so an edit can be explained and undone.
    previous      JSONB NOT NULL DEFAULT '{}'::jsonb,

    is_active     BOOLEAN NOT NULL DEFAULT true,
    note          TEXT,
    created_by    TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    withdrawn_by  TEXT,
    withdrawn_at  TIMESTAMPTZ
);

-- Replay order is creation order: a later edit to the same field wins, which
-- is the only ordering that matches what the user saw happen.
CREATE INDEX IF NOT EXISTS ix_ontology_edit_replay
    ON platform.ontology_edit (space_id, created_at)
 WHERE is_active;

CREATE INDEX IF NOT EXISTS ix_ontology_edit_target
    ON platform.ontology_edit (space_id, target_kind, target_rid, created_at DESC);

-- ── hand-authored ontology objects ──────────────────────────────────────────
--  A link or action a person drew is not discovered by introspection, so the
--  pipeline would never regenerate it. These columns mark the rows that exist
--  only because someone created them, so replay knows to re-insert rather than
--  re-update, and the UI can show which parts of the ontology are hand-made.

ALTER TABLE platform.link_type
    ADD COLUMN IF NOT EXISTS is_user_defined BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE platform.action_type
    ADD COLUMN IF NOT EXISTS is_user_defined BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE platform.object_type
    ADD COLUMN IF NOT EXISTS is_user_defined BOOLEAN NOT NULL DEFAULT false;

-- The pipeline's own check constraint does not allow 'manual' to be set from
-- anywhere but its discovery stages; a hand-drawn link uses it legitimately.
COMMENT ON COLUMN platform.link_type.is_user_defined IS
    'True where a person drew this link rather than the pipeline discovering it. '
    'Replayed from platform.ontology_edit after each publish.';
