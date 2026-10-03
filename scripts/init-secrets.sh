#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  Generate the secret files docker-compose.yml mounts at /run/secrets.
#
#  Run once before the first `docker compose up`. It is idempotent: an existing
#  file is left alone, so re-running it never rotates a secret out from under a
#  running stack. Pass --force to regenerate (which invalidates every issued
#  token, makes every stored connection password unreadable and, for the
#  database password, requires a `down -v`).
#
#  Run it again after pulling a version that adds a secret. A stack started
#  before a secret's file exists gets an empty DIRECTORY at that path from
#  Docker, and the service cannot read its key; this replaces such a directory
#  with the file. The containers then have to be RECREATED, not restarted
#  (`docker compose up -d --force-recreate`): one that started with the
#  directory mounted cannot start again now the path is a file, and for as long
#  as it keeps running Docker shows the directory to every new container too.
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

# Docker creates a DIRECTORY at a secret's path when the stack is started
# before the file exists, and the service that mounts it then cannot read its
# key. An empty directory there is that leftover - never a secret - so it is
# replaced by the file. One with something in it is not this script's to remove.
clear_stray_directory() {
    local path=$1
    [ -d "$path" ] || return 0
    if [ -n "$(ls -A "$path" 2>/dev/null)" ]; then
        echo "  ! $path is a directory with files in it. Move it away and run this again." >&2
        exit 1
    fi
    if ! rmdir "$path" 2>/dev/null; then
        echo "  ! $path is an empty directory that could not be removed (a running container" >&2
        echo "    may be holding it). Run 'docker compose stop' and run this again." >&2
        exit 1
    fi
    echo "  - $(basename "$path") was an empty directory left by Docker; writing the file in its place"
    REPLACED_STRAY=1
}
REPLACED_STRAY=0

write_secret() {
    local name=$1 value=$2 description=$3
    local path="$SECRETS_DIR/$name"

    clear_stray_directory "$path"
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
# lost. An empty file is valid: the assistant is the only thing that needs it,
# and it reports exactly that at /health until the key is set.
AZURE_KEY=""
if [ -f .env ]; then
    AZURE_KEY=$(grep -E '^AZURE_OPENAI_KEY=' .env | head -1 | cut -d= -f2- || true)
fi
clear_stray_directory "$SECRETS_DIR/azure_openai_key"
if [ -s "$SECRETS_DIR/azure_openai_key" ] && [ "$FORCE" -eq 0 ]; then
    echo "  = azure_openai_key already exists, left alone"
else
    printf '%s' "$AZURE_KEY" > "$SECRETS_DIR/azure_openai_key"
    chmod 600 "$SECRETS_DIR/azure_openai_key"
    if [ -n "$AZURE_KEY" ]; then
        echo "  + azure_openai_key taken from .env"
    else
        echo "  + azure_openai_key written empty (the built-in planner answers until it is set)"
    fi
fi

# ── credential vault ───────────────────────────────────────────────────────
# Encrypts the database passwords people type into the connect form. Kept
# apart from jwt_secret so rotating the signing key does not make every stored
# connection password unreadable. 64 hex characters = 32 bytes.
write_secret credential_key "$(openssl rand -hex 32)" "AES-256 key for stored connection passwords"

echo
if [ "$REPLACED_STRAY" -eq 1 ]; then
    # Said instead of the first-run steps: this stack has run before.
    echo "Done. A secret that was a directory is a file now. A container that"
    echo "started with the directory mounted cannot be restarted with the file in"
    echo "its place, and while it runs Docker shows new containers the directory"
    echo "too - so recreate them:"
    echo "  docker compose up -d --build --force-recreate"
    exit 0
fi
echo "Done. Next:"
echo "  1. Set BOOTSTRAP_ADMIN_PASSWORD in .env (at least 12 characters)."
echo "  2. docker compose up -d --build"
echo
echo "Without BOOTSTRAP_ADMIN_PASSWORD no user is created and every API route"
echo "answers 401. To add one later:"
echo "  docker compose run --rm pipeline python -m pipeline.users add <name> admin '<password>'"
