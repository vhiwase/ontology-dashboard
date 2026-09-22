-- ============================================================================
--  0011: attribute the turns that were showing as "unknown".
--
--  0009 added provider/model to chat_message and backfilled the TOKEN counts
--  from token_usage, but left provider and model NULL — so the cost report
--  grouped those turns under "unknown / unknown", which reads as a mystery
--  rather than as history.
--
--  They are not a mystery. chat_session records llm_provider and llm_model at
--  the point the conversation was created, so which model answered is a fact
--  already stored one table over. This copies it down.
--
--  COST IS STILL NOT BACKFILLED, deliberately. Knowing WHICH model answered is
--  not the same as knowing what RATE applied at the time, and no rate was
--  recorded for these calls. Pricing them at today's rates would put a
--  fabricated number in a spend report — which is the thing 0009 set out to
--  avoid. They stay counted as unpriced, and the report says so.
-- ============================================================================

UPDATE platform.chat_message m
   SET provider = s.llm_provider,
       model    = s.llm_model
  FROM platform.chat_session s
 WHERE s.chat_session_id = m.chat_session_id
   AND m.role = 'assistant'
   AND m.provider IS NULL
   AND s.llm_provider IS NOT NULL;

-- Anything still without a provider has no session record either, which can
-- only happen for a row written before sessions carried the fields at all.
-- Named explicitly so the report distinguishes "never recorded" from a
-- provider it simply does not have a rate for.
UPDATE platform.chat_message
   SET provider = 'not recorded',
       model    = 'not recorded'
 WHERE role = 'assistant'
   AND provider IS NULL
   AND total_tokens IS NOT NULL;
