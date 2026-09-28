"""Assistant eval suites - the AI-FDE service's half of platform.eval_suite.

A suite is a set of prompts; each case runs the real agent loop (real tools,
real ontology) and is scored by STRUCTURAL evaluators over what the turn
produced: which tools ran, whether the reply carries the data-quality caveat
it owed, citation shape, and bounds on rounds, latency and tokens.

No LLM judge, deliberately. An evaluator that is itself a model makes a
passing score a matter of opinion, and the platform's whole position on
simulated versus measured figures is that a number without provenance is
worse than no number. These evaluators either hold on the transcript or name
why they do not - the same standard the function evals (ontology-service,
src/evals.ts) apply to SQL results. The two target kinds share the
platform.eval_* tables; this service owns the 'assistant' kind because it owns
the agent the cases exercise.

Eval runs deliberately bypass the chat rate limiter: they are explicit
analyst-initiated runs of a fixed suite, and a suite that tripped the per-user
chat limits would measure the limiter rather than the assistant. What a run
spends is still recorded on the run row, so the cost of a regression check is
visible next to the cost of a conversation.
"""

from __future__ import annotations

import re
from typing import Any, Awaitable, Callable

from .agent import AgentResult
from .ontology_client import ToolError, client

# The evaluator kinds, with what each needs. Validation at suite-creation time
# means a malformed case is refused where it is written, not discovered inside
# a run report.
EVALUATOR_KINDS = (
    "reply_contains",
    "reply_not_contains",
    "reply_matches",
    "tool_used",
    "tool_not_used",
    "caveat_when_simulated",
    "cites_documentation",
    "max_rounds",
    "max_latency_ms",
    "max_tokens",
)


def validate_case_spec(spec: dict[str, Any]) -> str | None:
    """The reason a case spec is unusable, or None when it is well formed."""
    if not str(spec.get("prompt") or "").strip():
        return "Every case needs a prompt."
    evaluators = spec.get("evaluators") or []
    if not isinstance(evaluators, list) or not evaluators:
        return "Every case needs at least one evaluator."
    for evaluator in evaluators:
        if not isinstance(evaluator, dict):
            return "Each evaluator is an object with a kind."
        kind = str(evaluator.get("kind") or "")
        if kind not in EVALUATOR_KINDS:
            return (
                f"Unknown evaluator kind '{kind}'. Kinds: "
                + ", ".join(EVALUATOR_KINDS)
                + "."
            )
        if kind in ("reply_contains", "reply_not_contains") and not str(
            evaluator.get("text") or ""
        ):
            return f"{kind} needs text."
        if kind == "reply_matches":
            pattern = str(evaluator.get("pattern") or "")
            if not pattern:
                return "reply_matches needs a pattern."
            try:
                re.compile(pattern)
            except re.error as exc:
                return f"reply_matches pattern does not compile: {exc}"
        if kind in ("max_rounds", "max_latency_ms", "max_tokens") and not isinstance(
            evaluator.get("value"), (int, float)
        ):
            return f"{kind} needs a numeric value."
    return None


def evaluate_case(
    case_name: str,
    spec: dict[str, Any],
    reply: str,
    result: AgentResult,
    dropped_citations: int,
) -> dict[str, Any]:
    """Score one case's transcript with its evaluators. Pure."""
    lower_reply = reply.lower()
    tool_names = [invocation.name for invocation in result.tool_invocations]
    # The caveat travels on execute_kpi results when a metric rests on
    # simulated data; the reply owes the user the same admission.
    saw_caveat = any(
        invocation.result.get("dataQualityCaveat") for invocation in result.tool_invocations
    )

    outcomes: list[dict[str, Any]] = []
    for evaluator in spec.get("evaluators") or []:
        kind = str(evaluator.get("kind") or "")
        ok = False
        detail = ""

        if kind == "reply_contains":
            needle = str(evaluator.get("text") or "")
            ok = needle.lower() in lower_reply
            detail = f"{'found' if ok else 'did not find'} {needle!r}"
        elif kind == "reply_not_contains":
            needle = str(evaluator.get("text") or "")
            ok = needle.lower() not in lower_reply
            detail = "absent" if ok else f"reply contains {needle!r}"
        elif kind == "reply_matches":
            pattern = str(evaluator.get("pattern") or "")
            ok = re.search(pattern, reply, re.IGNORECASE) is not None
            detail = f"pattern {'matched' if ok else 'did not match'}"
        elif kind == "tool_used":
            name = str(evaluator.get("name") or "")
            ok = name in tool_names
            detail = f"tools used: {', '.join(tool_names) or 'none'}"
        elif kind == "tool_not_used":
            name = str(evaluator.get("name") or "")
            ok = name not in tool_names
            detail = "absent" if ok else f"{name} ran"
        elif kind == "caveat_when_simulated":
            if saw_caveat:
                ok = "simulat" in lower_reply
                detail = (
                    "caveat passed on"
                    if ok
                    else "a simulated metric was quoted without the simulation caveat"
                )
            else:
                ok = True
                detail = "no simulated figure was quoted"
        elif kind == "cites_documentation":
            ok = ":citation[" in reply and dropped_citations == 0
            detail = (
                "citations intact"
                if ok
                else "no citation in the reply" if ":citation[" not in reply
                else f"{dropped_citations} citation(s) pointed at documents that do not exist"
            )
        elif kind == "max_rounds":
            value = float(evaluator.get("value") or 0)
            ok = result.rounds <= value
            detail = f"{result.rounds} rounds, bound {value:g}"
        elif kind == "max_latency_ms":
            value = float(evaluator.get("value") or 0)
            ok = result.latency_ms <= value
            detail = f"{result.latency_ms} ms, bound {value:g}"
        elif kind == "max_tokens":
            value = float(evaluator.get("value") or 0)
            tokens = int((result.usage or {}).get("totalTokens") or 0)
            ok = tokens <= value
            detail = f"{tokens} tokens, bound {value:g}"

        outcomes.append({"kind": kind, "ok": ok, "detail": detail})

    return {
        "case": case_name,
        "prompt": spec.get("prompt"),
        "ok": all(entry["ok"] for entry in outcomes),
        "evaluators": outcomes,
        "rounds": result.rounds,
        "latencyMs": result.latency_ms,
        "usage": result.usage or {},
        "stoppedBecause": result.stopped_because,
    }


async def run_assistant_suite(
    suite_name: str,
    cases: list[dict[str, Any]],
    agent: Any,
    snapshot_provider: Callable[[], Awaitable[dict[str, Any]]],
    citation_validator: Callable[[str], Awaitable[tuple[str, int]]],
) -> dict[str, Any]:
    """Run every case through the live agent and score the transcripts.

    Each case starts from an empty history and a fresh agent state: an eval
    measures what the assistant does from the prompt alone, not what it
    inherits from whatever conversation ran last.
    """
    from .agent import AgentResult
    from .modes import SessionAgentState

    outcomes: list[dict[str, Any]] = []
    total_tokens = 0
    prompt_tokens = 0
    completion_tokens = 0

    for index, case in enumerate(cases, start=1):
        name = str(case.get("name") or f"Case {index}")
        spec = case.get("spec") or {}
        prompt = str(spec.get("prompt") or "")
        try:
            snapshot = await snapshot_provider()
            result = await agent.run(prompt, [], snapshot, SessionAgentState())
            reply, dropped = await citation_validator(result.content)
            outcome = evaluate_case(name, spec, reply, result, dropped)
            usage = result.usage or {}
            prompt_tokens += int(usage.get("promptTokens") or 0)
            completion_tokens += int(usage.get("completionTokens") or 0)
            total_tokens += int(usage.get("totalTokens") or 0)
        except ToolError as exc:
            outcome = {
                "case": name,
                "prompt": prompt,
                "ok": False,
                "evaluators": [],
                "error": str(exc),
            }
        except Exception as exc:  # noqa: BLE001 - a case failing is data, not a crash
            outcome = {
                "case": name,
                "prompt": prompt,
                "ok": False,
                "evaluators": [],
                "error": f"{type(exc).__name__}: {exc}",
            }
        outcomes.append(outcome)

    passed = sum(1 for entry in outcomes if entry["ok"])
    return {
        "suite": suite_name,
        "passed": passed,
        "failed": len(outcomes) - passed,
        "total": len(outcomes),
        "outcomes": outcomes,
        "tokens": {
            "promptTokens": prompt_tokens,
            "completionTokens": completion_tokens,
            "totalTokens": total_tokens,
        },
    }
