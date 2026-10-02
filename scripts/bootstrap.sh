#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  Bring the platform up.
#
#  The assistant runs on the Azure OpenAI deployment configured in .env
#  (AZURE_OPENAI_ENDPOINT plus the key in ./secrets/azure_openai_key). There
#  is no local model to size hardware for any more, so this script is now
#  plain orchestration: create .env if missing, bring the stack up, wait for
#  the one-shot pipeline to finish, and report where everything lives.
#
#  Usage:
#      ./scripts/bootstrap.sh            write .env, bring everything up
# ---------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "$0")/.."

for arg in "$@"; do
    case "$arg" in
        -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
        *) echo "Unknown option: $arg" >&2; exit 2 ;;
    esac
done

# ── .env ───────────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
    cp .env.example .env
    echo "Created .env from .env.example."
fi

if ! grep -qE '^AZURE_OPENAI_KEY=.+$' .env && ! [ -s secrets/azure_openai_key ]; then
    echo
    echo "  !! AZURE_OPENAI_KEY is empty and ./secrets/azure_openai_key is empty."
    echo "     The assistant needs it; everything else in the workbench runs"
    echo "     without it. Set it and run ./scripts/init-secrets.sh or edit"
    echo "     secrets/azure_openai_key directly."
fi

# ── bring it up ────────────────────────────────────────────────────────────
COMPOSE=(docker compose -f docker-compose.yml)

echo "=== Building and starting ==="
"${COMPOSE[@]}" up -d --build

echo
echo "=== Waiting for the pipeline to finish ==="
# The pipeline runs to completion and exits; the services after it wait on that.
"${COMPOSE[@]}" logs -f pipeline &
LOGS_PID=$!
for _ in $(seq 1 120); do
    STATE=$("${COMPOSE[@]}" ps -a --format json pipeline 2>/dev/null | head -1 || true)
    case "$STATE" in
        *'"State":"exited"'*|*'"State": "exited"'*) break ;;
    esac
    sleep 2
done
kill "$LOGS_PID" 2>/dev/null || true

echo
echo "=== Up ==="
"${COMPOSE[@]}" ps
UI_PORT=$(grep -E '^UI_PORT=' .env | cut -d= -f2)
echo
echo "  Workbench:        http://127.0.0.1:${UI_PORT:-3000}"
echo "  Ontology API:     http://127.0.0.1:4000/api/stats"
echo "  Assistant health: http://127.0.0.1:4100/health"
