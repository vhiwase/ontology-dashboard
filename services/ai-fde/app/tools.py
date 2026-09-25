"""The assistant's tools: its entire access to the platform.

Every tool is a call to the ontology service. The assistant has no database
connection and cannot write SQL, which is the point: it can only ask questions the
ontology already knows how to answer, so a wrong answer is a wrong choice of
metric rather than a wrong query.

Two design decisions that shape everything here:

RESULTS ARE TRIMMED FOR CONTEXT, NOT FOR TRUTH. A 500-row object search would
swamp a 7B model's context and push the ontology description out of it. Tools cap
rows and say so explicitly in the payload ("showing 20 of 738"), so the model
knows it is looking at a sample and can say so too.

ERRORS ARE RETURNED, NOT RAISED. A tool that fails hands the model the error text
and, where the service provided one, the list of valid alternatives. That turns a
dead turn into a self-correction: asked for a dimension that does not exist, the
model gets told which ones do and retries.
"""

from __future__ import annotations

import json
import logging
from urllib.parse import quote
from typing import Any, Callable, Awaitable

import httpx

from .config import CONFIG
from .context import current_request_id, current_space, current_token

log = logging.getLogger("ai_fde.tools")

# Row caps per tool. Chosen so a full turn of tool results stays inside the
# 16k context the Ollama provider requests.
MAX_OBJECT_ROWS = 20
MAX_AGGREGATE_ROWS = 25
MAX_SERIES_POINTS = 30


class OntologyClient:
    def __init__(self, base_url: str | None = None) -> None:
        self.base_url = (base_url or CONFIG.ontology_service_url).rstrip("/")

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        url = f"{self.base_url}{path}"

        # Forward the caller's bearer token. Without one the ontology service
        # answers 401, which is the correct outcome: there is no ambient
        # service identity here that could read the ontology on nobody's
        # behalf.
        headers = dict(kwargs.pop("headers", None) or {})
        token = current_token.get()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        # Carry the correlation id downstream so the ontology service logs the
        # same id against the queries this turn caused.
        request_id = current_request_id.get()
        if request_id:
            headers["X-Request-ID"] = request_id
        if headers:
            kwargs["headers"] = headers

        # Every call is made in the conversation's space, so the assistant
        # reads the ontology of the environment the user is actually in. A
        # tool that set its own space explicitly keeps it.
        params = dict(kwargs.pop("params", None) or {})
        params.setdefault("space", current_space.get())
        kwargs["params"] = params

        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.request(method, url, **kwargs)
        if response.status_code >= 400:
            # Pass the service's own message through: it usually names the valid
            # options, which is exactly what the model needs to recover.
            try:
                detail = response.json().get("error") or response.text
            except Exception:
                detail = response.text
            if response.status_code == 409:
                # The space has no published ontology. A distinct type because
                # the answer is "nothing has been published here yet", which is
                # worth saying plainly rather than reporting as a failed call.
                raise NoOntologyInSpace(detail)
            raise ToolError(f"{method} {path} failed ({response.status_code}): {detail}")
        if response.status_code == 204:
            return None
        return response.json()

    async def get(self, path: str, **kwargs: Any) -> Any:
        return await self._request("GET", path, **kwargs)

    async def post(self, path: str, json_body: Any = None) -> Any:
        return await self._request("POST", path, json=json_body or {})


class ToolError(RuntimeError):
    pass


class NoOntologyInSpace(ToolError):
    """Raised where the conversation's space has no published ontology."""


client = OntologyClient()


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


# ── tool implementations ────────────────────────────────────────────────────

async def list_object_types(_: dict[str, Any]) -> dict[str, Any]:
    types = await client.get("/api/object-types")
    return {
        "objectTypes": [
            {
                "apiName": t["apiName"],
                "label": t["label"],
                "group": t["group"],
                "objects": t["rowCount"],
                "properties": t["propertyCount"],
                "measures": t["measureCount"],
                "links": t["linkCount"],
                "description": t["description"],
            }
            for t in types
        ]
    }


async def describe_object_type(arguments: dict[str, Any]) -> dict[str, Any]:
    api_name = str(arguments.get("objectType") or arguments.get("apiName") or "")
    if not api_name:
        raise ToolError("objectType is required.")
    detail = await client.get(f"/api/object-types/{api_name}")
    # Properties are grouped by semantic role rather than listed flat: the model
    # needs to know what it may aggregate versus group by, and a flat list of 68
    # properties does not convey that.
    by_role: dict[str, list[dict[str, Any]]] = {}
    for prop in detail["properties"]:
        by_role.setdefault(prop["semanticRole"], []).append(
            {
                "apiName": prop["apiName"],
                "label": prop["label"],
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
        "sourceView": detail["sourceView"],
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
        "relatedKpis": [k["apiName"] for k in detail["kpis"]],
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
    result = await client.post(f"/api/objects/{api_name}/search", body)
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
    result = await client.post(f"/api/objects/{api_name}/aggregate", body)
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
        f"/api/objects/{api_name}/{key}/links/{link}", params={"limit": MAX_OBJECT_ROWS}
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
    if category:
        catalogue = [k for k in catalogue if k["category"] == str(category).lower()]
    return {
        "kpis": catalogue,
        "categories": sorted({k["category"] for k in await client.get("/api/kpis/catalogue")}),
    }


async def execute_kpi(arguments: dict[str, Any]) -> dict[str, Any]:
    api_name = str(arguments.get("kpi") or arguments.get("apiName") or "")
    if not api_name:
        raise ToolError("kpi is required.")
    body = {
        "dimension": arguments.get("dimension"),
        "filters": arguments.get("filters") or {},
        "limit": min(int(arguments.get("limit") or MAX_SERIES_POINTS), MAX_SERIES_POINTS),
        "sort": arguments.get("sort") or "value_desc",
        "totalOnly": bool(arguments.get("totalOnly")),
    }
    result = await client.post(f"/api/kpis/{api_name}/execute", body)
    payload: dict[str, Any] = {
        "kpi": result["kpi"],
        "label": result["label"],
        "total": result["total"],
        "unit": result["unit"],
        "format": result["valueFormat"],
        "dimension": result["dimension"],
        "series": result["series"][:MAX_SERIES_POINTS],
        "target": result["target"],
        "higherIsBetter": result["higherIsBetter"],
    }
    # The caveat travels with the number so it cannot be quoted without it.
    if result["dependsOnSimulation"]:
        payload["dataQualityCaveat"] = result["coverageNote"] or (
            "This metric rests on simulated execution data, not measured data."
        )
    if len(result["series"]) > MAX_SERIES_POINTS:
        payload["note"] = f"Showing the top {MAX_SERIES_POINTS} of {len(result['series'])} groups."
    return payload


async def get_data_coverage(_: dict[str, Any]) -> dict[str, Any]:
    stats = await client.get("/api/stats")
    return {
        "coverage": [
            {
                "metricArea": row["metric_area"],
                "objectType": row["object_type"],
                "totalRows": row["total_rows"],
                "rowsFromSource": row["rows_from_source"],
                "rowsSimulated": row["rows_simulated"],
                "sourceCoveragePct": row["source_coverage_pct"],
                "note": row["note"],
            }
            for row in stats["dataCoverage"]
        ],
        "guidance": (
            "Metric areas below 100% source coverage rest partly or wholly on the "
            "execution data this snapshot does not carry. Say so whenever you quote a "
            "figure from one of them."
        ),
    }


async def get_exceptions(_: dict[str, Any]) -> dict[str, Any]:
    stats = await client.get("/api/stats")
    return {
        "exceptions": [
            {
                "type": row["exception_type"],
                "objectType": row["object_type"],
                "severity": row["severity"],
                "count": row["item_count"],
                "description": row["description"],
            }
            for row in stats["exceptions"]
        ]
    }


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
        },
    )
    return {
        "created": True,
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
            "Every action here mutates, so you may invoke none of them: propose one "
            "to the user and let them run it. A read-only action - one that computes "
            "and returns a result rather than being staged - you could invoke "
            "yourself, but the catalogue currently holds none."
        ),
    }


async def apply_action(arguments: dict[str, Any]) -> dict[str, Any]:
    api_name = str(arguments.get("action") or "")
    if not api_name:
        raise ToolError("action is required.")
    parameters = arguments.get("parameters") or {}

    # The agent runs as an analyst, so the ontology service refuses any mutating
    # action on RBAC grounds. Checking here as well means the model gets a clear
    # explanation instead of a bare 403, and cannot spend a round finding out.
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
                "with which parameters, and tell them they can run it from the Actions "
                "panel on the object."
            ),
        }

    # actor and actorRole used to be sent from here as "ai-fde" plus a default
    # role. The ontology service now takes both from the forwarded token, so
    # the action runs as the signed-in user with their own ontology role, and
    # the audit row names a person rather than the assistant. initiatedByAi
    # still travels in the body: it records how the request arrived and grants
    # nothing on its own.
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


async def get_lineage(arguments: dict[str, Any]) -> dict[str, Any]:
    object_type = arguments.get("objectType")
    kpi = arguments.get("kpi")
    if not object_type and not kpi:
        raise ToolError("Give either objectType or kpi.")

    path = f"/api/lineage/kpi/{kpi}" if kpi else f"/api/lineage/object-type/{object_type}"
    result = await client.get(path)
    trace = result["trace"]

    # The full trace is ~96 nodes. Summarised by layer, because "which endpoint and
    # which table" is the answer being asked for, not the whole subgraph.
    by_layer: dict[str, list[str]] = {}
    for node in trace["nodes"]:
        by_layer.setdefault(node["layer"] or "unknown", []).append(node["label"])
    return {
        "subject": kpi or object_type,
        "upstreamByLayer": {
            layer: sorted(set(labels))[:12] for layer, labels in by_layer.items()
        },
        "nodeCount": len(trace["nodes"]),
        "sourceColumns": [
            f"{row['source_table']}.{row['source_column']}" for row in result["columns"][:25]
        ],
        "sourceColumnCount": len(result["columns"]),
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


# ── tool schemas handed to the model ───────────────────────────────────────


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


async def request_clarification(arguments: dict[str, Any]) -> dict[str, Any]:
    """Ask the user a question instead of guessing.

    This tool does not look anything up. It is a terminal step: the agent stops
    the round loop when it is called and hands the question back, because
    continuing would mean answering the question the model was unsure about.
    """
    question = str(arguments.get("question") or "").strip()
    if not question:
        raise ToolError("question is required.")

    raw_options = arguments.get("options") or []
    options: list[dict[str, str]] = []
    for option in raw_options[:6]:
        if isinstance(option, dict):
            label = str(option.get("label") or "").strip()
            detail = str(option.get("detail") or "").strip()
        else:
            label, detail = str(option).strip(), ""
        if label:
            options.append({"label": label, "detail": detail})

    return {
        "clarificationRequested": True,
        "question": question,
        "options": options,
        "allowFreeText": bool(arguments.get("allowFreeText", True)),
    }

async def propose_function(arguments: dict[str, Any]) -> dict[str, Any]:
    """Draft a metric that does not exist yet, for a person to approve.

    The gap this closes: the assistant may not invent a KPI, so asked for
    something the catalogue does not cover it can only say no and the
    conversation dead-ends. This gives it a third option — write the
    definition down and hand it over.

    It is a TERMINAL step, like request_clarification. The draft is saved as
    `proposed`, which computes nothing and cannot back a dashboard, and the
    turn ends so the user can read it. Continuing would mean building a
    dashboard on a metric nobody has approved, which is the exact thing the
    proposal step exists to prevent.

    The server validates the SQL before storing it, so a definition that will
    not run is refused here rather than discovered by whoever approves it.
    """
    name = str(arguments.get("name") or "").strip()
    definition = str(arguments.get("definition") or "").strip()
    if not name:
        raise ToolError("name is required.")
    if not definition:
        raise ToolError("definition is required - the SQL the metric computes.")

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
        # The server refused the definition. Handed back rather than raised so
        # the model can correct the SQL and try once more, which is usually a
        # column name it guessed instead of looking up.
        return {
            "functionProposed": False,
            "error": str(exc),
            "hint": (
                "Fix the definition and call propose_function again. Use "
                "describe_object_type or list_kpis first to get real column names."
            ),
        }

    return {
        "functionProposed": True,
        # The UI opens its review dialog on this flag; the payload is what it
        # renders, including the two identifiers it must not let anyone edit.
        "function": created,
        "awaitingApproval": True,
        "note": (
            "Saved as a PROPOSAL. It computes nothing and no dashboard can use it "
            "until a person approves it. Tell the user what it measures and that "
            "it is waiting for their approval."
        ),
    }


async def propose_pipeline(arguments: dict[str, Any]) -> dict[str, Any]:
    """Draft a pipeline graph for a person to accept (§18).

    Terminal, like propose_function and for the same reason. A pipeline that
    runs writes real tables which dashboards and this assistant then read, so
    a graph nobody has reviewed must not become a dataset because a sentence
    asked for it.

    The server compiles every node before storing the draft, so a filter on a
    column that does not exist is refused here rather than discovered by the
    reviewer.
    """
    name = str(arguments.get("name") or "").strip()
    graph = arguments.get("graph")
    if not name:
        raise ToolError("name is required.")
    if not isinstance(graph, dict) or not graph.get("nodes"):
        raise ToolError("graph must be an object with a nodes array.")

    payload = {
        "name": name,
        "description": str(arguments.get("description") or "").strip(),
        "graph": graph,
        "proposedFrom": str(arguments.get("proposedFrom") or "").strip() or None,
    }

    try:
        created = await client.post("/api/pipelines/propose", payload)
    except ToolError as exc:
        # Handed back rather than raised, so the model can correct the graph.
        # Usually a column it guessed instead of looking up.
        return {
            "pipelineProposed": False,
            "error": str(exc),
            "hint": (
                "Fix the graph and call propose_pipeline again. Use "
                "describe_object_type for real sqlColumn names, and remember a "
                "source node needs sourceView set to a published view."
            ),
        }

    return {
        "pipelineProposed": True,
        "pipeline": created.get("pipeline"),
        "compiled": created.get("compiled"),
        "awaitingAcceptance": True,
        "note": (
            "Saved as a PROPOSAL. Every node compiles, but nothing has run and it "
            "cannot run until a person accepts it. Describe what it does and that "
            "it is waiting for them."
        ),
    }


TOOL_IMPLEMENTATIONS: dict[str, Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]] = {
    "search_documentation": search_documentation,
    "request_clarification": request_clarification,
    "propose_function": propose_function,
    "propose_pipeline": propose_pipeline,
    "list_object_types": list_object_types,
    "describe_object_type": describe_object_type,
    "search_objects": search_objects,
    "aggregate_objects": aggregate_objects,
    "traverse_link": traverse_link,
    "list_kpis": list_kpis,
    "execute_kpi": execute_kpi,
    "get_data_coverage": get_data_coverage,
    "get_exceptions": get_exceptions,
    "list_dashboards": list_dashboards,
    "create_dashboard": create_dashboard,
    "list_actions": list_actions,
    "apply_action": apply_action,
    "get_lineage": get_lineage,
    "global_search": global_search,
}

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


def tool_schemas() -> list[dict[str, Any]]:
    """The OpenAI-style function schemas both providers accept."""
    return [
        {
            "type": "function",
            "function": {
                "name": "search_documentation",
                "description": (
                    "Search this platform's documentation for a definition, a data-quality "
                    "caveat, or how something behaves. Use it before asserting anything "
                    "about how a metric is computed, what is simulated, how roles work or "
                    "how actions behave - then cite the result."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "What you need to know, in a few words.",
                        },
                        "limit": {"type": "integer", "description": "Max results, default 6."},
                    },
                    "required": ["query"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "propose_pipeline",
                "description": (
                    "Draft a data pipeline from a description, for a person to accept. "
                    "Use this when the user asks you to BUILD or CREATE a pipeline. "
                    "The draft is saved but inert: nothing runs until they accept it. "
                    "Calling this ends your turn. "
                    "Call describe_object_type first to get real sqlColumn names - a "
                    "graph referencing a column that does not exist is refused."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "description": "Short business name for the pipeline."},
                        "description": {"type": "string", "description": "What it produces and from what."},
                        "proposedFrom": {
                            "type": "string",
                            "description": "The user's own words that prompted this.",
                        },
                        "graph": {
                            "type": "object",
                            "description": (
                                "nodes[] and edges[]. Each node: id, kind, name, "
                                "position{x,y}, config{}. Kinds that run SQL: dataSource "
                                "(config.sourceView = a published view), filter "
                                "(config.mode = filter|select|sort|dedupe|calculate|"
                                "normalize|lookup|union), join, aggregate, sql, output. "
                                "Each edge: id, source, target. Lay nodes left to "
                                "right, 260px apart. An aggregate needs measures[] as "
                                "well as groupBy[], each {aggregation, field, alias} - "
                                "groupBy alone computes nothing."
                            ),
                            "properties": {
                                "nodes": {"type": "array", "items": {"type": "object"}},
                                "edges": {"type": "array", "items": {"type": "object"}},
                            },
                            "required": ["nodes", "edges"],
                        },
                    },
                    "required": ["name", "graph"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "propose_function",
                "description": (
                    "Draft a NEW metric when the user needs one the KPI catalogue does "
                    "not have. Call list_kpis first: if a published KPI already answers "
                    "the question, use it instead of proposing a duplicate. "
                    "The draft is saved as a PROPOSAL for a person to approve - it "
                    "computes nothing and no dashboard can use it until they do. "
                    "Calling this ends your turn. "
                    "The SQL must be a single SELECT over views the ontology publishes; "
                    "use describe_object_type to get real column names rather than "
                    "guessing them."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": (
                                "Short business name, e.g. 'Distance Travelled Per Month'. "
                                "The permanent id and api name are derived from this by the "
                                "server and cannot be set or changed afterwards."
                            ),
                        },
                        "description": {
                            "type": "string",
                            "description": "What it measures and any caveat about the data behind it.",
                        },
                        "businessQuestion": {
                            "type": "string",
                            "description": "The question a user would ask that this answers.",
                        },
                        "definition": {
                            "type": "string",
                            "description": (
                                "A single SELECT over published views. No semicolons, no "
                                "writes. For a scalar metric return one row and one column. "
                                "Use each property's sqlColumn (snake_case) from "
                                "describe_object_type, NOT its apiName (camelCase) - the "
                                "apiName is not a column and the definition will be rejected."
                            ),
                        },
                        "returns": {
                            "type": "string",
                            "enum": ["scalar", "table"],
                            "description": "scalar for a KPI tile, table for a chart.",
                        },
                        "returnType": {
                            "type": "string",
                            "description": "numeric, percent, currency, duration_hours, distance_km, …",
                        },
                        "unit": {"type": "string", "description": "km, hours, USD, …"},
                        "valueFormat": {
                            "type": "string",
                            "enum": [
                                "number", "integer", "currency", "percent",
                                "duration_hours", "duration_days", "weight_kg", "distance_km",
                            ],
                        },
                        "readsObjectTypes": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Ontology object types this reads, for lineage.",
                        },
                        "proposedFrom": {
                            "type": "string",
                            "description": "The user's own words that prompted this, for the audit trail.",
                        },
                    },
                    "required": ["name", "definition", "returns"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "request_clarification",
                "description": (
                    "Ask the user a question instead of guessing. Use this when the request "
                    "is genuinely ambiguous in a way that changes the answer - which lane, "
                    "which time window, which of two metrics they mean. Do NOT use it for "
                    "something you could look up yourself. Calling it ends your turn: you "
                    "will be given the user's reply on the next one."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "question": {
                            "type": "string",
                            "description": "One specific question, in the user's language.",
                        },
                        "options": {
                            "type": "array",
                            "description": (
                                "Two to six concrete choices. Offer these whenever the "
                                "possibilities are known - picking from a list is far less "
                                "work than typing."
                            ),
                            "items": {
                                "type": "object",
                                "properties": {
                                    "label": {"type": "string"},
                                    "detail": {
                                        "type": "string",
                                        "description": "One short line on what this choice means.",
                                    },
                                },
                                "required": ["label"],
                            },
                        },
                        "allowFreeText": {
                            "type": "boolean",
                            "description": "Whether a typed answer is also acceptable. Default true.",
                        },
                    },
                    "required": ["question"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "list_object_types",
                "description": (
                    "List every object type in the TMS ontology with its object count. "
                    "Start here when you do not yet know what data exists."
                ),
                "parameters": {"type": "object", "properties": {}},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "describe_object_type",
                "description": (
                    "Get one object type's properties grouped by semantic role (measure, "
                    "dimension, temporal, flag), plus its links and actions. Call this "
                    "before searching or aggregating so you use real property names."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "objectType": {"type": "string", "description": "e.g. Order, Shipment, Transport."}
                    },
                    "required": ["objectType"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "search_objects",
                "description": (
                    "Find individual objects with filters and sorting. Use for questions "
                    "about specific records ('which orders are unplanned'), not for totals."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
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
                    "required": ["objectType"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "aggregate_objects",
                "description": (
                    "Group objects and compute totals. Only properties whose semantic role "
                    "is 'measure' can be summed or averaged. Prefer execute_kpi when a "
                    "defined metric already answers the question."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
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
                    "required": ["objectType", "metrics"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "traverse_link",
                "description": (
                    "Follow a link from one object to related objects, e.g. from an Order "
                    "to its Shipments. Link api names come from describe_object_type."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "objectType": {"type": "string"},
                        "objectKey": {"type": "string", "description": "The object's primary key value."},
                        "linkApiName": {"type": "string"},
                    },
                    "required": ["objectType", "objectKey", "linkApiName"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "list_kpis",
                "description": (
                    "List the defined business metrics with the question each answers and "
                    "the dimensions it can be sliced by. Use this before answering any "
                    "'how are we doing on X' question or building a dashboard."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "category": {
                            "type": "string",
                            "description": "Optional filter: demand, service, cost, finance, operations, network, data_quality.",
                        }
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "execute_kpi",
                "description": (
                    "Compute a KPI, optionally broken down by one of its dimensions. "
                    "Returns the headline total plus the series. This is the preferred way "
                    "to answer a metric question."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "kpi": {"type": "string", "description": "KPI api name from list_kpis."},
                        "dimension": {"type": "string", "description": "One of the KPI's dimensions."},
                        "filters": {
                            "type": "object",
                            "description": "Equality filters keyed by dimension column.",
                        },
                        "limit": {"type": "integer"},
                        "sort": {
                            "type": "string",
                            "enum": ["value_desc", "value_asc", "dimension_asc", "dimension_desc"],
                        },
                        "totalOnly": {"type": "boolean", "description": "Skip the breakdown."},
                    },
                    "required": ["kpi"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "get_data_coverage",
                "description": (
                    "Report how much of each metric area is measured versus simulated. Call "
                    "this when the user asks whether a number can be trusted, and whenever "
                    "you are about to present execution, cost or carrier figures."
                ),
                "parameters": {"type": "object", "properties": {}},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "get_exceptions",
                "description": (
                    "The operational worklist: counts of unplanned orders, unrated "
                    "shipments, late stops, holds and data faults. Use for 'what needs "
                    "attention' questions."
                ),
                "parameters": {"type": "object", "properties": {}},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "list_dashboards",
                "description": "List the saved dashboards.",
                "parameters": {"type": "object", "properties": {}},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "create_dashboard",
                "description": (
                    "Build and save a dashboard. Every widget must name a KPI from "
                    "list_kpis and, for charts and tables, a dimension that KPI supports. "
                    "Aim for 4 stat tiles across the top then 2 to 4 charts. Widths are "
                    "grid columns out of 4."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string"},
                        "description": {"type": "string"},
                        "audience": {"type": "string", "description": "Who this is for."},
                        "layout": {"type": "array", "items": WIDGET_SCHEMA},
                        "sourcePrompt": {
                            "type": "string",
                            "description": "The user's request, recorded for provenance.",
                        },
                    },
                    "required": ["title", "layout"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "list_actions",
                "description": (
                    "List the ontology's actions. Read-only ones you may run; mutating ones "
                    "must be proposed to the user instead."
                ),
                "parameters": {"type": "object", "properties": {}},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "apply_action",
                "description": (
                    "Run a read-only action such as a what-if rate change or an on-time "
                    "projection. Mutating actions are refused here by design."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string"},
                        "parameters": {"type": "object"},
                    },
                    "required": ["action", "parameters"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "get_lineage",
                "description": (
                    "Trace where an object type or KPI's data comes from, through the "
                    "views and raw tables back to the source API endpoint."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "objectType": {"type": "string"},
                        "kpi": {"type": "string"},
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "global_search",
                "description": (
                    "Find an object by name or identifier across every object type. Use "
                    "when the user mentions something like 'O100918', 'S45435' or 'Tesla' "
                    "and you need its key."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {"term": {"type": "string"}},
                    "required": ["term"],
                },
            },
        },
    ]


TOOL_NAMES = set(TOOL_IMPLEMENTATIONS)


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
