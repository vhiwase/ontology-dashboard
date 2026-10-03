"""Tests for the prompt assembly, turn pricing and the agent loop."""

from __future__ import annotations

import asyncio
import dataclasses
import os

os.environ.setdefault("AUTH_JWT_SECRET", "test-secret-at-least-thirty-two-characters-long")
os.environ.setdefault("DATABASE_URL", "postgresql://unused:unused@127.0.0.1:1/unused")

from app import agent as agent_module  # noqa: E402
from app import llm as llm_module  # noqa: E402
from app.pricing import price_turn  # noqa: E402
from app.prompts import (  # noqa: E402
    SYSTEM_PROMPT,
    TMS_ADDENDUM,
    TMS_STARTERS,
    build_context_message,
    is_tms,
    starter_prompts,
)

WORKSPACE = {
    "ontologyVersion": "1.0.0",
    "space": {"slug": "u-maria", "name": "maria's workspace", "kind": "personal"},
    "counts": {"dashboards": 1, "reports": 0, "pendingProposals": 2},
    "objectTypes": [
        {"apiName": "OrderDetail", "label": "Order Detail", "pluralLabel": "Order Details", "rowCount": 2155},
        {"apiName": "Order", "label": "Order", "pluralLabel": "Orders", "rowCount": 830},
        {"apiName": "Customer", "label": "Customer", "pluralLabel": "Customers", "rowCount": 91},
    ],
    "links": [{"apiName": "orderCustomer", "source": "Order", "target": "Customer"}],
    "kpis": [
        {"apiName": "order_count", "label": "Orders", "format": "integer", "aggregation": "count", "objectType": "Order", "dimensions": ["ship_country", "order_date:day", "order_date:month"]},
        {"apiName": "order_freight_sum", "label": "Total Freight", "format": "currency", "aggregation": "sum", "objectType": "Order", "unit": None, "dimensions": ["ship_country", "order_date:month"]},
    ],
    "coverage": [],
}

TMS = {
    "space": {"slug": "sandbox", "kind": "sandbox"},
    "objectTypes": [{"apiName": name, "label": name, "rowCount": 1} for name in ("Order", "Shipment", "Transport", "Carrier")],
    "kpis": [],
}


# ── prompts ─────────────────────────────────────────────────────────────────


def test_the_fixed_prompt_names_no_domain():
    lowered = SYSTEM_PROMPT.lower()
    for word in ("freight", "carrier", "shipment", "3pl", "lane", "tms"):
        assert word not in lowered, word


def test_the_prompt_checks_feasibility_before_building():
    assert "call check_feasibility FIRST" in SYSTEM_PROMPT
    assert "propose_change" in SYSTEM_PROMPT and "not_possible" in SYSTEM_PROMPT


def test_the_transport_rules_apply_only_to_the_transport_space():
    assert is_tms(TMS)
    assert not is_tms(WORKSPACE)
    assert not is_tms(None)
    # A personal workspace is never the demo, whatever its tables are called.
    assert not is_tms({**TMS, "space": {"kind": "personal"}})
    assert TMS_ADDENDUM in build_context_message(TMS)
    assert TMS_ADDENDUM not in build_context_message(WORKSPACE)


def test_context_lists_types_links_and_metrics():
    text = build_context_message(WORKSPACE)
    assert "maria's workspace" in text
    assert "OrderDetail (2,155)" in text
    assert "Order -> Customer (orderCustomer)" in text
    assert "order_freight_sum" in text


def test_starters_come_from_the_workspace_metrics():
    starters = starter_prompts(WORKSPACE)
    labels = [s["label"] for s in starters]
    assert labels[0] == "What can I build from my data?"
    # Money first, by month.
    assert "Total Freight per month" in labels
    assert any(label.startswith("Build an order") or label.startswith("Build a ") for label in labels)
    assert "Combine orders with their customers" in labels
    assert starter_prompts(TMS) == TMS_STARTERS
    assert starter_prompts(None)[0]["label"] == "How do I get started?"


# ── pricing ─────────────────────────────────────────────────────────────────


def test_azure_turns_are_priced_and_the_planner_is_free():
    cost = price_turn("azure_openai", "gpt-4.1", {"promptTokens": 1_000_000, "completionTokens": 100_000})
    assert cost.priced and cost.cost_usd > 0
    assert price_turn("builtin", "planner-1", {"promptTokens": 0}).cost_usd == 0.0
    assert price_turn("builtin", "planner-1", {}).priced
    assert not price_turn("nobody", "x", {"promptTokens": 10}).priced


# ── providers ───────────────────────────────────────────────────────────────


def test_without_azure_the_planner_answers(monkeypatch):
    unconfigured = dataclasses.replace(llm_module.CONFIG, provider="azure_openai", azure_endpoint="", azure_key="")
    monkeypatch.setattr(llm_module, "CONFIG", unconfigured)
    provider, why = asyncio.run(llm_module.build_provider())
    assert provider.name == "builtin" and "not configured" in why


def test_the_planner_can_be_chosen_and_other_providers_cannot(monkeypatch):
    monkeypatch.setattr(llm_module, "CONFIG", dataclasses.replace(llm_module.CONFIG, provider="builtin"))
    provider, _ = asyncio.run(llm_module.build_provider())
    assert provider.name == "builtin"
    monkeypatch.setattr(llm_module, "CONFIG", dataclasses.replace(llm_module.CONFIG, provider="anthropic"))
    try:
        asyncio.run(llm_module.build_provider())
    except llm_module.LlmError as exc:
        assert "azure_openai" in str(exc)
    else:
        raise AssertionError("an unknown provider must be refused")


# ── agent ───────────────────────────────────────────────────────────────────
def test_feasibility_and_proposal_results_become_artifacts():
    feasibility = agent_module._artifact_from(
        "check_feasibility",
        {},
        {"intent": "chart", "summary": {"ready": 1}, "items": [{"status": "ready", "kpi": "k", "dimension": "d", "explanation": "e"}]},
    )
    assert feasibility["kind"] == "feasibility" and feasibility["items"][0]["kpi"] == "k"
    proposal = agent_module._artifact_from(
        "propose_change", {}, {"proposal": {"id": 7, "kind": "combination", "status": "pending", "title": "t", "summary": "s", "payload": {}}}
    )
    assert proposal == {
        "kind": "proposal",
        "proposal": {"id": 7, "kind": "combination", "status": "pending", "title": "t", "summary": "s", "dependsOn": None, "payload": {}},
    }
    board = agent_module._artifact_from("create_dashboard", {}, {"created": True, "kind": "report", "slug": "r", "title": "R", "widgets": 3})
    assert board["boardKind"] == "report"


def test_a_question_about_what_can_be_built_is_recognised():
    for question in (
        "What can I build from my data?",
        "What charts, KPIs and dashboards can I build from my data?",
        "what could we make from this",
        "What's possible with this data?",
        "what can my data answer",
        "Which dashboards can you create for me?",
    ):
        assert agent_module.asks_what_can_be_built(question), question
    # A request, a figure, or a question about something else is left alone.
    for question in (
        "build me a sales dashboard",
        "revenue by country per month",
        "which orders can I see",
        "what can you do about late shipments",
        "enable the plan capabilities",
        "can I build a dashboard of orders?",
    ):
        assert not agent_module.asks_what_can_be_built(question), question


class _ScriptedProvider:
    """A model that answers in words and records what it was shown."""

    name = "scripted"

    def __init__(self) -> None:
        self.seen: list[list[dict]] = []

    async def chat(self, messages, tools):
        self.seen.append([dict(message) for message in messages])
        return llm_module.LlmReply(content="Here is what is ready.", provider="scripted", model="scripted-1")


def _run_agent(monkeypatch, question: str, tool_result: tuple[dict, bool]):
    calls: list[tuple[str, dict]] = []

    async def fake_run_tool(name, arguments):
        calls.append((name, arguments))
        return tool_result

    monkeypatch.setattr(agent_module, "run_tool", fake_run_tool)
    provider = _ScriptedProvider()
    result = asyncio.run(agent_module.Agent(provider).run(question, [], WORKSPACE))
    return result, provider, calls


def test_what_can_i_build_is_checked_before_the_model_is_asked(monkeypatch):
    report = {"intent": "capabilities", "summary": {"ready": 2}, "items": [{"status": "ready", "kpi": "order_count", "dimension": "ship_country"}]}
    result, provider, calls = _run_agent(monkeypatch, "What can I build from my data?", (report, True))

    # The check ran once, with the user's words, without a model round spent on it.
    assert calls == [("check_feasibility", {"text": "What can I build from my data?", "intent": "capabilities"})]
    assert result.rounds == 1
    # The model saw the call and its result as work already done...
    first = provider.seen[0]
    assert [m["role"] for m in first[-3:]] == ["user", "assistant", "tool"]
    assert first[-2]["tool_calls"][0]["function"]["name"] == "check_feasibility"
    assert first[-1]["tool_call_id"] == first[-2]["tool_calls"][0]["id"]
    assert "order_count" in first[-1]["content"]
    # ...and the reply carries the card and the record of the call.
    assert [a["kind"] for a in result.artifacts] == ["feasibility"]
    assert [i.name for i in result.tool_invocations] == ["check_feasibility"]
    assert result.content == "Here is what is ready."


def test_a_failed_check_leaves_the_turn_as_it_was(monkeypatch):
    result, provider, calls = _run_agent(monkeypatch, "What can I build from my data?", ({"error": "service unavailable"}, False))
    assert len(calls) == 1
    # Nothing half-recorded: the model is simply asked, and may call it itself.
    assert provider.seen[0][-1]["role"] == "user"
    assert result.artifacts == [] and result.tool_invocations == []


def test_other_questions_are_not_checked_for_the_model(monkeypatch):
    result, provider, calls = _run_agent(monkeypatch, "revenue by country per month", ({}, True))
    assert calls == []
    assert provider.seen[0][-1]["role"] == "user"
    assert result.content == "Here is what is ready."


# A feasibility result that drafted one proposal, and what making it returns.
_DRAFTED = {
    "intent": "dashboard",
    "summary": {"ready": 0, "needsApproval": 1, "notPossible": 0},
    "items": [
        {
            "status": "needs_approval",
            "explanation": "Sales needs orders joined to accounts.",
            "proposals": [{"kind": "combination", "title": "Sales order", "payload": {"name": "sales_order"}}],
        }
    ],
}
_MADE = {"proposal": {"id": 7, "kind": "combination", "status": "pending", "title": "Sales order", "summary": "s", "payload": {}}}


class _SequencedProvider:
    """A model that replies with a fixed sequence, recording what it was shown."""

    name = "scripted"

    def __init__(self, replies) -> None:
        self.replies = list(replies)
        self.seen: list[list[dict]] = []

    async def chat(self, messages, tools):
        self.seen.append([dict(message) for message in messages])
        reply = self.replies.pop(0)
        if isinstance(reply, str):
            return llm_module.LlmReply(content=reply, provider="scripted", model="scripted-1")
        name, arguments = reply
        call = llm_module.ToolCall(id=f"call_{len(self.seen)}", name=name, arguments=arguments)
        return llm_module.LlmReply(content="", tool_calls=[call], provider="scripted", model="scripted-1")


def _run_sequence(monkeypatch, replies, results):
    async def fake_run_tool(name, arguments):
        return results[name], True

    monkeypatch.setattr(agent_module, "run_tool", fake_run_tool)
    provider = _SequencedProvider(replies)
    result = asyncio.run(agent_module.Agent(provider).run("build me a sales dashboard", [], WORKSPACE))
    return result, provider


def test_a_reply_that_promises_an_approval_is_sent_back_to_make_the_proposal(monkeypatch):
    result, provider = _run_sequence(
        monkeypatch,
        [
            ("check_feasibility", {"text": "build me a sales dashboard"}),
            "A new dataset is needed. You can approve this proposal below to proceed.",
            ("propose_change", {"kind": "combination", "payload": {"name": "sales_order"}}),
            "The proposal is waiting for your approval under this answer.",
        ],
        {"check_feasibility": _DRAFTED, "propose_change": _MADE},
    )
    # The third round was asked for by the agent, in so many words.
    reminder = provider.seen[2][-1]
    assert reminder["role"] == "system" and "propose_change was never called" in reminder["content"]
    assert provider.seen[2][-2] == {"role": "assistant", "content": "A new dataset is needed. You can approve this proposal below to proceed."}
    # And the turn ends with something to approve.
    assert [a["kind"] for a in result.artifacts] == ["feasibility", "proposal"]
    assert result.content == "The proposal is waiting for your approval under this answer."
    assert result.rounds == 4


def test_the_reminder_is_given_once(monkeypatch):
    result, provider = _run_sequence(
        monkeypatch,
        [
            ("check_feasibility", {"text": "build me a sales dashboard"}),
            "Approve the proposal below.",
            "Approve the proposal below, as I said.",
        ],
        {"check_feasibility": _DRAFTED},
    )
    assert len(provider.seen) == 3
    assert result.content == "Approve the proposal below, as I said."
    assert [a["kind"] for a in result.artifacts] == ["feasibility"]


def test_a_question_that_only_asks_leave_to_propose_is_not_put_to_the_user(monkeypatch):
    asking = {
        "question": "Approve the new combined dataset and build the sales dashboard?",
        "options": [{"label": "Yes, approve and build the dashboard"}, {"label": "No, do not proceed"}],
        "multiple": False,
        "allowFreeText": True,
        "message": "",
    }
    result, provider = _run_sequence(
        monkeypatch,
        [
            ("check_feasibility", {"text": "build me a sales dashboard"}),
            ("request_clarification", asking),
            ("propose_change", {"kind": "combination", "payload": {"name": "sales_order"}}),
            "The proposal is under this answer, with its Approve button.",
        ],
        {"check_feasibility": _DRAFTED, "request_clarification": asking, "propose_change": _MADE},
    )
    # The model was told its question was not asked, and why.
    told = provider.seen[2][-1]
    assert told["role"] == "tool" and told["name"] == "request_clarification"
    assert '"asked":false' in told["content"].replace(" ", "") and "propose_change" in told["content"]
    # The turn did not end on the question: it ends with a proposal to approve.
    assert result.stopped_because == "answered"
    assert [a["kind"] for a in result.artifacts] == ["feasibility", "proposal"]
    assert result.content == "The proposal is under this answer, with its Approve button."


def test_a_question_about_something_else_is_still_asked(monkeypatch):
    asking = {
        "question": "Which figure do you mean by sales?",
        "options": [{"label": "Declared value"}, {"label": "COD amount"}],
        "multiple": False,
        "allowFreeText": True,
        "message": "",
    }
    result, provider = _run_sequence(
        monkeypatch,
        [("check_feasibility", {"text": "build me a sales dashboard"}), ("request_clarification", asking)],
        {"check_feasibility": _DRAFTED, "request_clarification": asking},
    )
    assert result.stopped_because == "needs_clarification"
    assert [a["kind"] for a in result.artifacts] == ["feasibility", "clarification"]
    assert len(provider.seen) == 2


def test_asking_leave_in_prose_is_sent_back_too(monkeypatch):
    result, provider = _run_sequence(
        monkeypatch,
        [
            ("check_feasibility", {"text": "build me a sales dashboard"}),
            "Sales needs orders joined to accounts.\n\nWould you like me to create this combined dataset?",
            ("propose_change", {"kind": "combination", "payload": {"name": "sales_order"}}),
            "It is waiting under this answer.",
        ],
        {"check_feasibility": _DRAFTED, "propose_change": _MADE},
    )
    assert provider.seen[2][-1]["role"] == "system"
    assert [a["kind"] for a in result.artifacts] == ["feasibility", "proposal"]


def test_replies_that_promise_nothing_are_left_alone():
    made = agent_module.ToolInvocation("propose_change", {}, True, 1, "", _MADE)
    drafted = agent_module.ToolInvocation("check_feasibility", {}, True, 1, "", _DRAFTED)
    overview = agent_module.ToolInvocation(
        "check_feasibility", {}, True, 1, "", {"items": [{"status": "needs_approval", "explanation": "needs a join"}]}
    )
    count = agent_module.proposals_promised_but_not_made
    assert count("Approve it below.", [drafted]) == 1
    # The proposal was made; nothing was drafted; or the reply does not speak of approving.
    assert count("Approve it below.", [drafted, made]) == 0
    assert count("Some of these need an approval first.", [overview]) == 0
    assert count("Sales needs orders joined to accounts.", [drafted]) == 0
    assert count("Approve it below.", []) == 0
