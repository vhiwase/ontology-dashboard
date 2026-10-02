"""Tests for the Claude provider's translation, request body and parsing.

Nothing here reaches the network: the request is built and inspected, and
responses are the SDK's own types built from literal JSON.
"""

from __future__ import annotations

import dataclasses
import json

import pytest
from anthropic.types.beta import BetaMessage

from app import anthropic_provider as ap
from app.anthropic_provider import (
    BETA_FALLBACK,
    BETA_THINKING_BINDING,
    AnthropicProvider,
    supports_system_messages,
    to_anthropic_messages,
    to_anthropic_tools,
)

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "check_feasibility",
            "description": "Decide what can be built.",
            "parameters": {"type": "object", "properties": {"text": {"type": "string"}}},
        },
    },
    {"type": "function", "function": {"name": "list_kpis", "description": "", "parameters": None}},
]


def provider(model: str = "claude-opus-5-5") -> AnthropicProvider:
    # Built without __init__: it insists on a key and a client, and these
    # tests only need the request and the parser.
    instance = object.__new__(AnthropicProvider)
    instance.model = model
    return instance


def message(**fields) -> BetaMessage:
    body = {
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "model": "claude-opus-5-5",
        "content": [],
        "stop_reason": "end_turn",
        "stop_sequence": None,
        "usage": {"input_tokens": 10, "output_tokens": 5},
    }
    body.update(fields)
    return BetaMessage.model_validate(body)


# ── tools ───────────────────────────────────────────────────────────────────


def test_tools_translate_to_input_schema():
    converted = to_anthropic_tools(TOOLS)
    assert [t["name"] for t in converted] == ["check_feasibility", "list_kpis"]
    assert converted[0]["input_schema"]["properties"]["text"] == {"type": "string"}
    # A tool with no parameters still gets an object schema.
    assert converted[1]["input_schema"] == {"type": "object", "properties": {}}


# ── messages ────────────────────────────────────────────────────────────────


def test_leading_system_messages_become_system_parts():
    system, turns = to_anthropic_messages(
        [
            {"role": "system", "content": "instructions"},
            {"role": "system", "content": "inventory"},
            {"role": "user", "content": "revenue by country"},
        ]
    )
    assert system == ["instructions", "inventory"]
    assert turns == [{"role": "user", "content": [{"type": "text", "text": "revenue by country"}]}]


def test_tool_round_trip_and_parallel_results_share_one_user_message():
    _, turns = to_anthropic_messages(
        [
            {"role": "system", "content": "s"},
            {"role": "user", "content": "q"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {"id": "a", "type": "function", "function": {"name": "list_kpis", "arguments": "{}"}},
                    {"id": "b", "type": "function", "function": {"name": "check_feasibility", "arguments": '{"text": "x"}'}},
                ],
            },
            {"role": "tool", "tool_call_id": "a", "name": "list_kpis", "content": "[]"},
            {"role": "tool", "tool_call_id": "b", "name": "check_feasibility", "content": "{}"},
        ]
    )
    assert [t["role"] for t in turns] == ["user", "assistant", "user"]
    assistant = turns[1]["content"]
    assert [b["type"] for b in assistant] == ["tool_use", "tool_use"]
    assert assistant[1]["input"] == {"text": "x"}
    results = turns[2]["content"]
    assert [b["tool_use_id"] for b in results] == ["a", "b"]
    assert all(b["type"] == "tool_result" for b in results)


def test_claude_content_is_replayed_verbatim_with_thinking():
    raw = [
        {"type": "thinking", "thinking": "", "signature": "sig-1"},
        {"type": "tool_use", "id": "t1", "name": "list_kpis", "input": {}},
    ]
    _, turns = to_anthropic_messages(
        [
            {"role": "user", "content": "q"},
            {
                "role": "assistant",
                "content": "",
                "provider": "anthropic",
                "provider_content": raw,
                "tool_calls": [{"id": "t1", "type": "function", "function": {"name": "list_kpis", "arguments": "{}"}}],
            },
            {"role": "tool", "tool_call_id": "t1", "content": "[]"},
        ]
    )
    assert turns[1] == {"role": "assistant", "content": raw}


def test_other_providers_content_is_rebuilt_not_replayed():
    _, turns = to_anthropic_messages(
        [
            {"role": "user", "content": "q"},
            {
                "role": "assistant",
                "content": "Looking.",
                "provider": "builtin",
                "provider_content": [{"type": "thinking", "thinking": "", "signature": "x"}],
                "tool_calls": [{"id": "t1", "type": "function", "function": {"name": "list_kpis", "arguments": "{}"}}],
            },
        ]
    )
    assert [b["type"] for b in turns[1]["content"]] == ["text", "tool_use"]


def test_late_system_message_stays_in_place_on_models_that_take_it():
    _, turns = to_anthropic_messages(
        [
            {"role": "system", "content": "s"},
            {"role": "user", "content": "q"},
            {"role": "system", "content": "last step"},
        ],
        system_messages=True,
    )
    assert turns[-1] == {"role": "system", "content": "last step"}


def test_late_system_message_folds_into_the_user_turn_elsewhere():
    _, turns = to_anthropic_messages(
        [
            {"role": "system", "content": "s"},
            {"role": "user", "content": "q"},
            {"role": "system", "content": "last step"},
        ],
        system_messages=False,
    )
    assert [t["role"] for t in turns] == ["user"]
    assert turns[0]["content"][-1]["text"] == "<system-reminder>last step</system-reminder>"


def test_history_that_starts_mid_exchange_is_trimmed_to_a_user_turn():
    _, turns = to_anthropic_messages(
        [
            {"role": "assistant", "content": "an earlier answer"},
            {"role": "user", "content": "q"},
        ]
    )
    assert turns[0]["role"] == "user"


@pytest.mark.parametrize(
    ("model", "expected"),
    [
        ("claude-opus-5-5", True),
        ("claude-sonnet-5-5", True),
        ("claude-fable-5-1", True),
        ("claude-sonnet-5", False),
        ("claude-haiku-4-5-20251001", False),
        ("claude-opus-4-8", True),
    ],
)
def test_which_models_take_mid_conversation_system_messages(model, expected):
    assert supports_system_messages(model) is expected


# ── request body ────────────────────────────────────────────────────────────


def turn(final: bool = False) -> list[dict]:
    messages = [
        {"role": "system", "content": "instructions"},
        {"role": "system", "content": "inventory"},
        {"role": "user", "content": "q"},
    ]
    if final:
        messages.append({"role": "system", "content": "answer now"})
    return messages


def test_request_uses_adaptive_thinking_with_drop_block_and_explicit_effort():
    body = provider().request(turn(), TOOLS, "auto")
    assert body["model"] == "claude-opus-5-5"
    assert body["thinking"] == {"type": "adaptive", "block_binding": {"prefix_mismatch_behavior": "drop_block"}}
    assert body["output_config"] == {"effort": "medium"}
    assert BETA_THINKING_BINDING in body["betas"]
    # No sampling parameters and no budget_tokens: both are rejected now.
    assert "temperature" not in body and "budget_tokens" not in json.dumps(body)


def test_request_caches_the_fixed_prefix_and_the_tail():
    body = provider().request(turn(), TOOLS, "auto")
    system = body["system"]
    assert [b["text"] for b in system] == ["instructions", "inventory"]
    assert system[0]["cache_control"] == {"type": "ephemeral"}
    # The per-turn inventory rides on automatic caching, not its own marker.
    assert "cache_control" not in system[1]
    assert body["cache_control"] == {"type": "ephemeral"}


def test_request_never_forces_a_tool_and_keeps_tools_on_the_last_round():
    auto = provider().request(turn(), TOOLS, "auto")
    final = provider().request(turn(final=True), TOOLS, "none")
    assert auto["tool_choice"] == {"type": "auto"}
    assert final["tool_choice"] == {"type": "none"}
    # Same tools on the last round: withdrawing them would invalidate the
    # turn's earlier thinking.
    assert final["tools"] == auto["tools"]
    assert final["messages"][-1] == {"role": "system", "content": "answer now"}


def test_server_side_fallback_is_on_by_default_and_can_be_switched_off(monkeypatch):
    body = provider().request(turn(), TOOLS, "auto")
    assert body["fallbacks"] == "default"
    assert BETA_FALLBACK in body["betas"]

    monkeypatch.setattr(ap, "CONFIG", dataclasses.replace(ap.CONFIG, anthropic_fallbacks="off"))
    body = provider().request(turn(), TOOLS, "auto")
    assert "fallbacks" not in body
    assert BETA_FALLBACK not in body["betas"]


# ── parsing ─────────────────────────────────────────────────────────────────


def test_parse_collects_text_tool_calls_usage_and_raw_content():
    reply = provider().parse(
        message(
            content=[
                {"type": "thinking", "thinking": "", "signature": "sig"},
                {"type": "text", "text": "Checking."},
                {"type": "tool_use", "id": "toolu_1", "name": "check_feasibility", "input": {"text": "revenue"}},
            ],
            stop_reason="tool_use",
            usage={
                "input_tokens": 100,
                "output_tokens": 20,
                "cache_read_input_tokens": 900,
                "cache_creation_input_tokens": 50,
            },
        )
    )
    assert reply.content == "Checking."
    assert [(c.id, c.name, c.arguments) for c in reply.tool_calls] == [("toolu_1", "check_feasibility", {"text": "revenue"})]
    assert reply.usage == {"promptTokens": 1050, "completionTokens": 20, "cacheReadTokens": 900, "cacheWriteTokens": 50}
    assert reply.provider == "anthropic"
    assert [b["type"] for b in reply.provider_content] == ["thinking", "text", "tool_use"]
    assert reply.provider_content[0]["signature"] == "sig"


def test_parse_checks_for_a_refusal_before_reading_content():
    reply = provider().parse(
        message(stop_reason="refusal", content=[], stop_details={"type": "refusal", "category": "cyber"})
    )
    assert reply.raw_finish_reason == "refusal"
    assert reply.tool_calls == []
    assert "declined" in reply.content and "cyber" in reply.content


def test_parse_says_when_an_answer_was_cut_off():
    reply = provider().parse(message(stop_reason="max_tokens", content=[{"type": "text", "text": "Half an answ"}]))
    assert reply.content.startswith("Half an answ")
    assert "cut off" in reply.content
