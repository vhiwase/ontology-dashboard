-- 0028: what to build once a proposal is applied.
--
-- "Build me a sales dashboard" on data that has no sales dataset yet becomes a
-- proposal for that dataset. Approving it used to leave the person to ask for
-- the dashboard a second time; the follow-up records the request so the board
-- is built from the new dataset the moment it exists.
--
--   {"build": "dashboard" | "report", "title": "Sales dashboard",
--    "measure": "revenue", "sourcePrompt": "build me a sales dashboard"}

ALTER TABLE platform.proposal ADD COLUMN IF NOT EXISTS follow_up JSONB;
