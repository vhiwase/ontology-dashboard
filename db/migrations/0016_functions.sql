-- ============================================================================
--  0016: functions — named, reviewable computations over the ontology.
--
--  The gap this fills: the assistant can only use metrics that already exist.
--  Asked for "distance travelled by month" it correctly refuses to invent a
--  KPI, and the conversation dead-ends — the user is told no such metric
--  exists and has no way to create one.
--
--  A function is the missing piece: a definition someone can read, approve and
--  then use like any other metric. The assistant DRAFTS one; it never creates
--  one. Creation is a human act, which is why status starts at 'proposed' and
--  only a person moves it to 'active'.
--
--  ── on languages ───────────────────────────────────────────────────────────
--  SQL functions execute: they compile through the same validated-identifier
--  path as pipeline nodes and run read-only. Python and TypeScript are stored
--  as definitions and reported as not executable in this deployment, because
--  running them needs a sandboxed runtime that does not exist here. Recording
--  them is useful; pretending to run them would not be.
-- ============================================================================

CREATE TABLE IF NOT EXISTS platform.function (
    function_id     BIGSERIAL PRIMARY KEY,
    space_id        BIGINT NOT NULL
        REFERENCES platform.space(space_id) ON DELETE CASCADE,

    -- Identity. Both are fixed once created: everything that references a
    -- function does so by one of them, so letting either be edited would
    -- silently break dashboards and saved queries that already point at it.
    function_rid    TEXT NOT NULL,              -- fn:avg_distance_per_month
    api_name        TEXT NOT NULL,              -- avgDistancePerMonth

    name            TEXT NOT NULL,
    description     TEXT,
    business_question TEXT,

    language        TEXT NOT NULL DEFAULT 'sql'
                    CHECK (language IN ('sql','python','typescript')),
    -- The body. For SQL, a single SELECT compiled and run read-only.
    definition      TEXT NOT NULL,

    -- 'scalar' feeds a KPI tile; 'table' feeds a chart or an object table.
    returns         TEXT NOT NULL DEFAULT 'scalar'
                    CHECK (returns IN ('scalar','table')),
    return_type     TEXT,                       -- numeric, percent, currency, …
    unit            TEXT,
    value_format    TEXT NOT NULL DEFAULT 'number',

    -- Declared inputs, so a caller knows what to pass before running it.
    parameters      JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Which views and object types it reads, for lineage and impact analysis.
    reads_views     TEXT[] NOT NULL DEFAULT '{}',
    reads_object_types TEXT[] NOT NULL DEFAULT '{}',

    -- proposed  — drafted, usually by the assistant, awaiting a human
    -- active    — approved and usable
    -- rejected  — declined, kept so the same suggestion is not re-proposed
    -- archived  — retired but still referenced by old dashboards
    status          TEXT NOT NULL DEFAULT 'proposed'
                    CHECK (status IN ('proposed','active','rejected','archived')),

    -- Who suggested it versus who approved it. Kept apart on purpose: "the
    -- assistant wrote this and Vaibhav approved it" is the sentence an audit
    -- needs to be able to reconstruct.
    proposed_by     TEXT NOT NULL DEFAULT 'user',
    proposed_from   TEXT,                       -- the prompt that produced it
    approved_by     TEXT,
    approved_at     TIMESTAMPTZ,

    version         INTEGER NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by      TEXT NOT NULL DEFAULT 'user',
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      TEXT
);

-- Per space, like everything else published (0012). Two spaces may each hold
-- their own version of the same metric.
CREATE UNIQUE INDEX IF NOT EXISTS ux_function_space_api_name
    ON platform.function (space_id, api_name);
CREATE UNIQUE INDEX IF NOT EXISTS ux_function_space_rid
    ON platform.function (space_id, function_rid);
CREATE INDEX IF NOT EXISTS ix_function_status
    ON platform.function (space_id, status, updated_at DESC);

-- ── execution history ───────────────────────────────────────────────────────
--  §11 asks for execution history and logs. A function that produces a number
--  on a dashboard needs to be auditable: which definition ran, when, for whom,
--  what it returned and how long it took.
CREATE TABLE IF NOT EXISTS platform.function_run (
    function_run_id BIGSERIAL PRIMARY KEY,
    function_id     BIGINT NOT NULL
        REFERENCES platform.function(function_id) ON DELETE CASCADE,
    -- The version that ran, not just the function: a number on last week's
    -- dashboard was produced by the definition as it stood then.
    version         INTEGER NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('success','failed')),
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    duration_ms     INTEGER,
    row_count       BIGINT,
    -- The scalar result, or the first rows of a table result. Capped by the
    -- caller so a wide result does not fill the audit table.
    result          JSONB,
    parameters      JSONB NOT NULL DEFAULT '{}'::jsonb,
    sql_text        TEXT,
    error_message   TEXT,
    triggered_by    TEXT NOT NULL DEFAULT 'user'
);

CREATE INDEX IF NOT EXISTS ix_function_run_function
    ON platform.function_run (function_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ix_function_run_failed
    ON platform.function_run (function_id, started_at DESC) WHERE status = 'failed';
