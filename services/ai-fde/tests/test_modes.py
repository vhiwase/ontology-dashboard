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
    for name in ("list_kpis", "execute_kpi", "search_objects", "get_lineage"):
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
    assert resolve_mode(" dataIntegration ") == "dataIntegration"
    with pytest.raises(ValueError, match="Unknown mode"):
        resolve_mode("workshop")


def test_schemas_for_filters_the_full_list(state):
    available = tools_for(state)
    schemas = tools.schemas_for(available)
    names = {s["function"]["name"] for s in schemas}
    assert names == available
    assert len(schemas) < len(tools.tool_schemas())


# ── mode switching and capabilities ─────────────────────────────────────────


def test_change_mode_switches_and_reports(state):
    payload, ok = _run(tools.run_tool("change_mode", {"mode": "applicationBuilding"}))
    assert ok
    assert state.mode == "applicationBuilding"
    assert "create_dashboard" in payload["toolsNowAvailable"]
    assert "get_exceptions" not in payload["toolsNowAvailable"]


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
