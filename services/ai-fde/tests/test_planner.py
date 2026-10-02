"""Tests for the built-in planner: the assistant that works without a model.

The planner is driven exactly as the agent drives a model: it is handed the
transcript and returns tool calls or an answer. These tests replay that loop
with canned tool results.
"""

from __future__ import annotations

import asyncio
import json

from app.planner import (
    PLANNER_NOTE,
    BuiltinPlanner,
    compose_answer,
    current_turn,
    describe_series,
    format_period,
    format_value,
    next_calls,
)

TOOLS = [{"type": "function", "function": {"name": "check_feasibility", "parameters": {}}}]


def transcript(question: str, *rounds: tuple[list[tuple[str, dict]], list[dict]]) -> list[dict]:
    """A transcript: the question, then (calls, results) per round."""
    messages: list[dict] = [{"role": "system", "content": "s"}, {"role": "user", "content": question}]
    counter = 0
    for calls, results in rounds:
        ids = []
        tool_calls = []
        for name, arguments in calls:
            counter += 1
            ids.append(f"c{counter}")
            tool_calls.append({"id": f"c{counter}", "type": "function", "function": {"name": name, "arguments": json.dumps(arguments)}})
        messages.append({"role": "assistant", "content": "", "tool_calls": tool_calls})
        for call_id, result in zip(ids, results):
            messages.append({"role": "tool", "tool_call_id": call_id, "content": json.dumps(result)})
    return messages


READY_CHART = {
    "intent": "chart",
    "items": [
        {
            "status": "ready",
            "kpi": "revenue_sum",
            "dimension": "country",
            "explanation": "Revenue by country is ready.",
            "request": {"text": "revenue by country"},
            "widget": {"type": "chart", "title": "Revenue by country"},
        }
    ],
}

SERIES = {
    "kpi": "revenue_sum",
    "label": "Total Revenue",
    "format": "currency",
    "unit": None,
    "total": 1000.0,
    "dimension": "country",
    "dimensionLabel": "Country",
    "dimensionGrain": None,
    "aggregation": "sum",
    "series": [{"label": "USA", "value": 600.0}, {"label": "Germany", "value": 400.0}],
}


def test_current_turn_pairs_calls_with_their_results():
    turn = current_turn(transcript("revenue by country", ([("check_feasibility", {"text": "revenue by country"})], [READY_CHART])))
    assert turn.question == "revenue by country"
    assert [s.name for s in turn.steps] == ["check_feasibility"]
    assert turn.results("check_feasibility")[0].result["intent"] == "chart"


def test_first_step_is_always_the_feasibility_check():
    calls = next_calls(current_turn(transcript("revenue by country")))
    assert [(c.name, c.arguments) for c in calls] == [("check_feasibility", {"text": "revenue by country"})]


def test_ready_charts_are_executed_then_answered_from_their_numbers():
    first = transcript("revenue by country", ([("check_feasibility", {"text": "revenue by country"})], [READY_CHART]))
    calls = next_calls(current_turn(first))
    assert [(c.name, c.arguments["kpi"], c.arguments["dimension"]) for c in calls] == [("execute_kpi", "revenue_sum", "country")]
    assert calls[0].arguments["limit"] == 12

    done = transcript(
        "revenue by country",
        ([("check_feasibility", {"text": "revenue by country"})], [READY_CHART]),
        ([("execute_kpi", {"kpi": "revenue_sum", "dimension": "country", "limit": 12})], [SERIES]),
    )
    assert next_calls(current_turn(done)) == []
    answer = compose_answer(current_turn(done))
    assert "Total Revenue by country" in answer
    assert "USA 600" in answer and "60%" in answer
    assert answer.endswith(PLANNER_NOTE)


def test_a_timeline_is_not_cut_to_twelve_periods():
    report = {**READY_CHART, "items": [{**READY_CHART["items"][0], "dimension": "order_date:month"}]}
    calls = next_calls(current_turn(transcript("revenue per month", ([("check_feasibility", {})], [report]))))
    assert "limit" not in calls[0].arguments


def test_a_dashboard_is_built_from_the_returned_layout_once():
    report = {
        "intent": "dashboard",
        "title": "Sales dashboard",
        "items": [],
        "layout": [{"type": "stat", "kpi": "revenue_sum", "title": "Revenue"}, {"type": "chart", "kpi": "revenue_sum", "dimension": "country", "title": "Revenue by country"}],
    }
    first = transcript("build a sales dashboard", ([("check_feasibility", {})], [report]))
    calls = next_calls(current_turn(first))
    assert [c.name for c in calls] == ["create_dashboard"]
    assert calls[0].arguments["kind"] == "dashboard"
    assert calls[0].arguments["layout"] == report["layout"]

    built = transcript(
        "build a sales dashboard",
        ([("check_feasibility", {})], [report]),
        ([("create_dashboard", calls[0].arguments)], [{"created": True, "slug": "sales-dashboard", "title": "Sales dashboard", "widgets": 2}]),
    )
    assert next_calls(current_turn(built)) == []
    answer = compose_answer(current_turn(built))
    assert ":resource[dashboard:sales-dashboard]" in answer
    assert "Headline figures: Revenue." in answer
    assert "- Revenue by country" in answer


def test_proposals_are_stored_dependencies_first_with_their_follow_up():
    link = {"kind": "link_type", "title": "Link", "summary": "s", "payload": {"source": "Order"}, "dependsOn": []}
    combo = {
        "kind": "combination",
        "title": "Dataset",
        "summary": "s",
        "payload": {"name": "Sales"},
        "dependsOn": [0],
        "followUp": {"build": "dashboard", "title": "Sales dashboard", "measure": "revenue", "sourcePrompt": "q"},
    }
    report = {"intent": "chart", "items": [{"status": "needs_approval", "explanation": "needs a dataset", "proposals": [link, combo]}]}
    feasibility = ([("check_feasibility", {})], [report])
    calls = next_calls(current_turn(transcript("q", feasibility)))
    # The combination waits for the link's id.
    assert [(c.name, c.arguments["kind"]) for c in calls] == [("propose_change", "link_type")]
    link_round = ([("propose_change", calls[0].arguments)], [{"proposed": True, "proposal": {"id": 41, "title": "Link", "summary": "s"}}])

    calls = next_calls(current_turn(transcript("q", feasibility, link_round)))
    assert [(c.name, c.arguments["kind"], c.arguments["dependsOn"]) for c in calls] == [("propose_change", "combination", [41])]
    assert calls[0].arguments["followUp"]["title"] == "Sales dashboard"
    combo_round = (
        [("propose_change", calls[0].arguments)],
        [{"proposed": True, "proposal": {"id": 42, "title": "Dataset", "summary": "s", "followUp": combo["followUp"]}}],
    )

    third = transcript("q", feasibility, link_round, combo_round)
    assert next_calls(current_turn(third)) == []
    answer = compose_answer(current_turn(third))
    assert "Waiting for your approval" in answer
    assert "**Sales dashboard** is built straight away" in answer


def test_not_possible_says_what_is_missing_and_offers_alternatives():
    report = {
        "intent": "chart",
        "items": [
            {
                "status": "not_possible",
                "explanation": "There is no on-time measure.",
                "request": {"text": "on-time rate"},
                "missing": ["a promised date and an actual date"],
                "alternatives": ["Orders", "Revenue"],
            }
        ],
    }
    turn = current_turn(transcript("on-time rate", ([("check_feasibility", {})], [report])))
    assert next_calls(turn) == []
    answer = compose_answer(turn)
    assert "Not possible with this data" in answer
    assert "a promised date and an actual date" in answer
    assert "*Orders*" in answer


def test_capabilities_list_ready_charts_by_title():
    report = {
        "intent": "capabilities",
        "items": [
            {"status": "ready", "kpi": "order_count", "widget": {"type": "chart", "title": "Orders per month"}},
            {"status": "ready", "kpi": "category_count", "widget": {"type": "stat", "title": "Categories"}},
            {"status": "needs_approval", "explanation": "Orders by customer country needs a join."},
        ],
    }
    turn = current_turn(transcript("what can I build?", ([("check_feasibility", {})], [report])))
    assert next_calls(turn) == []
    answer = compose_answer(turn)
    assert "- Orders per month" in answer
    assert "**Single figures:** Categories." in answer
    assert "Orders by customer country needs a join." in answer


def test_an_average_is_not_described_as_a_total_with_shares():
    text = describe_series({**SERIES, "label": "Average Freight", "aggregation": "avg", "total": 78.2})
    assert "overall" in text and "in total" not in text
    assert "%" not in text
    assert text.startswith("**Average Freight by country**")


def test_a_timeline_names_its_partial_period_and_does_not_compare_it():
    text = describe_series(
        {
            **SERIES,
            "dimension": "order_date:month",
            "dimensionGrain": "month",
            "series": [
                {"label": "1998-03-01", "value": 100.0},
                {"label": "1998-04-01", "value": 150.0},
                {"label": "1998-05-01", "value": 20.0},
            ],
            "partialPeriod": "1998-05-01",
            "dataThrough": "1998-05-06",
        }
    )
    assert "Mar 1998 to May 1998" in text
    assert "latest complete month, Apr 1998" in text
    assert "May 1998 is still incomplete" in text and "6 May 1998" in text


def test_formatting():
    assert format_value(1265793.04, "currency", None) == "1,265,793.04"
    assert format_value(830, "integer", None) == "830"
    assert format_value(12.345, "percent", "%") == "12.3%"
    assert format_value(None, None, None) == "no value"
    assert format_period("1997-04-01", "quarter") == "Q2 1997"
    assert format_period("1997-04-01", "month") == "Apr 1997"
    assert format_period("1997-04-01", "year") == "1997"
    assert format_period("Germany", "month") == "Germany"


def test_the_provider_answers_without_tools_when_told_to():
    planner = BuiltinPlanner()
    reply = asyncio.run(planner.chat(transcript("revenue by country"), TOOLS, tool_choice="none"))
    assert reply.tool_calls == []
    assert reply.provider == "builtin"
    calls = asyncio.run(planner.chat(transcript("revenue by country"), TOOLS))
    assert [c.name for c in calls.tool_calls] == ["check_feasibility"]
