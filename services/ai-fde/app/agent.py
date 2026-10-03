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

  * ONE CHECK IS NOT LEFT TO THE MODEL. "What can I build?" is run through the
    feasibility check before the model is asked anything (see
    asks_what_can_be_built), so the answer is what the data was measured to
    support and not a recital of the inventory.

  * A PROMISED APPROVAL HAS TO EXIST. An answer that tells the user to approve
    a proposal the turn never made is sent back once, to make it (see
    proposals_promised_but_not_made). So is a question that only asks leave to
    make one (proposals_asked_about_instead_of_made): the proposal's Approve
    button is how that is asked.
"""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any

from .clarify import asks_something, closing_passage
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

# "What can I build?", "what charts and KPIs can we make from my data?",
# "what's possible with this?" - narrower than the feasibility service's own
# reading of the same question (detectIntent in feasibility.ts), which also
# takes "what can I see/do": here a wrong match costs an unasked-for check.
_ASKS_WHAT_IS_POSSIBLE = re.compile(
    r"\b(what|which)\b[^?.!]{0,80}?\b(can|could)\s+(i|we|you)\s+(build|chart|make|create|measure|plot|visuali[sz]e)\b"
    r"|\bwhat('s|\u2019s| is) possible\b"
    r"|\bwhat (can|could) (my|our|this|the) data\b",
    re.IGNORECASE,
)


def asks_what_can_be_built(message: str) -> bool:
    """Whether the user is asking what their data can be turned into.

    The model is handed the workspace's inventory every turn, and answers this
    question from it: a fluent list of object types that says nothing about
    which charts are ready now, which are one approval away and which the data
    cannot support. Telling it to check first was not enough - it had what
    looked like the answer already. So for this one question the feasibility
    check is run before the model is asked, and it answers from the result.
    """
    return bool(_ASKS_WHAT_IS_POSSIBLE.search(message))


_SPEAKS_OF_APPROVING = re.compile(r"\bapprov(e|es|ed|al|ing)\b", re.IGNORECASE)
_ASKS_TO_GO_AHEAD = re.compile(r"\b(approv\w*|proceed|go ahead|create|build)\b", re.IGNORECASE)


def drafts_not_proposed(invocations: list["ToolInvocation"]) -> int:
    """Proposals this turn's feasibility checks drafted and nothing has made.

    check_feasibility only DRAFTS what a request needs; propose_change is what
    puts a draft in front of the user, with its Approve button. Zero once the
    turn has made a proposal, or when none was drafted.
    """
    if any(invocation.ok and invocation.name == "propose_change" for invocation in invocations):
        return 0
    drafted = 0
    for invocation in invocations:
        if not (invocation.ok and invocation.name == "check_feasibility"):
            continue
        for item in invocation.result.get("items") or []:
            if isinstance(item, dict) and item.get("status") == "needs_approval":
                drafted += len(item.get("proposals") or [])
    return drafted


def proposals_promised_but_not_made(content: str, invocations: list["ToolInvocation"]) -> int:
    """How many drafted proposals a reply tells the user to approve but never made.

    A model will sometimes describe the draft, write "approve it below" and
    stop - and there is nothing below. Or it closes by asking, in prose,
    whether it should go ahead and create it. Zero when the reply does
    neither, or there is nothing it left unmade.
    """
    text = content or ""
    asks_leave = asks_something(text) and _ASKS_TO_GO_AHEAD.search(closing_passage(text))
    if not (_SPEAKS_OF_APPROVING.search(text) or asks_leave):
        return 0
    return drafts_not_proposed(invocations)


def proposals_asked_about_instead_of_made(question: dict[str, Any], invocations: list["ToolInvocation"]) -> int:
    """How many drafted proposals a clarifying question asks permission to make.

    "Shall I create the combined dataset and build the dashboard?" is a
    question the proposal already asks, with a button: putting it to the user
    first makes them say yes twice, and gives them choices where the Approve
    button should be. A question about anything else - which period, which of
    two measures - is the user's to answer and is not counted.
    """
    labels = " ".join(
        str(option.get("label", "")) if isinstance(option, dict) else str(option)
        for option in question.get("options") or []
    )
    if not _ASKS_TO_GO_AHEAD.search(f"{question.get('question', '')} {labels}"):
        return 0
    return drafts_not_proposed(invocations)


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
            "dimensionLabel": payload.get("dimensionLabel"),
            "dimensionGrain": payload.get("dimensionGrain"),
            "partialPeriod": payload.get("partialPeriod"),
            "dataThrough": payload.get("dataThrough"),
            "unit": payload.get("unit"),
            "format": payload.get("format"),
            "total": payload.get("total"),
            "series": payload.get("series"),
            "caveat": payload.get("dataQualityCaveat"),
            # A ranked category list reads far better horizontally; a date series
            # reads as a line. Picking here means the assistant does not have to.
            "chart": "line" if payload.get("dimensionGrain") or _looks_temporal(payload.get("dimension")) else "hbar",
        }
    if name == "create_dashboard" and payload.get("created"):
        return {
            "kind": "dashboard",
            "slug": payload.get("slug"),
            "title": payload.get("title"),
            "widgets": payload.get("widgets"),
            "url": payload.get("url"),
            # "dashboard" or "report": the UI opens a report in its document view.
            "boardKind": payload.get("kind") or "dashboard",
        }
    if name == "check_feasibility" and isinstance(payload.get("items"), list):
        # What the data can answer, what is one approval away, and what not -
        # the UI renders it as a checklist with the drafted proposals attached.
        return {
            "kind": "feasibility",
            "intent": payload.get("intent"),
            "subject": payload.get("subject"),
            "summary": payload.get("summary"),
            "items": [
                {
                    "status": item.get("status"),
                    "explanation": item.get("explanation"),
                    "request": item.get("request"),
                    "kpi": item.get("kpi"),
                    "dimension": item.get("dimension"),
                    "missing": item.get("missing"),
                    "alternatives": item.get("alternatives"),
                }
                for item in payload["items"][:24]
            ],
        }
    if name == "propose_change" and payload.get("proposal"):
        proposal = payload["proposal"]
        return {
            "kind": "proposal",
            "proposal": {
                key: proposal.get(key)
                for key in ("id", "kind", "status", "title", "summary", "dependsOn", "payload")
            },
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


def clarification_reply(payload: dict[str, Any], written: str | None) -> str:
    """The text of a turn that ends by asking: what there was to say, then the question.

    A question must not cost the person the answer that came with it. "How do
    I create this dataset?" deserves the how, and then the offer to do it - so
    whatever the model gave the tool as its message (or wrote beside the call)
    stays in the reply, with the question after it. The choices are shown by
    the UI from the clarification artifact; the text is what the next turn's
    model reads back as what it said.
    """
    question = str(payload.get("question") or "").strip()
    said = str(payload.get("message") or written or "").strip()
    return f"{said}\n\n{question}" if said and said != question else question


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
        # Whether the model has already been sent back once to make the
        # proposals its answer spoke of (proposals_promised_but_not_made).
        reminded = False

        if asks_what_can_be_built(user_message):
            await self._preflight(
                ToolCall(
                    id="preflight_check_feasibility",
                    name="check_feasibility",
                    arguments={"text": user_message, "intent": "capabilities"},
                ),
                messages,
                invocations,
                artifacts,
                cache,
            )

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
                # An answer that says "approve it below" over nothing: sent
                # back once, with what is missing, while there are still tools
                # to make it with. Whatever comes back the second time stands.
                missing = 0 if (reminded or is_final_round) else proposals_promised_but_not_made(content, invocations)
                if missing:
                    reminded = True
                    log.info("Reply promised an approval with no proposal made; asking for %d.", missing)
                    messages.append({"role": "assistant", "content": content})
                    messages.append(
                        {
                            "role": "system",
                            "content": (
                                "Your reply tells the user to approve something, but nothing exists for them "
                                f"to approve: check_feasibility drafted {missing} proposal(s) and "
                                "propose_change was never called, so there is no Approve button under your "
                                "answer. Call propose_change now - once per drafted proposal, in order, "
                                "passing dependsOn and the followUp each one carries - and then answer "
                                "again, briefly."
                            ),
                        }
                    )
                    continue
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
                # A question that only asks leave to make a proposal is not put
                # to the user: the answer goes back to the model instead, once,
                # saying to make the proposal. Its Approve button is the asking.
                put_to_user = ok and call.name == "request_clarification"
                if put_to_user and not reminded and not is_final_round:
                    pending = proposals_asked_about_instead_of_made(payload, invocations)
                    if pending:
                        reminded = True
                        put_to_user = False
                        log.info("Clarification asked leave to make %d drafted proposal(s); sent back.", pending)
                        payload = {
                            "asked": False,
                            "note": (
                                "This question was NOT put to the user. check_feasibility drafted "
                                f"{pending} proposal(s) for this request, and a proposal is how the user "
                                "is asked: it appears under your answer with its own Approve button and "
                                "changes nothing until they press it. Call propose_change now - once per "
                                "drafted proposal, in order, passing dependsOn and the followUp each one "
                                "carries - then tell the user what each adds. Ask a question only if "
                                "something other than whether to go ahead is unclear."
                            ),
                        }
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
                if put_to_user:
                    return AgentResult(
                        content=clarification_reply(payload, content),
                        tool_invocations=invocations,
                        artifacts=[
                            *artifacts,
                            {
                                "kind": "clarification",
                                "question": payload.get("question", ""),
                                "options": payload.get("options", []),
                                "multiple": payload.get("multiple", False),
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

    async def _preflight(
        self,
        call: ToolCall,
        messages: list[dict[str, Any]],
        invocations: list[ToolInvocation],
        artifacts: list[dict[str, Any]],
        cache: dict[str, dict[str, Any]],
    ) -> None:
        """Run one tool before the first model round, as if the model had asked.

        The call and its result go into the transcript in the shape a model's
        own tool call takes, so the model reads it as work already done, and
        the result is recorded and turned into an artifact like any other. A
        call that fails leaves no trace: the model is then asked as usual, and
        may make the call itself.
        """
        payload, ok, duration_ms = await self._invoke(call, cache)
        if not ok:
            log.info("preflight %s did not run: %s", call.name, str(payload.get("error", ""))[:200])
            return
        messages.append(
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": call.id,
                        "type": "function",
                        "function": {"name": call.name, "arguments": json.dumps(call.arguments)},
                    }
                ],
            }
        )
        messages.append(
            {
                "role": "tool",
                "tool_call_id": call.id,
                "name": call.name,
                "content": serialise_result(payload),
            }
        )
        invocations.append(
            ToolInvocation(
                name=call.name,
                arguments=call.arguments,
                ok=True,
                duration_ms=duration_ms,
                result_preview=serialise_result(payload)[:240],
                result=payload,
            )
        )
        artifact = _artifact_from(call.name, call.arguments, payload)
        if artifact:
            artifacts.append(artifact)

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
