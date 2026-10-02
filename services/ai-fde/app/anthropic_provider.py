"""The Claude provider: Anthropic's Messages API, through the official SDK.

The agent keeps its transcript in the OpenAI chat shape every other provider
here speaks (system/user/assistant/tool messages, `tool_calls`). This module
translates that shape to the Messages API on the way out and back on the way in:

  * leading system messages become the top-level `system` blocks. The first
    (the fixed instructions) carries an explicit cache breakpoint, so every
    conversation on the server shares it; the rest of the request is cached by
    top-level automatic caching, which follows the conversation as it grows;
  * a later system message (the agent's "last step" note) stays where it
    arises, as a mid-conversation `role: "system"` message on models that take
    one, or as a text block at the end of the user turn before it on models
    that do not;
  * an assistant turn's `tool_calls` become `tool_use` blocks, and consecutive
    tool results become `tool_result` blocks in ONE user message (splitting
    them teaches the model to stop making parallel calls);
  * within a turn, the assistant content Claude returned - including its
    thinking blocks - is replayed VERBATIM. Thinking blocks are bound to the
    conversation that produced them, so a reconstructed copy would be an edit;
    the agent carries the raw blocks on the message as `provider_content`.

Earlier turns are replayed as text only (the store keeps answers, not
reasoning). Dropping thinking from the front of a conversation is allowed;
`prefix_mismatch_behavior: "drop_block"` is still set explicitly, so anything
that does not match is dropped from that one request instead of failing it.

Credentials and endpoint come only from AI_FDE_ANTHROPIC_* (see config.py),
never from ambient ANTHROPIC_* variables.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

import anthropic

from .config import CONFIG
from .llm import LlmError, LlmProvider, LlmReply, ToolCall

log = logging.getLogger("ai_fde.anthropic")

# thinking-binding-controls: lets the request set prefix_mismatch_behavior.
# server-side-fallback (2026-07-01): the `fallbacks: "default"` scalar form.
BETA_THINKING_BINDING = "thinking-binding-controls-2026-08-01"
BETA_FALLBACK = "server-side-fallback-2026-07-01"

MAX_TOKENS = 16_000

# Models that accept a `role: "system"` message inside `messages`. Anything else
# gets the same words as a text block in the user turn before it, rather than a
# 400. Claude Sonnet 5 is deliberately absent.
SYSTEM_MESSAGE_MODELS = {
    "claude-opus-5",
    "claude-opus-5-5",
    "claude-opus-4-8",
    "claude-fable-5",
    "claude-fable-5-1",
    "claude-mythos-5",
    "claude-mythos-5-1",
    "claude-sonnet-5-5",
}


def supports_system_messages(model: str) -> bool:
    base = re.sub(r"-\d{8}$", "", (model or "").strip().lower())
    return base in SYSTEM_MESSAGE_MODELS


def to_anthropic_tools(tools: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """OpenAI function tools -> Messages API tool definitions."""
    out: list[dict[str, Any]] = []
    for tool in tools or []:
        function = tool.get("function") or {}
        name = function.get("name")
        if not name:
            continue
        out.append(
            {
                "name": name,
                "description": function.get("description") or "",
                "input_schema": function.get("parameters") or {"type": "object", "properties": {}},
            }
        )
    return out


def _arguments(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {"value": parsed}
        except json.JSONDecodeError:
            return {}
    return {}


def to_anthropic_messages(
    messages: list[dict[str, Any]], system_messages: bool = True
) -> tuple[list[str], list[dict[str, Any]]]:
    """Split the transcript into the system prompt parts and Messages API turns.

    `system_messages` says whether the model takes a mid-conversation
    `role: "system"` message; without it such a message becomes a text block
    at the end of the user turn it follows. Pure, so the translation is tested
    without a network.
    """
    system_parts: list[str] = []
    turns: list[dict[str, Any]] = []
    started = False

    def append(role: str, blocks: list[dict[str, Any]]) -> None:
        # The API wants alternating roles; adjacent same-role messages (tool
        # results followed by a note, say) are merged into one.
        if turns and turns[-1]["role"] == role and role != "system":
            turns[-1]["content"].extend(blocks)
        else:
            turns.append({"role": role, "content": blocks})

    for message in messages:
        role = message.get("role")
        content = message.get("content") or ""
        if role == "system":
            if not started:
                system_parts.append(str(content))
            elif system_messages and turns and turns[-1]["role"] == "user":
                # A mid-conversation instruction (the agent's "last step" note)
                # is appended where it arises rather than folded into `system`,
                # so the prefix earlier blocks are bound to stays unchanged.
                turns.append({"role": "system", "content": str(content)})
            else:
                append("user", [{"type": "text", "text": f"<system-reminder>{content}</system-reminder>"}])
            continue
        started = True
        if role == "user":
            append("user", [{"type": "text", "text": str(content)}])
        elif role == "assistant":
            raw = message.get("provider_content")
            if isinstance(raw, list) and raw and message.get("provider") == "anthropic":
                # Exactly what Claude returned, thinking blocks included.
                turns.append({"role": "assistant", "content": raw})
                continue
            blocks: list[dict[str, Any]] = []
            if str(content).strip():
                blocks.append({"type": "text", "text": str(content)})
            for call in message.get("tool_calls") or []:
                function = call.get("function") or {}
                blocks.append(
                    {
                        "type": "tool_use",
                        "id": call.get("id"),
                        "name": function.get("name"),
                        "input": _arguments(function.get("arguments")),
                    }
                )
            if blocks:
                append("assistant", blocks)
        elif role == "tool":
            append(
                "user",
                [
                    {
                        "type": "tool_result",
                        "tool_use_id": message.get("tool_call_id"),
                        "content": str(content),
                    }
                ],
            )
    # A conversation opens with the user. Stored history is a window onto a
    # longer thread and can begin mid-exchange, so anything before the first
    # user turn is dropped from the front.
    while turns and turns[0]["role"] != "user":
        turns.pop(0)
    return [part for part in system_parts if part.strip()], turns


class AnthropicProvider(LlmProvider):
    name = "anthropic"

    def __init__(self) -> None:
        if not CONFIG.anthropic_api_key:
            raise LlmError(
                "LLM_PROVIDER=anthropic needs AI_FDE_ANTHROPIC_API_KEY (or "
                "AI_FDE_ANTHROPIC_API_KEY_FILE). Set it, or choose another provider."
            )
        self.model = CONFIG.anthropic_model
        # Explicit key and base URL, so nothing ambient is used.
        self.client = anthropic.AsyncAnthropic(
            api_key=CONFIG.anthropic_api_key,
            base_url=CONFIG.anthropic_base_url,
            timeout=CONFIG.anthropic_timeout,
            max_retries=2,
        )

    def request(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
        tool_choice: str,
    ) -> dict[str, Any]:
        """The request body, separated from sending it so it can be tested."""
        system, turns = to_anthropic_messages(messages, supports_system_messages(self.model))
        betas = [BETA_THINKING_BINDING]
        body: dict[str, Any] = {
            "model": self.model,
            "max_tokens": MAX_TOKENS,
            "messages": turns,
            "thinking": {"type": "adaptive", "block_binding": {"prefix_mismatch_behavior": "drop_block"}},
            "output_config": {"effort": CONFIG.anthropic_effort},
            # Automatic caching for the growing tail: each tool round of a turn
            # re-reads the rounds before it instead of paying for them again.
            "cache_control": {"type": "ephemeral"},
        }
        if system:
            # The fixed instructions come first and are the same for every
            # conversation on the server: an explicit breakpoint after them
            # gives every turn a read point, whatever follows. The orientation
            # (this workspace's types and metrics) changes per turn and rides
            # on the automatic breakpoint instead.
            blocks: list[dict[str, Any]] = [{"type": "text", "text": part} for part in system]
            # Every leading block but the last is fixed text (the instructions,
            # and a space's addendum when it has one); the last is this turn's
            # inventory. Breakpoints after the first and the last fixed block.
            fixed = len(blocks) - 1 if len(blocks) > 1 else 1
            for index in {0, fixed - 1}:
                blocks[index]["cache_control"] = {"type": "ephemeral"}
            body["system"] = blocks
        converted = to_anthropic_tools(tools)
        if converted:
            # The same tools on every round of a turn, even the last: changing
            # the tools array would invalidate the turn's thinking blocks, so
            # the final round says "none" instead of withdrawing them.
            body["tools"] = converted
            body["tool_choice"] = {"type": "none" if tool_choice == "none" else "auto"}
        if CONFIG.anthropic_fallbacks not in ("", "off", "none", "false"):
            body["fallbacks"] = "default"
            betas.append(BETA_FALLBACK)
        body["betas"] = betas
        return body

    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str = "auto",
    ) -> LlmReply:
        body = self.request(messages, tools, tool_choice)
        try:
            # Streamed and collected, so a long answer is never cut off by an
            # HTTP timeout: the timeout applies between chunks, not to the whole.
            async with self.client.beta.messages.stream(**body) as stream:
                response = await stream.get_final_message()
        except anthropic.AuthenticationError as exc:
            raise LlmError("Claude rejected the API key (AI_FDE_ANTHROPIC_API_KEY).") from exc
        except anthropic.PermissionDeniedError as exc:
            raise LlmError(f"The API key may not use {self.model}: {exc.message}") from exc
        except anthropic.NotFoundError as exc:
            raise LlmError(f"Unknown model or endpoint for Claude: {exc.message}") from exc
        except anthropic.RateLimitError as exc:
            raise LlmError("Claude is rate-limiting this key; try again shortly.") from exc
        except anthropic.BadRequestError as exc:
            raise LlmError(f"Claude rejected the request: {exc.message}") from exc
        except anthropic.APITimeoutError as exc:
            raise LlmError(f"Claude sent nothing for {CONFIG.anthropic_timeout:.0f}s.") from exc
        except anthropic.APIStatusError as exc:
            raise LlmError(f"Claude returned {exc.status_code}: {exc.message}") from exc
        except anthropic.APIConnectionError as exc:
            raise LlmError(f"Could not reach Claude at {CONFIG.anthropic_base_url}: {exc}") from exc
        return self.parse(response)

    def parse(self, response: Any) -> LlmReply:
        """Messages API response -> LlmReply. Checks the stop reason first."""
        usage = getattr(response, "usage", None)
        usage_out = {
            "promptTokens": (getattr(usage, "input_tokens", 0) or 0)
            + (getattr(usage, "cache_read_input_tokens", 0) or 0)
            + (getattr(usage, "cache_creation_input_tokens", 0) or 0),
            "completionTokens": getattr(usage, "output_tokens", 0) or 0,
            "cacheReadTokens": getattr(usage, "cache_read_input_tokens", 0) or 0,
            "cacheWriteTokens": getattr(usage, "cache_creation_input_tokens", 0) or 0,
        }
        transformations = getattr(response, "input_transformations", None)
        if transformations:
            log.info("Claude dropped or flagged replayed blocks: %s", transformations)

        if response.stop_reason == "refusal":
            details = getattr(response, "stop_details", None)
            category = getattr(details, "category", None) if details else None
            return LlmReply(
                content=(
                    "The model declined to answer that"
                    + (f" (its safety checks flagged it as '{category}')" if category else "")
                    + ". Rephrase the question, or ask about the data in a different way."
                ),
                usage=usage_out,
                raw_finish_reason="refusal",
                provider=self.name,
                model=getattr(response, "model", self.model),
            )

        text = "".join(block.text for block in response.content if block.type == "text")
        calls = [
            ToolCall(
                id=block.id,
                name=block.name,
                arguments=block.input if isinstance(block.input, dict) else {},
            )
            for block in response.content
            if block.type == "tool_use"
        ]
        if response.stop_reason == "max_tokens" and not calls:
            text = (text + "\n\n_(The answer was cut off at the length limit.)_").strip()
        return LlmReply(
            content=text,
            tool_calls=calls,
            usage=usage_out,
            raw_finish_reason=response.stop_reason,
            provider=self.name,
            model=getattr(response, "model", self.model),
            # Replayed verbatim on the next round of this turn.
            provider_content=[block.model_dump(mode="json", exclude_none=True) for block in response.content],
        )

    async def health(self) -> dict[str, Any]:
        # Configured is all that can be said without spending tokens; a bad
        # key surfaces on the first turn with its own message.
        return {"reachable": True, "model": self.model, "modelPresent": True, "detail": None}
