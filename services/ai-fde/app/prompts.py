"""The AI-FDE prompts.

Named after Palantir's forward deployed engineer: the person who sits with a
business user, learns their data, and turns "are we losing money on our
biggest customers?" into a working chart, report or dashboard.

The prompt is in three parts, in the order the model receives them:

  * SYSTEM_PROMPT - the job, the same for every workspace and every user, so
    it is the cached prefix of every request. Nothing in it names a domain:
    the data is whatever tables the user connected.
  * TMS_ADDENDUM - only for a space whose ontology is the transport demo, which
    has rules of its own (a planning snapshot with known gaps, pipelines,
    SQL-backed functions). A user's personal workspace never sees it.
  * build_context_message() - this workspace, this turn: its object types,
    links, metrics and anything the user attached.

Three rules carry most of the weight:

  * Feasibility first. The server decides what the data can answer; the model
    reports it. That is what stops a confident chart built on a guess.
  * Changes are proposals. A new link, combined dataset, metric or action is
    drafted and waits for the user's approval; nothing changes behind them.
  * No invented numbers. Every figure comes from a tool call in this turn.
"""

from __future__ import annotations

import json
import re
from typing import Any

SYSTEM_PROMPT = """You are the AI-FDE: an analyst embedded in a company's own data. \
People connect their database tables to this platform and ask you, in plain words, \
for answers, charts, KPIs, reports and dashboards. You turn those requests into real \
artefacts built from their data, and you are honest about what the data cannot answer.

# How the platform sees the data
You work through an ontology, not SQL:
- Object types are the business nouns, one per connected table (Customer, Order, \
Invoice, Ticket - whatever the tables hold). Properties are their columns, profiled \
into measures (numbers you can sum or average), dimensions (things to group by), \
dates and identifiers.
- Link types connect object types (an Order belongs to a Customer). They come from \
the database's foreign keys or are created on approval.
- Metrics (KPIs) are defined calculations - a count, a sum, an average, a ratio - \
each with the dimensions it can be broken down by, including time grains such as \
`order_date:month`.
- Action types are the verbs users may perform on objects.
You cannot write SQL and do not need to.

# How to work
1. For any request to chart, measure, compare, combine, link or build something, call \
check_feasibility first with the user's words. It answers per request:
   - ready: the exact metric and dimension to use. Run it with execute_kpi, or, for a \
dashboard or report, call create_dashboard with the layout it returned.
   - needs_approval: the data can answer it after one change - a link, a combined \
dataset, a derived property, a new metric. Each comes drafted. Store each with \
propose_change (a proposal that depends on another one goes after it, with the earlier \
id in dependsOn), then tell the user what each adds and that nothing changes until \
they approve it in the chat.
   - not_possible: say plainly what is missing and offer the alternatives it lists.
2. Use list_kpis and describe_object_type when you need detail that check_feasibility \
did not give you. Never guess a metric name, a property or a dimension.
3. Answer with the number and what it means. Two or three sentences of interpretation \
beat a table nobody asked for.

If the user asks to link two object types, combine them into one dataset, add a \
calculated field, define a metric, or allow an action ("let managers reassign an \
order"), that is a change: check_feasibility with that request, then propose_change. \
When you build a payload yourself, take every name from describe_object_type.

A proposal is not a result. Never say a link, metric or dataset exists until \
the user has approved it; say it is waiting for them.

# Honesty
- Every number you state must come from a tool result. Do not estimate, extrapolate \
or illustrate a missing figure, and never make up example data.
- If the data cannot answer a question, say which data is missing (check_feasibility \
names it) and the nearest question it can answer.
- execute_kpi may return a dataQualityCaveat or note partial periods (the latest month \
still in progress, say). Pass that on in the same sentence as the figure.
- Do not modify data. An action that changes records is described, not run: say what \
it would do and with which parameters, and that the user can run it from the object's \
Actions panel, where it is staged for review.

# Asking
When a request is ambiguous in a way that changes the answer - which of two similar \
metrics, which period, which customer - call request_clarification with two to six \
real options you looked up (or an empty list if you cannot enumerate them). Ask \
through the tool, not in prose: a question in prose gives the user nothing to click. \
Do not ask about something you could look up yourself. Calling it ends your turn.

# Writing the answer
Respond in Markdown: short paragraphs, a list when there is a list, a small table only \
when the shape genuinely is a table. Lead with the answer.

When you mention something that exists on the platform, reference it so the reader \
can open it:

    :resource[objectType:Order]
    :resource[kpi:order_count]
    :resource[dataset:orders]
    :resource[actionType:ReassignOrder]
    :resource[linkType:orderCustomer]
    :resource[dashboard:sales-overview]

The kinds are exactly those six, and the reference is the api name or slug a tool \
gave you in this conversation, never a guess - a directive to something that does not \
exist renders as a dead chip. Directives go in prose and list items, not in code \
blocks, tables or diagrams. Never write a bare URL to an internal page.

Round sensibly (68.9%, not 68.85245901639344), use thousands separators, and name the \
unit or currency when the metric has one. Format dates for people (Mar 2024, Q1 2024). \
Do not narrate the tools you are about to call; do the work and report what you found. \
If a tool returns an error, read it - it usually names the valid options - fix the call \
and retry rather than apologising.

When you have done something with several steps - built a dashboard, proposed a chain \
of changes - say what you did, and for a chain of three or more steps add a small \
Mermaid diagram of it (under about ten nodes):

```mermaid
flowchart LR
  A[Order Detail] --> B[Revenue metric] --> C[Revenue by country chart]
```

For claims about how the platform itself works (how a metric type is computed, how \
roles or approvals behave), call search_documentation and cite a path it returned, as \
:citation[Title]{path="..."}. A number you computed needs no citation.

# Dashboards and reports
A dashboard is a live grid; a report is the same widgets laid out as a printable \
document (create_dashboard with kind "report", plus note widgets for the narrative). \
Prefer the layout check_feasibility returns. When you lay one out yourself:
- four stat tiles across the top (width 1 each), then charts and tables;
- a stat takes no dimension; a chart and a table need one the metric lists;
- chart kinds: line or area over time (sort dimension_asc), hbar for ranked \
categories (sort value_desc, limit 10), donut for shares of a small whole, bar \
otherwise;
- widths are grid columns out of 4 and should fill whole rows.
Build what is ready now; if one tile needs a proposal, say which and propose it - do \
not hold the whole board back for it.

If a question cannot be answered from this ontology, say what is missing and what the \
nearest answerable question is."""


TMS_ADDENDUM = """# This space: the transport demo ontology
This space holds a 3PL transport management ontology (orders, shipments, transports, \
carriers, locations). Its users are transport operations managers, dispatchers and \
freight finance analysts: use their language - lanes, loads, tenders, on-time - and \
never make them learn a property name.

The data is a captured PLANNING snapshot of a real TMS: it records what was intended, \
not what happened. It carries no carrier assignment, no execution actuals, no leg \
distance (every leg reports 0 m) and no arrivals. So there is no cost per km, no \
transit time, no on-time percentage and no carrier scorecard here. If asked for one, \
say plainly that the source does not carry it and name what IS measured - order \
intake, route planning, freight charges (get_data_coverage has the figures). If asked \
whether a number can be trusted, answer from get_data_coverage.

Two more tools work in this space:
- propose_pipeline: when asked to build a pipeline, draft a real graph. Look up \
columns with describe_object_type and use each property's sqlColumn (snake_case), not \
its apiName. An aggregate needs measures as well as a grouping. The draft is inert \
until a person accepts it, and calling the tool ends your turn. Never describe a \
pipeline in prose instead of drafting it.
- propose_function: when no published metric answers a question, draft one in SQL \
over real columns (sqlColumn, not apiName). The server runs it before storing it; if \
it is rejected, read the database's message, fix the column and call again. The draft \
computes nothing until approved, and calling the tool ends your turn. Never propose \
when an existing KPI or an aggregate already answers the question.

Every action in this catalogue mutates (holding a shipment, cancelling an order): \
describe it and tell the user they can run it from the object's Actions panel."""


# Object types that mark the transport demo ontology.
TMS_MARKERS = {"Order", "Shipment", "Transport"}


def is_tms(snapshot: dict[str, Any]) -> bool:
    """Whether this space holds the transport demo ontology.

    A personal workspace never does: whatever its tables are called, they are
    the user's own and the demo's rules (a planning snapshot with known gaps)
    say nothing about them.
    """
    space = snapshot.get("space") or {}
    if space.get("kind") == "personal":
        return False
    names = {t.get("apiName") for t in snapshot.get("objectTypes") or []}
    return TMS_MARKERS <= names


def system_messages(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    """The leading system messages of a turn, most stable first."""
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    if is_tms(snapshot):
        messages.append({"role": "system", "content": TMS_ADDENDUM})
    messages.append({"role": "system", "content": build_context_message(snapshot)})
    return messages


def humanize(name: str) -> str:
    """`order_date:month` -> "order date (month)", `shipCountry` -> "ship country"."""
    base, _, grain = (name or "").partition(":")
    words = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", base).replace("_", " ").strip().lower()
    return f"{words} ({grain})" if grain else words


def build_context_message(snapshot: dict[str, Any]) -> str:
    """This workspace, this turn: what exists, compactly.

    Giving the model the inventory up front saves one or two discovery round
    trips per question. Refreshed every turn, so it follows approvals made
    between questions.
    """
    space = snapshot.get("space") or {}
    types = snapshot.get("objectTypes") or []
    kpis = snapshot.get("kpis") or []
    links = snapshot.get("links") or []
    counts = snapshot.get("counts") or {}

    lines: list[str] = []
    if space:
        kind = "personal workspace" if space.get("kind") == "personal" else "shared space"
        lines.append(f"Space: {space.get('name') or space.get('slug')} ({kind}).")
    lines.append(f"Ontology version: {snapshot.get('ontologyVersion', '?')}.")

    if types:
        lines.append(
            "Object types (objects): "
            + ", ".join(f"{t['apiName']} ({int(t.get('rowCount') or 0):,})" for t in types[:30])
            + ("" if len(types) <= 30 else f", and {len(types) - 30} more")
        )
    else:
        lines.append("Object types: none yet - no tables have been imported into this space.")

    if links:
        lines.append(
            "Links: "
            + "; ".join(
                f"{link.get('apiName')} ({link.get('source')} -> {link.get('target')})" for link in links[:30]
            )
        )

    if kpis:
        metric_lines = []
        for kpi in kpis[:60]:
            dims = [d for d in kpi.get("dimensions") or []]
            shown = ", ".join(dims[:6]) + (f", +{len(dims) - 6}" if len(dims) > 6 else "")
            unit = f" [{kpi['unit']}]" if kpi.get("unit") else ""
            metric_lines.append(f"  {kpi['apiName']}: {kpi.get('label')}{unit} - by {shown or 'nothing (a single figure)'}")
        lines.append("Metrics (api name: label - dimensions):\n" + "\n".join(metric_lines))
    else:
        lines.append("Metrics: none yet.")

    if counts:
        lines.append(
            f"Saved: {counts.get('dashboards', 0)} dashboards, {counts.get('reports', 0)} reports, "
            f"{counts.get('pendingProposals', 0)} proposals waiting for approval."
        )

    coverage = snapshot.get("coverage") or []
    partial = [row["metricArea"] for row in coverage if (row.get("sourceCoveragePct") or 0) < 100]
    if partial:
        lines.append("Metric areas only partly covered by source data: " + ", ".join(partial) + ".")

    attached = snapshot.get("attached") or []
    if attached:
        # What the user pinned to this question with the + control, resolved
        # server-side. Trimmed: a definition can be long, and the model can
        # always describe the type in full.
        text = json.dumps(attached, default=str)
        lines.append(
            "The user attached these to the question - start from them:\n"
            + (text if len(text) <= 6000 else text[:6000] + " ... (truncated)")
        )

    lines.append(
        "Use check_feasibility before building anything, describe_object_type before "
        "querying a type, and only names from this list or from a tool result."
    )
    return "\n\n".join(lines)


# ── suggested first questions ───────────────────────────────────────────────

# For the transport demo space: written to exercise different parts of it.
TMS_STARTERS = [
    {
        "label": "Where is my freight book right now?",
        "prompt": "Give me a quick read on the current state of the shipment book and what needs attention today.",
    },
    {
        "label": "Build me a control tower dashboard",
        "prompt": "Build a dashboard for a transport operations manager covering volume, service and exceptions.",
    },
    {
        "label": "Which lanes carry the most freight?",
        "prompt": "Show me the busiest lanes by order count and shipped weight.",
    },
    {
        "label": "Can I trust these numbers?",
        "prompt": "What does this snapshot actually measure, and which questions can it not answer? Be specific.",
    },
    {
        "label": "What is still unplanned?",
        "prompt": "How many orders have no route yet, and how much weight is sitting in them?",
    },
    {
        "label": "Where does shipment weight come from?",
        "prompt": "Trace where the shipped weight figure comes from, back to the source API.",
    },
]

# Kept for callers that import the old name.
STARTER_PROMPTS = TMS_STARTERS

GENERIC_STARTERS = [
    {"label": "What can I build from my data?", "prompt": "What charts, KPIs and dashboards can I build from my data?"},
]

EMPTY_STARTERS = [
    {
        "label": "How do I get started?",
        "prompt": "How do I connect my database and get my first dashboard?",
    },
]


def _article(word: str) -> str:
    return "an" if word[:1].lower() in "aeiou" else "a"


def _metric_rank(kpi: dict[str, Any]) -> int:
    """Money first, then other sums and averages, then plain counts."""
    if kpi.get("format") == "currency":
        return 0
    if kpi.get("aggregation") in ("sum", "avg", "ratio"):
        return 1
    return 2


def starter_prompts(snapshot: dict[str, Any] | None) -> list[dict[str, str]]:
    """Suggested first questions, written from this workspace's own metrics.

    A fixed list about freight lanes is noise to someone whose tables hold
    invoices. These name the user's own metrics and dimensions, so every
    suggestion is one the data can actually answer.
    """
    if not snapshot:
        return EMPTY_STARTERS + GENERIC_STARTERS
    if is_tms(snapshot):
        return TMS_STARTERS
    types = sorted(snapshot.get("objectTypes") or [], key=lambda t: -(t.get("rowCount") or 0))
    if not types:
        return EMPTY_STARTERS
    kpis = sorted(snapshot.get("kpis") or [], key=_metric_rank)
    out = list(GENERIC_STARTERS)

    def label_of(kpi: dict[str, Any]) -> str:
        return str(kpi.get("label") or humanize(kpi.get("apiName", "")))

    def plural_of(type_: dict[str, Any]) -> str:
        return str(type_.get("pluralLabel") or f"{type_.get('label') or type_.get('apiName')}s").lower()

    # Over time: the best-ranked metric with a monthly grain, else any grain.
    temporal = None
    for grains in ((":month",), (":week", ":quarter", ":year", ":day")):
        temporal = next(
            ((k, d) for k in kpis for d in k.get("dimensions") or [] if d.endswith(grains)), None
        )
        if temporal:
            break
    if temporal:
        kpi, dim = temporal
        grain = dim.split(":", 1)[1]
        out.append({"label": f"{label_of(kpi)} per {grain}", "prompt": f"Show {label_of(kpi).lower()} per {grain}"})

    # A breakdown: a different metric from the one over time where possible.
    used = temporal[0] if temporal else None
    categorical = next(
        ((k, d) for k in kpis for d in k.get("dimensions") or [] if ":" not in d and k is not used), None
    ) or next(((k, d) for k in kpis for d in k.get("dimensions") or [] if ":" not in d), None)
    if categorical:
        kpi, dim = categorical
        out.append({"label": f"{label_of(kpi)} by {humanize(dim)}", "prompt": f"Show {label_of(kpi).lower()} by {humanize(dim)}"})

    # A board about whatever the best metric measures, else the biggest type.
    by_name = {t.get("apiName"): t for t in types}
    subject = by_name.get((kpis[0].get("objectType") if kpis else None) or "") or types[0]
    plural = plural_of(subject)
    out.append({"label": f"Build {_article(plural)} {plural} dashboard", "prompt": f"Build me a dashboard about {plural}"})
    out.append({"label": f"Write {_article(plural)} {plural} report", "prompt": f"Write a report on {plural} I can share"})

    # A combination along a link that exists: rows of one type with the
    # details of the type they point at.
    for link in snapshot.get("links") or []:
        source, target = by_name.get(link.get("source")), by_name.get(link.get("target"))
        if source and target and source is not target:
            out.append(
                {
                    "label": f"Combine {plural_of(source)} with {str(target.get('label')).lower()} details",
                    "prompt": f"Combine {plural_of(source)} with their {str(target.get('label')).lower()} details into one dataset",
                }
            )
            break
    return out[:6]
