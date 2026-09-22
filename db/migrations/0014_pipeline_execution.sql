-- ============================================================================
--  0014: pipelines actually execute.
--
--  Until now a "run" walked the graph in dependency order and ESTIMATED how
--  many rows each node would emit — a filter was assumed to keep 60%, an
--  aggregate to collapse 50:1. The code said so plainly and marked every run
--  is_simulated, which was honest, but it meant the Pipeline Builder could not
--  answer the only question that matters: what does this pipeline produce?
--
--  Now each node compiles to SQL and is materialised as a real table. This
--  migration adds what execution needs and the estimator never did:
--
--    * a schema to materialise node outputs into
--    * per-node run rows, so a failure names the node that failed
--    * dataset versions, so a rerun that changes the row count is visible
--    * the columns a run needs to distinguish executed from estimated
-- ============================================================================

-- Node outputs live apart from the warehouse schemas (tms_raw, tms_sim,
-- tms_views): they are derived, disposable, and rebuilt on every run, and
-- mixing them in with curated views would blur that.
CREATE SCHEMA IF NOT EXISTS pipeline_out;

COMMENT ON SCHEMA pipeline_out IS
    'Materialised pipeline node outputs. Every table here is rebuilt by a '
    'pipeline run and may be dropped at any time.';

-- ── per-node execution records ──────────────────────────────────────────────
--  node_results was already stored as JSONB on the run, which is fine for
--  display but cannot be queried: "which node fails most often" needs rows.
CREATE TABLE IF NOT EXISTS platform.pipeline_node_run (
    pipeline_node_run_id BIGSERIAL PRIMARY KEY,
    pipeline_run_id   BIGINT NOT NULL
        REFERENCES platform.pipeline_run(pipeline_run_id) ON DELETE CASCADE,
    node_id           TEXT NOT NULL,
    node_name         TEXT NOT NULL,
    node_kind         TEXT NOT NULL,
    status            TEXT NOT NULL
                      CHECK (status IN ('queued','running','success','failed','skipped','cancelled')),
    started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at       TIMESTAMPTZ,
    duration_ms       INTEGER,
    rows_in           BIGINT,
    rows_out          BIGINT,
    -- Where the node's result was materialised, so the UI can preview it.
    output_table      TEXT,
    -- The SQL that ran. Kept because a pipeline that produces a surprising
    -- number is only debuggable if you can see the query it ran.
    sql_text          TEXT,
    error_message     TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_pipeline_node_run_run
    ON platform.pipeline_node_run (pipeline_run_id);
CREATE INDEX IF NOT EXISTS ix_pipeline_node_run_failed
    ON platform.pipeline_node_run (node_kind, status) WHERE status = 'failed';

-- ── the run itself ──────────────────────────────────────────────────────────

ALTER TABLE platform.pipeline_run
    ADD COLUMN IF NOT EXISTS rows_read BIGINT,
    ADD COLUMN IF NOT EXISTS rows_written BIGINT,
    -- 'estimated' preserves the old behaviour for a graph that cannot be
    -- compiled; 'executed' means SQL ran. A run must say which it was.
    ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'estimated'
        CHECK (execution_mode IN ('estimated','executed')),
    ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

-- The old CHECK allowed only the states the estimator produced.
ALTER TABLE platform.pipeline_run DROP CONSTRAINT IF EXISTS pipeline_run_status_check;
ALTER TABLE platform.pipeline_run
    ADD CONSTRAINT pipeline_run_status_check
        CHECK (status IN ('queued','running','success','failed','cancelled'));

-- ── dataset versions ────────────────────────────────────────────────────────
--  A materialised output changes shape between runs. Recording each build is
--  what makes "this dataset had 183,921 rows yesterday and 12 today" a
--  question the platform can answer instead of a surprise.
CREATE TABLE IF NOT EXISTS platform.dataset_version (
    dataset_version_id BIGSERIAL PRIMARY KEY,
    space_id          BIGINT NOT NULL
        REFERENCES platform.space(space_id) ON DELETE CASCADE,
    -- schema.table in pipeline_out, or a warehouse view for a source dataset.
    qualified_name    TEXT NOT NULL,
    version           INTEGER NOT NULL,
    row_count         BIGINT NOT NULL,
    column_count      INTEGER NOT NULL,
    -- The column list as built, so a schema change between versions is visible.
    columns           JSONB NOT NULL DEFAULT '[]'::jsonb,
    built_by_run      BIGINT REFERENCES platform.pipeline_run(pipeline_run_id) ON DELETE SET NULL,
    built_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    built_by          TEXT NOT NULL DEFAULT 'pipeline',
    UNIQUE (space_id, qualified_name, version)
);

CREATE INDEX IF NOT EXISTS ix_dataset_version_latest
    ON platform.dataset_version (space_id, qualified_name, version DESC);
