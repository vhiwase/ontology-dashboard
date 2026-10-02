"""Tests for the prompt assembly, turn pricing and the agent loop."""

from __future__ import annotations

import asyncio
import dataclasses
import os

os.environ.setdefault("AUTH_JWT_SECRET", "test-secret-at-least-thirty-two-characters-long")
os.environ.setdefault("DATABASE_URL", "postgresql://unused:unused@127.0.0.1:1/unused")

from app import agent as agent_module  # noqa: E402
from app.agent import Agent  # noqa: E402
from app.llm import LlmProvider, LlmReply, ToolCall  # noqa: E402
from app.pricing import price_turn  # noqa: E402
from app.prompts import (  # noqa: E402
    SYSTEM_PROMPT,
    TMS_ADDENDUM,
    TMS_STARTERS,
    build_context_message,
    is_tms,
    starter_prompts,
    system_messages,
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
    for word in ("freight", "carrier", "shipment", "3pl", "lane"):
        assert word not in lowered, word


def test_the_transport_rules_apply_only_to_the_transport_space():
    assert is_tms(TMS)
    assert not is_tms(WORKSPACE)
    # A personal workspace is never the demo, whatever its tables are called.
    assert not is_tms({**TMS, "space": {"kind": "personal"}})
    assert [m["content"] for m in system_messages(TMS)][:2] == [SYSTEM_PROMPT, TMS_ADDENDUM]
    contents = [m["content"] for m in system_messages(WORKSPACE)]
    assert contents[0] == SYSTEM_PROMPT and TMS_ADDENDUM not in contents
    # Fixed text first, the per-turn inventory last.
    assert contents[-1] == build_context_message(WORKSPACE)


def test_context_lists_types_links_metrics_and_attachments():
    text = build_context_message({**WORKSPACE, "attached": [{"kind": "objectType", "ref": "Order", "definition": {"apiName": "Order"}}]})
    assert "personal workspace" in text
    assert "OrderDetail (2,155)" in text
    assert "orderCustomer (Order -> Customer)" in text
    assert "order_freight_sum: Total Freight - by ship_country, order_date:month" in text
    assert "2 proposals waiting for approval" in text
    assert "The user attached these" in text and '"ref": "Order"' in text


def test_starters_come_from_the_workspace_metrics():
    starters = starter_prompts(WORKSPACE)
    labels = [s["label"] for s in starters]
    assert labels[0] == "What can I build from my data?"
    # Money first, by month.
    assert "Total Freight per month" in labels
    assert any(label.startswith("Build an order") or label.startswith("Build a ") for label in labels)
    assert "Combine orders with customer details" in labels
    assert starter_prompts(TMS) == TMS_STARTERS
    assert starter_prompts(None)[0]["label"] == "How do I get started?"


# ── pricing ─────────────────────────────────────────────────────────────────


def test_claude_turns_price_cache_reads_and_writes_apart():
    cost = price_turn(
        "anthropic",
        "claude-opus-5-5",
        {"promptTokens": 1_000_000, "completionTokens": 100_000, "cacheReadTokens": 600_000, "cacheWriteTokens": 100_000},
    )
    # 300k uncached at $4, 600k reads at $0.20, 100k writes at $5, 100k out at $20.
    assert cost.priced
    assert round(cost.cost_usd, 4) == round(1.2 + 0.12 + 0.5 + 2.0, 4)


def test_the_planner_is_free_and_an_unknown_model_is_unpriced():
    assert price_turn("builtin", "planner-1", {"promptTokens": 0}).cost_usd == 0.0
    assert price_turn("builtin", "planner-1", {}).priced
    assert not price_turn("anthropic", "some-future-model", {"promptTokens": 10}).priced
    assert not price_turn("nobody", "x", {"promptTokens": 10}).priced


# ── agent loop ──────────────────────────────────────────────────────────────


class ScriptedProvider(LlmProvider):
    """Answers from a script and records what it was sent."""

    name = "anthropic"

    def __init__(self, replies: list[LlmReply]) -> None:
        self.model = "claude-opus-5-5"
        self.replies = list(replies)
        self.calls: list[dict] = []

    async def chat(self, messages, tools=None, tool_choice="auto"):
        self.calls.append({"messages": [dict(m) for m in messages], "tools": tools, "tool_choice": tool_choice})
        return self.replies.pop(0)

    async def health(self):
        return {"reachable": True}


def test_the_agent_replays_provider_content_and_keeps_tools_on_the_last_round(monkeypatch):
    raw = [{"type": "thinking", "thinking": "", "signature": "s"}, {"type": "tool_use", "id": "t1", "name": "list_kpis", "input": {}}]
    loops = [
        LlmReply(content="", tool_calls=[ToolCall(id=f"t{i}", name="list_kpis", arguments={"i": i})], provider="anthropic", model="m", provider_content=raw)
        for i in range(3)
    ]
    final = LlmReply(content="Done.", provider="anthropic", model="m")
    provider = ScriptedProvider([*loops, final])

    async def fake_tool(name, arguments):
        return {"kpis": []}, True

    monkeypatch.setattr(agent_module, "run_tool", fake_tool)
    monkeypatch.setattr(agent_module, "CONFIG", dataclasses.replace(agent_module.CONFIG, max_tool_rounds=4))
    result = asyncio.run(Agent(provider).run("q", [], WORKSPACE))

    assert result.content == "Done."
    assert [c["tool_choice"] for c in provider.calls] == ["auto", "auto", "auto", "none"]
    # The same tool list on every round, the last included.
    assert all(c["tools"] == provider.calls[0]["tools"] for c in provider.calls)
    replayed = [m for m in provider.calls[1]["messages"] if m["role"] == "assistant"]
    assert replayed[0]["provider_content"] == raw and replayed[0]["provider"] == "anthropic"
    assert provider.calls[-1]["messages"][-1]["role"] == "system"


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
