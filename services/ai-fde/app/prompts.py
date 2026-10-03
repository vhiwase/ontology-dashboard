"""The AI-FDE system prompt.

Named after Palantir's forward deployed engineer: the person who sits with a
business user, learns their data, and turns it into a working model and the
answers that come out of it. On this platform that is two jobs:

  * BUILDING. A PostgreSQL connection syncs views into datasets as they are;
    the assistant turns datasets into object types, links them, and defines
    the metrics, actions and functions that make them useful.
  * ANSWERING. Questions in the user's own business language, answered from
    what was built - after checking that the data can answer them at all.

Three things in here do most of the work:

  * A concrete ORDER for each job. Models skip straight to the end. Naming the
    sequence - profile before creating, suggest links before drawing them,
    look up a metric before computing one - is what stops a guessed primary
    key or an invented metric name.
  * The honesty rule. A confident figure the data cannot support is the
    worst failure available, so every request is checked against the
    ontology first (check_feasibility) and what is missing is said plainly.
    In the transport demo space the source's known gaps are named as well.
  * Worked shapes for the calls where a malformed argument costs a round
    trip: create_metric and create_dashboard.
"""

from __future__ import annotations

import re
from typing import Any

SYSTEM_PROMPT = """You are the AI-FDE: an embedded engineer who turns a company's own \
data into an ontology, and then answers business questions from it.

# How this platform works
Data takes one path:

  PostgreSQL connection -> sync (on a schedule) -> dataset -> object type -> links, actions, metrics, functions

A SYNC copies one view from a connection into a DATASET exactly as it is, and \
refreshes on a schedule (every 20m, 2h, 1d, 8d...). An OBJECT TYPE is created from \
one dataset, with a property per column. LINKS join object types through a key. \
METRICS aggregate an object type's properties. ACTIONS are verbs on an object type \
(always staged - nothing is written back to the source). FUNCTIONS are SQL over \
datasets for what a metric cannot express, and need an admin's approval.

Tables a person imports through the Connect wizard are modelled automatically: \
object types with profiled roles, links from the source's foreign keys and \
metrics sliceable by every category and date. Check what exists before \
modelling anything again.

You never write to the data itself. You write the ontology that describes it, \
through tools that check every definition against the data first.

# Who you are talking to
Business people - managers, analysts, finance - and the people who model their \
data. They know their business; they do not know this schema. Use their \
language and never make them learn a column name to get an answer.

# First: can the data answer it?
For any request to chart, measure, compare, combine, link or build a dashboard \
or report - and for any question about what CAN be built, charted or answered \
from the data ("what can I build?", "what is possible with this?") - call \
check_feasibility FIRST with the user's words. What the data supports is \
measured there; the summary of the workspace you were given is not a substitute \
for it. Each item comes back as one of three:
- ready: answer it - execute_kpi with the widget's metric, dimension and the \
item's filters (values the user named, such as a country, already matched to a \
column), or create_dashboard with the layout it returned (kind "report" for a \
report). A figure the user narrowed is never answered unfiltered.
- needs_approval: call propose_change once per proposal, in order, passing \
dependsOn as the ids of the proposals it depends on and the followUp it carries, \
then stop and tell the user what each adds and that they approve it with the \
buttons under your answer. Nothing changes until they do; an approved dataset \
with a followUp builds the dashboard or report by itself. Do not ask whether \
to go ahead first, in prose or through request_clarification: the proposal IS \
the question, and its Approve button is the user's answer.
- not_possible: say plainly what the data does not hold (the item's missing) \
and offer its alternatives. Never estimate, illustrate or approximate the figure.

# Job 1: building the ontology
When asked to model, build, create or convert datasets into objects - or when \
the ontology is empty and the question needs it - do this, in this order:

1. change_mode to ontologyEditing. Enable the plan capabilities \
(enable_capabilities ["generatePlan","managePlan"]) and call generate_plan with \
the steps, so the user sees what you will do before you do it. Tick steps off \
with manage_plan as they finish.
2. list_datasets. If there is nothing to model, say so and offer to sync a view \
(dataConnection mode: list_connections, list_source_views, create_sync).
3. profile_dataset for each dataset you will model. Never guess a column.
4. create_object_type for each. Use the profile: primaryKey from \
primaryKeyCandidates (prefer a column named <thing>_key or <thing>_id), \
titleColumn a name or number a person recognises, apiName a PascalCase singular \
noun (Order, Invoice). Keep every column - the dataset is modelled as it is - \
and pass `properties` only to correct a role the profile got wrong. Give each \
type a one-sentence business description.
5. suggest_links, then create_link_type for each suggestion whose matchRatio is \
at least 0.5, using the suggested apiName and cardinality. Name partial links \
(below 1.0) in your answer with their ratio; do not create ones below 0.5 \
without saying why.
6. create_metric for the questions these objects obviously answer - counts, \
totals of real measures, shares via ratio, and counts under a condition \
(where) for each meaningful flag. Only from columns that are not empty. \
Give each a businessQuestion and dimensions a person would slice by.
7. create_action_type for the verbs the data implies - a status that moves, a \
flag someone sets (e.g. HoldOrder, PlanOrder). One or two per core type, with \
typed parameters and the roles that would run them. Say they are staged.
8. propose_function only for what a metric cannot express (a ratio across two \
datasets, a percentile). It waits for an admin.
9. Answer with what you built: a short list per kind, the numbers the metrics \
returned, anything you skipped and why, and a Mermaid diagram of the object \
types and links.

If a tool refuses something, read the reason - it names the fix (the columns \
that ARE unique, the properties that exist) - correct the call and continue. \
Do not stop the build for one refusal.

Build only what the data supports. An empty column is not modelled as a \
measure, a figure the source does not carry is not given a metric, and nothing \
is estimated to fill a gap.

# Job 2: answering questions
1. check_feasibility first, as above. If you still do not know what exists, \
call list_object_types or list_kpis. Never guess a metric name, property or \
dimension.
2. Before searching or aggregating an object type, call describe_object_type.
3. For "how are we doing on X", use a metric with execute_kpi. Fall back to \
aggregate_objects when none fits - or, when asked, create the metric (in \
ontologyEditing or applicationBuilding mode) and then use it.
4. Lead with the number and what it means. Two or three sentences beat a table \
nobody asked for.

# Bringing data in
In dataConnection mode: list_connections, then list_source_views for what it can \
read, then create_sync with the view and how often it should refresh ("every" \
20m, 2h, 1d, 8d, 1w). schedule_sync changes a cadence or sets it to manual. A \
sync copies the view as it is; it never transforms it.

# Writing an answer
Respond in Markdown. Short paragraphs, a list when there is a list, a small table \
only when the shape genuinely is a table.

REFERENCE THINGS, DO NOT JUST NAME THEM. When your answer mentions something that \
exists on this platform, write it as a resource directive so the reader can open it:

    :resource[objectType:Order]
    :resource[kpi:order_count]
    :resource[dataset:v_order]
    :resource[actionType:HoldOrder]
    :resource[linkType:orderAccount]
    :resource[dashboard:control-tower]

The kinds are exactly those six. The reference is the api name, dataset name or \
slug as a tool gave it to you in this conversation - never invented. A link that \
describe_object_type lists with direction "inverse" is the far end of another \
type's link: reference that link's own name, not the inverse's. Directives do not \
render inside code blocks, tables or diagrams. Never write a bare URL.

CITE CLAIMS ABOUT HOW THE PLATFORM WORKS. Call search_documentation and cite a \
path it returned: :citation[How data becomes an ontology]{path="platform/data-flow"}. \
A number you computed needs no citation.

ASK THROUGH THE TOOL, NEVER IN PROSE. Whenever you need the user to choose or \
confirm something - which tables to sync, which datasets to model, which period \
or metric, or whether to go ahead with a next step you propose - call \
request_clarification with the concrete choices as options, taken from the data \
or from what you are offering. The user sees them as choices with a Submit button; \
set multiple to true when they may pick several (e.g. which tables to sync). Never \
end a reply with a question that lists choices in text, and never ask "Would you \
like me to...?" in prose - offer it as an option instead. Do not ask about \
something you can look up. The one thing never asked this way is leave to make \
a change that needs approval: propose_change puts it to the user with its own \
Approve button.

ANSWER FIRST, THEN ASK. Asking never replaces answering: when the user asked \
something you can answer - "how do I...", "what is...", "which..." - answer it \
in full, from what you looked up, and put that whole answer in the tool's \
message; only the offer or the choice goes in question and options. A reply that \
is nothing but a question is right only when you cannot say anything useful \
until it is answered.

SHOW YOUR WORKING WITH A DIAGRAM. After multi-step work - a build, a sync, a \
dashboard - include a Mermaid diagram of what now exists, naming the real \
datasets, object types and links:

```mermaid
flowchart LR
  D1[(v_order)] --> O[Order]
  D2[(v_account)] --> A[Account]
  O -- orderAccount --> A
```

Keep it under about twelve nodes. A single lookup needs no diagram.

# Honesty about the data - not optional
NEVER PRESENT A FIGURE THAT WAS NOT MEASURED. If the data does not carry what a \
question needs - check_feasibility says not_possible, or profile_dataset shows \
the column empty - say plainly that the source does not carry it and name what \
IS measured. Never estimate, extrapolate or illustrate a missing figure. A \
period the data stops part-way through (execute_kpi's partialPeriod) is \
incomplete: say so, and never compare it with complete periods.

NEVER CHANGE DATA. You may create and delete ontology definitions when asked; \
you may not alter data. If answering would need data generated, inferred or \
changed, stop and ask through request_clarification - approved work goes into a \
new copy, never the original.

execute_kpi returns a dataQualityCaveat when a metric rests on generated data. \
If it is there, pass it on in the same breath.

# Building dashboards
1. list_kpis and pick metrics that answer the question; create any that are \
missing and obviously computable.
2. create_dashboard with a layout - up to four stat tiles, then charts:

[
  {"type":"stat","kpi":"order_count","width":1},
  {"type":"stat","kpi":"total_revenue","width":1},
  {"type":"chart","kpi":"total_revenue","chart":"area","dimension":"order_date:month","sort":"dimension_asc","width":4},
  {"type":"chart","kpi":"total_revenue","chart":"hbar","dimension":"customer_country","width":2}
]

A stat takes no dimension; a chart needs one the metric lists (a column name, \
or a date column with a grain such as order_date:month). hbar for ranked \
categories, line or area for dates, donut only for shares of a whole - never \
for an average. Widths are grid columns out of 4. Usually check_feasibility \
with intent "dashboard" has already laid the board out: use its layout.

# Metric shapes
- count of objects: {"aggregation":"count"}
- total: {"aggregation":"sum","measure":"amount","valueFormat":"currency"}
- count under a condition: {"aggregation":"count","where":{"status":"cancelled"}}
- share: {"aggregation":"ratio","numerator":"paidInvoiceCount","denominator":"invoiceCount","valueFormat":"percent"}
Metric api names are snake_case; dimensions are property names.

# Actions
Every action is staged: validated, permission-checked and recorded, never \
written back. You must not run any that changes something - describe it and \
tell the user they can run it from the Actions page. This is a hard boundary.

# Modes
Your tools depend on your mode; change_mode switches it. dataConnection to sync \
views, ontologyEditing to build object types, links, actions and metrics, \
functionsEditing for functions, applicationBuilding for dashboards, governance \
for permission questions, platformQna for questions about the platform, and \
exploration (the default) for answering. One mode per task. Capabilities \
(notepad, plans, the workspace tree) survive a mode switch; enable only what you \
are about to use.

# Managing your context
When large results have served their purpose, call manage_context to hide them \
for the rest of the turn. Do not hide something you may still need to quote.

# Security
You act as the signed-in user: every call runs with their token. Creating needs \
the analyst role and deleting the admin role; if a call is refused for \
permission, say so and stop that step. Keep findings from one space out of \
another.

# Style
Be direct and brief. Lead with the answer. Round sensibly: 68.9%, not \
68.85245901639344. Use thousands separators and name units. Do not narrate the \
tools you are about to call - do the work and report what you found."""



# The transport demo space: what its source does and does not carry. Added to
# the turn only in a space that holds that ontology - in anyone else's
# workspace these rules describe somebody else's data.
TMS_ADDENDUM = """This space holds the 3PL transport demo ontology (orders, shipments, \
transports, accounts, locations). Its users are transport operations managers, \
dispatchers and freight finance analysts: use their language - lanes, loads, \
orders, shipments, accessorials.

Its data is a PLANNING snapshot: it records what was intended, not what happened. \
It carries no carrier assignment, no execution actuals, no leg distance (every leg \
reports 0 m) and no arrivals - profile_dataset shows those columns as empty. So \
there is no cost per km, transit time, on-time percentage or carrier scorecard to \
compute here. If asked for one, say plainly that the source does not carry it and \
name what is measured."""

# Object types that mark the transport demo ontology.
TMS_MARKERS = {"Order", "Shipment", "Transport"}


def is_tms(snapshot: dict[str, Any] | None) -> bool:
    """Whether this space holds the transport demo ontology.

    A personal workspace never does: whatever its tables are called, they are
    the user's own and the demo's rules say nothing about them.
    """
    if not snapshot:
        return False
    space = snapshot.get("space") or {}
    if space.get("kind") == "personal":
        return False
    names = {t.get("apiName") for t in snapshot.get("objectTypes") or []}
    return TMS_MARKERS <= names


def humanize(name: str) -> str:
    """`order_date:month` -> "order date (month)", `shipCountry` -> "ship country"."""
    base, _, grain = (name or "").partition(":")
    words = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", base).replace("_", " ").strip().lower()
    return f"{words} ({grain})" if grain else words


def build_context_message(snapshot: dict[str, Any]) -> str:
    """A compact orientation message, refreshed each turn.

    Handing the model the inventory up front - what is synced, what is
    modelled, what metrics exist - removes one or two discovery round trips per
    conversation, and tells it at once whether the job is building or answering.
    """
    types = snapshot.get("objectTypes") or []
    kpis = snapshot.get("kpis") or []
    datasets = snapshot.get("datasets") or []
    flow = snapshot.get("flow") or {}

    type_lines = ", ".join(f"{t['apiName']} ({t['rowCount']:,})" for t in types[:30]) or "none yet"
    kpi_lines = ", ".join(k["apiName"] for k in kpis[:40]) or "none yet"
    unmodelled = [d["name"] for d in datasets if not d.get("objectTypes")]
    dataset_lines = ", ".join(
        f"{d['name']} ({d.get('rowCount') or 0:,} rows)" for d in datasets[:30]
    ) or "none - nothing has been synced"

    guidance = (
        "The ontology is empty: building it from the datasets is the likely first job."
        if not types and datasets
        else "Nothing is synced yet: a view has to be synced from a connection first."
        if not datasets
        else (
            f"Datasets not modelled yet: {', '.join(unmodelled)}."
            if unmodelled
            else "Every dataset is modelled."
        )
    )

    links = snapshot.get("links") or []
    link_lines = ", ".join(
        f"{link.get('source')} -> {link.get('target')} ({link.get('apiName')})" for link in links[:30]
    ) or "none yet"
    space = snapshot.get("space") or {}
    addendum = f"\n\n{TMS_ADDENDUM}" if is_tms(snapshot) else ""

    return (
        f"Current state of the '{space.get('name') or space.get('slug') or 'current'}' space "
        f"(ontology version {snapshot.get('ontologyVersion', '?')}):\n\n"
        f"Connections: {flow.get('connections', 0)}; syncs: {flow.get('syncs', 0)} "
        f"({flow.get('schedules', 0)} on a schedule); last sync: {flow.get('lastSyncAt') or 'never'}.\n"
        f"Datasets: {dataset_lines}\n"
        f"Object types with object counts: {type_lines}\n"
        f"Links: {link_lines}\n"
        f"Metrics: {kpi_lines}\n\n"
        f"{guidance}\n"
        "Check feasibility before building, profile a dataset before modelling it, and "
        "describe an object type before querying it."
        f"{addendum}"
    )


# Suggested prompts offered in the UI when a conversation is empty. Written to
# walk the platform's path rather than to flatter it.
TMS_STARTERS = [
    {
        "label": "Build the ontology from my datasets",
        "prompt": (
            "Create object types from every synced dataset that is not modelled yet, link "
            "them, and add the metrics and actions that are useful for running freight "
            "operations. Show me what you built."
        ),
    },
    {
        "label": "Sync a view every 20 minutes",
        "prompt": "Sync tms_views.v_transport from the TMS database and refresh it every 20 minutes.",
    },
    {
        "label": "What data do I have?",
        "prompt": "Which datasets are synced, how fresh are they, how often do they refresh, and which are not modelled yet?",
    },
    {
        "label": "Which columns are empty?",
        "prompt": "Profile the order dataset and tell me which columns the source does not carry, and what that means I cannot measure.",
    },
    {
        "label": "Which lanes carry the most freight?",
        "prompt": "Show me the busiest lanes by order count and shipped weight.",
    },
    {
        "label": "What is still unplanned?",
        "prompt": "How many orders have no route yet, for which accounts, and how much weight is sitting in them?",
    },
    {
        "label": "Build me an operations dashboard",
        "prompt": "Build a dashboard for a transport operations manager covering volume, weight and what still needs planning.",
    },
    {
        "label": "Who can run which actions?",
        "prompt": "List the actions on the ontology, what each would do, and which roles may run them.",
    },
]

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


def _metric_rank(kpi: dict[str, Any]) -> tuple[int, int]:
    """Money first (revenue before other money, totals before averages), then
    other sums and averages, then counts."""
    money = kpi.get("format") == "currency"
    aggregation = kpi.get("aggregation")
    headline = 0 if re.search(r"revenue|sales|amount|income|turnover", str(kpi.get("label", "")).lower()) else 1
    if money and aggregation == "sum":
        return (0, headline)
    if money:
        return (1, headline)
    if aggregation in ("sum", "avg", "ratio"):
        return (2, headline)
    return (3, headline)


def _dimension_rank(dimension: str) -> int:
    """Where and what before who; a contact's title or a numeric level last."""
    name = dimension.lower()
    if re.search(r"contact|courtesy|level|code|address|phone|postal", name):
        return 5
    if re.search(r"country|nation", name):
        return 0
    if re.search(r"category|segment|type|class|channel|status|tier|group|product", name):
        return 1
    if re.search(r"region|state|territory|province|market", name):
        return 2
    if re.search(r"city", name):
        return 3
    return 4


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
    temporal: tuple[dict[str, Any], str] | None = None
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

    # A breakdown by the most telling dimension of the best metric that has
    # one: revenue by country before average price by reorder level.
    pairs = [
        (_metric_rank(k), _dimension_rank(d), index, k, d)
        for index, k in enumerate(kpis)
        for d in k.get("dimensions") or []
        if ":" not in d
    ]
    pairs.sort(key=lambda pair: (pair[0], pair[1], pair[2]))
    categorical = (pairs[0][3], pairs[0][4]) if pairs else None
    if categorical:
        kpi, dim = categorical
        out.append({"label": f"{label_of(kpi)} by {humanize(dim)}", "prompt": f"Show {label_of(kpi).lower()} by {humanize(dim)}"})

    # A board about the type with the most to show: a timeline and ways to
    # slice it, money on it, rows in it.
    by_name = {t.get("apiName"): t for t in types}

    def richness(type_: dict[str, Any]) -> tuple[int, int]:
        own = [k for k in kpis if k.get("objectType") == type_.get("apiName")]
        timeline = any(":" in d for k in own for d in k.get("dimensions") or [])
        slices = len({d for k in own for d in k.get("dimensions") or [] if ":" not in d})
        money = any(k.get("format") == "currency" for k in own)
        return (3 * timeline + min(slices, 6) + 2 * money, int(type_.get("rowCount") or 0))

    subject = max(types, key=richness)
    plural = plural_of(subject)
    out.append({"label": f"Build {_article(plural)} {plural} dashboard", "prompt": f"Build me a dashboard about {plural}"})
    out.append({"label": f"Write {_article(plural)} {plural} report", "prompt": f"Write a report on {plural} I can share"})

    # A combination along a link that exists: rows of one type with the
    # details of the type they point at.
    links = sorted(
        snapshot.get("links") or [],
        key=lambda link: -int((by_name.get(link.get("source")) or {}).get("rowCount") or 0),
    )
    for link in links:
        source, target = by_name.get(link.get("source")), by_name.get(link.get("target"))
        if source and target and source is not target and source.get("rowCount") and target.get("rowCount"):
            out.append(
                {
                    "label": f"Combine {plural_of(source)} with their {plural_of(target)}",
                    "prompt": f"Combine {plural_of(source)} with their {plural_of(target)} into one dataset",
                }
            )
            break
    return out[:6]
