-- ============================================================================
--  0006: the pipeline builder.
--
--  A pipeline is a graph the user draws: nodes (sources, transforms, object
--  types, actions, links, outputs) and the edges between them. The graph is
--  stored whole as JSONB rather than shredded into node/edge tables, because
--  it is always read and written as one document by one editor, and the
--  shredded form would buy joins nothing here uses.
--
--  Versions are kept so a pipeline can be rolled back, and because "who
--  changed this and when" is the first question asked of anything that
--  produces numbers people act on.
-- ============================================================================

CREATE TABLE IF NOT EXISTS platform.pipeline (
    pipeline_id   BIGSERIAL PRIMARY KEY,
    slug          TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    description   TEXT,
    -- Which deployment this describes. A pipeline is drawn once and promoted,
    -- so the environment travels with the version rather than the definition.
    environment   TEXT NOT NULL DEFAULT 'development'
                  CHECK (environment IN ('development', 'staging', 'production')),
    graph         JSONB NOT NULL DEFAULT '{"nodes":[],"edges":[]}'::jsonb,
    -- Cached from the last validation so the list can show status without
    -- re-validating every pipeline on every page load.
    validation    JSONB NOT NULL DEFAULT '{"status":"unknown","errors":[],"warnings":[]}'::jsonb,
    version       INTEGER NOT NULL DEFAULT 1,
    created_by    TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by    TEXT,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_pipeline_updated ON platform.pipeline (updated_at DESC);

-- Every save keeps the graph it replaced, so a bad edit is recoverable.
CREATE TABLE IF NOT EXISTS platform.pipeline_version (
    pipeline_version_id BIGSERIAL PRIMARY KEY,
    pipeline_id         BIGINT NOT NULL
                        REFERENCES platform.pipeline(pipeline_id) ON DELETE CASCADE,
    version             INTEGER NOT NULL,
    graph               JSONB NOT NULL,
    note                TEXT,
    saved_by            TEXT NOT NULL,
    saved_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (pipeline_id, version)
);

CREATE INDEX IF NOT EXISTS ix_pipeline_version_pipeline
    ON platform.pipeline_version (pipeline_id, version DESC);

CREATE TABLE IF NOT EXISTS platform.pipeline_run (
    pipeline_run_id BIGSERIAL PRIMARY KEY,
    pipeline_id     BIGINT NOT NULL
                    REFERENCES platform.pipeline(pipeline_id) ON DELETE CASCADE,
    version         INTEGER NOT NULL,
    status          TEXT NOT NULL
                    CHECK (status IN ('running', 'success', 'failed', 'cancelled')),
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    duration_ms     INTEGER,
    records         BIGINT NOT NULL DEFAULT 0,
    errors          INTEGER NOT NULL DEFAULT 0,
    warnings        INTEGER NOT NULL DEFAULT 0,
    -- Per-node outcome, so the canvas can colour each card after a run.
    node_results    JSONB NOT NULL DEFAULT '[]'::jsonb,
    log             JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- These runs execute the graph's SHAPE, not its data: the platform reads a
    -- captured snapshot and has no execution engine behind it. The flag keeps
    -- that fact attached to the row rather than living only in documentation.
    is_simulated    BOOLEAN NOT NULL DEFAULT true,
    triggered_by    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_pipeline_run_pipeline
    ON platform.pipeline_run (pipeline_id, started_at DESC);
