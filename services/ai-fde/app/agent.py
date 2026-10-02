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
from .context import current_session_state
from .llm import LlmError, LlmProvider, ToolCall, recover_text_tool_calls
from .modes import SessionAgentState, tools_for
from .prompts import SYSTEM_PROMPT, build_context_message
from .tools import TOOL_NAMES, run_tool, schemas_for, serialise_result

log = logging.getLogger("ai_fde.agent")

# Tools that change the platform. Their results are never served from the
# duplicate-call cache, and a successful one empties it, because a read made
# before it may no longer be true.
WRITE_TOOLS = frozenset(
    {
        "create_sync",
        "run_sync",
        "schedule_sync",
        "create_object_type",
        "create_link_type",
        "create_metric",
        "create_action_type",
        "delete_ontology_object",
        "propose_function",
        "create_dashboard",
        "apply_action",
        "notepad",
    }
)


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
    # Which provider and model actually answered.
    provider: str = ""
    model: str = ""


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
    # What the assistant built, one card per change, so the reply shows the
    # ontology growing rather than asking the reader to take the prose's word.
    if name == "create_object_type" and payload.get("created"):
        return {
            "kind": "ontologyChange",
            "change": "objectType",
            "apiName": payload.get("objectType"),
            "detail": f"{payload.get('objects')} objects from {payload.get('dataset')}",
        }
    if name == "create_link_type" and payload.get("created"):
        ratio = payload.get("matchRatio") or 0
        return {
            "kind": "ontologyChange",
            "change": "linkType",
            "apiName": payload.get("link"),
            "detail": f"{payload.get('matched')}/{payload.get('candidates')} resolve ({ratio:.0%})",
        }
    if name == "create_metric" and payload.get("created"):
        return {
            "kind": "ontologyChange",
            "change": "kpi",
            "apiName": payload.get("metric"),
            "detail": f"= {payload.get('value')} {payload.get('unit') or ''}".strip(),
        }
    if name == "create_action_type" and payload.get("created"):
        return {
            "kind": "ontologyChange",
            "change": "actionType",
            "apiName": payload.get("action"),
            "detail": f"on {payload.get('objectType')}",
        }
    if name == "create_sync" and payload.get("created"):
        run = payload.get("run") or {}
        return {
            "kind": "ontologyChange",
            "change": "dataset",
            "apiName": payload.get("dataset"),
            "detail": f"{run.get('rows', '?')} rows, {payload.get('schedule')}",
        }
    if name == "propose_function" and payload.get("functionProposed"):
        return {"kind": "functionProposal", "function": payload.get("function")}
    if name in ("generate_plan", "manage_plan") and payload.get("plan"):
        return {"kind": "plan", "plan": payload["plan"]}
    if name == "manage_todo_list":
        return {"kind": "todos", "todos": payload.get("todos") or []}
    if name == "change_mode" and payload.get("mode"):
        return {
            "kind": "modeChange",
            "mode": payload.get("mode"),
            "label": payload.get("label"),
        }
    return None


_CHANGE_NOUNS = {
    "dataset": "Synced",
    "objectType": "Created object type",
    "linkType": "Linked",
    "kpi": "Defined metric",
    "actionType": "Declared action",
}


def _summarise_changes(artifacts: list[dict[str, Any]]) -> str:
    """What a turn changed, as a Markdown list, from its artifacts."""
    lines = [
        f"- {_CHANGE_NOUNS.get(a.get('change') or '', 'Changed')} `{a.get('apiName')}` ({a.get('detail')})"
        for a in artifacts
        if a.get("kind") == "ontologyChange"
    ]
    lines += [
        f"- Proposed function `{(a.get('function') or {}).get('apiName')}`, awaiting approval"
        for a in artifacts
        if a.get("kind") == "functionProposal"
    ]
    return "\n".join(lines)


def _looks_temporal(dimension: str | None) -> bool:
    if not dimension:
        return False
    return any(token in dimension for token in ("date", "week", "month", "day"))


def _accumulate_usage(
    total: dict[str, Any], latest: dict[str, Any]
) -> dict[str, Any]:
    """Sum token counts across rounds, keeping non-numeric fields from the last.

    Providers do not all report the same keys: Azure sends totalTokens, others
    send prompt and completion counts plus a duration. totalTokens is therefore
    derived when it is missing, so a budget charged on it measures the same
    thing whichever provider answered.
    """
    merged = dict(total)
    for key, value in latest.items():
        if isinstance(value, (int, float)):
            merged[key] = (merged.get(key) or 0) + value
        else:
            merged[key] = value

    # Recomputed from the running prompt/completion totals every round rather
    # than derived once, so a provider that omits totalTokens on later rounds
    # cannot silently freeze the total at the first round's value.
    prompt = merged.get("promptTokens") or 0
    completion = merged.get("completionTokens") or 0
    if prompt or completion:
        merged["totalTokens"] = prompt + completion
    return merged


class Agent:
    def __init__(self, provider: LlmProvider) -> None:
        self.provider = provider

    async def run(
        self,
        user_message: str,
        history: list[dict[str, Any]],
        snapshot: dict[str, Any],
        state: SessionAgentState | None = None,
    ) -> AgentResult:
        started = time.monotonic()
        if state is None:
            # Every caller in main.py passes the session's state; the default
            # keeps the agent usable standalone (tests, one-off scripts).
            state = SessionAgentState()
        # The stateful tools reach the state through this contextvar rather
        # than arguments, exactly as the token and space travel.
        current_session_state.set(state)

        messages: list[dict[str, Any]] = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "system", "content": build_context_message(snapshot)},
        ]
        # Prior turns are replayed as plain text. Tool transcripts from earlier
        # turns are deliberately not replayed: they are large, and the model
        # re-derives what it needs far more cheaply than carrying them forward.
        messages.extend(history)
        messages.append({"role": "user", "content": user_message})

        invocations: list[ToolInvocation] = []
        artifacts: list[dict[str, Any]] = []
        # Accumulated across every round, not replaced by the last one. A turn
        # can spend AI_FDE_MAX_TOOL_ROUNDS model calls, and reporting only the
        # final round's counts understated the cost of exactly the turns that
        # cost the most - which is also what the chat token budget charges on.
        usage: dict[str, Any] = {}
        # Keyed on name + arguments, so a genuine second call with different
        # arguments still runs.
        cache: dict[str, dict[str, Any]] = {}
        stopped_because = "answered"
        rounds = 0
        provider_used = ""
        model_used = ""

        for round_index in range(CONFIG.max_tool_rounds):
            rounds = round_index + 1
            is_final_round = round_index == CONFIG.max_tool_rounds - 1

            # Recomputed every round, not fixed before the loop: change_mode
            # and enable_capabilities are meant to take effect mid-turn, so
            # the tool set the model sees has to track the state it mutates.
            schemas = None if is_final_round else schemas_for(tools_for(state))

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
                # The rounds already run spent real tokens and may have built
                # real things, so both are reported: the usage is recorded
                # against the user, and the reply says what was done before
                # the model stopped answering rather than only that it did.
                done = _summarise_changes(artifacts)
                return AgentResult(
                    content=(
                        f"I could not reach the language model: {exc}"
                        + (f"\n\nBefore it stopped answering I had done this:\n\n{done}" if done else "")
                    ),
                    tool_invocations=invocations,
                    artifacts=artifacts,
                    rounds=rounds,
                    usage=usage,
                    latency_ms=int((time.monotonic() - started) * 1000),
                    stopped_because="llm_error",
                    provider=provider_used,
                    model=model_used,
                )

            if reply.usage:
                usage = _accumulate_usage(usage, reply.usage)
            provider_used = reply.provider or provider_used
            model_used = reply.model or model_used

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
                if ok and call.name == "manage_context":
                    # Applied here, where the message list is in hand, and
                    # before the tool message is appended - so the model's
                    # own view of what was pruned is accurate.
                    self._apply_context_operations(state, messages, payload)
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

                # request_clarification is terminal. Feeding its result back and
                # continuing would mean the model answering the very question it
                # just said it could not answer, which is the guess the tool
                # exists to prevent. The turn ends and the question goes to the
                # user; their reply arrives as the next turn.
                if ok and call.name == "request_clarification":
                    return AgentResult(
                        content=payload.get("question", ""),
                        tool_invocations=invocations,
                        artifacts=[
                            *artifacts,
                            {
                                "kind": "clarification",
                                "question": payload.get("question", ""),
                                "options": payload.get("options", []),
                                "allowFreeText": payload.get("allowFreeText", True),
                            },
                        ],
                        rounds=rounds,
                        usage=usage,
                        latency_ms=int((time.monotonic() - started) * 1000),
                        stopped_because="needs_clarification",
                        provider=provider_used,
                        model=model_used,
                        )

                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call.id,
                        "name": call.name,
                        "content": serialise_result(payload),
                    }
                )

        done = _summarise_changes(artifacts)
        return AgentResult(
            content=(
                "I ran out of steps before finishing that. "
                + (
                    f"This much is done:\n\n{done}\n\nAsk me to carry on and I will pick up from here."
                    if done
                    else "Here is what I gathered: "
                    + ", ".join(f"{i.name}" for i in invocations[-4:])
                    + ". Ask me again more narrowly and I will get further."
                )
            ),
            tool_invocations=invocations,
            artifacts=artifacts,
            rounds=rounds,
            usage=usage,
            latency_ms=int((time.monotonic() - started) * 1000),
            stopped_because="round_budget_exhausted",
            provider=provider_used,
            model=model_used,
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
        if ok and call.name in WRITE_TOOLS:
            # Something changed, so every answer read before it may be stale:
            # list_object_types after create_object_type must see the new type.
            cache.clear()
        elif ok:
            cache[key] = payload
        log.info(
            "tool %s %s in %dms", call.name, "ok" if ok else "FAILED", duration_ms
        )
        return payload, ok, duration_ms

    def _apply_context_operations(
        self,
        state: SessionAgentState,
        messages: list[dict[str, Any]],
        payload: dict[str, Any],
    ) -> None:
        """Hide or restore tool results named by manage_context, in place.

        Hidden content is stashed on the turn's state keyed by tool_call id,
        so unhide restores exactly what was hidden and the message dicts
        themselves never carry extra keys - what reaches the provider stays
        strictly OpenAI-shaped. Hiding only ever matches results already in
        the transcript; the result of the manage_context call itself is
        appended afterwards and is always kept.
        """
        applied_hide: list[str] = []
        applied_unhide: list[str] = []

        for name in state.pending_hide:
            hidden = 0
            for message in messages:
                if (
                    message.get("role") == "tool"
                    and message.get("name") == name
                    and message["tool_call_id"] not in state.stashed
                ):
                    state.stashed[message["tool_call_id"]] = message["content"]
                    message["content"] = (
                        f"[hidden by manage_context: the {name} result was pruned "
                        "for the rest of this turn; call manage_context with "
                        f"unhide=[\"{name}\"] to restore it]"
                    )
                    hidden += 1
            if hidden:
                applied_hide.append(name)

        for name in state.pending_unhide:
            for message in messages:
                if (
                    message.get("role") == "tool"
                    and message.get("name") == name
                    and message["tool_call_id"] in state.stashed
                ):
                    message["content"] = state.stashed.pop(message["tool_call_id"])
                    applied_unhide.append(name)

        state.pending_hide = []
        state.pending_unhide = []
        payload["applied"] = {"hidden": applied_hide, "unhidden": applied_unhide}
