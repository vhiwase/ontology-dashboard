#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  Bring the platform up, choosing the LLM path from the hardware that is here.
#
#  The decision this script exists to make: Ollama on a GPU is the better default
#  (local, no keys, nothing leaves the machine), but on CPU a 7B model with a
#  fifteen-tool schema takes minutes per call, and the agent makes several calls
#  per question. So:
#
#      nvidia-smi answers      -> GPU:  Ollama primary, Azure OpenAI fallback,
#                                       and the GPU compose overlay is applied.
#      nvidia-smi absent/fails -> CPU:  Azure OpenAI primary, Ollama fallback.
#
#  Override by setting LLM_PROVIDER in .env; this script only fills in what is
#  unset.
#
#  Usage:
#      ./scripts/bootstrap.sh            detect, write .env, bring everything up
#      ./scripts/bootstrap.sh --detect   report the decision and exit
#      ./scripts/bootstrap.sh --cpu      force the CPU/Azure path
#      ./scripts/bootstrap.sh --gpu      force the GPU/Ollama path
# ---------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "$0")/.."

MODE="auto"
DETECT_ONLY=false
for arg in "$@"; do
    case "$arg" in
        --detect) DETECT_ONLY=true ;;
        --cpu) MODE="cpu" ;;
        --gpu) MODE="gpu" ;;
        -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
        *) echo "Unknown option: $arg" >&2; exit 2 ;;
    esac
done

# ── detect ─────────────────────────────────────────────────────────────────
detect_gpu() {
    # Presence on PATH is not enough: nvidia-smi is installed but fails when the
    # driver is missing or the GPU is unavailable, so the query has to succeed.
    if command -v nvidia-smi >/dev/null 2>&1; then
        if nvidia-smi --query-gpu=name --format=csv,noheader >/dev/null 2>&1; then
            return 0
        fi
        echo "  nvidia-smi is on PATH but returned an error; treating this as CPU-only." >&2
    fi
    return 1
}

if [ "$MODE" = "auto" ]; then
    if detect_gpu; then MODE="gpu"; else MODE="cpu"; fi
fi

echo "=== LLM hardware decision ==="
if [ "$MODE" = "gpu" ]; then
    GPU_NAME=$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null | head -1)
    echo "  GPU:      ${GPU_NAME:-detected}"
    echo "  Primary:  ollama (local, open source)"
    echo "  Fallback: azure_openai"
    LLM_PROVIDER_VALUE="ollama"
    LLM_FALLBACK_VALUE="azure_openai"
    OLLAMA_GPU_VALUE="true"
else
    echo "  GPU:      none usable (nvidia-smi absent or failing)"
    echo "  Primary:  azure_openai  - a CPU-only 7B model is too slow for a"
    echo "            tool-calling agent (minutes per call, several calls per answer)"
    echo "  Fallback: ollama        - still available, and used if Azure fails"
    LLM_PROVIDER_VALUE="azure_openai"
    LLM_FALLBACK_VALUE="ollama"
    OLLAMA_GPU_VALUE="false"
fi

if [ "$DETECT_ONLY" = true ]; then exit 0; fi

# ── .env ───────────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
    cp .env.example .env
    echo "Created .env from .env.example."
fi

# Set a key only if it is absent or empty, so a deliberate edit is never
# overwritten by a later run.
set_env() {
    local key="$1" value="$2"
    if grep -qE "^${key}=.+$" .env; then
        echo "  ${key} already set in .env; leaving it alone."
    elif grep -qE "^${key}=" .env; then
        # Present but empty: fill it in, portably across BSD and GNU sed.
        sed "s|^${key}=.*$|${key}=${value}|" .env > .env.tmp && mv .env.tmp .env
        echo "  ${key}=${value}"
    else
        printf '\n%s=%s\n' "$key" "$value" >> .env
        echo "  ${key}=${value}"
    fi
}

echo "=== Configuring .env ==="
set_env LLM_PROVIDER "$LLM_PROVIDER_VALUE"
set_env LLM_FALLBACK_PROVIDER "$LLM_FALLBACK_VALUE"
set_env OLLAMA_GPU "$OLLAMA_GPU_VALUE"

if [ "$LLM_PROVIDER_VALUE" = "azure_openai" ] && ! grep -qE '^AZURE_OPENAI_KEY=.+$' .env; then
    echo
    echo "  !! AZURE_OPENAI_KEY is empty in .env, and Azure is the chosen primary."
    echo "     Set it, or run with --gpu / set LLM_PROVIDER=ollama to stay local."
    echo "     Without it the assistant will fall back to Ollama on CPU, which works"
    echo "     but is slow; everything else in the workbench is unaffected."
fi

# ── bring it up ────────────────────────────────────────────────────────────
COMPOSE=(docker compose -f docker-compose.yml)
if [ "$MODE" = "gpu" ]; then
    COMPOSE+=(-f docker-compose.gpu.yml)
    echo "=== Using the GPU overlay ==="
fi

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
if [ "$MODE" = "gpu" ]; then
    echo
    echo "  Confirm the GPU is really in use:"
    echo "    curl -s http://127.0.0.1:11434/api/ps"
    echo "  size_vram greater than zero means layers are on the GPU."
fi
