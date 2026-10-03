-- ============================================================================
--  0035: the admin console.
--
--  Three things an administrator could previously only do by editing .env,
--  restarting containers or running `docker compose run pipeline ...`:
--
--    * an AI credit per user - how much of the hosted model a person may spend
--      in a calendar month, or the platform default, or no limit at all;
--    * platform settings - the default model, the price per million tokens,
--      the default credit and whether anyone may register - stored here so a
--      change applies to the running services without a restart;
--    * a record of what administrators changed, and when, and who did it.
-- ============================================================================

-- ── credit per user ─────────────────────────────────────────────────────────
-- credit_mode says where the limit comes from:
--   default    the platform default (setting credit.defaultMonthlyUsd)
--   unlimited  no limit for this person, whatever the default is
--   custom     credit_limit_usd, for this person only
-- Spend is measured from platform.chat_message.cost_usd, which is priced at
-- write time with the rate then in force (0009), so a limit is checked against
-- what the turns actually cost rather than against today's price list.
ALTER TABLE platform.app_user
    ADD COLUMN IF NOT EXISTS credit_mode      TEXT NOT NULL DEFAULT 'default',
    ADD COLUMN IF NOT EXISTS credit_limit_usd NUMERIC(12, 2);

ALTER TABLE platform.app_user DROP CONSTRAINT IF EXISTS app_user_credit_mode_check;
ALTER TABLE platform.app_user
    ADD CONSTRAINT app_user_credit_mode_check
    CHECK (credit_mode IN ('default', 'unlimited', 'custom'));

-- An amount exactly when the mode is custom, and never a negative one.
ALTER TABLE platform.app_user DROP CONSTRAINT IF EXISTS app_user_credit_limit_check;
ALTER TABLE platform.app_user
    ADD CONSTRAINT app_user_credit_limit_check
    CHECK (
        ((credit_mode = 'custom') = (credit_limit_usd IS NOT NULL))
        AND (credit_limit_usd IS NULL OR credit_limit_usd >= 0)
    );

-- ── platform settings ───────────────────────────────────────────────────────
-- One row per setting an administrator has changed. A missing row means the
-- setting falls back to its environment variable, then to the built-in
-- default, so clearing a setting is a DELETE and .env keeps working as before.
CREATE TABLE IF NOT EXISTS platform.app_setting (
    key        TEXT PRIMARY KEY,
    value      JSONB NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── what administrators did ─────────────────────────────────────────────────
-- Accounts created, roles changed, credit raised, passwords reset, settings
-- edited. `target` is the username or setting key acted on, as text, so the
-- record outlives a deleted account.
CREATE TABLE IF NOT EXISTS platform.admin_event (
    admin_event_id BIGSERIAL PRIMARY KEY,
    actor          TEXT NOT NULL,
    action         TEXT NOT NULL,
    target         TEXT,
    detail         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_admin_event_recent
    ON platform.admin_event (created_at DESC);
