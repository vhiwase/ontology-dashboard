"""Modes and capabilities - the structure Palantir's AI-FDE prompt gives its
assistant, and this platform's implementation of it.

The reference prompt (secrets/prompt) does not hand the assistant one flat tool
list. It loads a MODE - a named bundle of tool categories plus the documentation
for the task at hand - and layers toggleable CAPABILITIES on top, which stay
enabled across mode switches. The point is context economy and least privilege:
a question about the platform does not need the ontology builder, and building
a dashboard does not need the sync tools, so neither turn pays for the other's
schemas.

The modes follow the platform's one path:

    dataConnection   connection -> sync (on a schedule) -> dataset
    ontologyEditing  dataset -> object types, links, actions, metrics
    functionsEditing metric functions over datasets, for a person to approve
    exploration      answering questions from what was built
    applicationBuilding  dashboards on the metrics

Capabilities the reference lists but this platform cannot honour honestly -
subagents, skills, an issue tracker - are declared NOT_IMPLEMENTED and refuse,
rather than being offered and doing nothing.

Session state (the active mode, enabled capabilities, plan, todos) is context
the agent loop reads each round; it is persisted onto the chat session so a
conversation keeps its mode across restarts.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# ── the session's agent state ───────────────────────────────────────────────


@dataclass
class SessionAgentState:
    """Everything about the conversation that outlives a single turn."""

    mode: str = "exploration"
    capabilities: set[str] = field(default_factory=set)
    # One plan and one checklist per conversation, created by the plan tools.
    plan: dict[str, Any] | None = None
    todos: list[dict[str, Any]] = field(default_factory=list)
    # Tool results hidden this turn by manage_context, kept so unhide can
    # restore them. Never persisted: hidden context is a within-turn concern.
    stashed: dict[str, str] = field(default_factory=dict)
    # Validated by the manage_context tool, applied (and cleared) by the agent
    # loop, which owns the message list the hiding actually happens to.
    pending_hide: list[str] = field(default_factory=list)
    pending_unhide: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "capabilities": sorted(self.capabilities),
            "plan": self.plan,
            "todos": self.todos,
        }


# ── capabilities ────────────────────────────────────────────────────────────
# The reference prompt's capability list, mapped onto this platform. A
# capability names the tools enabling it adds; the always-on ones below are
# not listed because they cannot be turned off.

CAPABILITIES: dict[str, dict[str, Any]] = {
    "notepad": {
        "label": "Notepad",
        "description": "Create, read and update persistent notes for this space.",
        "tools": ["notepad"],
    },
    "generatePlan": {
        "label": "Plan proposal",
        "description": "Write a step-by-step plan for the work you are about to do.",
        "tools": ["generate_plan"],
    },
    "managePlan": {
        "label": "Plan management",
        "description": "Update the conversation's plan as steps are completed.",
        "tools": ["manage_plan"],
    },
    "manageTodoList": {
        "label": "Todo list",
        "description": "Keep a lightweight checklist for the conversation.",
        "tools": ["manage_todo_list"],
    },
    "executeAction": {
        "label": "Execute actions",
        "description": (
            "Run read-only ontology actions from the conversation. Mutating "
            "actions stay refused regardless of this capability."
        ),
        "tools": ["apply_action"],
    },
    "viewPermissions": {
        "label": "View permissions",
        "description": "Report who can read or operate a resource, and what gates apply.",
        "tools": ["get_access_requirements", "get_action_audit"],
    },
    "resourceDocumentation": {
        "label": "Resource documentation",
        "description": "Load the full documentation page for one resource.",
        "tools": ["get_resource_documentation"],
    },
    "filesystem": {
        "label": "Filesystem",
        "description": "Browse the workspace: spaces, projects, folders, resources.",
        "tools": ["browse_workspace"],
    },
}

# Capabilities the reference prompt names that this platform deliberately does
# not fake. enable_capabilities answers with the reason rather than silently
# enabling nothing, which would be the dishonest version of the feature.
NOT_IMPLEMENTED: dict[str, str] = {
    "subagents": "No sub-agent runtime is available in this service.",
    "loadSkills": "There is no skill registry on this platform yet.",
    "editSkills": "There is no skill registry on this platform yet.",
    "foundryIssues": "This platform has no issue tracker to attach to.",
    "workflowLineage": (
        "A dataset's lineage is its sync and an object type's is its dataset; "
        "list_datasets and describe_object_type report both."
    ),
    "solutionDesign": (
        "Covered by Mermaid diagrams in answers rather than a separate tool - "
        "no capability to enable."
    ),
}

# Always on, in every mode: the meta-tools. manage_context mirrors the
# reference prompt's rule that its own equivalent must not be disabled.
ALWAYS_ON = [
    "change_mode",
    "enable_capabilities",
    "disable_capabilities",
    "request_clarification",
    "search_documentation",
    "load_documentation",
    "manage_context",
]

# ── modes ───────────────────────────────────────────────────────────────────
# Named after the reference prompt's modes. `docs` names documentation pages
# handed to the model as required reading for the mode; `introduction` is one
# sentence of what the mode is for, which the change_mode result quotes back.

MODES: dict[str, dict[str, Any]] = {
    "exploration": {
        "label": "Exploration",
        "introduction": (
            "Answer business questions from the ontology: objects, links, "
            "metrics and the datasets behind them."
        ),
        "tools": [
            "list_object_types",
            "describe_object_type",
            "search_objects",
            "aggregate_objects",
            "traverse_link",
            "list_kpis",
            "execute_kpi",
            "list_datasets",
            "list_dashboards",
            "list_actions",
            "global_search",
        ],
        "docs": ["platform/data-quality"],
    },
    "dataConnection": {
        "label": "Data connection",
        "introduction": (
            "Bring data in: list connections and the views they can read, sync "
            "a view into a dataset as it is, and set how often it refreshes."
        ),
        "tools": [
            "list_connections",
            "list_source_views",
            "create_sync",
            "run_sync",
            "schedule_sync",
            "list_syncs",
            "list_schedules",
            "list_datasets",
            "profile_dataset",
        ],
        "docs": ["platform/data-flow", "platform/schedules"],
    },
    "ontologyEditing": {
        "label": "Ontology building",
        "introduction": (
            "Build the ontology from datasets: create object types, link them, "
            "and define the actions and metrics that make them useful."
        ),
        "tools": [
            "list_datasets",
            "profile_dataset",
            "list_object_types",
            "describe_object_type",
            "create_object_type",
            "suggest_links",
            "create_link_type",
            "create_metric",
            "create_action_type",
            "delete_ontology_object",
            "list_kpis",
            "execute_kpi",
            "list_actions",
            "list_functions",
            "propose_function",
        ],
        "docs": ["platform/building-the-ontology", "platform/data-quality"],
    },
    "functionsEditing": {
        "label": "Functions editing",
        "introduction": (
            "Work with metric functions: what is proposed, what is active, and "
            "drafting new definitions over datasets for a person to approve."
        ),
        "tools": [
            "list_datasets",
            "profile_dataset",
            "describe_object_type",
            "list_kpis",
            "execute_kpi",
            "create_metric",
            "list_functions",
            "propose_function",
        ],
        "docs": ["platform/building-the-ontology"],
    },
    "governance": {
        "label": "Governance",
        "introduction": (
            "Answer who may do what: roles, action permissions, the audit "
            "trail, and what the data behind a figure is allowed to be."
        ),
        "tools": [
            "list_actions",
            "list_object_types",
            "list_datasets",
            "global_search",
            "get_access_requirements",
            "get_action_audit",
        ],
        "docs": ["platform/roles", "platform/actions"],
    },
    "applicationBuilding": {
        "label": "Application building",
        "introduction": (
            "Build dashboards on the metric catalogue, adding a metric first "
            "where one the dashboard needs is missing."
        ),
        "tools": [
            "list_object_types",
            "describe_object_type",
            "list_kpis",
            "execute_kpi",
            "create_metric",
            "list_dashboards",
            "create_dashboard",
            "propose_function",
        ],
        "docs": [],
    },
    "platformQna": {
        "label": "Platform Q&A",
        "introduction": (
            "Answer questions about the platform itself from its documentation "
            "and catalogue, without touching operational tools."
        ),
        "tools": [
            "list_object_types",
            "list_kpis",
            "list_datasets",
            "list_dashboards",
            "list_actions",
        ],
        "docs": ["platform/data-flow", "platform/roles", "platform/spaces"],
    },
}

DEFAULT_MODE = "exploration"


def resolve_mode(name: str | None) -> str:
    """The canonical mode name, or a ValueError naming the valid ones."""
    if not name:
        raise ValueError(f"A mode name is required. Modes: {', '.join(sorted(MODES))}.")
    key = str(name).strip()
    # Accept the camelCase the reference prompt uses and the lowercase a small
    # model will emit.
    for mode in MODES:
        if key.lower() == mode.lower():
            return mode
    raise ValueError(
        f"Unknown mode {name!r}. Modes: {', '.join(sorted(MODES))}."
    )


def tools_for(state: SessionAgentState) -> set[str]:
    """The tool names available in this state: mode set, plus capabilities."""
    mode = MODES.get(state.mode, MODES[DEFAULT_MODE])
    names = set(ALWAYS_ON) | set(mode["tools"])
    for capability in state.capabilities:
        entry = CAPABILITIES.get(capability)
        if entry:
            names.update(entry["tools"])
    return names
