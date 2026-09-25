-- ============================================================================
--  0024: a connection can bring data in.
--
--  Until now a connection was a business card. You could register a PostgreSQL
--  source, press "Test connection" and be told it answered - and that was the
--  whole of it. Nothing could come through it. Every dataset on this platform
--  was backed by a view the pipeline had already built from the captured
--  snapshot, so the Connections folder described a capability the platform did
--  not have.
--
--  This adds the missing half, in the shape Foundry gives it: a SOURCE holds
--  the host and the credential reference; a SYNC is a named, re-runnable pull
--  from one table on that source into one dataset here; a SYNC RUN is what
--  happened the last time it ran.
--
--      connection resource  --->  connection_sync  --->  connection_raw.<table>
--                                       |                        |
--                                       v                        v
--                                connection_sync_run       dataset resource
--
--  -- on landing somewhere of its own -----------------------------------------
--  Synced tables land in `connection_raw`, not in `tms_raw`. tms_raw is the
--  captured TMS snapshot and its provenance is recorded per endpoint; a table
--  pulled from a database someone pointed at this week is a different claim
--  about where data came from, and mixing the two would make the lineage graph
--  lie. `connection_raw` is to a connection what `pipeline_out` is to a
--  pipeline: derived, rebuilt on demand, never confused with the source.
--
--  -- on what is NOT stored here ----------------------------------------------
--  No credential. The connection resource stores the NAME of an environment
--  variable or a Docker secret file, and that convention is unchanged: a sync
--  resolves the credential at run time through the same path a test does.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS connection_raw;

COMMENT ON SCHEMA connection_raw IS
    'Tables landed by a connection sync. Every table here is written by '
    'platform.connection_sync and is rebuilt or appended to on each run. '
    'Distinct from tms_raw, which is the captured TMS snapshot.';

-- -- the sync ----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform.connection_sync (
    sync_id         BIGSERIAL PRIMARY KEY,

    -- The connection this pulls through. A resource rather than a table of its
    -- own, because connections are already resources and live in a project
    -- folder like everything else people can open.
    resource_id     BIGINT NOT NULL
        REFERENCES platform.resource(resource_id) ON DELETE CASCADE,

    name            TEXT NOT NULL,
    description     TEXT,

    -- What to read, on the far side. Both are validated as plain SQL
    -- identifiers before they are ever quoted into a statement; neither is
    -- accepted as free text.
    source_schema   TEXT NOT NULL,
    source_table    TEXT NOT NULL,

    --  snapshot     - the target is dropped and rebuilt, so it is exactly what
    --                 the source holds now. The honest default: it cannot
    --                 accumulate rows that have since been deleted upstream.
    --  incremental  - rows with a cursor value greater than the last one seen
    --                 are appended. Cheaper, and wrong if the source mutates
    --                 rows in place without moving the cursor, which is why
    --                 the mode is recorded on every run.
    mode            TEXT NOT NULL DEFAULT 'snapshot'
                    CHECK (mode IN ('snapshot','incremental')),
    cursor_column   TEXT,
    -- Held as text and handed back to PostgreSQL as an untyped parameter, so
    -- the server resolves it against the real column type rather than this
    -- platform guessing at it.
    last_cursor_value TEXT,

    -- Where it lands, in connection_raw. Derived from the connection and the
    -- source table by the service, never supplied by the caller: it becomes a
    -- table name, and a table name is the one thing here that cannot be a
    -- bound parameter.
    target_table    TEXT NOT NULL,

    -- The reader is bounded. A sync holds its result in memory before writing
    -- it, so an unbounded pull from a table nobody checked the size of would
    -- take the service down. A run that hits the limit says so rather than
    -- reporting a partial table as complete.
    row_limit       INTEGER NOT NULL DEFAULT 50000
                    CHECK (row_limit > 0 AND row_limit <= 1000000),

    -- The dataset this sync produces, so the workspace shows one artefact
    -- rather than a table nobody can find. SET NULL rather than CASCADE:
    -- deleting the dataset should not delete the sync that rebuilds it.
    dataset_resource_id BIGINT
        REFERENCES platform.resource(resource_id) ON DELETE SET NULL,

    enabled         BOOLEAN NOT NULL DEFAULT true,
    created_by      TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- An incremental sync without a cursor column would silently re-read the
    -- whole table on every run and append it, doubling the dataset. Refused
    -- here as well as in the service: the service can be bypassed, this cannot.
    CONSTRAINT connection_sync_cursor_required
        CHECK (mode <> 'incremental' OR cursor_column IS NOT NULL),

    UNIQUE (resource_id, name)
);

-- One sync owns one landing table. Two syncs writing the same table would each
-- report a row count the other had just invalidated.
CREATE UNIQUE INDEX IF NOT EXISTS ux_connection_sync_target
    ON platform.connection_sync (target_table);
CREATE INDEX IF NOT EXISTS ix_connection_sync_resource
    ON platform.connection_sync (resource_id);

-- -- run history --------------------------------------------------------------
--  What a dataset's freshness question is actually answered from: when it last
--  ran, how many rows crossed, how long it took and what failed.

CREATE TABLE IF NOT EXISTS platform.connection_sync_run (
    sync_run_id     BIGSERIAL PRIMARY KEY,
    sync_id         BIGINT NOT NULL
        REFERENCES platform.connection_sync(sync_id) ON DELETE CASCADE,

    status          TEXT NOT NULL
                    CHECK (status IN ('running','success','failed')),
    -- The mode as it was WHEN IT RAN. A sync switched from snapshot to
    -- incremental afterwards must not rewrite the history of how the rows
    -- already in the table got there.
    mode            TEXT NOT NULL CHECK (mode IN ('snapshot','incremental')),

    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    duration_ms     INTEGER,

    rows_read       BIGINT,
    rows_written    BIGINT,
    -- Kept apart from rows_written: a snapshot that replaced 90 rows with 4 is
    -- a fact worth being able to see after the event.
    rows_before     BIGINT,
    rows_after      BIGINT,

    cursor_from     TEXT,
    cursor_to       TEXT,

    -- True when the read stopped because row_limit was reached, so the table
    -- is a prefix of the source rather than a copy of it.
    truncated       BOOLEAN NOT NULL DEFAULT false,

    error_message   TEXT,
    triggered_by    TEXT NOT NULL DEFAULT 'user'
);

CREATE INDEX IF NOT EXISTS ix_connection_sync_run_sync
    ON platform.connection_sync_run (sync_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ix_connection_sync_run_failed
    ON platform.connection_sync_run (sync_id, started_at DESC) WHERE status = 'failed';
