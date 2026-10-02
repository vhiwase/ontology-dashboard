"""The built-in planner: answers from the ontology when no language model is available.

A server with no Claude, OpenAI or Azure key and no GPU for a local model used
to have an assistant that could only say "the language model is not ready".
The planner is the rest of the product working anyway. It is a provider like
the others - it receives the conversation and returns either tool calls or an
answer - so it runs through the same agent loop, the same tools, the same
artifacts and the same transcript as a model would. What it does not do is
pretend to be one:

  * it decides nothing by itself: the feasibility check on the server says
    what is ready, what needs approval and what the data cannot answer;
  * every number in its answer is one a tool returned in this turn;
  * every answer ends with a line saying it came from the planner.

Its loop, one step per round:

  1. check_feasibility on the user's words
  2. build the dashboard or report, or execute the ready charts
  3. store the proposals that would make the rest possible (dependencies
     after the proposals they depend on)
  4. write the answer from what came back
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from .llm import LlmProvider, LlmReply, ToolCall

PLANNER_NOTE = (
    "_Answered by the built-in planner: no AI model is configured on this server, so this "
    "comes straight from the ontology's feasibility check and the metrics it ran. It handles "
    "requests like “revenue by country”, “orders per month”, “build a "
    "sales dashboard” and “what can I build?”._"
)

MAX_EXECUTIONS = 3
MAX_PROPOSALS = 6


@dataclass
class Step:
    name: str
    arguments: dict[str, Any]
    result: dict[str, Any] | None


@dataclass
class Turn:
    question: str
    steps: list[Step] = field(default_factory=list)

    def results(self, name: str) -> list[Step]:
        return [s for s in self.steps if s.name == name and s.result is not None]


def current_turn(messages: list[dict[str, Any]]) -> Turn:
    """The user's latest message and every tool call answered since."""
    last_user = max((i for i, m in enumerate(messages) if m.get("role") == "user"), default=-1)
    question = str(messages[last_user].get("content") or "") if last_user >= 0 else ""
    turn = Turn(question=question)
    by_id: dict[str, Step] = {}
    for message in messages[last_user + 1 :]:
        if message.get("role") == "assistant":
            for call in message.get("tool_calls") or []:
                function = call.get("function") or {}
                raw = function.get("arguments")
                try:
                    arguments = json.loads(raw) if isinstance(raw, str) else dict(raw or {})
                except json.JSONDecodeError:
                    arguments = {}
                step = Step(name=str(function.get("name")), arguments=arguments, result=None)
                by_id[str(call.get("id"))] = step
                turn.steps.append(step)
        elif message.get("role") == "tool":
            step = by_id.get(str(message.get("tool_call_id")))
            if step is not None:
                try:
                    step.result = json.loads(message.get("content") or "{}")
                except json.JSONDecodeError:
                    step.result = {"error": str(message.get("content"))}
    return turn


def _key(kind: str, payload: Any) -> str:
    return f"{kind}:{json.dumps(payload, sort_keys=True, default=str)}"


_call_counter = 0


def _call(name: str, arguments: dict[str, Any]) -> ToolCall:
    global _call_counter
    _call_counter += 1
    return ToolCall(id=f"planner_{_call_counter}", name=name, arguments=arguments)


# ── formatting ──────────────────────────────────────────────────────────────

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def format_value(value: Any, fmt: str | None, unit: str | None) -> str:
    if value is None:
        return "no value"
    try:
        number = float(value)
    except (TypeError, ValueError):
        return str(value)
    if fmt == "percent":
        return f"{number:,.1f}%"
    if fmt == "integer" or (number.is_integer() and abs(number) >= 1):
        text = f"{number:,.0f}"
    else:
        text = f"{number:,.2f}"
    return f"{text} {unit}" if unit and unit not in ("%",) else text


def format_period(label: str, grain: str | None) -> str:
    match = re.match(r"^(\d{4})-(\d{2})-(\d{2})", label or "")
    if not match or not grain:
        return label
    year, month, day = int(match[1]), int(match[2]), int(match[3])
    if grain == "year":
        return str(year)
    if grain == "quarter":
        return f"Q{(month - 1) // 3 + 1} {year}"
    if grain == "month":
        return f"{MONTHS[month - 1]} {year}"
    if grain == "week":
        return f"week of {day} {MONTHS[month - 1]} {year}"
    return f"{day} {MONTHS[month - 1]} {year}"


def describe_series(result: dict[str, Any]) -> str:
    """A sentence or two about one executed metric, from its numbers only."""
    label = result.get("label") or result.get("kpi")
    # "Total Revenue (Germany)": a narrowed figure says what it is narrowed to.
    limited = [
        ", ".join(str(v) for v in value) if isinstance(value, list) else str(value)
        for value in (result.get("filters") or {}).values()
    ]
    if limited:
        label = f"{label} ({'; '.join(limited)})"
    by = result.get("dimensionLabel")
    title = f"{label} by {by.lower()}" if by and not result.get("dimensionGrain") else label
    fmt, unit = result.get("format"), result.get("unit")
    series = [p for p in result.get("series") or [] if p.get("value") is not None]
    total = format_value(result.get("total"), fmt, unit)
    grain = result.get("dimensionGrain")
    # Parts of a sum or a count add up to the whole; parts of an average or a
    # distinct count do not, so those get no "in total" and no shares.
    additive = result.get("aggregation") in (None, "sum", "count")
    overall = "in total" if additive else "overall"
    if not series:
        return f"**{title}**: {total}."
    if grain:
        partial = result.get("partialPeriod")
        complete = [p for p in series if p["label"] != partial] or series
        first, last = series[0], complete[-1]
        peak = max(complete, key=lambda p: p["value"])
        text = (
            f"**{label}** per {grain}, {format_period(first['label'], grain)} to "
            f"{format_period(series[-1]['label'], grain)}: {total} {overall}. "
        )
        if peak is last:
            text += (
                f"The latest complete {grain}, {format_period(last['label'], grain)}, was also the highest "
                f"({format_value(last['value'], fmt, unit)})."
            )
        else:
            text += (
                f"The highest {grain} was {format_period(peak['label'], grain)} ({format_value(peak['value'], fmt, unit)}); "
                f"the latest complete {grain}, {format_period(last['label'], grain)}, came to {format_value(last['value'], fmt, unit)}."
            )
        if partial:
            text += (
                f" {format_period(partial, grain)} is still incomplete - the data runs to "
                f"{format_period(str(result.get('dataThrough') or ''), 'day')} - so it is not compared."
            )
        return text
    top = series[:3]
    whole = result.get("total")
    def share(p: dict[str, Any]) -> str:
        try:
            if additive and fmt != "percent" and whole and float(whole) > 0 and series[0]["value"] >= 0:
                return f", {float(p['value']) / float(whole) * 100:.0f}%"
        except (TypeError, ValueError, ZeroDivisionError):
            pass
        return ""
    tops = "; ".join(f"{p['label']} {format_value(p['value'], fmt, unit)}{share(p)}" for p in top)
    lead = "Largest" if additive else "Highest"
    return f"**{title}**: {total} {overall}. {lead}: {tops}."


# ── the planner ─────────────────────────────────────────────────────────────


class BuiltinPlanner(LlmProvider):
    name = "builtin"

    def __init__(self) -> None:
        self.model = "planner-1"

    async def health(self) -> dict[str, Any]:
        return {"reachable": True, "model": self.model, "modelPresent": True, "detail": None}

    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str = "auto",
    ) -> LlmReply:
        turn = current_turn(messages)
        can_call = bool(tools) and tool_choice != "none"
        calls = next_calls(turn) if can_call else []
        if calls:
            return LlmReply(content="", tool_calls=calls, provider=self.name, model=self.model)
        return LlmReply(content=compose_answer(turn), provider=self.name, model=self.model)


def next_calls(turn: Turn) -> list[ToolCall]:
    feasibility = turn.results("check_feasibility")
    if not feasibility:
        if not turn.question.strip():
            return []
        return [_call("check_feasibility", {"text": turn.question})]
    report = feasibility[-1].result or {}
    if "error" in report:
        return []
    intent = report.get("intent")
    items = report.get("items") or []

    # A dashboard or report: build it from the ready widgets, once.
    if intent in ("dashboard", "report") and report.get("layout") and not turn.results("create_dashboard"):
        return [
            _call(
                "create_dashboard",
                {
                    "title": report.get("title") or "Overview",
                    "description": f"Built from the request: {turn.question}"[:280],
                    "layout": report["layout"],
                    "kind": intent,
                    "sourcePrompt": turn.question,
                },
            )
        ]

    # Charts that are ready: run them so the answer quotes real numbers.
    if intent not in ("dashboard", "report", "capabilities"):
        done = {_run_key(s.arguments) for s in turn.results("execute_kpi")}
        ready = [
            item for item in items
            if item.get("status") == "ready" and item.get("kpi") and _run_key(item) not in done
        ][: max(0, MAX_EXECUTIONS - len(done))]
        if ready:
            return [
                _call(
                    "execute_kpi",
                    # A ranking shows its top twelve; a timeline shows every
                    # period the tool returns (its latest thirty). The values
                    # the question named ("in Germany") go along as filters.
                    {
                        "kpi": item["kpi"],
                        "dimension": item.get("dimension"),
                        **({"filters": item["filters"]} if item.get("filters") else {}),
                        **({} if ":" in str(item.get("dimension") or "") else {"limit": 12}),
                    },
                )
                for item in ready
            ]

    # Proposals: store what would make the rest possible, dependencies first.
    if intent == "capabilities":
        return []
    stored: dict[str, int] = {}
    for step in turn.results("propose_change"):
        proposal = (step.result or {}).get("proposal") or {}
        if proposal.get("id"):
            stored[_key(step.arguments.get("kind", ""), step.arguments.get("payload"))] = int(proposal["id"])
    attempted = {_key(s.arguments.get("kind", ""), s.arguments.get("payload")) for s in turn.steps if s.name == "propose_change"}
    calls: list[ToolCall] = []
    for item in items:
        if item.get("status") != "needs_approval":
            continue
        drafts = item.get("proposals") or []
        for draft in drafts:
            key = _key(draft.get("kind", ""), draft.get("payload"))
            if key in attempted or len(attempted) + len(calls) >= MAX_PROPOSALS:
                continue
            dependency_keys = [
                _key(drafts[d].get("kind", ""), drafts[d].get("payload")) for d in draft.get("dependsOn") or [] if d < len(drafts)
            ]
            if any(dep not in stored for dep in dependency_keys):
                continue  # next round, once its dependency has an id
            calls.append(
                _call(
                    "propose_change",
                    {
                        "kind": draft.get("kind"),
                        "payload": draft.get("payload"),
                        "title": draft.get("title"),
                        "summary": draft.get("summary"),
                        "dependsOn": [stored[dep] for dep in dependency_keys],
                        **({"followUp": draft["followUp"]} if draft.get("followUp") else {}),
                        "_via": "planner",
                    },
                )
            )
    return calls


def _run_key(source: dict[str, Any]) -> str:
    """One metric run: the metric, its slice and the values it is limited to."""
    return _key("run", {"kpi": source.get("kpi"), "dimension": source.get("dimension"), "filters": source.get("filters") or {}})


def compose_answer(turn: Turn) -> str:
    feasibility = turn.results("check_feasibility")
    if not feasibility:
        return "Ask me about your data - for example *orders by country*, *revenue per month*, or *build a dashboard*.\n\n" + PLANNER_NOTE
    report = feasibility[-1].result or {}
    if "error" in report:
        return f"I could not check that against your data: {report['error']}\n\n{PLANNER_NOTE}"
    intent = report.get("intent")
    items = report.get("items") or []
    proposals = [
        (s.result or {}).get("proposal") for s in turn.results("propose_change") if (s.result or {}).get("proposal")
    ]
    failed_proposals = [s for s in turn.results("propose_change") if "error" in (s.result or {})]
    parts: list[str] = []

    if intent == "capabilities":
        ready = [i for i in items if i.get("status") == "ready"]
        later = [i for i in items if i.get("status") == "needs_approval"]
        impossible = [i for i in items if i.get("status") == "not_possible"]
        if impossible and not ready:
            parts.append(impossible[0].get("explanation", ""))
        charts = [i for i in ready if (i.get("widget") or {}).get("type") == "chart"]
        figures = [i for i in ready if (i.get("widget") or {}).get("type") != "chart"]
        if charts:
            parts.append("**Ready to chart now** - ask for any of these by name:")
            parts.append("\n".join(f"- {(i.get('widget') or {}).get('title') or i.get('explanation')}" for i in charts[:12]))
        if figures:
            parts.append(
                "**Single figures:** "
                + ", ".join(str((i.get("widget") or {}).get("title") or i.get("kpi")) for i in figures[:12])
                + "."
            )
        if later:
            parts.append("**Possible after one approval** - ask for one and I will draft the change for you to approve:")
            parts.append("\n".join(f"- {i.get('explanation')}" for i in later[:8]))
        if ready:
            parts.append("Or ask for a whole board: *build a dashboard* or *write a report*.")
    elif intent in ("dashboard", "report"):
        created = turn.results("create_dashboard")
        board = created[-1].result if created else None
        if board and board.get("created"):
            noun = "report" if intent == "report" else "dashboard"
            parts.append(
                f"I built the {noun} **{board.get('title')}** from metrics that already exist in your "
                f"workspace: :resource[dashboard:{board.get('slug')}]"
            )
            layout = created[-1].arguments.get("layout") or []
            stats = [w.get("title") or w.get("kpi") for w in layout if w.get("type") == "stat"]
            charts = [w.get("title") or w.get("kpi") for w in layout if w.get("type") in ("chart", "table")]
            if stats:
                parts.append("Headline figures: " + ", ".join(str(t) for t in stats) + ".")
            if charts:
                parts.append("\n".join(f"- {t}" for t in charts))
            parts.append(
                "Open it to filter, drill in and export"
                + (", or print it as a PDF." if intent == "report" else ".")
            )
        elif board and "error" in board:
            parts.append(f"The board could not be saved: {board['error']}")
        elif not report.get("layout") and not any(i.get("status") == "needs_approval" for i in items):
            parts.append("There is nothing ready to put on a board yet.")
        extra = [i for i in items if i.get("status") != "ready"]
        for item in extra:
            parts.append(_item_sentence(item, turn))
    elif intent in ("link", "combination"):
        # A request to change the model: the explanation is the whole answer.
        for item in items:
            if item.get("status") == "not_possible":
                parts.append(_item_sentence(item, turn))
            else:
                parts.append(item.get("explanation", ""))
    else:
        for item in items:
            parts.append(_item_sentence(item, turn))

    if proposals:
        # Titles only: each proposal is shown in full on its approval card,
        # with the evidence, right under this answer.
        parts.append("**Waiting for your approval** (nothing changes until you approve):")
        parts.append("\n".join(f"- **{proposal.get('title')}**" for proposal in proposals))
        builds = [p.get("followUp") for p in proposals if p.get("followUp")]
        if builds:
            board = builds[-1]
            parts.append(f"Approve it below and the {board.get('build')} **{board.get('title')}** is built straight away.")
        else:
            them = "it" if len(proposals) == 1 else "them"
            parts.append(f"Approve {them} below, then ask again and the answer will be ready.")
    for step in failed_proposals:
        parts.append(f"A proposal could not be drafted: {(step.result or {}).get('error')}")

    parts.append("\n" + PLANNER_NOTE)
    return "\n\n".join(part for part in parts if part)


def _item_sentence(item: dict[str, Any], turn: Turn) -> str:
    status = item.get("status")
    request = item.get("request") or {}
    asked = request.get("text") or " ".join(
        str(v) for v in (request.get("measure"), "by" if request.get("dimension") else "", request.get("dimension")) if v
    )
    if status == "ready":
        for step in turn.results("execute_kpi"):
            if _run_key(step.arguments) == _run_key(item):
                if "error" in (step.result or {}):
                    return f"{item.get('explanation')} Running it failed: {step.result['error']}"
                return describe_series(step.result or {})
        return item.get("explanation", "")
    if status == "needs_approval":
        if any(d.get("followUp") for d in item.get("proposals") or []):
            return item.get("explanation", "")
        return f"**{asked or 'This'}** needs one more building block. {item.get('explanation', '')}"
    lines = [f"**Not possible with this data{f' ({asked})' if asked else ''}:** {item.get('explanation', '')}"]
    if item.get("missing"):
        lines.append("Missing: " + "; ".join(item["missing"]) + ".")
    if item.get("alternatives"):
        lines.append("You could ask instead: " + ", ".join(f"*{a}*" for a in item["alternatives"][:4]) + ".")
    return " ".join(lines)
