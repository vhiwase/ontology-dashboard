"""The agent loop.

A bounded tool-calling loop: ask the model, run whatever tools it asked for, feed
the results back, repeat until it answers or the round budget runs out.

What is deliberate here:

  * ROUND BUDGET. Capped at AI_FDE_MAX_TOOL_ROUNDS. On the last round the tools are
    withdrawn and the model is told to answer from what it already has, which
    turns "gave up after 8 loops" into a real answer built on partial information.

  * DUPLICATE CALL DETECTION. A small model will happily call
    list_object_types three times in one turn. Repeats are served from a cache with
    a note saying so, which breaks the loop without discarding the turn.

  * TOOL ERRORS GO BACK TO THE MODEL. The service's error messages name the valid
    options, so a failed call is usually recoverable in one retry. That only works
    if the error reaches the model instead of the user.

  * ARTEFACTS ARE COLLECTED SEPARATELY. When the model builds a dashboard or runs a
    KPI, the structured result is attached to the reply so the UI can render a real
    chart next to the prose instead of the user reading numbers out of a paragraph.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

from .config import CONFIG
from .llm import LlmError, LlmProvider, ToolCall, recover_text_tool_calls
from .prompts import SYSTEM_PROMPT, build_context_message
from .tools import TOOL_NAMES, run_tool, serialise_result, tool_schemas

log = logging.getLogger("ai_fde.agent")


@dataclass
class ToolInvocation:
    name: str
    arguments: dict[str, Any]
    ok: bool
    duration_ms: int
    result_preview: str
    result: dict[str, Any] = field(repr=False, default_factory=dict)


@dataclass
class AgentResult:
    content: str
    tool_invocations: list[ToolInvocation] = field(default_factory=list)
    artifacts: list[dict[str, Any]] = field(default_factory=list)
    rounds: int = 0
    usage: dict[str, Any] = field(default_factory=dict)
    latency_ms: int = 0
    stopped_because: str = "answered"
    # Which provider and model actually answered, and why the primary was not used.
    provider: str = ""
    model: str = ""
    failover_reason: str | None = None


def _artifact_from(name: str, arguments: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any] | None:
    """Turn a tool result the UI can render into an artifact descriptor."""
    if name == "execute_kpi" and payload.get("series"):
        return {
            "kind": "chart",
            "kpi": payload.get("kpi"),
            "title": payload.get("label"),
            "dimension": payload.get("dimension"),
            "unit": payload.get("unit"),
            "format": payload.get("format"),
            "total": payload.get("total"),
            "series": payload.get("series"),
            "caveat": payload.get("dataQualityCaveat"),
            # A ranked category list reads far better horizontally; a date series
            # reads as a line. Picking here means the assistant does not have to.
            "chart": "line" if _looks_temporal(payload.get("dimension")) else "hbar",
        }
    if name == "create_dashboard" and payload.get("created"):
        return {
            "kind": "dashboard",
            "slug": payload.get("slug"),
            "title": payload.get("title"),
            "widgets": payload.get("widgets"),
            "url": payload.get("url"),
        }
    if name in ("search_objects", "aggregate_objects", "traverse_link") and payload.get("rows"):
        return {
            "kind": "table",
            "title": payload.get("objectType") or payload.get("linkedObjectType") or "Results",
            "rows": payload["rows"][:20],
            "rowsTotal": payload.get("rowsTotal"),
        }
    if name == "apply_action" and payload.get("result"):
        return {
            "kind": "action",
            "action": payload.get("action"),
            "status": payload.get("status"),
            "result": payload.get("result"),
        }
    if name == "get_lineage":
        return {
            "kind": "lineage",
            "subject": payload.get("subject"),
            "upstreamByLayer": payload.get("upstreamByLayer"),
            "sourceColumnCount": payload.get("sourceColumnCount"),
        }
    return None


def _looks_temporal(dimension: str | None) -> bool:
    if not dimension:
        return False
    return any(token in dimension for token in ("date", "week", "month", "day"))


class Agent:
    def __init__(self, provider: LlmProvider) -> None:
        self.provider = provider

    async def run(
        self,
        user_message: str,
        history: list[dict[str, Any]],
        snapshot: dict[str, Any],
    ) -> AgentResult:
        started = time.monotonic()

        messages: list[dict[str, Any]] = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "system", "content": build_context_message(snapshot)},
        ]
        # Prior turns are replayed as plain text. Tool transcripts from earlier
        # turns are deliberately not replayed: they are large, and the model
        # re-derives what it needs far more cheaply than carrying them forward.
        messages.extend(history)
        messages.append({"role": "user", "content": user_message})

        schemas = tool_schemas()
        invocations: list[ToolInvocation] = []
        artifacts: list[dict[str, Any]] = []
        usage: dict[str, Any] = {}
        # Keyed on name + arguments, so a genuine second call with different
        # arguments still runs.
        cache: dict[str, dict[str, Any]] = {}
        stopped_because = "answered"
        rounds = 0
        provider_used = ""
        model_used = ""
        failover_reason: str | None = None

        for round_index in range(CONFIG.max_tool_rounds):
            rounds = round_index + 1
            is_final_round = round_index == CONFIG.max_tool_rounds - 1

            if is_final_round:
                messages.append(
                    {
                        "role": "system",
                        "content": (
                            "This is your last step and no more tools are available. "
                            "Answer now from what you already have. If something is "
                            "missing, say what and why, and answer the part you can."
                        ),
                    }
                )

            try:
                reply = await self.provider.chat(messages, None if is_final_round else schemas)
            except LlmError as exc:
                return AgentResult(
                    content=f"I could not reach the language model: {exc}",
                    tool_invocations=invocations,
                    artifacts=artifacts,
                    rounds=rounds,
                    latency_ms=int((time.monotonic() - started) * 1000),
                    stopped_because="llm_error",
                )

            if reply.usage:
                usage = reply.usage
            provider_used = reply.provider or provider_used
            model_used = reply.model or model_used
            failover_reason = reply.failover_reason or failover_reason

            content = reply.content
            calls = list(reply.tool_calls)
            if not calls and content:
                # Recover a tool call the model wrote as text rather than emitting
                # through the tool channel.
                content, recovered = recover_text_tool_calls(content, TOOL_NAMES)
                if recovered:
                    log.info("Recovered %d tool call(s) from message text.", len(recovered))
                    calls = recovered

            if not calls:
                return AgentResult(
                    content=content.strip()
                    or "I did not manage to produce an answer for that. Try rephrasing it?",
                    tool_invocations=invocations,
                    artifacts=artifacts,
                    rounds=rounds,
                    usage=usage,
                    latency_ms=int((time.monotonic() - started) * 1000),
                    stopped_because=stopped_because,
                    provider=provider_used,
                    model=model_used,
                    failover_reason=failover_reason,
                )

            messages.append(
                {
                    "role": "assistant",
                    "content": content,
                    "tool_calls": [
                        {
                            "id": call.id,
                            "type": "function",
                            "function": {
                                "name": call.name,
                                "arguments": json.dumps(call.arguments),
                            },
                        }
                        for call in calls
                    ],
                }
            )

            for call in calls:
                payload, ok, duration_ms = await self._invoke(call, cache)
                invocations.append(
                    ToolInvocation(
                        name=call.name,
                        arguments=call.arguments,
                        ok=ok,
                        duration_ms=duration_ms,
                        result_preview=serialise_result(payload)[:240],
                        result=payload,
                    )
                )
                if ok:
                    artifact = _artifact_from(call.name, call.arguments, payload)
                    if artifact:
                        artifacts.append(artifact)

                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call.id,
                        "name": call.name,
                        "content": serialise_result(payload),
                    }
                )

        return AgentResult(
            content=(
                "I ran out of steps before finishing that. Here is what I gathered: "
                + ", ".join(f"{i.name}" for i in invocations[-4:])
                + ". Ask me again more narrowly and I will get further."
            ),
            tool_invocations=invocations,
            artifacts=artifacts,
            rounds=rounds,
            usage=usage,
            latency_ms=int((time.monotonic() - started) * 1000),
            stopped_because="round_budget_exhausted",
            provider=provider_used,
            model=model_used,
            failover_reason=failover_reason,
        )

    async def _invoke(
        self, call: ToolCall, cache: dict[str, dict[str, Any]]
    ) -> tuple[dict[str, Any], bool, int]:
        key = f"{call.name}:{json.dumps(call.arguments, sort_keys=True, default=str)}"
        if key in cache:
            # Served from cache with a note, which is what stops a model looping on
            # the same call without throwing the turn away.
            cached = dict(cache[key])
            cached["_note"] = (
                "You already called this with these arguments in this turn; this is the "
                "same result. Use it rather than calling again."
            )
            return cached, True, 0

        started = time.monotonic()
        payload, ok = await run_tool(call.name, call.arguments)
        duration_ms = int((time.monotonic() - started) * 1000)
        if ok:
            cache[key] = payload
        log.info(
            "tool %s %s in %dms", call.name, "ok" if ok else "FAILED", duration_ms
        )
        return payload, ok, duration_ms
