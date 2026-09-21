"""AI-FDE HTTP service."""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import store
from .agent import Agent
from .auth import Principal, require_role
from .context import current_request_id
from .config import CONFIG
from .limits import REPLICA_WARNING, RateLimited, limiter
from .llm import LlmError, _single_provider, build_provider
from .prompts import STARTER_PROMPTS
from .tools import OntologyClient

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s %(name)-18s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("ai_fde")

state: dict[str, Any] = {}


# The providers a caller may choose between, in the order the dropdown shows
# them. "auto" is the server's configured chain, which is what ran before a
# per-request choice existed.
SELECTABLE_PROVIDERS = ("ollama", "azure_openai")

PROVIDER_LABELS = {
    "ollama": "Ollama (local, open source)",
    "azure_openai": "Azure OpenAI (hosted)",
    "auto": "Automatic (server default)",
}


@asynccontextmanager
async def lifespan(_: FastAPI):
    log.info("AI-FDE starting: LLM_PROVIDER=%s", CONFIG.provider)

    # One agent per provider that can actually be constructed, so a chat can
    # name the one it wants. A provider that cannot be built - no Azure key,
    # say - is simply absent from the map and from the dropdown, rather than
    # being offered and then failing on use.
    agents: dict[str, Agent] = {}
    for name in SELECTABLE_PROVIDERS:
        try:
            agents[name] = Agent(_single_provider(name))
        except LlmError as exc:
            log.warning("Provider %r is not available for selection: %s", name, exc)
    state["agents"] = agents

    try:
        provider, why = await build_provider()
        state["provider"] = provider
        state["providerReason"] = why
        state["agent"] = Agent(provider)
        log.info("LLM resolved: %s", why)
    except LlmError as exc:
        # Start anyway. /health reports the problem and the UI shows it, which is
        # far easier to diagnose than a container that will not come up.
        log.error("LLM provider unavailable: %s", exc)
        state["provider_error"] = str(exc)
    state["ontology"] = OntologyClient()
    log.info(REPLICA_WARNING)
    yield


app = FastAPI(
    title="TMS AI-FDE",
    description="Ontology-aware assistant that answers TMS questions and builds dashboards.",
    version="1.0.0",
    lifespan=lifespan,
)
# nginx serves the SPA and proxies this API, so the browser calls its own
# origin and needs no CORS. CORS_ALLOWED_ORIGINS covers a separately hosted
# front end; left unset, no cross-origin call is permitted, where allow_origins
# ["*"] previously permitted every one of them.
_allowed_origins = [
    origin.strip()
    for origin in os.environ.get("CORS_ALLOWED_ORIGINS", "").split(",")
    if origin.strip()
]
if _allowed_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_allowed_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["authorization", "content-type"],
    )
    log.info("CORS restricted to: %s", ", ".join(_allowed_origins))
else:
    log.info("CORS disabled (same-origin only).")


@app.middleware("http")
async def correlate_and_log(request: Request, call_next):
    """Attach a correlation id, then log one structured line per request.

    Logging was unstructured prose with no request id, so a slow or failed
    chat turn could not be tied to the ontology queries it caused. The id is
    taken from the inbound X-Request-ID when there is one - nginx and the
    browser can both supply it - so the same value spans the whole call chain.
    """
    incoming = request.headers.get("x-request-id", "")
    request_id = incoming if 0 < len(incoming) <= 64 else str(uuid.uuid4())
    current_request_id.set(request_id)

    started = time.monotonic()
    try:
        response = await call_next(request)
    except Exception:
        log.exception(
            json.dumps(
                {
                    "level": "error",
                    "requestId": request_id,
                    "method": request.method,
                    "path": request.url.path,
                    "durationMs": int((time.monotonic() - started) * 1000),
                }
            )
        )
        raise

    duration_ms = int((time.monotonic() - started) * 1000)
    response.headers["x-request-id"] = request_id

    # The health probe fires every ten seconds; logging it would bury
    # everything else.
    if request.url.path not in ("/health",):
        log.info(
            json.dumps(
                {
                    "level": "info",
                    "requestId": request_id,
                    "method": request.method,
                    "path": request.url.path,
                    "status": response.status_code,
                    "durationMs": duration_ms,
                }
            )
        )
    return response


async def ontology_snapshot() -> dict[str, Any]:
    """The orientation data handed to the model each turn."""
    client: OntologyClient = state["ontology"]
    try:
        types, kpis, stats = (
            await client.get("/api/object-types"),
            await client.get("/api/kpis/catalogue"),
            await client.get("/api/stats"),
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=503,
            detail=f"Could not read the ontology service at {client.base_url}: {exc}",
        ) from exc

    return {
        "ontologyVersion": stats["ontology"]["version"],
        "objectTypes": [
            {"apiName": t["apiName"], "label": t["label"], "rowCount": t["rowCount"]}
            for t in sorted(types, key=lambda t: -t["rowCount"])
        ],
        "kpis": kpis,
        "coverage": [
            {
                "metricArea": row["metric_area"],
                "sourceCoveragePct": float(row["source_coverage_pct"] or 0),
            }
            for row in stats["dataCoverage"]
        ],
    }


# ── schemas ─────────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    # userId / userRole used to be fields here and were written straight onto
    # the session row, so a caller named themselves and chose their own
    # ontology role. Both now come from the verified token instead.
    message: str = Field(min_length=1, max_length=8000)
    sessionId: int | None = None
    # Which model answers this turn. Unset, or "auto", uses the server's
    # configured chain with its failover. Naming one pins the turn to it, with
    # no failover: a caller who asked for the local model should be told it is
    # unavailable, not quietly billed for the hosted one.
    provider: str | None = None


class ToolCallView(BaseModel):
    name: str
    arguments: dict[str, Any]
    ok: bool
    durationMs: int
    preview: str


class ChatResponse(BaseModel):
    sessionId: int
    reply: str
    toolCalls: list[ToolCallView]
    artifacts: list[dict[str, Any]]
    rounds: int
    latencyMs: int
    stoppedBecause: str
    usage: dict[str, Any]
    provider: str
    model: str
    # Set when the primary provider was skipped or failed for this turn.
    failoverReason: str | None = None


# ── endpoints ───────────────────────────────────────────────────────────────

# Both paths serve the same payload: /health is what the container healthcheck
# probes, and /api/assistant/health is what the browser reaches through the nginx
# prefix, which only forwards /api/assistant.
async def _health_detail() -> dict[str, Any]:
    llm: dict[str, Any]
    if "provider" in state:
        try:
            llm = await state["provider"].health()
        except Exception as exc:  # noqa: BLE001
            llm = {"reachable": False, "detail": str(exc)}
    else:
        llm = {"reachable": False, "detail": state.get("provider_error", "not initialised")}

    ontology_ok = False
    ontology_detail: str | None = None
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            response = await client.get(f"{CONFIG.ontology_service_url}/health")
        ontology_ok = response.status_code == 200
        if not ontology_ok:
            ontology_detail = f"HTTP {response.status_code}"
    except Exception as exc:  # noqa: BLE001
        ontology_detail = str(exc)

    # Reports ok when the ontology is reachable even if the model is not: the UI
    # stays usable and shows exactly which dependency is down.
    provider = state.get("provider")
    active = llm.get("activeProvider") or getattr(provider, "name", CONFIG.provider)
    return {
        "status": "ok" if ontology_ok else "degraded",
        "provider": active,
        "configuredProvider": CONFIG.provider,
        "model": llm.get("model") or CONFIG.model_for(active),
        "providerReason": state.get("providerReason"),
        "llm": llm,
        "ontologyService": {"url": CONFIG.ontology_service_url, "reachable": ontology_ok,
                            "detail": ontology_detail},
        "maxToolRounds": CONFIG.max_tool_rounds,
    }


@app.get("/health")
async def health() -> dict[str, Any]:
    """Liveness for the compose healthcheck, which carries no credential.

    Deliberately terse. The detailed view names the provider, the model, the
    ontology service URL and the text of whatever exception a dependency
    raised, none of which an unauthenticated caller needs.
    """
    detail = await _health_detail()
    return {
        "status": detail["status"],
        "llmReachable": bool(detail["llm"].get("reachable")),
        "ontologyReachable": detail["ontologyService"]["reachable"],
    }


@app.get("/api/assistant/health")
async def assistant_health(
    _: Principal = Depends(require_role("viewer")),
) -> dict[str, Any]:
    """The full picture, for the UI to render once someone has signed in."""
    return await _health_detail()


async def _ollama_is_cpu_only(agent: Agent) -> bool:
    """Whether Ollama lacks GPU offload, cached for the life of the process.

    has_gpu() proves offload by loading the model and reading its VRAM, which
    on CPU-only hardware is the very multi-minute operation this is trying to
    warn about - so probing it on every dropdown render would be its own
    outage. Whether a GPU is present cannot change while the container runs,
    so the first answer is kept.
    """
    if "ollamaCpuOnly" in state:
        return bool(state["ollamaCpuOnly"])

    gpu = CONFIG.ollama_gpu
    if gpu in ("true", "false"):
        state["ollamaCpuOnly"] = gpu == "false"
        return bool(state["ollamaCpuOnly"])

    try:
        detected, _why = await agent.provider.has_gpu()
        # None means "could not tell", which is not evidence of CPU-only, so it
        # is not cached: a later call can still find out.
        if detected is None:
            return False
        state["ollamaCpuOnly"] = detected is False
    except Exception:  # noqa: BLE001 - advisory only, never fatal
        return False
    return bool(state["ollamaCpuOnly"])


@app.get("/api/assistant/providers")
async def providers(
    _: Principal = Depends(require_role("viewer")),
) -> dict[str, Any]:
    """The models a chat may choose between, with live availability.

    Availability is probed per request rather than cached, because "is the
    local model pulled yet" changes while the stack is running and a dropdown
    that lies about it is worse than no dropdown.
    """
    agents: dict[str, Agent] = state.get("agents", {})

    async def describe(name: str) -> dict[str, Any]:
        entry: dict[str, Any] = {
            "id": name,
            "label": PROVIDER_LABELS.get(name, name),
            "model": CONFIG.model_for(name),
            "configured": name in agents,
            "available": False,
            # Usable, but slow enough that the choice deserves a warning.
            "slow": False,
            "detail": None,
        }
        agent = agents.get(name)
        if agent is None:
            entry["detail"] = "Not configured on this server."
            return entry
        try:
            health = await agent.provider.health()
            entry["available"] = bool(health.get("reachable"))
            # Ollama can be reachable with the model absent, which is not the
            # same as usable, so that case is reported as unavailable.
            if entry["available"] and health.get("modelPresent") is False:
                entry["available"] = False
                entry["detail"] = (
                    f"{CONFIG.model_for(name)} is not pulled yet. "
                    "docker compose up ollama-init"
                )
            elif not entry["available"]:
                entry["detail"] = health.get("detail") or "Not reachable."

            # Reachable is not the same as usable. A 7B model with this tool
            # schema needs minutes per round on CPU, which reads as a hang
            # rather than as slowness, so the dropdown says so up front instead
            # of letting someone wait out the timeout to find out.
            if name == "ollama" and entry["available"]:
                entry["slow"] = await _ollama_is_cpu_only(agent)
                if entry.get("slow"):
                    entry["detail"] = (
                        "No GPU offload detected, so this runs on CPU and a single "
                        f"answer can take several minutes (timeout {CONFIG.ollama_timeout:.0f}s). "
                        "Azure OpenAI answers in seconds."
                    )
        except Exception as exc:  # noqa: BLE001 - availability, never fatal
            entry["detail"] = str(exc)
        return entry

    described = [await describe(name) for name in SELECTABLE_PROVIDERS]

    return {
        "providers": described,
        "auto": {
            "id": "auto",
            "label": PROVIDER_LABELS["auto"],
            "resolvedTo": getattr(state.get("provider"), "name", None),
            "reason": state.get("providerReason"),
        },
        # What the UI should preselect. Ollama is the intended default, but a
        # default nobody can use is not a default, so it yields to the first
        # provider that is actually available.
        "default": next(
            (p["id"] for p in described if p["id"] == "ollama" and p["available"]),
            next((p["id"] for p in described if p["available"]), "auto"),
        ),
    }


@app.get("/api/assistant/starters")
async def starters(
    _: Principal = Depends(require_role("viewer")),
) -> dict[str, Any]:
    return {"starters": STARTER_PROMPTS}


def _visible_owner(principal: Principal) -> str | None:
    """The owner filter for this caller: None means unrestricted.

    Only an admin sees other people's conversations, and that is deliberate -
    an answer can quote any customer record the ontology exposes.
    """
    return None if principal.role == "admin" else principal.username


@app.get("/api/assistant/sessions")
async def sessions(
    principal: Principal = Depends(require_role("viewer")),
) -> dict[str, Any]:
    return {"sessions": store.list_sessions(_visible_owner(principal))}


@app.get("/api/assistant/sessions/{session_id}")
async def session_messages(
    session_id: int,
    principal: Principal = Depends(require_role("viewer")),
) -> dict[str, Any]:
    # 404 rather than 403 on someone else's session, so this cannot be used to
    # enumerate which session ids exist.
    if not store.session_exists(session_id, _visible_owner(principal)):
        raise HTTPException(status_code=404, detail=f"No session {session_id}.")
    return {"sessionId": session_id, "messages": store.get_messages(session_id)}


# response_class=Response is required, not stylistic: FastAPI asserts that a 204
# route cannot produce a body, and a `-> None` annotation still makes it build a
# response model, which trips that assertion at import time.
@app.delete("/api/assistant/sessions/{session_id}", status_code=204, response_class=Response)
async def remove_session(
    session_id: int,
    principal: Principal = Depends(require_role("viewer")),
) -> Response:
    if not store.delete_session(session_id, _visible_owner(principal)):
        raise HTTPException(status_code=404, detail=f"No session {session_id}.")
    return Response(status_code=204)


@app.post("/api/assistant/chat", response_model=ChatResponse)
async def chat(
    request: ChatRequest,
    principal: Principal = Depends(require_role("analyst")),
) -> ChatResponse:
    # Rate and spend are checked before anything expensive happens, and both
    # key on the authenticated user rather than an IP, so a shared NAT does not
    # throttle a whole office and a rotating IP does not evade the budget.
    try:
        limiter.check_rate(principal.username)
        limiter.check_budget(principal.username)
    except RateLimited as exc:
        raise HTTPException(
            status_code=429,
            detail=str(exc),
            headers={"Retry-After": str(exc.retry_after)},
        ) from exc

    # Pick the agent for this turn. An explicit choice is honoured exactly:
    # no failover to the other provider, because someone who selected the
    # local model wants to know it is down rather than have the hosted one
    # answer - and be charged for it - without saying so.
    chosen = (request.provider or "auto").strip().lower()
    if chosen in ("", "auto"):
        if "agent" not in state:
            raise HTTPException(
                status_code=503,
                detail=(
                    "The language model is not available: "
                    + state.get("provider_error", "unknown")
                    + " Check /health for detail."
                ),
            )
        agent: Agent = state["agent"]
    else:
        if chosen not in SELECTABLE_PROVIDERS:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Unknown provider {chosen!r}. Choose one of: "
                    + ", ".join(("auto", *SELECTABLE_PROVIDERS))
                ),
            )
        agent = state.get("agents", {}).get(chosen)
        if agent is None:
            raise HTTPException(
                status_code=503,
                detail=(
                    f"{PROVIDER_LABELS.get(chosen, chosen)} is not configured on "
                    "this server. Pick another model."
                ),
            )

    session_id = request.sessionId
    if session_id is None:
        session_id = store.create_session(
            title=None,
            user_id=principal.username,
            user_role=principal.ontology_role,
            provider=chosen if chosen not in ("", "auto") else CONFIG.provider,
            model=CONFIG.model_for(chosen) if chosen not in ("", "auto") else CONFIG.model_name,
        )
    elif not store.session_exists(session_id, _visible_owner(principal)):
        # Continuing someone else's conversation would hand the caller its
        # history, so an unowned id is simply not found.
        raise HTTPException(status_code=404, detail=f"No session {session_id}.")

    # What this turn actually ran against, for honest reporting below.
    attempted_provider = (
        chosen
        if chosen not in ("", "auto")
        else getattr(state.get("provider"), "name", CONFIG.provider)
    )

    snapshot = await ontology_snapshot()
    history = store.history_for_model(session_id)

    store.append_message(session_id, "user", request.message)

    result = await agent.run(request.message, history, snapshot)

    # Charge the budget with what the turn actually cost. This runs after the
    # call, so a single turn can overshoot the cap; the next one is refused.
    # Capping mid-stream would mean abandoning work already paid for.
    usage = result.usage or {}
    limiter.record_usage(principal.username, int(usage.get("totalTokens") or 0))

    # Tool calls are persisted alongside the answer so a number can be traced to
    # the query that produced it.
    store.append_message(
        session_id,
        "assistant",
        result.content,
        tool_calls=[
            {
                "name": invocation.name,
                "arguments": invocation.arguments,
                "ok": invocation.ok,
                "durationMs": invocation.duration_ms,
                "preview": invocation.result_preview,
            }
            for invocation in result.tool_invocations
        ],
        artifacts=result.artifacts,
        latency_ms=result.latency_ms,
        token_usage=result.usage,
    )

    return ChatResponse(
        sessionId=session_id,
        reply=result.content,
        toolCalls=[
            ToolCallView(
                name=invocation.name,
                arguments=invocation.arguments,
                ok=invocation.ok,
                durationMs=invocation.duration_ms,
                preview=invocation.result_preview,
            )
            for invocation in result.tool_invocations
        ],
        artifacts=result.artifacts,
        rounds=result.rounds,
        latencyMs=result.latency_ms,
        stoppedBecause=result.stopped_because,
        usage=result.usage,
        # When the model errors, result.provider is empty. Falling back to
        # CONFIG.provider then reported the SERVER default rather than what was
        # actually attempted - so a turn pinned to Ollama that timed out came
        # back labelled azure_openai, which reads as "the hosted model answered"
        # and, worse, as "you were billed for it". Fall back to what this turn
        # actually selected.
        provider=result.provider or attempted_provider,
        model=result.model or CONFIG.model_for(attempted_provider),
        failoverReason=result.failover_reason,
    )


def main() -> None:
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=CONFIG.port, log_level="info")


if __name__ == "__main__":
    main()
