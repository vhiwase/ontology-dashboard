"""The assistant's tools: its entire access to the platform.

Two families live here. The domain tools call the ontology service with the
signed-in user's token: the assistant has no database connection and cannot
write SQL against the platform, so what it can do is exactly what that user can
do through the API - and every write it makes is checked by the same rules a
person's form is. The capability tools (modes, plans, notepad, context
management - the assistant managing itself, per the Palantir AI-FDE prompt)
live in capability_tools.py and are merged into the same registry below.

The domain tools follow the platform's one path:

    connection -> sync (scheduled) -> dataset -> object type -> links,
                                                 actions, metrics, functions

Two design decisions that shape everything here:

RESULTS ARE TRIMMED FOR CONTEXT, NOT FOR TRUTH. A 500-row object search would
swamp the context and push the ontology description out of it. Tools cap rows
and say so explicitly in the payload ("showing 20 of 738"), so the model knows
it is looking at a sample and can say so too.

ERRORS ARE RETURNED, NOT RAISED. A tool that fails hands the model the error
text and, where the service provided one, the list of valid alternatives. That
turns a dead turn into a self-correction: asked for a primary key that is not
unique, the model is told which columns are, and retries.
"""

from __future__ import annotations

import json
import logging
from urllib.parse import quote
from typing import Any, Callable, Awaitable

# The client, the error types and the shared instance live in their own module
# so the capability tools (modes, plans, notepad) can reach the ontology
# through the same client without importing this module and its registry.
from .capability_tools import CAPABILITY_TOOL_SCHEMAS, CAPABILITY_TOOLS
from .context import current_session, current_session_state
from .modes import tools_for
from .ontology_client import (  # noqa: F401 - re-exported for existing imports
    NoOntologyInSpace,
    OntologyClient,
    ToolError,
    client,
)

log = logging.getLogger("ai_fde.tools")

# Row caps per tool. Chosen so a full turn of tool results stays inside a
# context window a hosted model with a large tool schema handles comfortably.
MAX_OBJECT_ROWS = 20
MAX_AGGREGATE_ROWS = 25
MAX_SERIES_POINTS = 30
MAX_CATALOGUE_ROWS = 80


def _truncate(rows: list[Any], cap: int, total: int | None = None) -> dict[str, Any]:
    """Wrap rows with an explicit note about what was left out."""
    shown = rows[:cap]
    actual_total = total if total is not None else len(rows)
    payload: dict[str, Any] = {"rows": shown, "rowsShown": len(shown), "rowsTotal": actual_total}
    if actual_total > len(shown):
        payload["note"] = (
            f"Showing {len(shown)} of {actual_total} rows. Say so if you quote these, "
            "or narrow the query with a filter."
        )
    return payload


def _clean(values: dict[str, Any]) -> dict[str, Any]:
    """Drop keys the model left empty, so the service applies its defaults."""
    return {key: value for key, value in values.items() if value not in (None, "", [], {})}


# ── reading the ontology ────────────────────────────────────────────────────

async def list_object_types(_: dict[str, Any]) -> dict[str, Any]:
    types = await client.get("/api/object-types")
    return {
        "objectTypes": [
            {
                "apiName": t["apiName"],
                "label": t["label"],
                "objects": t["rowCount"],
                "properties": t["propertyCount"],
                "measures": t["measureCount"],
                "links": t["linkCount"],
                "dataset": t["sourceView"],
                "description": t["description"],
            }
            for t in types
        ],
        "note": None
        if types
        else "No object types yet. They are created from datasets: see list_datasets.",
    }


async def describe_object_type(arguments: dict[str, Any]) -> dict[str, Any]:
    api_name = str(arguments.get("objectType") or arguments.get("apiName") or "")
    if not api_name:
        raise ToolError("objectType is required.")
    detail = await client.get(f"/api/object-types/{quote(api_name)}")
    # Properties are grouped by semantic role rather than listed flat: the model
    # needs to know what it may aggregate versus group by, and a flat list of 70
    # properties does not convey that. The column is included because a
    # function's SQL, a metric's condition and a link are written against it.
    by_role: dict[str, list[dict[str, Any]]] = {}
    for prop in detail["properties"]:
        by_role.setdefault(prop["semanticRole"], []).append(
            {
                "apiName": prop["apiName"],
                "column": prop["sqlColumn"],
                "type": prop["datatype"],
                **({"unit": prop["unit"]} if prop.get("unit") else {}),
                **(
                    {"aggregate": prop["defaultAggregation"]}
                    if prop.get("defaultAggregation")
                    else {}
                ),
            }
        )
    return {
        "apiName": detail["apiName"],
        "label": detail["label"],
        "description": detail["description"],
        "objects": detail["rowCount"],
        "dataset": detail["sourceView"],
        "propertiesByRole": by_role,
        "links": [
            {
                "apiName": link["apiName"],
                "label": link["label"],
                "to": link["targetObjectType"],
                "direction": link["direction"],
                "complete": link["isVerified"],
                "matchRatio": link["matchRatio"],
            }
            for link in detail["links"]
        ],
        "actions": [
            {
                "apiName": action["apiName"],
                "label": action["label"],
                "readOnly": action["isReadOnly"],
                "requiresApproval": action["requiresApproval"],
            }
            for action in detail["actions"]
        ],
        "metrics": [k["apiName"] for k in detail["kpis"]],
    }


async def search_objects(arguments: dict[str, Any]) -> dict[str, Any]:
    api_name = str(arguments.get("objectType") or "")
    if not api_name:
        raise ToolError("objectType is required.")
    body = {
        "where": arguments.get("where") or [],
        "search": arguments.get("search"),
        "orderBy": arguments.get("orderBy") or [],
        "select": arguments.get("select") or [],
        "limit": min(int(arguments.get("limit") or MAX_OBJECT_ROWS), MAX_OBJECT_ROWS),
        "includeLinkTitles": True,
    }
    result = await client.post(f"/api/objects/{quote(api_name)}/search", body)
    payload = _truncate(result["data"], MAX_OBJECT_ROWS, result["totalCount"])
    payload["objectType"] = result["objectType"]
    payload["matchingObjects"] = result["totalCount"]
    return payload


async def aggregate_objects(arguments: dict[str, Any]) -> dict[str, Any]:
    api_name = str(arguments.get("objectType") or "")
    if not api_name:
        raise ToolError("objectType is required.")
    metrics = arguments.get("metrics") or [{"aggregation": "count", "alias": "count"}]
    body = {
        "groupBy": arguments.get("groupBy") or [],
        "metrics": metrics,
        "where": arguments.get("where") or [],
        "orderBy": arguments.get("orderBy"),
        "limit": min(int(arguments.get("limit") or MAX_AGGREGATE_ROWS), MAX_AGGREGATE_ROWS),
    }
    result = await client.post(f"/api/objects/{quote(api_name)}/aggregate", body)
    payload = _truncate(result["rows"], MAX_AGGREGATE_ROWS)
    payload["objectType"] = result["objectType"]
    payload["groupBy"] = result["groupBy"]
    return payload


async def traverse_link(arguments: dict[str, Any]) -> dict[str, Any]:
    api_name = str(arguments.get("objectType") or "")
    key = str(arguments.get("objectKey") or "")
    link = str(arguments.get("linkApiName") or "")
    if not (api_name and key and link):
        raise ToolError("objectType, objectKey and linkApiName are all required.")
    result = await client.get(
        f"/api/objects/{quote(api_name)}/{quote(key)}/links/{quote(link)}",
        params={"limit": MAX_OBJECT_ROWS},
    )
    payload = _truncate(result["data"], MAX_OBJECT_ROWS, result["totalCount"])
    payload["linkedObjectType"] = result["targetObjectType"]
    payload["linkLabel"] = result["label"]
    if result["matchRatio"] < 0.999:
        payload["incompleteLinkWarning"] = (
            f"This link resolves only {result['matchRatio'] * 100:.0f}% of references, "
            "so some related objects cannot be reached through it."
        )
    return payload


async def list_kpis(arguments: dict[str, Any]) -> dict[str, Any]:
    catalogue = await client.get("/api/kpis/catalogue")
    category = arguments.get("category")
    categories = sorted({k["category"] for k in catalogue})
    if category:
        catalogue = [k for k in catalogue if k["category"] == str(category).lower()]
    return {
        "kpis": catalogue,
        "categories": categories,
        "note": None if catalogue else "No metrics yet. create_metric defines one over an object type.",
    }


async def execute_kpi(arguments: dict[str, Any]) -> dict[str, Any]:
    api_name = str(arguments.get("kpi") or arguments.get("apiName") or "")
    if not api_name:
        raise ToolError("kpi is required.")
    dimension = arguments.get("dimension")
    sort = arguments.get("sort") or None
    # A timeline cut to its first thirty periods would answer "per month" with
    # the oldest months of the data. Asked newest-first and put back in time
    # order, it ends at the latest period instead.
    latest_first = bool(dimension and ":" in str(dimension) and sort in (None, "dimension_asc"))
    body = {
        "dimension": dimension,
        "filters": arguments.get("filters") or {},
        "limit": min(int(arguments.get("limit") or MAX_SERIES_POINTS), MAX_SERIES_POINTS),
        # Unset lets the service choose: time order for a date grain, largest
        # first for a category. Forcing value_desc scrambled every timeline.
        "sort": "dimension_desc" if latest_first else sort,
        "totalOnly": bool(arguments.get("totalOnly")),
    }
    result = await client.post(f"/api/kpis/{quote(api_name)}/execute", body)
    if latest_first:
        result["series"] = list(reversed(result["series"]))
    payload: dict[str, Any] = {
        "kpi": result["kpi"],
        "label": result["label"],
        "total": result["total"],
        "unit": result["unit"],
        "format": result["valueFormat"],
        "dimension": result["dimension"],
        "dimensionLabel": result.get("dimensionLabel"),
        "dimensionGrain": result.get("dimensionGrain"),
        # Whether the parts add up to the total: a breakdown of a sum or a
        # count does; one of an average or a distinct count does not.
        "aggregation": result.get("aggregation"),
        "series": result["series"][:MAX_SERIES_POINTS],
        # The metric's own conditions ("completed orders only"), so the
        # figure is described with them.
        "conditions": result.get("conditions") or {},
        # The caller's filters, as applied: a narrowed figure is described as one.
        "filters": result.get("appliedFilters") or {},
        "target": result["target"],
        "higherIsBetter": result["higherIsBetter"],
    }
    if result.get("partialPeriod"):
        # Said where the number is, so the newest period is not read as a fall.
        payload["partialPeriod"] = result["partialPeriod"]
        payload["dataThrough"] = result.get("dataThrough")
        payload["periodNote"] = (
            f"The data runs to {result.get('dataThrough')}, so the period starting "
            f"{result['partialPeriod']} is incomplete. Say so if you quote it, and do "
            "not compare it with complete periods."
        )
    # The caveat travels with the number so it cannot be quoted without it.
    if result["dependsOnSimulation"]:
        payload["dataQualityCaveat"] = result["coverageNote"] or (
            "This metric is flagged as resting on generated data, not measured data."
        )
    if len(result["series"]) > MAX_SERIES_POINTS:
        payload["note"] = f"Showing the top {MAX_SERIES_POINTS} of {len(result['series'])} groups."
    return payload


async def list_dashboards(_: dict[str, Any]) -> dict[str, Any]:
    dashboards = await client.get("/api/dashboards")
    return {
        "dashboards": [
            {
                "slug": d["slug"],
                "title": d["title"],
                "description": d["description"],
                "widgets": len(d["layout"]),
                "aiGenerated": d["isAiGenerated"],
                "audience": d["audience"],
            }
            for d in dashboards
        ]
    }


async def create_dashboard(arguments: dict[str, Any]) -> dict[str, Any]:
    title = str(arguments.get("title") or "").strip()
    layout = arguments.get("layout")
    if not title:
        raise ToolError("title is required.")
    if not isinstance(layout, list) or not layout:
        raise ToolError(
            "layout must be a non-empty array of widgets. Each widget needs a type "
            "(stat, chart, table or note) and, unless it is a note, a kpi api name."
        )

    # Validate before saving so a rejection comes back as a correctable list of
    # problems rather than a 400 the model has to guess at.
    validation = await client.post("/api/dashboards/validate", {"layout": layout})
    if not validation["valid"]:
        raise ToolError(
            "This layout is not valid yet:\n- "
            + "\n- ".join(validation["errors"])
            + "\nFix these and call create_dashboard again."
        )

    saved = await client.post(
        "/api/dashboards",
        {
            "title": title,
            "description": arguments.get("description"),
            "layout": validation["widgets"],
            "audience": arguments.get("audience"),
            "isAiGenerated": True,
            "sourcePrompt": arguments.get("sourcePrompt"),
            "createdBy": "ai-fde",
            "isPinned": False,
            "kind": "report" if arguments.get("kind") == "report" else "dashboard",
            "chatSessionId": current_session.get(),
        },
    )
    return {
        "created": True,
        "kind": saved.get("kind", "dashboard"),
        "slug": saved["slug"],
        "title": saved["title"],
        "widgets": len(saved["layout"]),
        "url": f"/dashboards/{saved['slug']}",
        "message": (
            f"Dashboard '{saved['title']}' saved with {len(saved['layout'])} widgets. "
            "It is now in the Dashboards section of the UI."
        ),
    }


async def list_actions(_: dict[str, Any]) -> dict[str, Any]:
    actions = await client.get("/api/action-types")
    return {
        "actions": [
            {
                "apiName": a["apiName"],
                "label": a["label"],
                "description": a["description"],
                "readOnly": a["isReadOnly"],
                "requiresApproval": a["requiresApproval"],
                "targets": a["targetObjectTypes"],
                "allowedRoles": a.get("allowedRoles") or [],
                "parameters": [
                    {
                        "name": p.get("name"),
                        "type": p.get("type"),
                        "required": p.get("required"),
                    }
                    for p in a["parameters"]
                ],
            }
            for a in actions
        ],
        "guidance": (
            "Actions that change something are staged, and you may run none of them: "
            "describe one to the user and let them run it from the Actions page. A "
            "read-only action - one that computes and returns a result - you could run."
        ),
    }


async def apply_action(arguments: dict[str, Any]) -> dict[str, Any]:
    api_name = str(arguments.get("action") or "")
    if not api_name:
        raise ToolError("action is required.")
    parameters = arguments.get("parameters") or {}

    # Checked here as well as by the service, so the model gets a clear
    # explanation instead of a bare 403 and cannot spend a round finding out.
    catalogue = await client.get("/api/action-types")
    meta = next((a for a in catalogue if a["apiName"].lower() == api_name.lower()), None)
    if meta is None:
        raise ToolError(
            f"No action '{api_name}'. Available: "
            + ", ".join(a["apiName"] for a in catalogue)
        )
    if not meta["isReadOnly"]:
        return {
            "executed": False,
            "reason": "mutating_action_requires_human_approval",
            "action": meta["apiName"],
            "label": meta["label"],
            "parameters": parameters,
            "message": (
                f"{meta['label']} changes operational data, so it is not something to "
                "run from a conversation. Describe to the user what it would do and "
                "with which parameters, and tell them they can run it from the Actions page."
            ),
        }

    # The action runs as the signed-in user with their own ontology role, and
    # the audit row names a person rather than the assistant. initiatedByAi
    # records how the request arrived and grants nothing on its own.
    outcome = await client.post(
        f"/api/actions/{meta['apiName']}/apply",
        {
            "parameters": parameters,
            "initiatedByAi": True,
            "chatSessionId": arguments.get("chatSessionId"),
        },
    )
    return {
        "executed": outcome["status"] == "succeeded",
        "status": outcome["status"],
        "action": outcome["action"],
        "message": outcome["message"],
        "result": outcome["result"],
    }


async def global_search(arguments: dict[str, Any]) -> dict[str, Any]:
    term = str(arguments.get("term") or "").strip()
    if not term:
        raise ToolError("term is required.")
    results = await client.get("/api/search", params={"q": term, "limit": 5})
    return {
        "term": term,
        "matches": [
            {
                "objectType": group["objectType"],
                "label": group["label"],
                "hits": [{"key": h["key"], "title": h["title"]} for h in group["hits"]],
            }
            for group in results
        ],
        "note": "No matches means the term is not an identifier in this ontology."
        if not results
        else None,
    }


# ── bringing data in ────────────────────────────────────────────────────────

async def list_connections(_: dict[str, Any]) -> dict[str, Any]:
    rows = await client.get("/api/connections")
    return {
        "connections": [
            {
                "connectionId": c["id"],
                "name": c["name"],
                "database": c["properties"].get("database"),
                "host": c["properties"].get("host"),
                "syncs": c["syncCount"],
                "lastTest": (c["properties"].get("lastTest") or {}).get("detail"),
            }
            for c in rows
        ]
    }


async def list_source_views(arguments: dict[str, Any]) -> dict[str, Any]:
    connection_id = arguments.get("connectionId")
    if connection_id is None:
        raise ToolError("connectionId is required - call list_connections first.")
    catalog = await client.get(f"/api/resources/{int(connection_id)}/catalog")
    schema = str(arguments.get("schema") or "").strip()
    relations = [r for r in catalog["relations"] if not schema or r["schema"] == schema]
    views = [
        {
            "schema": r["schema"],
            "name": r["name"],
            "kind": r["kind"],
            **({"estimatedRows": r["estimatedRows"]} if r["estimatedRows"] is not None else {}),
        }
        for r in relations
    ]
    payload = _truncate(views, MAX_CATALOGUE_ROWS)
    payload["connection"] = catalog["connection"]
    payload["schemas"] = sorted({r["schema"] for r in catalog["relations"]})
    return payload


def _sync_summary(sync: dict[str, Any]) -> dict[str, Any]:
    last = sync.get("lastRun") or {}
    schedule = sync.get("schedule")
    return {
        "syncId": sync["id"],
        "source": f"{sync['sourceSchema']}.{sync['sourceTable']}",
        "dataset": sync["targetRelation"],
        "connection": sync["connectionName"],
        "schedule": f"every {schedule['intervalSeconds']}s" if schedule else "manual",
        "lastRun": last.get("status"),
        "rows": last.get("rowsAfter"),
        "truncated": last.get("truncated"),
    }


async def list_syncs(_: dict[str, Any]) -> dict[str, Any]:
    return {"syncs": [_sync_summary(s) for s in await client.get("/api/syncs")]}


async def create_sync(arguments: dict[str, Any]) -> dict[str, Any]:
    """Define a sync, run it once so the dataset exists, and set its cadence.

    One tool for the whole step because the three are one intention: "bring
    this view in, and keep it fresh". Each part reports separately, so a sync
    that was created but whose first run failed says exactly that.
    """
    connection_id = arguments.get("connectionId")
    schema = str(arguments.get("sourceSchema") or "").strip()
    table = str(arguments.get("sourceTable") or "").strip()
    if connection_id is None or not schema or not table:
        raise ToolError("connectionId, sourceSchema and sourceTable are required.")

    sync = await client.post(
        f"/api/resources/{int(connection_id)}/syncs",
        _clean({"sourceSchema": schema, "sourceTable": table, "rowLimit": arguments.get("rowLimit")}),
    )
    outcome: dict[str, Any] = {"created": True, "syncId": sync["id"], "dataset": sync["targetRelation"]}

    try:
        ran = await client.post(f"/api/syncs/{sync['id']}/run", {})
        outcome["run"] = {
            "status": ran["run"]["status"],
            "rows": ran["run"]["rowsAfter"],
            "truncated": ran["run"]["truncated"],
            "widenedColumns": ran["widenedColumns"],
        }
    except ToolError as exc:
        outcome["run"] = {"status": "failed", "error": str(exc)}

    every = arguments.get("every")
    if every:
        try:
            scheduled = await client.post(f"/api/syncs/{sync['id']}/schedule", {"every": every})
            outcome["schedule"] = (scheduled.get("schedule") or {}).get("every", "manual")
        except ToolError as exc:
            outcome["schedule"] = {"error": str(exc)}
    else:
        outcome["schedule"] = "manual - it refreshes only when run"
    return outcome


async def run_sync(arguments: dict[str, Any]) -> dict[str, Any]:
    sync_id = arguments.get("syncId")
    if sync_id is None:
        raise ToolError("syncId is required - call list_syncs first.")
    ran = await client.post(f"/api/syncs/{int(sync_id)}/run", {})
    return {
        "status": ran["run"]["status"],
        "rowsBefore": ran["run"]["rowsBefore"],
        "rowsAfter": ran["run"]["rowsAfter"],
        "truncated": ran["run"]["truncated"],
        "objectTypesRefreshed": ran.get("objectTypesRefreshed"),
        "brokenProperties": ran.get("brokenProperties") or [],
    }


async def schedule_sync(arguments: dict[str, Any]) -> dict[str, Any]:
    sync_id = arguments.get("syncId")
    every = arguments.get("every")
    if sync_id is None or not every:
        raise ToolError("syncId and every are required, e.g. every='2h' or 'manual'.")
    result = await client.post(f"/api/syncs/{int(sync_id)}/schedule", {"every": every})
    schedule = result.get("schedule")
    return {
        "syncId": int(sync_id),
        "schedule": schedule["every"] if schedule else "manual",
        "nextRunAt": schedule["nextRunAt"] if schedule else None,
    }


# ── building the ontology ───────────────────────────────────────────────────

async def list_datasets(_: dict[str, Any]) -> dict[str, Any]:
    datasets = await client.get("/api/datasets")
    return {
        "datasets": [
            {
                "dataset": d["relation"],
                "name": d["name"],
                "source": d["source"],
                "rows": d["rowCount"],
                "columns": d["columnCount"],
                "lastSyncedAt": d["lastSyncedAt"],
                "objectTypes": d["objectTypes"],
            }
            for d in datasets
        ],
        "note": (
            "A dataset with no objectTypes has not been modelled yet."
            if datasets
            else "Nothing has been synced yet. Sync a view from a connection first (dataConnection mode)."
        ),
    }


async def profile_dataset(arguments: dict[str, Any]) -> dict[str, Any]:
    dataset = str(arguments.get("dataset") or "").strip()
    if not dataset:
        raise ToolError("dataset is required - its name or connection_raw.<table> from list_datasets.")
    profile = await client.get(f"/api/datasets/{quote(dataset, safe='')}/profile")
    return {
        "dataset": profile["dataset"]["relation"],
        "source": profile["dataset"]["source"],
        "rows": profile["rowCount"],
        "sampled": profile["sampled"],
        "primaryKeyCandidates": profile["primaryKeyCandidates"],
        "suggestion": profile["suggestion"],
        "existingObjectTypes": profile["existingObjectTypes"],
        # One compact line per column: what it is, how full, and the role the
        # data suggests. Empty columns are flagged so they are not modelled as
        # though the source carried them.
        "columns": [
            {
                "column": c["column"],
                "type": c["sqlType"],
                "distinct": c["distinct"],
                "nulls": c["nulls"],
                **({"empty": True} if c.get("empty") else {}),
                "role": c["suggested"]["semanticRole"],
                **(
                    {"aggregate": c["suggested"]["defaultAggregation"]}
                    if c["suggested"]["defaultAggregation"]
                    else {}
                ),
                # Two short samples are enough to recognise a column; more is
                # context a seventy-column dataset cannot spare.
                **({"samples": [str(v)[:40] for v in c["samples"][:2]]} if c["samples"] else {}),
            }
            for c in profile["columns"]
        ],
    }


async def create_object_type(arguments: dict[str, Any]) -> dict[str, Any]:
    if not arguments.get("dataset"):
        raise ToolError("dataset is required - call list_datasets, then profile_dataset.")
    body = _clean(
        {
            "dataset": arguments.get("dataset"),
            "apiName": arguments.get("apiName"),
            "label": arguments.get("label"),
            "pluralLabel": arguments.get("pluralLabel"),
            "description": arguments.get("description"),
            "primaryKey": arguments.get("primaryKey"),
            "titleColumn": arguments.get("titleColumn"),
            "group": arguments.get("group"),
            "properties": arguments.get("properties"),
            "excludeColumns": arguments.get("excludeColumns"),
        }
    )
    created = await client.post("/api/ontology/object-types", body)
    roles: dict[str, int] = {}
    for prop in created["properties"]:
        roles[prop["role"]] = roles.get(prop["role"], 0) + 1
    return {
        "created": True,
        "objectType": created["apiName"],
        "dataset": created["dataset"],
        "objects": created["objects"],
        "primaryKey": created["primaryKey"],
        "titleColumn": created["titleColumn"],
        "propertiesByRole": roles,
        "measures": [p["apiName"] for p in created["properties"] if p["role"] == "measure"],
    }


async def suggest_links(arguments: dict[str, Any]) -> dict[str, Any]:
    params = {"objectType": arguments["objectType"]} if arguments.get("objectType") else None
    suggestions = await client.get("/api/ontology/link-suggestions", params=params)
    return {
        "suggestions": suggestions,
        "note": (
            "Each is measured against the data: matchRatio is the share of values that "
            "really resolve. Nothing has been created - call create_link_type for the ones "
            "worth keeping."
            if suggestions
            else "No candidate links: no column in one object type is named for another's key."
        ),
    }


async def create_link_type(arguments: dict[str, Any]) -> dict[str, Any]:
    body = _clean(
        {
            "apiName": arguments.get("apiName"),
            "label": arguments.get("label"),
            "description": arguments.get("description"),
            "sourceObjectType": arguments.get("sourceObjectType"),
            "sourceProperty": arguments.get("sourceProperty"),
            "targetObjectType": arguments.get("targetObjectType"),
            "targetProperty": arguments.get("targetProperty"),
            "cardinality": arguments.get("cardinality"),
            "inverseApiName": arguments.get("inverseApiName"),
            "inverseLabel": arguments.get("inverseLabel"),
        }
    )
    created = await client.post("/api/ontology/link-types", body)
    link = created.get("link") or {}
    return {
        "created": True,
        "link": link.get("apiName"),
        "inverse": link.get("inverseApiName"),
        "matched": created["matched"],
        "candidates": created["candidates"],
        "matchRatio": round(created["matchRatio"], 4),
    }


async def create_metric(arguments: dict[str, Any]) -> dict[str, Any]:
    body = _clean(
        {
            "apiName": arguments.get("apiName"),
            "label": arguments.get("label"),
            "description": arguments.get("description"),
            "businessQuestion": arguments.get("businessQuestion"),
            "category": arguments.get("category"),
            "objectType": arguments.get("objectType"),
            "aggregation": arguments.get("aggregation"),
            "measure": arguments.get("measure"),
            "numerator": arguments.get("numerator"),
            "denominator": arguments.get("denominator"),
            "dimensions": arguments.get("dimensions"),
            "defaultDimension": arguments.get("defaultDimension"),
            "timeProperty": arguments.get("timeProperty"),
            "unit": arguments.get("unit"),
            "valueFormat": arguments.get("valueFormat"),
            "target": arguments.get("target"),
        }
    )
    # where and higherIsBetter carry meaningful falsy values (false, 0), so they
    # are passed whenever they were given at all.
    if isinstance(arguments.get("where"), dict) and arguments["where"]:
        body["where"] = arguments["where"]
    if isinstance(arguments.get("higherIsBetter"), bool):
        body["higherIsBetter"] = arguments["higherIsBetter"]
    created = await client.post("/api/ontology/metrics", body)
    return {
        "created": True,
        "metric": created["apiName"],
        "objectType": created["objectType"],
        "value": created["value"],
        "unit": created.get("unit"),
        "dimensions": created["dimensions"],
        "conditions": created.get("conditions") or {},
    }


async def create_action_type(arguments: dict[str, Any]) -> dict[str, Any]:
    body = _clean(
        {
            "apiName": arguments.get("apiName"),
            "label": arguments.get("label"),
            "description": arguments.get("description"),
            "objectType": arguments.get("objectType"),
            "parameters": arguments.get("parameters"),
            "allowedRoles": arguments.get("allowedRoles"),
            "approverRoles": arguments.get("approverRoles"),
        }
    )
    if isinstance(arguments.get("requiresApproval"), bool):
        body["requiresApproval"] = arguments["requiresApproval"]
    created = await client.post("/api/ontology/action-types", body)
    return {
        "created": True,
        "action": created["apiName"],
        "objectType": created["objectType"],
        "parameters": [p["name"] for p in created["parameters"]],
        "allowedRoles": created["allowedRoles"],
        "note": created.get("note"),
    }


async def delete_ontology_object(arguments: dict[str, Any]) -> dict[str, Any]:
    kind = str(arguments.get("kind") or "").strip()
    api_name = str(arguments.get("apiName") or "").strip()
    if kind not in ("objectType", "linkType", "actionType", "metric") or not api_name:
        raise ToolError("kind (objectType, linkType, actionType or metric) and apiName are required.")
    await client.delete(f"/api/ontology/{kind}/{quote(api_name)}")
    return {"deleted": True, "kind": kind, "apiName": api_name}


# ── documentation, clarification, functions ─────────────────────────────────

async def search_documentation(arguments: dict[str, Any]) -> dict[str, Any]:
    """Search the platform's documentation so a claim can be cited.

    The corpus is generated from the live registry, so a caveat found here is
    the caveat actually in force rather than a remembered paraphrase.
    """
    query = str(arguments.get("query") or "").strip()
    if not query:
        raise ToolError("query is required.")
    limit = min(int(arguments.get("limit") or 6), 12)
    hits = await client.get(
        f"/api/docs/search?q={quote(query)}&limit={limit}"
    )
    return {
        "query": query,
        "results": hits,
        "note": (
            "Cite a result with :citation[<title>]{path=\"<path>\"} , adding "
            'section="<sectionTitle>" when the hit names one. Only cite paths that '
            "appear in these results."
        ),
    }


# How many choices a question may offer. Enough for "which of these tables
# should I sync?"; past this the person is better served by typing.
MAX_CLARIFICATION_OPTIONS = 12


async def request_clarification(arguments: dict[str, Any]) -> dict[str, Any]:
    """Ask the user a question instead of guessing.

    This tool does not look anything up. It is a terminal step: the agent stops
    the round loop when it is called and hands the question back, because
    continuing would mean answering the question the model was unsure about.
    The UI shows the options as choices with a Submit button - several at once
    when `multiple` is set - and the person's pick arrives as the next turn.
    """
    question = str(arguments.get("question") or "").strip()
    if not question:
        raise ToolError("question is required.")

    raw_options = arguments.get("options") or []
    if not isinstance(raw_options, list):
        raw_options = []
    options: list[dict[str, str]] = []
    seen: set[str] = set()
    for option in raw_options:
        if isinstance(option, dict):
            label = str(option.get("label") or "").strip()
            detail = str(option.get("detail") or "").strip()
        else:
            label, detail = str(option).strip(), ""
        # A repeated label is one choice, not two buttons that do the same.
        if label and label.lower() not in seen:
            seen.add(label.lower())
            options.append({"label": label[:120], "detail": detail[:240]})
        if len(options) == MAX_CLARIFICATION_OPTIONS:
            break

    return {
        "clarificationRequested": True,
        "question": question,
        # What there was to say before asking. The reply keeps it above the
        # choices, so asking a question never replaces answering one.
        "message": str(arguments.get("message") or "").strip()[:8000],
        "options": options,
        # Several choices only make sense when there are several to make.
        "multiple": bool(arguments.get("multiple", False)) and len(options) > 1,
        "allowFreeText": bool(arguments.get("allowFreeText", True)),
    }


async def propose_function(arguments: dict[str, Any]) -> dict[str, Any]:
    """Draft a function over datasets, for a person to approve.

    For what a metric cannot express - a ratio across two datasets, a
    percentile, a derived figure. The draft is saved as `proposed`: it
    computes nothing and nothing may use it until an admin approves it, so the
    turn can carry on building around it without anything depending on it.

    The server plans the SQL before storing it, and refuses a definition that
    reads anything but synced datasets or does not run, so a guessed column
    comes straight back with the database's own message.
    """
    name = str(arguments.get("name") or "").strip()
    definition = str(arguments.get("definition") or "").strip()
    if not name:
        raise ToolError("name is required.")
    if not definition:
        raise ToolError("definition is required - the SQL the function computes.")

    payload = {
        "name": name,
        "description": str(arguments.get("description") or "").strip(),
        "businessQuestion": str(arguments.get("businessQuestion") or "").strip(),
        "language": "sql",
        "definition": definition,
        "returns": arguments.get("returns") or "scalar",
        "returnType": arguments.get("returnType"),
        "unit": arguments.get("unit"),
        "valueFormat": arguments.get("valueFormat") or "number",
        "readsObjectTypes": arguments.get("readsObjectTypes") or [],
        "proposedFrom": str(arguments.get("proposedFrom") or "").strip() or None,
    }

    try:
        created = await client.post("/api/functions", payload)
    except ToolError as exc:
        # Handed back rather than raised so the model can correct the SQL and
        # try once more - usually a column it guessed instead of looking up.
        return {
            "functionProposed": False,
            "error": str(exc),
            "hint": (
                "Fix the definition and call propose_function again. Read real column "
                "names from profile_dataset or describe_object_type, and read FROM the "
                "dataset relation (connection_raw.<table>)."
            ),
        }

    return {
        "functionProposed": True,
        # The UI renders a review card from this; the payload includes the two
        # identifiers it must not let anyone edit.
        "function": created,
        "awaitingApproval": True,
        "note": (
            "Saved as a PROPOSAL. It computes nothing until an admin approves it on the "
            "Functions page. Tell the user what it measures and that it is waiting."
        ),
    }


async def check_feasibility(arguments: dict[str, Any]) -> dict[str, Any]:
    """What this workspace's data can and cannot answer, and what is missing."""
    body: dict[str, Any] = {}
    if arguments.get("text"):
        body["text"] = str(arguments["text"])
    if isinstance(arguments.get("requests"), list):
        body["requests"] = arguments["requests"]
    if arguments.get("intent"):
        body["intent"] = str(arguments["intent"])
    if arguments.get("objectType"):
        body["objectType"] = str(arguments["objectType"])
    if not body:
        raise ToolError("Give text (the user's request) or requests (structured asks).")
    return await client.post("/api/feasibility", body)


async def propose_change(arguments: dict[str, Any]) -> dict[str, Any]:
    """Draft a link, metric, combined dataset or action type for approval."""
    kind = str(arguments.get("kind") or "")
    payload = arguments.get("payload")
    if not isinstance(payload, dict):
        raise ToolError("payload must be an object (use the payload check_feasibility returned).")
    created = await client.post(
        "/api/proposals",
        {
            "kind": kind,
            "payload": payload,
            "title": arguments.get("title"),
            "summary": arguments.get("summary"),
            "dependsOn": arguments.get("dependsOn") or [],
            "createdVia": "planner" if arguments.get("_via") == "planner" else "assistant",
            # What to build once it is approved, as check_feasibility drafted it.
            "followUp": arguments.get("followUp"),
            "chatSessionId": current_session.get(),
        },
    )
    follow_up = created.get("followUp") or {}
    return {
        "proposed": True,
        "proposal": created,
        "note": (
            "Saved as a PROPOSAL waiting for the user's approval; nothing has changed yet. "
            "Say what it adds and that it appears with Approve / Reject buttons."
            + (
                f" Approving it also builds the {follow_up.get('build')} \"{follow_up.get('title')}\" straight away."
                if follow_up
                else ""
            )
        ),
    }


async def list_proposals(arguments: dict[str, Any]) -> dict[str, Any]:
    status = arguments.get("status")
    params = {"status": str(status)} if status else {}
    proposals = await client.get("/api/proposals", params=params)
    return {"proposals": proposals[:30], "count": len(proposals)}


TOOL_IMPLEMENTATIONS: dict[str, Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]] = {
    "search_documentation": search_documentation,
    "request_clarification": request_clarification,
    "propose_function": propose_function,
    "list_object_types": list_object_types,
    "describe_object_type": describe_object_type,
    "search_objects": search_objects,
    "aggregate_objects": aggregate_objects,
    "traverse_link": traverse_link,
    "list_kpis": list_kpis,
    "execute_kpi": execute_kpi,
    "list_dashboards": list_dashboards,
    "create_dashboard": create_dashboard,
    "list_actions": list_actions,
    "apply_action": apply_action,
    "global_search": global_search,
    "list_connections": list_connections,
    "list_source_views": list_source_views,
    "list_syncs": list_syncs,
    "create_sync": create_sync,
    "run_sync": run_sync,
    "schedule_sync": schedule_sync,
    "list_datasets": list_datasets,
    "profile_dataset": profile_dataset,
    "create_object_type": create_object_type,
    "suggest_links": suggest_links,
    "create_link_type": create_link_type,
    "create_metric": create_metric,
    "create_action_type": create_action_type,
    "delete_ontology_object": delete_ontology_object,
    "check_feasibility": check_feasibility,
    "propose_change": propose_change,
    "list_proposals": list_proposals,
}

# The capability tools (modes, plans, notepad, context) are part of the same
# registry and the same duplicate-call cache as the domain tools. A mode or
# capability decides which of these names the model SEES (schemas_for) and
# which it may RUN (run_tool checks the same set): hiding a schema while the
# tool stayed callable would make capability gating advisory - a hallucinated
# or text-recovered call would run anyway.
TOOL_IMPLEMENTATIONS.update(CAPABILITY_TOOLS)

FILTER_CLAUSE_SCHEMA = {
    "type": "object",
    "properties": {
        "property": {"type": "string", "description": "Property api name."},
        "op": {
            "type": "string",
            "enum": [
                "eq", "ne", "gt", "gte", "lt", "lte", "in", "notIn",
                "contains", "startsWith", "endsWith", "isNull", "isNotNull", "between",
            ],
        },
        "value": {"description": "Comparison value. Omit for isNull / isNotNull."},
    },
    "required": ["property", "op"],
}

WIDGET_SCHEMA = {
    "type": "object",
    "properties": {
        "type": {"type": "string", "enum": ["stat", "chart", "table", "note"]},
        "kpi": {"type": "string", "description": "KPI api name. Required unless type is note."},
        "title": {"type": "string", "description": "Optional override of the KPI label."},
        "dimension": {
            "type": "string",
            "description": "Column to group by. Must be one of the KPI's dimensions. Ignored for stat.",
        },
        "chart": {"type": "string", "enum": ["bar", "hbar", "line", "area", "donut"]},
        "limit": {"type": "integer", "description": "Max categories to plot."},
        "sort": {
            "type": "string",
            "enum": ["value_desc", "value_asc", "dimension_asc", "dimension_desc"],
        },
        "width": {"type": "integer", "description": "Grid columns out of 4. Default 2."},
        "body": {"type": "string", "description": "Markdown text, for type note only."},
    },
    "required": ["type"],
}

PROPERTY_SPEC_SCHEMA = {
    "type": "object",
    "properties": {
        "column": {"type": "string", "description": "The dataset column."},
        "apiName": {"type": "string", "description": "camelCase; defaults from the column."},
        "label": {"type": "string"},
        "semanticRole": {
            "type": "string",
            "enum": [
                "identity", "title", "measure", "dimension", "temporal",
                "geo", "flag", "attribute", "provenance",
            ],
        },
        "defaultAggregation": {"type": "string", "enum": ["sum", "avg", "count", "min", "max"]},
        "unit": {"type": "string"},
    },
    "required": ["column"],
}

ACTION_PARAMETER_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string", "description": "camelCase."},
        "type": {
            "type": "string",
            "enum": ["string", "integer", "float", "decimal", "boolean", "date", "datetime"],
        },
        "label": {"type": "string"},
        "description": {"type": "string"},
        "required": {"type": "boolean"},
        "enum": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Allowed values, when the parameter is a choice.",
        },
    },
    "required": ["name"],
}


def _fn(name: str, description: str, properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties,
                **({"required": required} if required else {}),
            },
        },
    }


def tool_schemas() -> list[dict[str, Any]]:
    """The OpenAI-style function schemas the provider receives."""
    return _BASE_TOOL_SCHEMAS + CAPABILITY_TOOL_SCHEMAS


def schemas_for(names: set[str]) -> list[dict[str, Any]]:
    """The schemas whose tool is in `names`, in registry order.

    The agent calls this once per round with the set derived from the
    conversation's mode and enabled capabilities. A model is only ever handed
    the tools it may actually run.
    """
    return [schema for schema in tool_schemas() if schema["function"]["name"] in names]


# The domain tool schemas, built once at import. The capability schemas are
# appended by tool_schemas(); both are filtered per turn by schemas_for().
_BASE_TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "check_feasibility",
            "description": (
                "Decide, from this workspace's ontology, whether charts, metrics, dashboards "
                "or reports the user asks for can be built. Returns one item per request "
                "with status ready (with the exact widget to use), needs_approval (with the "
                "proposals that would make it possible: a link, a combined dataset, a derived "
                "property, a metric) or not_possible (with what data is missing and the nearest "
                "answerable alternatives). For a dashboard or report it also returns a layout "
                "of ready widgets. Call this FIRST for any request to chart, measure, combine, "
                "link or build something."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "The user's request in their words."},
                    "requests": {
                        "type": "array",
                        "description": "Structured asks, when you know them precisely.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "measure": {"type": "string"},
                                "aggregation": {"type": "string", "enum": ["count", "sum", "avg", "min", "max", "count_distinct"]},
                                "dimension": {"type": "string"},
                                "grain": {"type": "string", "enum": ["day", "week", "month", "quarter", "year"]},
                                "objectType": {"type": "string"},
                            },
                        },
                    },
                    "intent": {
                        "type": "string",
                        "enum": ["chart", "dashboard", "report", "link", "combination", "metric", "capabilities"],
                    },
                    "objectType": {"type": "string", "description": "Object type api name to focus on."},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "propose_change",
            "description": (
                "Save a change to the ontology as a PROPOSAL the user approves: kind link_type, "
                "metric, combination or action_type, with the payload check_feasibility returned "
                "(or one you build from describe_object_type). Nothing is applied until the user "
                "approves it. For a proposal that needs another one first, pass the earlier "
                "proposal's id in dependsOn. After proposing, stop and tell the user what each "
                "proposal adds; they approve it in the chat."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": ["link_type", "metric", "combination", "action_type"]},
                    "payload": {
                        "type": "object",
                        "description": (
                            "link_type: {source, sourceProperty, target, targetProperty}. "
                            "metric: {objectType, aggregation, measure?, numerator?, denominator? ('*' = per row), filters?, label?, extraDimensions?}. "
                            "combination: {name, base, joins: [{path: [link api names], fields: [property]}], derived?: [{name, expression}]} - "
                            "expressions are arithmetic over numeric properties, e.g. 'unit_price * quantity * (1 - discount)'. "
                            "action_type: {objectType, label, parameters: [{property, allowedValues?}]}."
                        ),
                    },
                    "title": {"type": "string"},
                    "summary": {"type": "string"},
                    "dependsOn": {"type": "array", "items": {"type": "integer"}},
                    "followUp": {
                        "type": "object",
                        "description": (
                            "Pass through the followUp check_feasibility drafted with the proposal, "
                            "if any: the dashboard or report to build as soon as it is approved."
                        ),
                    },
                },
                "required": ["kind", "payload"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_proposals",
            "description": "List proposals in this workspace (pending, applied, rejected, failed).",
            "parameters": {
                "type": "object",
                "properties": {"status": {"type": "string", "enum": ["pending", "applied", "rejected", "failed"]}},
            },
        },
    },
    _fn(
        "search_documentation",
        "Search this platform's documentation for how something works - the data "
        "flow, how object types, links, metrics and actions are checked, roles, "
        "schedules, what the data measures. Use it before asserting how the "
        "platform behaves, then cite the result.",
        {
            "query": {"type": "string", "description": "What you need to know, in a few words."},
            "limit": {"type": "integer", "description": "Max results, default 6."},
        },
        ["query"],
    ),
    _fn(
        "request_clarification",
        "Ask the user to choose or confirm, instead of asking in prose. Use it whenever "
        "your reply would end by asking the user to pick something - which tables to "
        "sync, which datasets to model, which metric or period, or whether to go ahead "
        "with a next step you propose - and when a request is ambiguous in a way that "
        "changes the answer. The options appear as choices with a Submit button. Do NOT "
        "use it for something you could look up yourself. Calling it ends your turn, so "
        "whatever you have to tell the user goes in `message`: asking must never replace "
        "answering.",
        {
            "message": {
                "type": "string",
                "description": (
                    "Everything you would have written before the question - the answer, the "
                    "explanation, what you found - in Markdown, with its citations and resource "
                    "chips. Required whenever the user asked something you can answer; leave it "
                    "out only when the question stands alone."
                ),
            },
            "question": {"type": "string", "description": "One specific question, in the user's language."},
            "options": {
                "type": "array",
                "description": (
                    "Two to twelve concrete choices, taken from the data or from what you "
                    "offered - e.g. the tables you listed, or 'Yes, model all three' / "
                    "'Only business_entity_contact'."
                ),
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string"},
                        "detail": {"type": "string", "description": "One short line on what this choice means."},
                    },
                    "required": ["label"],
                },
            },
            "multiple": {
                "type": "boolean",
                "description": "True when the user may pick several options at once, e.g. which tables to sync.",
            },
            "allowFreeText": {"type": "boolean", "description": "Whether a typed answer is also acceptable."},
        },
        ["question"],
    ),
    # ── data ────────────────────────────────────────────────────────────────
    _fn(
        "list_connections",
        "List the PostgreSQL connections in this space, with how many syncs each has.",
        {},
    ),
    _fn(
        "list_source_views",
        "List the views and tables a connection can read - what could be synced.",
        {
            "connectionId": {"type": "integer"},
            "schema": {"type": "string", "description": "Only this schema, e.g. tms_views."},
        },
        ["connectionId"],
    ),
    _fn(
        "list_syncs",
        "List the syncs in this space: source view, dataset, schedule, last run and rows.",
        {},
    ),
    _fn(
        "create_sync",
        "Sync a view (or table) from a connection into a dataset, exactly as it is: "
        "defines the sync, runs it once, and optionally sets how often it refreshes.",
        {
            "connectionId": {"type": "integer"},
            "sourceSchema": {"type": "string", "description": "e.g. tms_views"},
            "sourceTable": {"type": "string", "description": "The view or table, e.g. v_order"},
            "every": {
                "type": "string",
                "description": "How often to refresh: 20m, 2h, 1d, 8d, 1w. Omit for manual.",
            },
            "rowLimit": {"type": "integer", "description": "Max rows per run. Default 50,000."},
        },
        ["connectionId", "sourceSchema", "sourceTable"],
    ),
    _fn(
        "run_sync",
        "Run a sync now, rebuilding its dataset from the source. Reports rows before "
        "and after, and any object-type property whose column the source dropped.",
        {"syncId": {"type": "integer"}},
        ["syncId"],
    ),
    _fn(
        "schedule_sync",
        "Set how often a sync runs: 20m, 2h, 1d, 8d, 1w, or 'manual' to stop it running on its own.",
        {"syncId": {"type": "integer"}, "every": {"type": "string"}},
        ["syncId", "every"],
    ),
    _fn(
        "list_datasets",
        "List the synced datasets: source view, rows, last sync, and which object "
        "types are built on each. A dataset with no object types is not modelled yet.",
        {},
    ),
    _fn(
        "profile_dataset",
        "Profile one dataset before modelling it: every column's type, distinct and "
        "null counts, sample values, whether it is empty, and its suggested role; the "
        "columns that could be a primary key; and a suggested object type name.",
        {"dataset": {"type": "string", "description": "Name or connection_raw.<table> from list_datasets."}},
        ["dataset"],
    ),
    # ── ontology building ───────────────────────────────────────────────────
    _fn(
        "create_object_type",
        "Create an object type from a dataset, one property per column. Profile the "
        "dataset first. primaryKey must be one of its primaryKeyCandidates. Omit "
        "`properties` to take every column with its suggested role; pass properties "
        "only to override a role, label or unit.",
        {
            "dataset": {"type": "string"},
            "apiName": {"type": "string", "description": "PascalCase singular, e.g. Order."},
            "label": {"type": "string"},
            "pluralLabel": {"type": "string"},
            "description": {"type": "string", "description": "What one object is, in business terms."},
            "primaryKey": {"type": "string", "description": "A column that is unique and never null."},
            "titleColumn": {"type": "string", "description": "The column a person recognises an object by."},
            "group": {"type": "string", "description": "A domain to group it under, e.g. Demand, Network."},
            "properties": {"type": "array", "items": PROPERTY_SPEC_SCHEMA},
            "excludeColumns": {"type": "array", "items": {"type": "string"}},
        },
        ["dataset"],
    ),
    _fn(
        "suggest_links",
        "Find links the data supports between object types: columns named for "
        "another type's key, each measured for how many values really resolve.",
        {"objectType": {"type": "string", "description": "Only links from this type."}},
    ),
    _fn(
        "create_link_type",
        "Link two object types: a property of the source that holds the target's key. "
        "The match ratio is measured; a link where nothing matches is refused.",
        {
            "apiName": {"type": "string", "description": "camelCase, e.g. orderAccount."},
            "sourceObjectType": {"type": "string"},
            "sourceProperty": {"type": "string"},
            "targetObjectType": {"type": "string"},
            "targetProperty": {"type": "string", "description": "Usually the target's primary key."},
            "cardinality": {"type": "string", "enum": ["MANY_TO_ONE", "ONE_TO_ONE", "ONE_TO_MANY", "MANY_TO_MANY"]},
            "label": {"type": "string"},
            "inverseApiName": {"type": "string"},
            "inverseLabel": {"type": "string"},
        },
        ["apiName", "sourceObjectType", "sourceProperty", "targetObjectType", "targetProperty"],
    ),
    _fn(
        "create_metric",
        "Define a metric over an object type. It is computed once before it is kept. "
        "count needs no measure; sum/avg/min/max need a numeric measure; ratio needs a "
        "numerator and denominator (sum over sum). `where` fixes a condition, e.g. "
        "{\"isUnplanned\": true} counts only unplanned orders.",
        {
            "apiName": {"type": "string", "description": "snake_case, e.g. total_gross_weight_kg."},
            "label": {"type": "string"},
            "description": {"type": "string"},
            "businessQuestion": {"type": "string"},
            "category": {"type": "string", "description": "demand, service, finance, operations, network, data_quality"},
            "objectType": {"type": "string"},
            "aggregation": {"type": "string", "enum": ["count", "count_distinct", "sum", "avg", "min", "max", "ratio"]},
            "measure": {"type": "string", "description": "Property to aggregate."},
            "numerator": {"type": "string"},
            "denominator": {"type": "string"},
            "dimensions": {"type": "array", "items": {"type": "string"}, "description": "Properties it can be grouped by."},
            "defaultDimension": {"type": "string"},
            "timeProperty": {"type": "string"},
            "where": {"type": "object", "description": "Property -> value (or list of values) always applied."},
            "unit": {"type": "string"},
            "valueFormat": {
                "type": "string",
                "enum": ["number", "integer", "currency", "percent", "duration_hours", "duration_days", "weight_kg", "distance_km"],
            },
            "higherIsBetter": {"type": "boolean"},
            "target": {"type": "number"},
        },
        ["apiName", "objectType", "aggregation"],
    ),
    _fn(
        "create_action_type",
        "Declare an action on an object type - a verb a person runs on one object, "
        "like HoldOrder. The object's key parameter is added for you. Running it "
        "validates, checks the role and records the request; it is staged, not "
        "written back.",
        {
            "apiName": {"type": "string", "description": "PascalCase verb + noun, e.g. HoldOrder."},
            "label": {"type": "string"},
            "description": {"type": "string", "description": "What it would do, in business terms."},
            "objectType": {"type": "string"},
            "parameters": {"type": "array", "items": ACTION_PARAMETER_SCHEMA},
            "allowedRoles": {
                "type": "array",
                "items": {"type": "string", "enum": ["OperationsManagerRole", "DispatcherRole", "FinanceRole"]},
                "description": "Who may run it besides the admin. Default: OperationsManagerRole.",
            },
            "requiresApproval": {"type": "boolean"},
        },
        ["apiName", "objectType"],
    ),
    _fn(
        "delete_ontology_object",
        "Delete an object type, link, action or metric you created by mistake. Needs "
        "the admin role; an object type with links, actions or metrics must lose those first.",
        {
            "kind": {"type": "string", "enum": ["objectType", "linkType", "actionType", "metric"]},
            "apiName": {"type": "string"},
        },
        ["kind", "apiName"],
    ),
    _fn(
        "propose_function",
        "Draft a function for something a metric cannot express - a ratio across two "
        "datasets, a percentile, a derived figure. Saved as a PROPOSAL that computes "
        "nothing until an admin approves it. The SQL is one SELECT that reads only "
        "datasets (FROM connection_raw.<table>), using real column names.",
        {
            "name": {"type": "string", "description": "Short business name, e.g. 'Average Weight Per Piece'."},
            "description": {"type": "string"},
            "businessQuestion": {"type": "string"},
            "definition": {"type": "string", "description": "A single SELECT over datasets. No semicolons, no writes."},
            "returns": {"type": "string", "enum": ["scalar", "table"]},
            "unit": {"type": "string"},
            "valueFormat": {
                "type": "string",
                "enum": ["number", "integer", "currency", "percent", "duration_hours", "duration_days", "weight_kg", "distance_km"],
            },
            "proposedFrom": {"type": "string", "description": "The user's own words that prompted this."},
        },
        ["name", "definition", "returns"],
    ),
    # ── reading and answering ──────────────────────────────────────────────
    _fn(
        "list_object_types",
        "List every object type with its object count and the dataset it was created from.",
        {},
    ),
    _fn(
        "describe_object_type",
        "Get one object type's properties grouped by semantic role (measure, "
        "dimension, temporal, flag) with their columns, plus its links, actions and "
        "metrics. Call this before searching or aggregating so you use real names.",
        {"objectType": {"type": "string", "description": "e.g. Order, Shipment."}},
        ["objectType"],
    ),
    _fn(
        "search_objects",
        "Find individual objects with filters and sorting. Use for questions about "
        "specific records ('which orders are unplanned'), not for totals.",
        {
            "objectType": {"type": "string"},
            "where": {"type": "array", "items": FILTER_CLAUSE_SCHEMA},
            "search": {"type": "string", "description": "Free-text match on identifiers and names."},
            "orderBy": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "property": {"type": "string"},
                        "direction": {"type": "string", "enum": ["asc", "desc"]},
                    },
                    "required": ["property"],
                },
            },
            "select": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Properties to return. Omit for all; naming a few keeps results readable.",
            },
            "limit": {"type": "integer", "description": f"Max {MAX_OBJECT_ROWS}."},
        },
        ["objectType"],
    ),
    _fn(
        "aggregate_objects",
        "Group objects and compute totals. Only properties whose semantic role is "
        "'measure' can be summed or averaged. Prefer execute_kpi when a metric already "
        "answers the question.",
        {
            "objectType": {"type": "string"},
            "groupBy": {"type": "array", "items": {"type": "string"}},
            "metrics": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "property": {"type": "string"},
                        "aggregation": {
                            "type": "string",
                            "enum": ["count", "countDistinct", "sum", "avg", "min", "max"],
                        },
                        "alias": {"type": "string"},
                    },
                    "required": ["aggregation"],
                },
            },
            "where": {"type": "array", "items": FILTER_CLAUSE_SCHEMA},
            "limit": {"type": "integer"},
        },
        ["objectType", "metrics"],
    ),
    _fn(
        "traverse_link",
        "Follow a link from one object to related objects, e.g. from an Order to its "
        "Account. Link api names come from describe_object_type.",
        {
            "objectType": {"type": "string"},
            "objectKey": {"type": "string", "description": "The object's primary key value."},
            "linkApiName": {"type": "string"},
        },
        ["objectType", "objectKey", "linkApiName"],
    ),
    _fn(
        "list_kpis",
        "List the metrics with the object type each is over, its aggregation, "
        "conditions and the dimensions it can be sliced by.",
        {"category": {"type": "string", "description": "Optional category filter."}},
    ),
    _fn(
        "execute_kpi",
        "Compute a metric, optionally broken down by one of its dimensions. Returns "
        "the headline total plus the series.",
        {
            "kpi": {"type": "string", "description": "Metric api name from list_kpis."},
            "dimension": {"type": "string", "description": "One of the metric's dimensions (a column)."},
            "filters": {"type": "object", "description": "Equality filters keyed by column."},
            "limit": {"type": "integer"},
            "sort": {"type": "string", "enum": ["value_desc", "value_asc", "dimension_asc", "dimension_desc"]},
            "totalOnly": {"type": "boolean", "description": "Skip the breakdown."},
        },
        ["kpi"],
    ),
    _fn("list_dashboards", "List the saved dashboards.", {}),
    _fn(
        "create_dashboard",
        "Build and save a dashboard. Every widget must name a metric from list_kpis "
        "and, for charts and tables, a dimension that metric supports. Aim for up to 4 "
        "stat tiles across the top then 2 to 4 charts. Widths are grid columns out of 4.",
        {
            "kind": {
                "type": "string",
                "enum": ["dashboard", "report"],
                "description": "report lays the widgets out as a printable document; add note widgets for the narrative.",
            },
            "title": {"type": "string"},
            "description": {"type": "string"},
            "audience": {"type": "string", "description": "Who this is for."},
            "layout": {"type": "array", "items": WIDGET_SCHEMA},
            "sourcePrompt": {"type": "string", "description": "The user's request, recorded for provenance."},
        },
        ["title", "layout"],
    ),
    _fn(
        "list_actions",
        "List the ontology's actions, the object type each acts on, its parameters and who may run it.",
        {},
    ),
    _fn(
        "apply_action",
        "Run a read-only action. Actions that change something are refused here by design.",
        {"action": {"type": "string"}, "parameters": {"type": "object"}},
        ["action", "parameters"],
    ),
    _fn(
        "global_search",
        "Find an object by name or identifier across every object type. Use when the "
        "user mentions something like 'O100918' or 'Tesla' and you need its key.",
        {"term": {"type": "string"}},
        ["term"],
    ),
]


TOOL_NAMES = set(TOOL_IMPLEMENTATIONS)


def _how_to_get(name: str, state: Any) -> str | None:
    """Where the tool lives, as an actionable instruction.

    The error a gated call returns should be recoverable in one round, like
    every other tool error: name the capability to enable, or the mode to
    switch to, rather than leaving the model to guess which.
    """
    from .capability_tools import CAPABILITY_TOOLS
    from .modes import CAPABILITIES, MODES

    for capability, entry in CAPABILITIES.items():
        if name in entry["tools"]:
            return (
                f"It needs the {entry['label']} capability: call "
                f"enable_capabilities with [\"{capability}\"]."
            )
    for mode, entry in MODES.items():
        if name in entry["tools"]:
            return (
                f"It belongs to the {mode} mode: call change_mode with "
                f"mode=\"{mode}\"."
            )
    if name in CAPABILITY_TOOLS:
        return None  # a meta-tool outside every mode set should not happen
    return None


async def run_tool(name: str, arguments: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    """Execute a tool. Returns (payload, ok); a failure comes back as data."""
    implementation = TOOL_IMPLEMENTATIONS.get(name)
    if implementation is None:
        return (
            {
                "error": f"No tool named '{name}'.",
                "availableTools": sorted(TOOL_NAMES),
            },
            False,
        )

    # The gate is checked at run time, not only at schema-build time, so a
    # call that arrives any other way - text-recovered, hallucinated, a
    # capability disabled mid-turn - is refused on the same terms.
    state = current_session_state.get()
    if state is not None and name not in tools_for(state):
        hint = _how_to_get(name, state)
        message = (
            f"Tool '{name}' is not available in mode '{state.mode}' with "
            f"capabilities {sorted(state.capabilities)}."
        )
        if hint:
            message += f" {hint}"
        else:
            message += " None of the current modes offer it."
        return {"error": message}, False

    try:
        return await implementation(arguments), True
    except ToolError as exc:
        log.info("Tool %s returned an error: %s", name, exc)
        return {"error": str(exc)}, False
    except Exception as exc:  # noqa: BLE001 - surfaced to the model, not swallowed
        log.exception("Tool %s crashed", name)
        return {"error": f"{type(exc).__name__}: {exc}"}, False


def serialise_result(payload: dict[str, Any]) -> str:
    """Compact JSON for the tool message: whitespace is context we cannot spare."""
    return json.dumps(payload, default=str, separators=(",", ":"))
