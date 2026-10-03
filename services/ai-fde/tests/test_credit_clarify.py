"""Tests for clarifications, monthly credit and administrator-set prices."""

from __future__ import annotations

import asyncio
import os
from datetime import datetime, timezone

os.environ.setdefault("AUTH_JWT_SECRET", "test-secret-at-least-thirty-two-characters-long")
os.environ.setdefault("DATABASE_URL", "postgresql://unused:unused@127.0.0.1:1/unused")

from app import settings  # noqa: E402
from app.agent import clarification_reply  # noqa: E402
from app.clarify import asks_something, closing_passage, infer_clarification  # noqa: E402
from app.credit import CreditStatus, effective_limit  # noqa: E402
from app.llm import LlmError, LlmProvider, LlmReply, ToolCall  # noqa: E402
from app.pricing import price_turn, rates  # noqa: E402
from app.tools import MAX_CLARIFICATION_OPTIONS, request_clarification  # noqa: E402


def run(coro):
    return asyncio.run(coro)


# ── the clarification tool ──────────────────────────────────────────────────


def test_options_are_cleaned_capped_and_deduplicated():
    raw = [{"label": f"table_{n}", "detail": "rows"} for n in range(20)]
    raw.insert(1, {"label": "TABLE_0"})  # the same choice, differently cased
    raw.insert(2, {"label": "   "})  # nothing to click
    payload = run(request_clarification({"question": "Which tables?", "options": raw, "multiple": True}))
    labels = [option["label"] for option in payload["options"]]
    assert len(labels) == MAX_CLARIFICATION_OPTIONS
    assert labels[:2] == ["table_0", "table_1"]
    assert payload["multiple"] is True
    assert payload["allowFreeText"] is True


def test_plain_strings_are_accepted_as_options():
    payload = run(request_clarification({"question": "Which?", "options": ["a", "b"]}))
    assert payload["options"] == [{"label": "a", "detail": ""}, {"label": "b", "detail": ""}]
    assert payload["multiple"] is False


def test_a_single_option_is_never_multiple_choice():
    payload = run(request_clarification({"question": "Go?", "options": ["Yes"], "multiple": True}))
    assert payload["multiple"] is False


# "How do I create this dataset?" once came back as nothing but "What would
# you like to do next?" - the question had replaced the answer.
def test_asking_keeps_the_answer_that_came_with_it():
    asked = {"question": "Model it now?", "options": ["Yes, model it", "No, not now"]}
    payload = run(request_clarification({**asked, "message": "  It is synced already; modelling is the next step.  "}))
    assert payload["message"] == "It is synced already; modelling is the next step."
    assert clarification_reply(payload, None) == "It is synced already; modelling is the next step.\n\nModel it now?"
    # Written beside the tool call rather than given to it: kept as well.
    bare = run(request_clarification(asked))
    assert bare["message"] == ""
    assert clarification_reply(bare, "It is synced already.") == "It is synced already.\n\nModel it now?"
    # A question that stands alone is just the question, said once.
    assert clarification_reply(bare, None) == "Model it now?"
    assert clarification_reply(bare, "Model it now?") == "Model it now?"


# ── questions asked in prose ────────────────────────────────────────────────


def test_a_closing_question_is_recognised_through_markdown():
    assert asks_something("Here are the tables.\n\nWould you like to model all three?")
    assert asks_something("Which one should I sync first?**")
    assert asks_something("Pick one (or several)?)  \n")
    assert not asks_something("Built 3 object types.")
    assert not asks_something("")


# Both taken from real replies, where the question was there to be read but
# was not the last character - and so was missed.
def test_a_question_followed_by_a_citation_or_a_sentence_is_still_a_question():
    cited = (
        "In your space, the ingest_run dataset is already synced.\n\n"
        "Would you like to model the ingest_run dataset now, so you can use it for reporting "
        'and analysis? :citation[How data becomes an ontology]{path="platform/data-flow"}'
    )
    assert asks_something(cited)
    followed = (
        "4. (Optional) Add metrics, links, or actions if the data supports them.\n\n"
        "Would you like me to proceed and create the ingest_run object type for you? "
        "If so, I will show you the plan before making any changes."
    )
    assert asks_something(followed)
    # One paragraph further up still counts as the close.
    assert asks_something("Shall I sync it?\n\nI will not change anything until you say so.")


def test_a_question_mark_that_is_not_a_question_is_not_one():
    # In a marker, in code, or far above the end of a long reply.
    assert not asks_something('It is synced. :citation[Why?]{path="platform/faq?id=3"}')
    assert not asks_something("Run it as `SELECT * FROM t WHERE id = ?` and it works.")
    assert not asks_something("It filters like this:\n\n```sql\nWHERE id = ?\n```\n\nThat is all.")
    assert not asks_something("Why does it matter?\n\nBecause of the keys.\n\nThey are unique.\n\nSo it is safe.")
    assert "?" not in closing_passage("Done. :resource[dataset:what?]")


class FakeModel(LlmProvider):
    """A provider whose one reply is scripted, recording what it was asked."""

    def __init__(self, reply: LlmReply | Exception, name: str = "azure_openai") -> None:
        self.name = name
        self.reply = reply
        self.calls: list[dict] = []

    async def chat(self, messages, tools=None, tool_choice=None):
        self.calls.append({"messages": messages, "tools": tools, "tool_choice": tool_choice})
        if isinstance(self.reply, Exception):
            raise self.reply
        return self.reply


REPLY = (
    "These tables are synced:\n- business_entity_contact\n- account\n- app_user\n\n"
    "Would you like to proceed with modelling all three, or focus on one first?"
)


def structured(options, multiple=False):
    return LlmReply(
        content="",
        tool_calls=[
            ToolCall(
                id="c1",
                name="request_clarification",
                arguments={"question": "Model all three, or one first?", "options": options, "multiple": multiple},
            )
        ],
        usage={"promptTokens": 300, "completionTokens": 40, "totalTokens": 340},
    )


def test_a_prose_question_becomes_choices_and_its_tokens_are_counted():
    model = FakeModel(structured([{"label": "Model all three"}, {"label": "Only account"}]))
    artifact, usage = run(infer_clarification(model, "model my data", REPLY, {"totalTokens": 1000, "promptTokens": 900}))
    assert artifact is not None
    assert artifact["kind"] == "clarification" and artifact["inferred"] is True
    assert [option["label"] for option in artifact["options"]] == ["Model all three", "Only account"]
    # The structuring call is forced through the clarification schema, and
    # what it cost lands on the turn so it is priced and charged.
    call = model.calls[0]
    assert call["tool_choice"]["function"]["name"] == "request_clarification"
    assert [tool["function"]["name"] for tool in call["tools"]] == ["request_clarification"]
    assert usage == {"totalTokens": 1340, "promptTokens": 1200, "completionTokens": 40}


def test_no_choices_means_no_clarification():
    model = FakeModel(structured([]))
    artifact, usage = run(infer_clarification(model, "hi", "What would you like to know?", {}))
    assert artifact is None
    assert usage["totalTokens"] == 340


# A question the reply answers itself is passed to the model to judge; when it
# returns no options, nothing is shown - and the call is still paid for.
def test_a_rhetorical_question_is_left_alone_by_the_model_not_by_guessing():
    model = FakeModel(structured([]))
    artifact, usage = run(infer_clarification(model, "why?", "Is it safe? Yes - the keys are unique.", {"totalTokens": 10}))
    assert artifact is None
    assert len(model.calls) == 1 and usage["totalTokens"] == 350


def test_a_reply_that_asks_nothing_costs_nothing_extra():
    model = FakeModel(structured([{"label": "a"}, {"label": "b"}]))
    artifact, usage = run(infer_clarification(model, "hi", "Built 3 object types.", {"totalTokens": 5}))
    assert artifact is None and usage == {"totalTokens": 5}
    assert model.calls == []


def test_the_builtin_planner_is_never_asked():
    model = FakeModel(structured([{"label": "a"}, {"label": "b"}]), name="builtin")
    assert run(infer_clarification(model, "hi", REPLY, {}))[0] is None
    assert model.calls == []


def test_a_failed_structuring_call_leaves_the_reply_alone():
    model = FakeModel(LlmError("Azure OpenAI returned 500"))
    artifact, usage = run(infer_clarification(model, "hi", REPLY, {"totalTokens": 7}))
    assert artifact is None and usage == {"totalTokens": 7}


# ── monthly credit ──────────────────────────────────────────────────────────


def test_the_limit_comes_from_the_account_or_the_default():
    assert effective_limit("default", None, 25.0) == 25.0
    assert effective_limit("default", None, None) is None
    assert effective_limit("unlimited", None, 25.0) is None
    assert effective_limit("custom", 5.0, 25.0) == 5.0
    assert effective_limit("custom", 0.0, None) == 0.0


def test_credit_is_used_up_only_at_the_limit():
    start = datetime(2026, 10, 1, tzinfo=timezone.utc)
    resets = datetime(2026, 11, 1, tzinfo=timezone.utc)
    under = CreditStatus("custom", 5.0, 4.99, start, resets)
    assert not under.exhausted and under.remaining_usd == 0.01
    spent = CreditStatus("custom", 5.0, 5.0, start, resets)
    assert spent.exhausted and spent.remaining_usd == 0.0
    assert not CreditStatus("unlimited", None, 999.0, start, resets).exhausted


def test_the_refusal_says_what_was_spent_and_when_it_renews():
    status = CreditStatus("custom", 5.0, 5.4321, datetime(2026, 10, 1), datetime(2026, 11, 1))
    message = status.refusal()
    assert "$5.00" in message and "$5.43" in message
    assert "since 1 October" in message and "renews on 1 November" in message
    assert status.as_dict()["exhausted"] is True


# ── prices an administrator set ─────────────────────────────────────────────


def test_an_administrators_price_wins_and_says_so():
    try:
        settings.prime({"pricing.azureInputPerMillion": 3.0, "pricing.azureOutputPerMillion": 12})
        rate = rates()["azure_openai"]
        assert (rate.input_per_m, rate.output_per_m) == (3.0, 12.0)
        assert rate.source == "set by an administrator"
        cost = price_turn("azure_openai", "gpt-4.1", {"promptTokens": 1_000_000, "completionTokens": 1_000_000})
        assert cost.cost_usd == 15.0
    finally:
        settings.clear_cache()


def test_half_a_price_falls_back_on_its_own():
    try:
        settings.prime({"pricing.azureOutputPerMillion": 10})
        rate = rates()["azure_openai"]
        assert rate.output_per_m == 10.0
        assert rate.input_per_m == float(os.environ.get("COST_AZURE_INPUT_PER_M") or 2.0)
    finally:
        settings.clear_cache()


def test_a_non_numeric_setting_is_ignored():
    try:
        settings.prime({"pricing.azureInputPerMillion": True})
        assert settings.number("pricing.azureInputPerMillion") is None
        assert rates()["azure_openai"].source != "set by an administrator"
    finally:
        settings.clear_cache()
