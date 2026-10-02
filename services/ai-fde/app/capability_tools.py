"""The capability tools: the assistant's meta-layer.

The Palantir AI-FDE prompt this platform implements does not only give its
assistant domain tools - it gives it tools for managing ITSELF: switching the
operational mode that decides which tools are loaded, toggling capabilities on
top of that mode, writing a plan before multi-step work, keeping a notepad,
and pruning its own context when a turn has accumulated more tool results than
it needs. Those are implemented here.

Two families share this module:

  * STATEFUL tools (change_mode, generate_plan, notepad, manage_context, ...)
    read and mutate the conversation's SessionAgentState through the
    current_session_state contextvar. They touch no external service. The
    agent loop owns the message list, so manage_context only validates and
    records intent; the loop applies the hiding, where the results actually
    live.

  * ONTOLOGY-BACKED tools (browse_workspace, get_access_requirements, ...) are
    ordinary calls to the ontology service, like everything in tools.py, gated
    behind a capability or a mode rather than always available.

Every capability the reference prompt names is accounted for: the ones this
platform cannot honour honestly are declared in modes.NOT_IMPLEMENTED and
refuse with the reason, rather than being enabled and doing nothing.
"""

from __future__ import annotations

from urllib.parse import quote
from typing import Any

from . import store
from .context import current_session_state, current_space, current_user
from .modes import (
    CAPABILITIES,
    MODES,
    NOT_IMPLEMENTED,
    SessionAgentState,
    resolve_mode,
    tools_for,
)
from .ontology_client import ToolError, client

# ── the state the stateful tools operate on ─────────────────────────────────


def _state() -> SessionAgentState:
    state = current_session_state.get()
    if state is None:
        # Only reachable if a schema leaked outside an agent turn - tests call
        # implementations directly and set the contextvar themselves.
        raise ToolError("This tool only runs inside a conversation turn.")
    return state


def _mode_summary(state: SessionAgentState) -> dict[str, Any]:
    mode = MODES[state.mode]
    return {
        "mode": state.mode,
        "label": mode["label"],
        "introduction": mode["introduction"],
        "toolsNowAvailable": sorted(tools_for(state)),
        "capabilitiesEnabled": sorted(state.capabilities),
        "suggestedReading": mode.get("docs") or [],
    }


# ── mode and capability management ──────────────────────────────────────────


async def change_mode(arguments: dict[str, Any]) -> dict[str, Any]:
    """Switch the operational mode, which changes the tools loaded next round.

    Not a terminal step: the turn continues with the new tool set, which is
    the point. A mode is a bundle of tools plus the documentation for the job,
    so the result names both - including what is GONE, because a tool that
    disappeared without acknowledgement reads as a malfunction.
    """
    state = _state()
    try:
        state.mode = resolve_mode(arguments.get("mode"))
    except ValueError as exc:
        raise ToolError(str(exc)) from exc
    return _mode_summary(state)


def _capability_report(state: SessionAgentState) -> dict[str, Any]:
    return {
        "mode": state.mode,
        "capabilitiesEnabled": sorted(state.capabilities),
        "available": {
            name: entry["description"] for name, entry in sorted(CAPABILITIES.items())
        },
        "toolsNowAvailable": sorted(tools_for(state)),
    }


async def enable_capabilities(arguments: dict[str, Any]) -> dict[str, Any]:
    """Toggle capabilities on. They persist across mode switches and turns."""
    state = _state()
    requested = arguments.get("capabilities") or []
    if isinstance(requested, str):
        requested = [requested]
    if not requested:
        raise ToolError("capabilities is required - a list of capability names.")

    enabled: list[str] = []
    refused: dict[str, str] = {}
    unknown: list[str] = []
    for name in requested:
        if name in CAPABILITIES:
            state.capabilities.add(name)
            enabled.append(name)
        elif name in NOT_IMPLEMENTED:
            refused[name] = NOT_IMPLEMENTED[name]
        else:
            unknown.append(name)

    payload = _capability_report(state)
    payload["enabled"] = enabled
    if refused:
        payload["refused"] = refused
        payload["note"] = (
            "Some capabilities were refused rather than silently enabled: this "
            "platform has no honest implementation of them."
        )
    if unknown:
        payload["unknown"] = unknown
        payload["validNames"] = sorted(CAPABILITIES)
    return payload


async def disable_capabilities(arguments: dict[str, Any]) -> dict[str, Any]:
    """Toggle capabilities off. The always-on meta-tools cannot be disabled."""
    state = _state()
    requested = arguments.get("capabilities") or []
    if isinstance(requested, str):
        requested = [requested]
    if not requested:
        raise ToolError("capabilities is required - a list of capability names.")

    disabled: list[str] = []
    unknown: list[str] = []
    for name in requested:
        if name in CAPABILITIES:
            state.capabilities.discard(name)
            disabled.append(name)
        else:
            unknown.append(name)

    payload = _capability_report(state)
    payload["disabled"] = disabled
    if unknown:
        payload["unknown"] = unknown
        payload["validNames"] = sorted(CAPABILITIES)
    return payload


# ── plan and todo list ──────────────────────────────────────────────────────

_STEP_STATUSES = ("pending", "in_progress", "done", "skipped")


def _normalise_plan_steps(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list) or not raw:
        raise ToolError(
            "steps is required - a non-empty list of step descriptions."
        )
    steps: list[dict[str, str]] = []
    for item in raw[:20]:
        text = str(item if not isinstance(item, dict) else item.get("description") or "").strip()
        if text:
            steps.append({"description": text, "status": "pending"})
    if not steps:
        raise ToolError("Every step needs a non-empty description.")
    return steps


def _plan_status(plan: dict[str, Any]) -> str:
    """A plan with no open steps is complete, whatever its stored status says."""
    if plan["steps"] and all(s["status"] in ("done", "skipped") for s in plan["steps"]):
        return "complete"
    return plan.get("status") or "in_progress"


async def generate_plan(arguments: dict[str, Any]) -> dict[str, Any]:
    """Write the plan this conversation will work through, for the user to read.

    A plan is the artefact that turns "I will profile the datasets, create the
    object types, then link them" from prose the user must trust into steps
    they can watch being ticked off. It replaces any previous plan, with
    overwrite: true acknowledged explicitly, because silently discarding a
    plan someone was following is worse than an extra round trip.
    """
    state = _state()
    title = str(arguments.get("title") or "").strip()
    if not title:
        raise ToolError("title is required.")
    if state.plan is not None and not bool(arguments.get("overwrite")):
        raise ToolError(
            "This conversation already has a plan: "
            f"'{state.plan.get('title')}'. Pass overwrite=true to replace it, "
            "or update it with manage_plan instead."
        )

    state.plan = {
        "title": title,
        "background": str(arguments.get("background") or "").strip() or None,
        "status": "in_progress",
        "steps": _normalise_plan_steps(arguments.get("steps")),
    }
    return {"plan": {**state.plan, "status": _plan_status(state.plan)}}


async def manage_plan(arguments: dict[str, Any]) -> dict[str, Any]:
    """Update the conversation's plan as the work progresses.

    Indexes are 1-based, matching the numbered list the model sees in the
    payload. Completing the last open step completes the plan - a plan that
    says in_progress over nothing open is a lie of the stale kind.
    """
    state = _state()
    if state.plan is None:
        raise ToolError(
            "There is no plan in this conversation yet. Write one with "
            "generate_plan first."
        )
    action = str(arguments.get("action") or "").strip()
    plan = state.plan
    steps: list[dict[str, str]] = plan["steps"]

    if action == "read":
        pass
    elif action in ("start_step", "complete_step", "skip_step", "remove_step"):
        index = int(arguments.get("index") or 0)
        if not 1 <= index <= len(steps):
            raise ToolError(
                f"index must be between 1 and {len(steps)}. "
                + "; ".join(f"{i + 1}. {s['description']}" for i, s in enumerate(steps))
            )
        if action == "remove_step":
            steps.pop(index - 1)
        else:
            steps[index - 1]["status"] = {
                "start_step": "in_progress",
                "complete_step": "done",
                "skip_step": "skipped",
            }[action]
    elif action == "add_step":
        description = str(arguments.get("description") or "").strip()
        if not description:
            raise ToolError("description is required to add a step.")
        steps.append({"description": description, "status": "pending"})
    elif action == "update_step":
        index = int(arguments.get("index") or 0)
        description = str(arguments.get("description") or "").strip()
        if not 1 <= index <= len(steps) or not description:
            raise ToolError("update_step needs a valid index and a description.")
        steps[index - 1]["description"] = description
    elif action == "set_background":
        plan["background"] = str(arguments.get("background") or "").strip() or None
    else:
        raise ToolError(
            f"Unknown action {action!r}. Actions: read, start_step, "
            "complete_step, skip_step, add_step, remove_step, update_step, "
            "set_background."
        )

    plan["status"] = _plan_status(plan)
    return {"plan": plan}


async def manage_todo_list(arguments: dict[str, Any]) -> dict[str, Any]:
    """A lightweight checklist, separate from the plan.

    The plan is the argument for doing the work; the todo list is the memory
    of the small things agreed along the way ("send the lane list to Priya").
    Keeping them apart is what stops a plan becoming a junk drawer.
    """
    state = _state()
    action = str(arguments.get("action") or "").strip()
    todos = state.todos

    if action == "read":
        pass
    elif action == "add":
        text = str(arguments.get("text") or "").strip()
        if not text:
            raise ToolError("text is required to add a todo.")
        if len(todos) >= 20:
            raise ToolError(
                "The todo list holds 20 items. Clear finished ones before "
                "adding more."
            )
        todos.append({"text": text, "status": "open"})
    elif action in ("set_status", "remove"):
        index = int(arguments.get("index") or 0)
        if not 1 <= index <= len(todos):
            raise ToolError(
                f"index must be between 1 and {len(todos)}."
                + ("" if not todos else "; ".join(
                    f" {i + 1}. {t['text']}" for i, t in enumerate(todos)
                ))
            )
        if action == "remove":
            todos.pop(index - 1)
        else:
            status = str(arguments.get("status") or "").strip()
            if status not in ("open", "done"):
                raise ToolError("status must be open or done.")
            todos[index - 1]["status"] = status
    elif action == "clear":
        todos.clear()
    else:
        raise ToolError(
            f"Unknown action {action!r}. Actions: read, add, set_status, "
            "remove, clear."
        )

    return {"todos": todos}


# ── notepad ─────────────────────────────────────────────────────────────────


async def notepad(arguments: dict[str, Any]) -> dict[str, Any]:
    """Persistent notes, scoped to the signed-in user and this space.

    Notes survive the conversation and the container: they are the place a
    finding lands when the user says "write that down", and a conversation is
    the wrong home for it - chats get purged on a retention schedule, notes
    do not.
    """
    user = current_user.get()
    if not user:
        raise ToolError("Notepad requires a signed-in user.")
    space = current_space.get()
    action = str(arguments.get("action") or "").strip()
    title = str(arguments.get("title") or "").strip()

    try:
        if action == "list":
            return {"documents": store.notepad_list(user, space)}
        if action == "read":
            if not title:
                raise ToolError("title is required to read a note.")
            return {"document": store.notepad_read(user, space, title)}
        if action == "create":
            content = str(arguments.get("content") or "")
            if not title:
                raise ToolError("title is required to create a note.")
            try:
                return {"document": store.notepad_create(user, space, title, content)}
            except store.NotepadExists as exc:
                raise ToolError(
                    f"A note titled '{title}' already exists in this space. "
                    "Use the update action."
                ) from exc
        if action == "update":
            content = str(arguments.get("content") or "")
            if not title:
                raise ToolError("title is required to update a note.")
            document = store.notepad_update(user, space, title, content)
            if document is None:
                raise ToolError(
                    f"No note titled '{title}' in this space. Create it first."
                )
            return {"document": document}
        if action == "delete":
            if not title:
                raise ToolError("title is required to delete a note.")
            if not store.notepad_delete(user, space, title):
                raise ToolError(f"No note titled '{title}' in this space.")
            return {"deleted": title}
    except store.NotepadSpaceMissing as exc:
        # The space was resolved from the conversation, so this names a real
        # inconsistency rather than a typo the model can fix by retrying.
        raise ToolError(str(exc)) from exc
    raise ToolError(
        f"Unknown action {action!r}. Actions: list, read, create, update, delete."
    )


# ── context management ──────────────────────────────────────────────────────


async def manage_context(arguments: dict[str, Any]) -> dict[str, Any]:
    """Prune this turn's context: hide tool results you are done with.

    The reference prompt makes its equivalent non-disableable, and for the
    same reason it is always on here: a long turn of unpruned tool results
    pushes the ontology description out of a small model's window, and the
    model is the only one who knows which results it will not need again.

    Hiding is by tool name and only affects THIS turn. The agent loop does
    the actual replacement - it owns the message list - so this tool
    validates and records; the applied detail is added to its result before
    the model sees it.
    """
    state = _state()

    def _names(raw: Any, field: str) -> list[str]:
        if raw is None:
            return []
        if isinstance(raw, str):
            raw = [raw]
        names = [str(item).strip() for item in raw if str(item).strip()]
        if not names:
            raise ToolError(f"{field} needs at least one tool name.")
        return names

    hide = _names(arguments.get("hide"), "hide")
    unhide = _names(arguments.get("unhide"), "unhide")
    if not hide and not unhide:
        raise ToolError(
            "Pass hide and/or unhide - lists of tool names whose results to "
            "prune or restore for the rest of this turn."
        )
    state.pending_hide = hide
    state.pending_unhide = unhide
    return {
        "requested": {"hide": hide, "unhide": unhide},
        "note": (
            "The named tool results are replaced by a placeholder for the rest "
            "of this turn. Unhide them if you need them again; hiding cannot "
            "affect earlier turns."
        ),
    }


# ── ontology-backed capability tools ────────────────────────────────────────

def _localized(value: Any) -> str | None:
    """A LocalizedText ({en: ...}) or a plain string, as plain text."""
    if isinstance(value, dict):
        return value.get("en") or next(iter(value.values()), None)
    return value

# The docs corpus is generated per resource kind; a resource kind maps to the
# prefix its documentation lives under. Kinds with no generated docs are told
# so honestly, with the platform pages they can still read.
_DOC_PATHS = {
    "kpi": "metric/{ref}",
    "objectType": "object-type/{ref}",
    "actionType": "action/{ref}",
}


async def load_documentation(arguments: dict[str, Any]) -> dict[str, Any]:
    """Load one documentation page in full, by the path search returned.

    search_documentation finds; this reads. A claim worth citing is worth
    reading in context rather than in a scored excerpt.
    """
    path = str(arguments.get("path") or "").strip().strip("/")
    if not path:
        raise ToolError("path is required - a documentation path from search_documentation.")
    try:
        page = await client.get(f"/api/docs/page/{quote(path, safe='/')}")
    except ToolError as exc:
        index = await client.get("/api/docs")
        known = ", ".join(doc["path"] for doc in index[:20])
        raise ToolError(
            f"{exc} Documentation paths that exist include: {known}."
        ) from exc
    return page


async def get_resource_documentation(arguments: dict[str, Any]) -> dict[str, Any]:
    """The documentation page generated for one resource, by its kind and ref."""
    kind = str(arguments.get("kind") or "").strip()
    ref = str(arguments.get("ref") or "").strip()
    if not kind or not ref:
        raise ToolError("kind and ref are both required, e.g. kind=kpi, ref=order_count.")
    template = _DOC_PATHS.get(kind)
    if template is None:
        raise ToolError(
            f"No generated documentation for kind {kind!r}. Documented kinds: "
            + ", ".join(sorted(_DOC_PATHS))
            + "; platform pages (platform/...) cover the rest."
        )
    return await load_documentation({"path": template.format(ref=ref)})


async def get_access_requirements(arguments: dict[str, Any]) -> dict[str, Any]:
    """Who may read and operate a resource, and what gates the platform applies.

    This platform is deliberately plain about access: platform role decides
    which routes answer, space decides which ontology is read, ontology role
    decides which actions may run, and the generated-data gate refuses anything
    flagged as resting on generated data. There are no markings and no
    restricted views yet - saying so plainly is the feature; implying a
    classification exists when it does not would be the failure mode.
    """
    kind = str(arguments.get("resourceKind") or "").strip()
    ref = str(arguments.get("ref") or "").strip()

    me = await client.get("/api/auth/me")
    roles = await client.get("/api/roles")

    related: list[dict[str, Any]] = []
    if kind == "objectType" and ref:
        actions = await client.get("/api/action-types")
        related = [
            {
                "apiName": a["apiName"],
                "label": a["label"],
                "readOnly": a["isReadOnly"],
                "requiresApproval": a["requiresApproval"],
                "allowedRoles": a.get("allowedRoles") or [],
            }
            for a in actions
            if ref in (a.get("targetObjectTypes") or [])
        ]

    return {
        "resource": {"kind": kind or None, "ref": ref or None},
        "caller": {
            "username": me.get("username"),
            "platformRole": me.get("role"),
            "ontologyRole": me.get("ontologyRole"),
            "space": current_space.get(),
        },
        "accessModel": {
            "readRoutes": "platform role viewer or above",
            "buildRoutes": (
                "platform role analyst - syncs, schedules, object types, links, "
                "actions, metrics, function proposals, dashboards"
            ),
            "adminRoutes": (
                "platform role admin - function approval, audit trail, deletes"
            ),
            "actions": "ontology role, checked against each action's allowedRoles",
        },
        "ontologyRoles": [
            {
                # Roles are ontograph RoleDefinitions: identified by "@id"
                # ("tms:DispatcherRole") with LocalizedText labels. Neither is a
                # plain column, so both are unwrapped here rather than handed to
                # the model as raw objects.
                "name": str(role.get("@id") or "").split(":")[-1],
                "label": _localized(role.get("label")),
            }
            for role in roles
        ],
        "actionsOnThisObject": related,
        "gates": [
            "Space isolation: this conversation reads only its own space's ontology.",
            "Generated-data gate: anything flagged dependsOnSimulation is refused "
            "while ALLOW_SIMULATED_DATA is false. Nothing is flagged today.",
            "Connection credentials are never stored - only the name of the "
            "secret that holds them.",
            "No markings or restricted views are configured on this platform.",
        ],
    }


async def get_action_audit(arguments: dict[str, Any]) -> dict[str, Any]:
    """The action audit trail. The service answers admin only; the forwarded
    token decides, so a non-admin caller gets the service's own 403."""
    limit = min(int(arguments.get("limit") or 25), 100)
    rows = await client.get(f"/api/actions/audit?limit={limit}")
    return {
        "entries": rows if isinstance(rows, list) else rows.get("entries", []),
        "note": (
            "The ontology service answers this route for platform admins; this "
            "call ran with your token, so what you see is what you may read."
        ),
    }


async def browse_workspace(arguments: dict[str, Any]) -> dict[str, Any]:
    """Read the workspace tree: spaces, then projects, then folders/resources.

    The Compass shape - space, project, folder, resource - exists in the UI;
    this is the assistant's read-only window onto it. Connections, syncs and
    ontology objects are created through their own tools, which file their
    cards in the workspace themselves.
    """
    scope = str(arguments.get("scope") or "spaces").strip()
    space = current_space.get()

    if scope == "spaces":
        return {"spaces": await client.get("/api/spaces")}

    if scope == "projects":
        return {"space": space, "projects": await client.get(f"/api/spaces/{space}/projects")}

    if scope == "tree":
        project_id = arguments.get("projectId")
        if not project_id:
            raise ToolError(
                "tree scope needs projectId. Call scope=projects first to get one."
            )
        return {
            "space": space,
            "tree": await client.get(f"/api/spaces/{space}/projects/{project_id}/tree"),
        }

    raise ToolError(f"Unknown scope {scope!r}. Scopes: spaces, projects, tree.")


async def list_functions(arguments: dict[str, Any]) -> dict[str, Any]:
    """The metric function catalogue, with where each definition stands.

    The proposed/active split is the gate that matters: a proposed function
    computes nothing and no dashboard may use it, so knowing the status of a
    definition is knowing whether it can back an answer.
    """
    status = str(arguments.get("status") or "").strip()
    path = "/api/functions" + (f"?status={quote(status)}" if status else "")
    rows = await client.get(path)
    if isinstance(rows, dict):
        rows = rows.get("functions", [])
    return {
        "functions": [
            {
                "apiName": f["apiName"],
                "name": f["name"],
                "status": f["status"],
                "language": f.get("language"),
                "executable": f.get("isExecutable"),
                "description": f.get("description"),
            }
            for f in rows[:30]
        ],
        "rowsShown": min(len(rows), 30),
        "rowsTotal": len(rows),
        "note": (
            "proposed computes nothing and cannot back a dashboard; active can."
        ),
    }


async def list_schedules(_: dict[str, Any]) -> dict[str, Any]:
    """How often each sync runs in this space, and how its last run went."""
    rows = await client.get("/api/schedules")
    return {
        "schedules": [
            {
                "name": s["name"],
                "syncId": s["targetRef"],
                "every": s.get("every") or f"every {s['intervalSeconds']}s",
                "enabled": s["enabled"],
                "nextRunAt": s["nextRunAt"],
                "lastStatus": s["lastStatus"],
                "lastError": s["lastError"],
                "runCount": s["runCount"],
            }
            for s in rows
        ],
        "note": (
            "Enabled schedules run their sync automatically; lastStatus 'failed' means "
            "the sync errored and the reason is in lastError. schedule_sync changes one."
        ),
    }


# ── registry and schemas ────────────────────────────────────────────────────

CAPABILITY_TOOLS: dict[str, Any] = {
    "change_mode": change_mode,
    "enable_capabilities": enable_capabilities,
    "disable_capabilities": disable_capabilities,
    "generate_plan": generate_plan,
    "manage_plan": manage_plan,
    "manage_todo_list": manage_todo_list,
    "notepad": notepad,
    "manage_context": manage_context,
    "load_documentation": load_documentation,
    "get_resource_documentation": get_resource_documentation,
    "get_access_requirements": get_access_requirements,
    "get_action_audit": get_action_audit,
    "browse_workspace": browse_workspace,
    "list_functions": list_functions,
    "list_schedules": list_schedules,
}


def _schema(name: str, description: str, properties: dict[str, Any],
            required: list[str] | None = None) -> dict[str, Any]:
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


CAPABILITY_TOOL_SCHEMAS: list[dict[str, Any]] = [
    _schema(
        "change_mode",
        "Switch your operational mode, which changes which tools are loaded. "
        "Switch when the task moves to a different kind of work - syncing data "
        "(dataConnection), building object types, links, actions and metrics "
        "(ontologyEditing), functions, dashboards, governance. The turn continues "
        "with the new tool set; capabilities you enabled stay on.",
        {
            "mode": {
                "type": "string",
                "description": (
                    "One of: " + ", ".join(sorted(MODES)) + "."
                ),
            }
        },
        ["mode"],
    ),
    _schema(
        "enable_capabilities",
        "Enable capabilities - tools that stay available across mode switches, "
        "such as notepad, plan writing, or browsing the workspace. Refused "
        "honestly for capabilities this platform does not implement.",
        {
            "capabilities": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Capability names to enable.",
            }
        },
        ["capabilities"],
    ),
    _schema(
        "disable_capabilities",
        "Disable capabilities you no longer need, to keep the tool set small.",
        {
            "capabilities": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Capability names to disable.",
            }
        },
        ["capabilities"],
    ),
    _schema(
        "generate_plan",
        "Write the step-by-step plan for multi-step work BEFORE doing it, so "
        "the user can see and follow the steps. Use for anything with three or "
        "more distinct steps - building a dashboard, preparing a proposal, "
        "investigating a data-quality question.",
        {
            "title": {"type": "string", "description": "What this plan delivers."},
            "background": {"type": "string", "description": "Optional context."},
            "steps": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Each step in one line, in order.",
            },
            "overwrite": {
                "type": "boolean",
                "description": "Replace an existing plan. Default false.",
            },
        },
        ["title", "steps"],
    ),
    _schema(
        "manage_plan",
        "Update the conversation's plan as you work: start, complete or skip "
        "steps (1-based index), add or remove steps. Call it AS steps finish, "
        "not at the end - the user is watching progress.",
        {
            "action": {
                "type": "string",
                "enum": [
                    "read", "start_step", "complete_step", "skip_step",
                    "add_step", "remove_step", "update_step", "set_background",
                ],
            },
            "index": {"type": "integer", "description": "1-based step number."},
            "description": {"type": "string"},
            "background": {"type": "string"},
        },
        ["action"],
    ),
    _schema(
        "manage_todo_list",
        "Keep a small checklist of follow-ups agreed during the conversation.",
        {
            "action": {"type": "string", "enum": ["read", "add", "set_status", "remove", "clear"]},
            "text": {"type": "string"},
            "index": {"type": "integer", "description": "1-based."},
            "status": {"type": "string", "enum": ["open", "done"]},
        },
        ["action"],
    ),
    _schema(
        "notepad",
        "Persistent notes for this space, surviving the conversation: list, "
        "read, create, update or delete. Use when the user says to write "
        "something down or asks what was noted before.",
        {
            "action": {"type": "string", "enum": ["list", "read", "create", "update", "delete"]},
            "title": {"type": "string"},
            "content": {"type": "string", "description": "Markdown body."},
        },
        ["action"],
    ),
    _schema(
        "manage_context",
        "Hide tool results you are finished with for the rest of this turn - "
        "large row dumps especially - so they stop spending context. Unhide "
        "restores them. Affects only this turn.",
        {
            "hide": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Tool names whose results to hide.",
            },
            "unhide": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Tool names whose results to restore.",
            },
        },
    ),
    _schema(
        "load_documentation",
        "Load one documentation page in full, by the path a "
        "search_documentation result gave you. Use when a scored excerpt is "
        "not enough to answer or cite accurately.",
        {"path": {"type": "string", "description": "e.g. platform/data-flow"}},
        ["path"],
    ),
    _schema(
        "get_resource_documentation",
        "Load the documentation page generated for one resource, by kind and "
        "ref - kpi, objectType or actionType.",
        {
            "kind": {"type": "string", "enum": ["kpi", "objectType", "actionType"]},
            "ref": {"type": "string", "description": "The resource's api name."},
        },
        ["kind", "ref"],
    ),
    _schema(
        "get_access_requirements",
        "Report who can read or operate a resource: the caller's roles, the "
        "access model, and the gates this platform applies. Use when someone "
        "asks who may see or change something, or before proposing work that "
        "needs a permission.",
        {
            "resourceKind": {
                "type": "string",
                "description": "objectType, kpi, dashboard, actionType, ...",
            },
            "ref": {"type": "string", "description": "The resource's api name or slug."},
        },
    ),
    _schema(
        "get_action_audit",
        "Read the action audit trail - who ran what, staged or applied. The "
        "ontology service answers for platform admins; the call runs with the "
        "signed-in user's token.",
        {"limit": {"type": "integer", "description": "Default 25, max 100."}},
    ),
    _schema(
        "browse_workspace",
        "Browse the workspace: scope=spaces lists the environments; "
        "scope=projects lists projects in this space; scope=tree needs a "
        "projectId and returns its folders and resources.",
        {
            "scope": {"type": "string", "enum": ["spaces", "projects", "tree"]},
            "projectId": {"type": "integer"},
        },
    ),
    _schema(
        "list_schedules",
        "List how often each sync runs in this space, whether it is enabled, and "
        "how its last run went. Use for 'what refreshes automatically' or 'why is "
        "this dataset stale' questions.",
        {},
    ),
    _schema(
        "list_functions",
        "List the metric function catalogue and each definition's status. "
        "proposed computes nothing and cannot back a dashboard; active can. "
        "Use before proposing a new function, so a duplicate is not drafted.",
        {"status": {"type": "string", "description": "proposed, active, rejected or archived."}},
    ),
]
