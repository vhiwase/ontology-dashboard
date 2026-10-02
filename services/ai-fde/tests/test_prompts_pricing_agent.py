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
