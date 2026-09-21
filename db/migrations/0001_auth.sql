-- ============================================================================
--  0001: application users, and the wiring that turns the existing
--        actor / user_id columns into a real principal instead of a default.
--
--  Password hashes are scrypt, formatted as
--      scrypt$<N>$<r>$<p>$<salt base64>$<derived key base64>
--  which both Node (crypto.scrypt) and Python (hashlib.scrypt) produce from
--  their standard library, so neither service needs a hashing dependency.
-- ============================================================================

CREATE TABLE IF NOT EXISTS platform.app_user (
    app_user_id   BIGSERIAL PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    display_name  TEXT,
    password_hash TEXT NOT NULL,
    -- Two separate role concepts, deliberately not collapsed into one:
    --
    --   role           the platform access tier. Decides which API routes the
    --                  caller may reach at all (read / write / administer).
    --
    --   ontology_role  the business hat, one of the roles declared in the
    --                  generated ontology. Decides which *actions* the caller
    --                  may execute, and is what AccessController checks.
    --
    -- A dispatcher and a finance user are both 'analyst' on the platform but
    -- may execute different actions, which one column could not express.
    role          TEXT NOT NULL CHECK (role IN ('viewer','analyst','admin')),
    ontology_role TEXT NOT NULL DEFAULT 'tms:AnalystRole'
                  CHECK (ontology_role IN (
                      'tms:AdminRole',
                      'tms:OperationsManagerRole',
                      'tms:DispatcherRole',
                      'tms:FinanceRole',
                      'tms:AnalystRole'
                  )),
    is_active     BOOLEAN NOT NULL DEFAULT true,
    -- Bumping this invalidates every token already issued to the user, which
    -- is the only revocation a stateless JWT allows without a denylist.
    token_version INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ix_app_user_username ON platform.app_user (username)
    WHERE is_active;

-- Failed logins, so a brute-force attempt is visible and rate-limitable.
CREATE TABLE IF NOT EXISTS platform.auth_attempt (
    auth_attempt_id BIGSERIAL PRIMARY KEY,
    username        TEXT NOT NULL,
    source_ip       TEXT,
    succeeded       BOOLEAN NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_auth_attempt_window
    ON platform.auth_attempt (username, created_at DESC);

-- The audit trail predates auth and defaulted actor to 'anonymous'. New rows
-- carry the authenticated principal; the default is dropped so a write that
-- forgets to pass one fails loudly rather than silently logging 'anonymous'.
ALTER TABLE platform.action_audit ALTER COLUMN actor DROP DEFAULT;

-- Same reasoning for chat ownership: 'demo-user' was a placeholder.
ALTER TABLE platform.chat_session ALTER COLUMN user_id   DROP DEFAULT;
ALTER TABLE platform.chat_session ALTER COLUMN user_role DROP DEFAULT;

CREATE INDEX IF NOT EXISTS ix_chat_session_user
    ON platform.chat_session (user_id, updated_at DESC);
