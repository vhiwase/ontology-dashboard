-- 0029: which space an action was attempted in.
--
-- The audit trail was one platform-wide list, readable only by administrators,
-- because it mixed every team's activity. With personal workspaces an owner
-- should see the trail of their own workspace - and nobody else's - so each
-- row now records its space and the trail is read per space.

ALTER TABLE platform.action_audit
    ADD COLUMN IF NOT EXISTS space_id BIGINT REFERENCES platform.space(space_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_action_audit_space
    ON platform.action_audit (space_id, created_at DESC);
