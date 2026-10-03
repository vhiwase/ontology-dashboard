-- ============================================================================
--  0036: a conversation history a person can manage.
--
--  Every conversation with the assistant has been stored since 0001 - the
--  session, each message, the tool calls behind each answer and what the
--  answer cost. What was missing was a way to live with that history:
--
--    * DELETING one removed its rows, and with them what it had cost. A
--      person's monthly AI credit is the sum of those costs (0035), so
--      deleting a conversation handed the credit back, and the spend report
--      lost the money it was there to account for.
--
--      A deleted conversation is now kept as a tombstone: marked here, gone
--      from every list and no longer openable, with its questions, answers,
--      tool calls and results erased - the assistant service does that when it
--      deletes one - and only the usage of each answer (tokens, model, price)
--      left in place. What was said is gone; what was spent is not.
--
--    * PINNING one keeps it at the top of the list. It is the same flag that
--      has exempted a session from the retention purge since 0002
--      (is_retained): a conversation worth pinning is one worth keeping.
--
--  Renaming needs nothing new: the title is already a column.
-- ============================================================================

ALTER TABLE platform.chat_session
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deleted_by TEXT;

COMMENT ON COLUMN platform.chat_session.deleted_at IS
    'When the conversation was deleted by its owner or an administrator. Its content is erased then; the row and each answer''s usage stay so spend is still accounted for.';

-- What a person's history lists: their live conversations, newest first.
CREATE INDEX IF NOT EXISTS ix_chat_session_history
    ON platform.chat_session (user_id, space_id, updated_at DESC)
    WHERE deleted_at IS NULL;
