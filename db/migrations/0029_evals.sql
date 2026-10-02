-- 0029: eval suites.
--
-- AIP Evals, in the shape this platform can honour: a suite of named cases,
-- each with a machine-checkable expectation, run against a target and scored.
-- Two target kinds share the tables because a suite is a suite whatever it
-- tests - what differs is the case spec and the runner:
--
--   function  - a metric definition in the catalogue; cases assert properties
--               of what the SQL returns (equals within tolerance, bounds,
--               row counts, columns not null). Run by the ontology service.
--   assistant - a prompt; cases assert properties of the turn the agent
--               produces (tools used or refused, caveats present, reply
--               shape, rounds and cost bounds). Run by the AI-FDE service,
--               which owns the agent. No LLM judge: every evaluator is
--               deterministic, so a score means the same thing twice.
--
-- Scheduling work (0028) and grading work land in the same database because
-- both are platform records a person will audit, not per-service state.

CREATE TABLE IF NOT EXISTS platform.eval_suite (
    eval_suite_id bigserial PRIMARY KEY,
    space_id      integer     NOT NULL REFERENCES platform.space (space_id) ON DELETE CASCADE,
    name          text        NOT NULL,
    target_kind   text        NOT NULL CHECK (target_kind IN ('function', 'assistant')),
    -- For a function suite: the function's api name. For an assistant suite:
    -- 'assistant', which keeps the column non-null without pretending a chat
    -- agent has a stable api name.
    target_ref    text        NOT NULL,
    description   text,
    created_by    text        NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (space_id, name)
);

CREATE TABLE IF NOT EXISTS platform.eval_case (
    eval_case_id bigserial PRIMARY KEY,
    suite_id     bigint      NOT NULL REFERENCES platform.eval_suite (eval_suite_id) ON DELETE CASCADE,
    name         text        NOT NULL,
    -- function:  {"assertions": [{"kind": "equals", "value": 90, "tolerance": 0.01}, ...]}
    -- assistant: {"prompt": "...", "evaluators": [{"kind": "tool_used", "name": "get_data_coverage"}, ...]}
    spec         jsonb       NOT NULL,
    ordinal      integer     NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS eval_case_suite_idx ON platform.eval_case (suite_id, ordinal);

-- One execution of a suite. Per-case outcomes live in detail; the counters
-- exist so a list of runs can be read without opening every blob.
CREATE TABLE IF NOT EXISTS platform.eval_run (
    eval_run_id       bigserial PRIMARY KEY,
    suite_id          bigint      NOT NULL REFERENCES platform.eval_suite (eval_suite_id) ON DELETE CASCADE,
    started_by        text        NOT NULL,
    status            text        NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
    passed            integer     NOT NULL DEFAULT 0,
    failed            integer     NOT NULL DEFAULT 0,
    total             integer     NOT NULL DEFAULT 0,
    detail            jsonb       NOT NULL DEFAULT '[]'::jsonb,
    -- Assistant suite runs pay for a model per case; the cost is recorded on
    -- the run, not laundered through the chat budget.
    prompt_tokens     integer,
    completion_tokens integer,
    total_tokens      integer,
    cost_usd          double precision,
    started_at        timestamptz NOT NULL DEFAULT now(),
    finished_at       timestamptz
);

CREATE INDEX IF NOT EXISTS eval_run_suite_idx ON platform.eval_run (suite_id, started_at DESC);
