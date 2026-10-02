-- 0027: the AI-FDE assistant's mode/capability layer.
--
-- The Palantir AI-FDE this platform imitates works through MODES - data
-- integration, ontology editing, governance, ... - each loading a different
-- set of tools, plus independently toggleable CAPABILITIES (notepad, plan,
-- execute action, view permissions) that survive a mode switch. Neither the
-- active mode nor the enabled capabilities may live only in the request:
-- a conversation that switched to governance mode must still be in it after
-- the container restarts, so both are session state.
--
-- The plan is persisted beside them: a plan the assistant proposed is part of
-- the conversation's record, and "what was it going to do" should outlive the
-- process that proposed it.

ALTER TABLE platform.chat_session
    ADD COLUMN IF NOT EXISTS agent_mode text NOT NULL DEFAULT 'exploration',
    ADD COLUMN IF NOT EXISTS capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS plan jsonb,
    ADD COLUMN IF NOT EXISTS todos jsonb;

-- Notepad documents. Scoped to a user and a space, like every other artefact
-- in this platform: a note written while investigating the sandbox must not
-- turn up as apparent context while working in production.
CREATE TABLE IF NOT EXISTS platform.notepad_document (
    notepad_document_id bigserial PRIMARY KEY,
    user_id      text        NOT NULL,
    space_id     integer     NOT NULL REFERENCES platform.space (space_id) ON DELETE CASCADE,
    title        text        NOT NULL,
    content      text        NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, space_id, title)
);

CREATE INDEX IF NOT EXISTS notepad_document_user_idx
    ON platform.notepad_document (user_id);
