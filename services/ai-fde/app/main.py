"""AI-FDE HTTP service."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import store
from .agent import Agent
from .config import CONFIG
from .llm import LlmError, build_provider
from .prompts import STARTER_PROMPTS
from .tools import OntologyClient

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s %(name)-18s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("ai_fde")

state: dict[str, Any] = {}


@asynccontextmanager
async def lifespan(_: FastAPI):
    log.info("AI-FDE starting: LLM_PROVIDER=%s", CONFIG.provider)
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
    yield


app = FastAPI(
    title="TMS AI-FDE",
    description="Ontology-aware assistant that answers TMS questions and builds dashboards.",
    version="1.0.0",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


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
    message: str = Field(min_length=1, max_length=8000)
    sessionId: int | None = None
    userId: str = "demo-user"
    userRole: str = CONFIG.default_role


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
@app.get("/health")
@app.get("/api/assistant/health")
async def health() -> dict[str, Any]:
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


@app.get("/api/assistant/starters")
async def starters() -> dict[str, Any]:
    return {"starters": STARTER_PROMPTS}


@app.get("/api/assistant/sessions")
async def sessions() -> dict[str, Any]:
    return {"sessions": store.list_sessions()}


@app.get("/api/assistant/sessions/{session_id}")
async def session_messages(session_id: int) -> dict[str, Any]:
    if not store.session_exists(session_id):
        raise HTTPException(status_code=404, detail=f"No session {session_id}.")
    return {"sessionId": session_id, "messages": store.get_messages(session_id)}


# response_class=Response is required, not stylistic: FastAPI asserts that a 204
# route cannot produce a body, and a `-> None` annotation still makes it build a
# response model, which trips that assertion at import time.
@app.delete("/api/assistant/sessions/{session_id}", status_code=204, response_class=Response)
async def remove_session(session_id: int) -> Response:
    if not store.delete_session(session_id):
        raise HTTPException(status_code=404, detail=f"No session {session_id}.")
    return Response(status_code=204)


@app.post("/api/assistant/chat", response_model=ChatResponse)
async def chat(request: ChatRequest) -> ChatResponse:
    if "agent" not in state:
        raise HTTPException(
            status_code=503,
            detail=(
                "The language model is not available: "
                + state.get("provider_error", "unknown")
                + " Check /health for detail."
            ),
        )

    session_id = request.sessionId
    if session_id is None:
        session_id = store.create_session(
            title=None,
            user_id=request.userId,
            user_role=request.userRole,
            provider=CONFIG.provider,
            model=CONFIG.model_name,
        )
    elif not store.session_exists(session_id):
        raise HTTPException(status_code=404, detail=f"No session {session_id}.")

    snapshot = await ontology_snapshot()
    history = store.history_for_model(session_id)

    store.append_message(session_id, "user", request.message)

    agent: Agent = state["agent"]
    result = await agent.run(request.message, history, snapshot)

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
        provider=result.provider or CONFIG.provider,
        model=result.model or CONFIG.model_name,
        failoverReason=result.failover_reason,
    )


def main() -> None:
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=CONFIG.port, log_level="info")


if __name__ == "__main__":
    main()
