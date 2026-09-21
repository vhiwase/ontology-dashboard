-- ============================================================================
--  0002: chat retention.
--
--  Conversations can quote customer data pulled from the ontology, so they
--  cannot sit forever with only a manual per-session delete. A session older
--  than the retention window is removed by pipeline.retention, which compose
--  runs on each pipeline pass; chat_message cascades from chat_session.
-- ============================================================================

-- Marks a session as exempt from the purge (an investigation, a saved example).
ALTER TABLE platform.chat_session
    ADD COLUMN IF NOT EXISTS is_retained BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS ix_chat_session_purge
    ON platform.chat_session (updated_at)
    WHERE NOT is_retained;

-- A record of what the purge removed, so deletion itself is auditable.
CREATE TABLE IF NOT EXISTS platform.retention_run (
    retention_run_id BIGSERIAL PRIMARY KEY,
    ran_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    policy_days      INTEGER NOT NULL,
    sessions_deleted INTEGER NOT NULL,
    messages_deleted INTEGER NOT NULL
);
