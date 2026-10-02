-- 0028: schedules.
--
-- Foundry's platform concept this platform was missing: a named, recurring
-- trigger for work that otherwise only ran when someone pressed a button.
-- A schedule names one target - a connection sync or a pipeline - and a
-- cadence, and the ontology service's scheduler loop fires it when due.
--
-- The scheduler lives in the ontology service because that service is the
-- always-running process that already owns both execution paths: runSync and
-- runPipeline are the same functions the API routes call, so a scheduled run
-- is byte-for-byte the same work as a manual one and lands in the same run
-- history (connection_sync_run / pipeline_run). The pipeline container is a
-- one-shot bootstrap; the assistant is for conversation.

CREATE TABLE IF NOT EXISTS platform.schedule (
    schedule_id      bigserial PRIMARY KEY,
    space_id         integer     NOT NULL REFERENCES platform.space (space_id) ON DELETE CASCADE,
    name             text        NOT NULL,
    -- What fires: a connection sync (target_ref = sync id) or a pipeline
    -- (target_ref = pipeline slug). One column rather than two nullable ones,
    -- because a schedule with both would be two schedules wearing a coat.
    kind             text        NOT NULL CHECK (kind IN ('sync', 'pipeline')),
    target_ref       text        NOT NULL,
    -- Interval cadence rather than a cron expression: the honest subset a
    -- data platform actually schedules, and the one a small UI can validate.
    -- 60s floor - a sub-minute schedule is a misconfiguration, not a cadence.
    interval_seconds integer     NOT NULL CHECK (interval_seconds >= 60),
    enabled          boolean     NOT NULL DEFAULT true,
    created_by       text        NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    -- Scheduler bookkeeping. next_run_at is the claim token: the loop moves
    -- it forward in the same UPDATE that fires, so two ticks cannot double-run
    -- one schedule and a disabled schedule is never picked up.
    last_run_at      timestamptz,
    next_run_at      timestamptz,
    last_status      text,
    last_error       text,
    run_count        bigint      NOT NULL DEFAULT 0,
    UNIQUE (space_id, name)
);

CREATE INDEX IF NOT EXISTS schedule_due_idx
    ON platform.schedule (next_run_at) WHERE enabled;

-- What a firing produced, distinct from what the target itself recorded: the
-- schedule row says whether the trigger worked; the sync or pipeline run it
-- caused has its own, richer history.
CREATE TABLE IF NOT EXISTS platform.schedule_run (
    schedule_run_id bigserial PRIMARY KEY,
    schedule_id     bigint      NOT NULL REFERENCES platform.schedule (schedule_id) ON DELETE CASCADE,
    status          text        NOT NULL CHECK (status IN ('succeeded', 'failed')),
    detail          jsonb       NOT NULL DEFAULT '{}'::jsonb,
    started_at      timestamptz NOT NULL DEFAULT now(),
    finished_at     timestamptz
);

CREATE INDEX IF NOT EXISTS schedule_run_schedule_idx
    ON platform.schedule_run (schedule_id, started_at DESC);
