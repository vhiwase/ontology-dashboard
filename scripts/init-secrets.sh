#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  Generate the secret files docker-compose.yml mounts at /run/secrets.
#
#  Run once before the first `docker compose up`. It is idempotent: an existing
#  file is left alone, so re-running it never rotates a secret out from under a
#  running stack. Pass --force to regenerate (which invalidates every issued
#  token and, for the database password, requires a `down -v`).
#
#      ./scripts/init-secrets.sh
#
#  ./secrets is gitignored. Nothing here belongs in the repository.
# ---------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "$0")/.."
SECRETS_DIR=secrets
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

write_secret() {
    local name=$1 value=$2 description=$3
    local path="$SECRETS_DIR/$name"

    if [ -s "$path" ] && [ "$FORCE" -eq 0 ]; then
        echo "  = $name already exists, left alone"
        return
    fi
    # printf, not echo: a trailing newline is stripped by every reader here,
    # but keeping the file free of one avoids depending on that.
    printf '%s' "$value" > "$path"
    chmod 600 "$path"
    echo "  + $name written ($description)"
}

random_secret() {
    # openssl is present on macOS, Linux and in Git Bash on Windows.
    openssl rand -base64 48 | tr -d '\n=' | cut -c1-64
}

echo "Writing secrets to ./$SECRETS_DIR"

# ── signing key shared by both services ────────────────────────────────────
write_secret jwt_secret "$(random_secret)" "HS256 key for API tokens"

# ── database ───────────────────────────────────────────────────────────────
PG_USER=${POSTGRES_USER:-ontology}
PG_DB=${POSTGRES_DB:-tms_ontology}

if [ -s "$SECRETS_DIR/postgres_password" ] && [ "$FORCE" -eq 0 ]; then
    PG_PASSWORD=$(cat "$SECRETS_DIR/postgres_password")
else
    PG_PASSWORD=$(random_secret)
fi
write_secret postgres_password "$PG_PASSWORD" "Postgres password"

# The full DSN, so the services never assemble a connection string from parts
# and cannot drift from the password above.
write_secret database_url \
    "postgresql://${PG_USER}:${PG_PASSWORD}@postgres:5432/${PG_DB}" \
    "connection string for all three services"

# ── Azure OpenAI ───────────────────────────────────────────────────────────
# Carried over from .env if it is there, so an existing working key is not
# lost. An empty file is valid: it means "no Azure", and LLM_PROVIDER=ollama
# then runs the stack entirely offline.
AZURE_KEY=""
if [ -f .env ]; then
    AZURE_KEY=$(grep -E '^AZURE_OPENAI_KEY=' .env | head -1 | cut -d= -f2- || true)
fi
if [ -s "$SECRETS_DIR/azure_openai_key" ] && [ "$FORCE" -eq 0 ]; then
    echo "  = azure_openai_key already exists, left alone"
else
    printf '%s' "$AZURE_KEY" > "$SECRETS_DIR/azure_openai_key"
    chmod 600 "$SECRETS_DIR/azure_openai_key"
    if [ -n "$AZURE_KEY" ]; then
        echo "  + azure_openai_key taken from .env"
    else
        echo "  + azure_openai_key written empty (set it, or run Ollama only)"
    fi
fi

echo
echo "Done. Next:"
echo "  1. Set BOOTSTRAP_ADMIN_PASSWORD in .env (at least 12 characters)."
echo "  2. docker compose up -d --build"
echo
echo "Without BOOTSTRAP_ADMIN_PASSWORD no user is created and every API route"
echo "answers 401. To add one later:"
echo "  docker compose run --rm pipeline python -m pipeline.users add <name> admin '<password>'"
