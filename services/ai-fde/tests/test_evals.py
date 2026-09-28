"""Assistant eval evaluators and the suite runner.

Pure tests: the evaluators score a canned AgentResult, and the runner is
exercised with a fake agent, so no model and no database are involved. The
property under test is that a score means the same thing twice - each
evaluator either holds on the transcript or names why it does not.
"""

from __future__ import annotations

import asyncio
import os

os.environ.setdefault("AUTH_JWT_SECRET", "test-secret-at-least-thirty-two-characters-long")
os.environ.setdefault("DATABASE_URL", "postgresql://unused:unused@127.0.0.1:1/unused")

from app.agent import AgentResult, ToolInvocation  # noqa: E402
from app.evals import evaluate_case, run_assistant_suite, validate_case_spec  # noqa: E402


def _result(
    content: str,
    tools: list[tuple[str, dict]] | None = None,
    rounds: int = 2,
    latency_ms: int = 1500,
    usage: dict | None = None,
) -> AgentResult:
    return AgentResult(
        content=content,
        tool_invocations=[
            ToolInvocation(
                name=name, arguments={}, ok=True, duration_ms=10, result_preview="", result=payload
            )
            for name, payload in (tools or [])
        ],
        rounds=rounds,
        latency_ms=latency_ms,
        usage=usage or {"promptTokens": 100, "completionTokens": 50, "totalTokens": 150},
    )


def _spec(evaluators: list[dict]) -> dict:
    return {"prompt": "How many orders are unplanned?", "evaluators": evaluators}


# ── spec validation ─────────────────────────────────────────────────────────


def test_spec_validation_names_its_reasons():
    assert "prompt" in (validate_case_spec({"evaluators": [{"kind": "tool_used"}]}) or "")
    assert "evaluator" in (validate_case_spec({"prompt": "p", "evaluators": []}) or "")
    assert "Unknown evaluator kind" in (
        validate_case_spec({"prompt": "p", "evaluators": [{"kind": "vibes"}]}) or ""
    )
    assert "pattern" in (
        validate_case_spec(
            {"prompt": "p", "evaluators": [{"kind": "reply_matches", "pattern": "("}]}
        )
        or ""
    ).lower()
    assert validate_case_spec(
        {"prompt": "p", "evaluators": [{"kind": "tool_used", "name": "list_kpis"}]}
    ) is None


# ── evaluators ──────────────────────────────────────────────────────────────


def test_tool_evaluators_see_what_actually_ran():
    result = _result("90 orders.", tools=[("execute_kpi", {}), ("get_data_coverage", {})])
    outcome = evaluate_case(
        "c",
        _spec(
            [
                {"kind": "tool_used", "name": "execute_kpi"},
                {"kind": "tool_not_used", "name": "apply_action"},
            ]
        ),
        result.content,
        result,
        0,
    )
    assert outcome["ok"] is True

    outcome = evaluate_case(
        "c", _spec([{"kind": "tool_used", "name": "create_dashboard"}]), result.content, result, 0
    )
    assert outcome["ok"] is False
    assert "execute_kpi" in outcome["evaluators"][0]["detail"]


def test_caveat_evaluator_demands_the_admission_only_when_simulated():
    caveat_tool = _result(
        "On-time is 68.9%.", tools=[("execute_kpi", {"dataQualityCaveat": "simulated"})]
    )
    passing = evaluate_case(
        "c", _spec([{"kind": "caveat_when_simulated"}]), caveat_tool.content, caveat_tool, 0
    )
    assert passing["ok"] is False  # quoted a simulated figure with no admission

    admitted = _result(
        "On-time is 68.9%, though that rests on simulated arrivals.",
        tools=[("execute_kpi", {"dataQualityCaveat": "simulated"})],
    )
    assert evaluate_case("c", _spec([{"kind": "caveat_when_simulated"}]), admitted.content, admitted, 0)[
        "ok"
    ] is True

    measured = _result("90 orders.", tools=[("execute_kpi", {})])
    assert evaluate_case("c", _spec([{"kind": "caveat_when_simulated"}]), measured.content, measured, 0)[
        "ok"
    ] is True  # nothing simulated quoted, nothing owed


def test_reply_shape_and_bounds():
    result = _result("90 orders are unplanned.", rounds=3, latency_ms=2000)
    outcome = evaluate_case(
        "c",
        _spec(
            [
                {"kind": "reply_contains", "text": "unplanned"},
                {"kind": "reply_not_contains", "text": "on-time"},
                {"kind": "reply_matches", "pattern": r"\d+ orders"},
                {"kind": "max_rounds", "value": 5},
                {"kind": "max_latency_ms", "value": 3000},
                {"kind": "max_tokens", "value": 200},
            ]
        ),
        result.content,
        result,
        0,
    )
    assert outcome["ok"] is True

    breached = evaluate_case(
        "c",
        _spec([{"kind": "max_rounds", "value": 2}, {"kind": "max_tokens", "value": 100}]),
        result.content,
        result,
        0,
    )
    assert breached["ok"] is False
    assert any("3 rounds" in e["detail"] for e in breached["evaluators"])


def test_citation_evaluator_counts_dropped_citations():
    cited = _result("See :citation[Roles]{path=\"platform/roles\"}.")
    assert evaluate_case("c", _spec([{"kind": "cites_documentation"}]), cited.content, cited, 0)[
        "ok"
    ] is True
    assert evaluate_case("c", _spec([{"kind": "cites_documentation"}]), cited.content, cited, 1)[
        "ok"
    ] is False
    assert evaluate_case("c", _spec([{"kind": "cites_documentation"}]), "no citation", cited, 0)[
        "ok"
    ] is False


# ── the runner ──────────────────────────────────────────────────────────────


class _FakeAgent:
    def __init__(self, results: list[AgentResult]) -> None:
        self.results = list(results)
        self.prompts: list[str] = []

    async def run(self, user_message, history, snapshot, state=None):
        self.prompts.append(user_message)
        assert history == []  # an eval measures the prompt alone
        return self.results.pop(0)


def test_runner_scores_every_case_and_sums_usage():
    agent = _FakeAgent(
        [
            _result("90 orders.", tools=[("execute_kpi", {})]),
            _result("covered elsewhere", rounds=1, usage={"promptTokens": 10, "completionTokens": 5, "totalTokens": 15}),
        ]
    )
    cases = [
        {"name": "count", "spec": _spec([{"kind": "tool_used", "name": "execute_kpi"}])},
        {"name": "miss", "spec": _spec([{"kind": "tool_used", "name": "create_dashboard"}])},
    ]
    outcome = asyncio.run(
        run_assistant_suite(
            "smoke",
            cases,
            agent,
            lambda: _async({}),
            lambda reply: _async((reply, 0)),
        )
    )
    assert outcome["passed"] == 1 and outcome["failed"] == 1 and outcome["total"] == 2
    assert outcome["tokens"]["totalTokens"] == 165
    assert agent.prompts == ["How many orders are unplanned?", "How many orders are unplanned?"]


async def _async(value):
    return value


def test_runner_records_a_crashing_case_as_failed():
    class _ExplodingAgent:
        async def run(self, user_message, history, snapshot, state=None):
            raise RuntimeError("model exploded")

    outcome = asyncio.run(
        run_assistant_suite(
            "smoke",
            [{"name": "boom", "spec": _spec([{"kind": "max_rounds", "value": 1}])}],
            _ExplodingAgent(),
            lambda: _async({}),
            lambda reply: _async((reply, 0)),
        )
    )
    assert outcome["failed"] == 1
    assert "model exploded" in outcome["outcomes"][0]["error"]
