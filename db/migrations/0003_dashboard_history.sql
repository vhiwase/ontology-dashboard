-- ============================================================================
--  0003: dashboard provenance and rename history.
--
--  A dashboard already recorded source_prompt, but not WHICH conversation
--  produced it, so the history view could not get from a dashboard back to the
--  session that built it. ON DELETE SET NULL, not CASCADE: purging chat history
--  under the retention policy must not take the dashboards with it.
-- ============================================================================

ALTER TABLE platform.dashboard
    ADD COLUMN IF NOT EXISTS chat_session_id BIGINT
        REFERENCES platform.chat_session(chat_session_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_dashboard_session
    ON platform.dashboard (chat_session_id)
    WHERE chat_session_id IS NOT NULL;

-- Renames are recorded rather than applied silently, so "this used to be called
-- something else" is answerable - which matters when a link or a screenshot
-- refers to the old name.
CREATE TABLE IF NOT EXISTS platform.dashboard_rename (
    dashboard_rename_id BIGSERIAL PRIMARY KEY,
    dashboard_id        BIGINT NOT NULL
                        REFERENCES platform.dashboard(dashboard_id) ON DELETE CASCADE,
    previous_title      TEXT NOT NULL,
    new_title           TEXT NOT NULL,
    previous_slug       TEXT NOT NULL,
    new_slug            TEXT NOT NULL,
    renamed_by          TEXT NOT NULL,
    renamed_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_dashboard_rename_dashboard
    ON platform.dashboard_rename (dashboard_id, renamed_at DESC);
