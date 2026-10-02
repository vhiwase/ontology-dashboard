"""The mode/capability layer: gating, plans, todos, context hiding.

No database and no model are touched. The stateful tools operate on a
SessionAgentState placed in the same contextvar the agent loop uses, and the
gating tests call run_tool directly - the assertion that matters is that a
tool outside the current mode or capabilities is refused with the instruction
that recovers it, not that the provider never sees the schema.

The suite stays synchronous like the rest of this service's tests: the
coroutines are driven with asyncio.run, which copies the current context, so
the fixture-set contextvar is visible inside them.
"""

from __future__ import annotations

import asyncio
import os

os.environ.setdefault("AUTH_JWT_SECRET", "test-secret-at-least-thirty-two-characters-long")
os.environ.setdefault("DATABASE_URL", "postgresql://unused:unused@127.0.0.1:1/unused")

import pytest  # noqa: E402

from app import tools  # noqa: E402
from app.context import current_session_state  # noqa: E402
from app.modes import (  # noqa: E402
    ALWAYS_ON,
    CAPABILITIES,
    MODES,
    NOT_IMPLEMENTED,
    SessionAgentState,
    resolve_mode,
    tools_for,
)

RunResult = tuple[dict, bool]


def _run(coro) -> RunResult:
    return asyncio.run(coro)


@pytest.fixture
def state():
    token = current_session_state.set(SessionAgentState())
    yield current_session_state.get()
    current_session_state.reset(token)


# ── the mode model itself ───────────────────────────────────────────────────


def test_default_mode_is_exploration_with_core_tools(state):
    assert state.mode == "exploration"
    available = tools_for(state)
    for name in ALWAYS_ON:
        assert name in available
    for name in ("list_kpis", "execute_kpi", "search_objects", "list_datasets"):
        assert name in available
    # Capability-gated tools are absent until their capability is enabled.
    for name in ("notepad", "apply_action", "generate_plan", "browse_workspace"):
        assert name not in available


def test_every_mode_tool_and_capability_tool_is_registered():
    """A mode or capability naming an unregistered tool would hide a schema
    that never existed and gate a call that could never run."""
    registered = set(tools.TOOL_IMPLEMENTATIONS)
    for mode, entry in MODES.items():
        for name in entry["tools"]:
            assert name in registered, f"{mode} names unregistered tool {name}"
    for capability, entry in CAPABILITIES.items():
        for name in entry["tools"]:
            assert name in registered, f"{capability} names unregistered tool {name}"


def test_resolve_mode_accepts_case_variants_and_rejects_the_rest():
    assert resolve_mode("applicationBuilding") == "applicationBuilding"
    assert resolve_mode("ApplicationBuilding") == "applicationBuilding"
    assert resolve_mode(" dataConnection ") == "dataConnection"
    # The pipeline and machine-learning modes went with the pipeline builder.
    for gone in ("dataIntegration", "machineLearning"):
        with pytest.raises(ValueError, match="Unknown mode"):
            resolve_mode(gone)
    with pytest.raises(ValueError, match="Unknown mode"):
        resolve_mode("workshop")


def test_schemas_for_filters_the_full_list(state):
    available = tools_for(state)
    schemas = tools.schemas_for(available)
    names = {s["function"]["name"] for s in schemas}
    assert names == available
    assert len(schemas) < len(tools.tool_schemas())


def _walk_properties(schema: dict, path: str, problems: list[str]) -> None:
    """Every schema node below `properties`/`items` must itself be an object.

    The failure this catches: passing a whole parameters object where a
    properties dict belongs, which produces a property named "type" whose
    schema is the string "object" - and Azure rejects the ENTIRE tool list
    with 400 'Invalid schema for property ... expected object for schema,
    got string', so every chat turn dies, not just the malformed tool's.
    """
    for key, value in schema.items():
        if key in ("properties",) and isinstance(value, dict):
            for prop_name, prop_schema in value.items():
                where = f"{path}.{prop_name}"
                if not isinstance(prop_schema, dict):
                    problems.append(
                        f"{where}: schema must be an object, got {type(prop_schema).__name__}"
                    )
                    continue
                _walk_properties(prop_schema, where, problems)
        elif key == "items":
            if isinstance(value, list):
                for index, item in enumerate(value):
                    if isinstance(item, dict):
                        _walk_properties(item, f"{path}.items[{index}]", problems)
            elif isinstance(value, dict):
                _walk_properties(value, f"{path}.items", problems)
        elif key in ("anyOf", "oneOf", "allOf") and isinstance(value, list):
            for index, item in enumerate(value):
                if isinstance(item, dict):
                    _walk_properties(item, f"{path}.{key}[{index}]", problems)


def test_every_tool_schema_is_well_formed():
    schemas = tools.tool_schemas()
    assert len(schemas) >= 30, f"Expected the full tool list, got {len(schemas)}"

    problems: list[str] = []
    seen: set[str] = set()
    for schema in schemas:
        function = schema["function"]
        name = function["name"]
        assert isinstance(name, str) and name.strip() and name not in seen, name
        seen.add(name)
        assert isinstance(function["description"], str) and function["description"].strip(), name

        parameters = function["parameters"]
        assert isinstance(parameters, dict), f"{name}: parameters must be an object"
        assert parameters.get("type") == "object", f"{name}: parameters.type must be 'object'"
        properties = parameters.get("properties", {})
        assert isinstance(properties, dict), f"{name}: properties must be an object"
        for required in parameters.get("required", []):
            assert required in properties, f"{name}: required '{required}' is not a property"
        _walk_properties(parameters, name, problems)

    assert not problems, "\n".join(problems)


# ── mode switching and capabilities ─────────────────────────────────────────


def test_change_mode_switches_and_reports(state):
    payload, ok = _run(tools.run_tool("change_mode", {"mode": "applicationBuilding"}))
    assert ok
    assert state.mode == "applicationBuilding"
    assert "create_dashboard" in payload["toolsNowAvailable"]
    assert "create_object_type" not in payload["toolsNowAvailable"]


def test_change_mode_rejects_unknown(state):
    payload, ok = _run(tools.run_tool("change_mode", {"mode": "workshop"}))
    assert not ok
    assert "Modes:" in payload["error"]
    assert state.mode == "exploration"


def test_enable_capabilities_adds_tools_and_refuses_honestly(state):
    payload, ok = _run(
        tools.run_tool("enable_capabilities", {"capabilities": ["notepad", "subagents"]})
    )
    assert ok
    assert "notepad" in payload["enabled"]
    assert "notepad" in tools_for(state)
    assert payload["refused"]["subagents"] == NOT_IMPLEMENTED["subagents"]


def test_disable_capabilities_removes_tools(state):
    state.capabilities.add("executeAction")
    payload, ok = _run(
        tools.run_tool("disable_capabilities", {"capabilities": ["executeAction"]})
    )
    assert ok
    assert "executeAction" not in state.capabilities
    assert "apply_action" not in tools_for(state)


# ── run-time gating ─────────────────────────────────────────────────────────


def test_gated_tool_is_refused_with_recovery_instruction(state):
    payload, ok = _run(tools.run_tool("notepad", {"action": "list"}))
    assert not ok
    assert "enable_capabilities" in payload["error"]


def test_tool_outside_the_mode_points_at_the_mode(state):
    state.mode = "platformQna"
    payload, ok = _run(tools.run_tool("execute_kpi", {"kpi": "order_count"}))
    assert not ok
    assert "change_mode" in payload["error"]
    assert "exploration" in payload["error"]


def test_each_step_of_the_flow_lives_in_its_mode(state):
    """Syncing lives in dataConnection, building in ontologyEditing - and
    neither can write from exploration, where a question should not be able
    to change the ontology on its way to an answer."""
    connection = tools_for(SessionAgentState(mode="dataConnection"))
    for name in ("list_connections", "list_source_views", "create_sync", "schedule_sync", "list_schedules"):
        assert name in connection, name

    building = tools_for(SessionAgentState(mode="ontologyEditing"))
    for name in (
        "list_datasets", "profile_dataset", "create_object_type", "suggest_links",
        "create_link_type", "create_metric", "create_action_type", "propose_function",
    ):
        assert name in building, name

    exploring = tools_for(SessionAgentState(mode="exploration"))
    for name in ("create_sync", "create_object_type", "create_link_type", "create_action_type", "delete_ontology_object"):
        assert name not in exploring, name
    assert "list_schedules" not in tools_for(SessionAgentState(mode="platformQna"))


def test_a_build_call_from_exploration_says_which_mode_to_switch_to(state):
    payload, ok = _run(tools.run_tool("create_object_type", {"dataset": "v_order"}))
    assert not ok
    assert 'mode="ontologyEditing"' in payload["error"]


def test_removed_tools_are_gone():
    for name in ("propose_pipeline", "get_lineage", "get_data_coverage", "get_exceptions", "list_interfaces"):
        assert name not in tools.TOOL_IMPLEMENTATIONS, name


def test_always_on_tools_are_in_every_mode_set(state):
    for mode in MODES:
        probe = SessionAgentState(mode=mode)
        for name in ALWAYS_ON:
            assert name in tools_for(probe), f"{name} missing from mode {mode}"


# ── plans ───────────────────────────────────────────────────────────────────


def _with_plan_capabilities(state) -> None:
    """The plan/todo tools are capability-gated like any other; the tests that
    exercise them enable them the way the model would."""
    state.capabilities.update({"generatePlan", "managePlan", "manageTodoList"})


def test_generate_plan_then_complete_it(state):
    _with_plan_capabilities(state)
    payload, ok = _run(
        tools.run_tool(
            "generate_plan",
            {"title": "Freight finance dashboard", "steps": ["list KPIs", "build layout"]},
        )
    )
    assert ok
    assert state.plan["title"] == "Freight finance dashboard"
    assert [s["status"] for s in state.plan["steps"]] == ["pending", "pending"]

    _, ok = _run(tools.run_tool("manage_plan", {"action": "start_step", "index": 1}))
    assert ok and state.plan["steps"][0]["status"] == "in_progress"

    _run(tools.run_tool("manage_plan", {"action": "complete_step", "index": 1}))
    _run(tools.run_tool("manage_plan", {"action": "complete_step", "index": 2}))
    assert state.plan["status"] == "complete"


def test_generate_plan_refuses_silent_overwrite(state):
    _with_plan_capabilities(state)
    _run(tools.run_tool("generate_plan", {"title": "First", "steps": ["a"]}))
    payload, ok = _run(tools.run_tool("generate_plan", {"title": "Second", "steps": ["b"]}))
    assert not ok
    assert "overwrite" in payload["error"]
    assert state.plan["title"] == "First"

    # overwrite is a schema field on the tool itself, so it is exercised there.
    from app.capability_tools import generate_plan

    asyncio.run(generate_plan({"title": "Second", "steps": ["b"], "overwrite": True}))
    assert state.plan["title"] == "Second"


def test_manage_plan_index_and_missing_plan_errors(state):
    _with_plan_capabilities(state)
    payload, ok = _run(tools.run_tool("manage_plan", {"action": "read"}))
    assert not ok and "generate_plan" in payload["error"]

    _run(tools.run_tool("generate_plan", {"title": "P", "steps": ["only"]}))
    payload, ok = _run(tools.run_tool("manage_plan", {"action": "complete_step", "index": 5}))
    assert not ok and "between 1 and 1" in payload["error"]


def test_manage_todo_list_lifecycle(state):
    _with_plan_capabilities(state)
    _run(tools.run_tool("manage_todo_list", {"action": "add", "text": "send lane list"}))
    _run(
        tools.run_tool(
            "manage_todo_list", {"action": "set_status", "index": 1, "status": "done"}
        )
    )
    payload, ok = _run(tools.run_tool("manage_todo_list", {"action": "read"}))
    assert payload["todos"][0]["status"] == "done"
    _run(tools.run_tool("manage_todo_list", {"action": "clear"}))
    assert state.todos == []


def test_manage_todo_list_validates_status(state):
    _with_plan_capabilities(state)
    _run(tools.run_tool("manage_todo_list", {"action": "add", "text": "x"}))
    payload, ok = _run(
        tools.run_tool(
            "manage_todo_list", {"action": "set_status", "index": 1, "status": "later"}
        )
    )
    assert not ok and "open or done" in payload["error"]


# ── context management ──────────────────────────────────────────────────────


def _agent():
    from app.agent import Agent

    return Agent(provider=None)


def _transcript() -> list[dict]:
    return [
        {"role": "system", "content": "system"},
        {"role": "user", "content": "question"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "call_a",
                    "type": "function",
                    "function": {"name": "search_objects", "arguments": "{}"},
                }
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "call_a",
            "name": "search_objects",
            "content": '{"rows": [1, 2, 3]}',
        },
    ]


def test_manage_context_records_pending_and_agent_applies(state):
    payload, ok = _run(tools.run_tool("manage_context", {"hide": ["search_objects"]}))
    assert ok
    # The tool records intent; the agent loop applies it where the messages live.
    assert state.pending_hide == ["search_objects"]

    messages = _transcript()
    _agent()._apply_context_operations(state, messages, payload)
    assert state.pending_hide == []
    assert "[hidden by manage_context" in messages[3]["content"]
    assert state.stashed["call_a"] == '{"rows": [1, 2, 3]}'


def test_manage_context_unhide_restores(state):
    payload, ok = _run(tools.run_tool("manage_context", {"hide": ["search_objects"]}))
    messages = _transcript()
    _agent()._apply_context_operations(state, messages, payload)

    payload, ok = _run(tools.run_tool("manage_context", {"unhide": ["search_objects"]}))
    _agent()._apply_context_operations(state, messages, payload)
    assert messages[3]["content"] == '{"rows": [1, 2, 3]}'
    assert state.stashed == {}


def test_manage_context_requires_at_least_one_direction(state):
    payload, ok = _run(tools.run_tool("manage_context", {}))
    assert not ok
    assert "hide and/or unhide" in payload["error"]


def test_context_hiding_touches_only_named_tools(state):
    messages = _transcript()
    messages.append(
        {"role": "tool", "tool_call_id": "call_b", "name": "list_kpis", "content": "keep me"}
    )
    payload: dict = {}
    state.pending_hide = ["list_kpis"]
    _agent()._apply_context_operations(state, messages, payload)
    assert messages[3]["content"] == '{"rows": [1, 2, 3]}'
    assert "[hidden by manage_context" in messages[4]["content"]
    assert payload["applied"] == {"hidden": ["list_kpis"], "unhidden": []}


# ── writes and the duplicate-call cache ─────────────────────────────────────


def test_a_write_empties_the_cache_so_a_later_read_is_fresh(state, monkeypatch):
    """list_object_types, then create_object_type, then list_object_types again
    must see the new type - not the cached empty list from before the write."""
    from app import agent as agent_module
    from app.llm import ToolCall

    calls: list[str] = []

    async def fake_run_tool(name, arguments):
        calls.append(name)
        return {"n": len(calls)}, True

    monkeypatch.setattr(agent_module, "run_tool", fake_run_tool)
    runner = _agent()
    cache: dict = {}
    read = ToolCall(id="a", name="list_object_types", arguments={})
    write = ToolCall(id="b", name="create_object_type", arguments={"dataset": "v_order"})

    asyncio.run(runner._invoke(read, cache))
    cached, _, _ = asyncio.run(runner._invoke(read, cache))
    assert "_note" in cached and calls == ["list_object_types"]

    asyncio.run(runner._invoke(write, cache))
    fresh, _, _ = asyncio.run(runner._invoke(read, cache))
    assert "_note" not in fresh
    assert calls == ["list_object_types", "create_object_type", "list_object_types"]


def test_create_sync_reports_a_failed_first_run_rather_than_hiding_it(state, monkeypatch):
    from app.tools import ToolError

    async def fake_post(path, body=None):
        if path.endswith("/syncs"):
            return {"id": 7, "targetRelation": "connection_raw.db__tms_views__v_order"}
        if path.endswith("/run"):
            raise ToolError("POST /api/syncs/7/run failed (400): the view went away")
        if path.endswith("/schedule"):
            return {"schedule": {"every": "every 2 hours"}}
        raise AssertionError(path)

    monkeypatch.setattr(tools.client, "post", fake_post)
    state.mode = "dataConnection"
    payload, ok = _run(
        tools.run_tool(
            "create_sync",
            {"connectionId": 1, "sourceSchema": "tms_views", "sourceTable": "v_order", "every": "2h"},
        )
    )
    assert ok
    assert payload["created"] and payload["syncId"] == 7
    assert payload["run"]["status"] == "failed" and "went away" in payload["run"]["error"]
    assert payload["schedule"] == "every 2 hours"


def test_create_metric_keeps_meaningful_false_values(state, monkeypatch):
    sent: dict = {}

    async def fake_post(path, body=None):
        sent.update(body or {})
        return {"apiName": "open_orders", "objectType": "Order", "value": 61, "dimensions": []}

    monkeypatch.setattr(tools.client, "post", fake_post)
    state.mode = "ontologyEditing"
    _run(
        tools.run_tool(
            "create_metric",
            {
                "apiName": "open_orders",
                "objectType": "Order",
                "aggregation": "count",
                "where": {"isClosed": False},
                "higherIsBetter": False,
                "dimensions": [],
            },
        )
    )
    # false is a condition and a direction, not an absence of one.
    assert sent["where"] == {"isClosed": False}
    assert sent["higherIsBetter"] is False
    assert "dimensions" not in sent
