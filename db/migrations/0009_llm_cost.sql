-- ============================================================================
--  0009: what each assistant turn actually cost.
--
--  The platform metered tokens for the rate limiter but never priced them, so
--  "how much is this assistant costing us" had no answer. Tokens alone do not
--  answer it either: input and output are priced differently, the rate differs
--  per model, and a turn can fail over from a free local model to a paid
--  hosted one half way through.
--
--  Cost is stored PER MESSAGE, with the rate that was in force when the call
--  was made. Recomputing historical spend from today's price list would be
--  wrong the first time a rate changes, and rates change.
-- ============================================================================

ALTER TABLE platform.chat_message
    ADD COLUMN IF NOT EXISTS provider        TEXT,
    ADD COLUMN IF NOT EXISTS model           TEXT,
    ADD COLUMN IF NOT EXISTS prompt_tokens   INTEGER,
    ADD COLUMN IF NOT EXISTS completion_tokens INTEGER,
    ADD COLUMN IF NOT EXISTS total_tokens    INTEGER,
    -- USD. numeric, not float: money that is summed should not drift.
    ADD COLUMN IF NOT EXISTS cost_usd        NUMERIC(12, 6),
    -- The per-million rates used, so a historical row can be explained and
    -- audited rather than just believed.
    ADD COLUMN IF NOT EXISTS rate_input_per_m  NUMERIC(10, 4),
    ADD COLUMN IF NOT EXISTS rate_output_per_m NUMERIC(10, 4);

CREATE INDEX IF NOT EXISTS ix_chat_message_cost
    ON platform.chat_message (created_at DESC)
    WHERE cost_usd IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_chat_message_model
    ON platform.chat_message (model, created_at DESC)
    WHERE model IS NOT NULL;

-- Backfill what can honestly be backfilled: the token counts already stored in
-- token_usage. Cost is deliberately left NULL rather than invented, because
-- the rate that applied to those calls was never recorded and guessing it
-- would put a fabricated number in a spend report.
UPDATE platform.chat_message
   SET prompt_tokens     = COALESCE((token_usage->>'promptTokens')::int, NULL),
       completion_tokens = COALESCE((token_usage->>'completionTokens')::int, NULL),
       total_tokens      = COALESCE((token_usage->>'totalTokens')::int, NULL)
 WHERE token_usage IS NOT NULL
   AND total_tokens IS NULL;
