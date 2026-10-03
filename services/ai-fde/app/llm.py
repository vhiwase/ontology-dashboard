"""The LLM provider: Azure OpenAI with tool calling.

There is one backend. The provider interface (`chat`, `health`) and the
tool-call normalisation are kept separate from the agent loop so a second
backend can be added without touching anything else, but nothing here assumes
one exists.

The normalisation that matters: tool-call arguments arrive as a JSON-encoded
string from the OpenAI wire format and are turned into a dict here, once,
rather than at every call site. A small model occasionally emits a tool call
as text instead of using the tool channel; that is recovered from rather than
shown to the user.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from dataclasses import dataclass, field
from typing import Any

import httpx

from .config import CONFIG

log = logging.getLogger("ai_fde.llm")


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass
class LlmReply:
    content: str
    tool_calls: list[ToolCall] = field(default_factory=list)
    usage: dict[str, Any] = field(default_factory=dict)
    raw_finish_reason: str | None = None
    provider: str = ""
    model: str = ""


class LlmError(RuntimeError):
    pass


# How often a rate-limited call is retried, and the longest single wait. Three
# waits of at most 20 s bound the extra time a turn can spend at a minute.
RATE_LIMIT_RETRIES = 3
MAX_RETRY_WAIT_SECONDS = 20.0


def _retry_after_seconds(response: httpx.Response) -> float:
    """The wait Azure asks for on a 429, bounded; 5 s when it names none."""
    for header, scale in (("retry-after-ms", 0.001), ("retry-after", 1.0)):
        raw = response.headers.get(header)
        if raw:
            try:
                return max(0.5, min(float(raw) * scale, MAX_RETRY_WAIT_SECONDS))
            except ValueError:
                continue
    return 5.0


def _coerce_arguments(raw: Any, tool_name: str) -> dict[str, Any]:
    """Normalise tool arguments from the wire format into a dict."""
    if isinstance(raw, dict):
        return raw
    if raw in (None, ""):
        return {}
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {"value": parsed}
        except json.JSONDecodeError:
            log.warning("Tool %s got unparseable arguments: %r", tool_name, raw[:200])
            return {}
    return {}


# A model sometimes writes the call it wanted to make into the content instead
# of using the tool channel. Recognising the two shapes it usually produces
# turns a dead turn into a working one.
_TEXT_TOOL_PATTERNS = [
    re.compile(r"```(?:json)?\s*(\{\s*\"(?:name|tool|function)\"\s*:.*?\})\s*```", re.S),
    re.compile(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", re.S),
]


def recover_text_tool_calls(content: str, known_tools: set[str]) -> tuple[str, list[ToolCall]]:
    """Pull a tool call out of prose, if one is hiding there.

    Only accepts a name the agent actually offers, so ordinary text that happens
    to contain JSON is left alone.
    """
    if not content:
        return content, []

    recovered: list[ToolCall] = []
    remaining = content
    for pattern in _TEXT_TOOL_PATTERNS:
        for match in pattern.finditer(content):
            try:
                payload = json.loads(match.group(1))
            except json.JSONDecodeError:
                continue
            name = payload.get("name") or payload.get("tool") or payload.get("function")
            if not isinstance(name, str) or name not in known_tools:
                continue
            arguments = (
                payload.get("arguments")
                or payload.get("parameters")
                or payload.get("args")
                or {}
            )
            recovered.append(
                ToolCall(
                    id=f"recovered_{uuid.uuid4().hex[:8]}",
                    name=name,
                    arguments=_coerce_arguments(arguments, name),
                )
            )
            remaining = remaining.replace(match.group(0), "").strip()

    return remaining, recovered


class LlmProvider:
    name = "base"

    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        tool_choice: Any = None,
    ) -> LlmReply:
        """One completion. `tool_choice` forces a named tool when given."""
        raise NotImplementedError

    async def health(self) -> dict[str, Any]:
        raise NotImplementedError


class AzureOpenAIProvider(LlmProvider):
    name = "azure_openai"

    def __init__(self) -> None:
        if not CONFIG.azure_endpoint or not CONFIG.azure_key:
            raise LlmError(
                "The assistant runs on Azure OpenAI and needs AZURE_OPENAI_ENDPOINT "
                "and AZURE_OPENAI_KEY. Set them in .env (the key lives in "
                "./secrets/azure_openai_key). Everything except the assistant works "
                "without them."
            )
        self.url = (
            f"{CONFIG.azure_endpoint}/openai/deployments/{CONFIG.azure_deployment}"
            f"/chat/completions?api-version={CONFIG.azure_api_version}"
        )

    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        tool_choice: Any = None,
    ) -> LlmReply:
        payload: dict[str, Any] = {
            "messages": messages,
            "temperature": CONFIG.temperature,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = tool_choice or "auto"

        async with httpx.AsyncClient(timeout=CONFIG.azure_timeout) as client:
            for attempt in range(RATE_LIMIT_RETRIES + 1):
                try:
                    response = await client.post(
                        self.url,
                        json=payload,
                        headers={"api-key": CONFIG.azure_key, "content-type": "application/json"},
                    )
                except httpx.TimeoutException as exc:
                    raise LlmError(
                        f"Azure OpenAI did not answer within {CONFIG.azure_timeout:.0f}s."
                    ) from exc
                except httpx.HTTPError as exc:
                    raise LlmError(f"Could not reach Azure OpenAI: {exc}") from exc

                # A 429 is the deployment's tokens-per-minute limit, not a
                # failure of the request: a long turn (building an ontology
                # is a dozen rounds) can cross it. Waiting the time Azure asks
                # for and trying again finishes the turn; giving up would
                # leave work half-described.
                if response.status_code != 429 or attempt == RATE_LIMIT_RETRIES:
                    break
                wait = _retry_after_seconds(response)
                log.warning("Azure OpenAI rate limit; retrying in %.1fs (attempt %d).", wait, attempt + 1)
                await asyncio.sleep(wait)

        if response.status_code >= 400:
            raise LlmError(f"Azure OpenAI returned {response.status_code}: {response.text[:400]}")

        body = response.json()
        choice = (body.get("choices") or [{}])[0]
        message = choice.get("message") or {}
        calls = [
            ToolCall(
                id=call.get("id") or f"call_{uuid.uuid4().hex[:8]}",
                name=(call.get("function") or {}).get("name", ""),
                arguments=_coerce_arguments((call.get("function") or {}).get("arguments"), "?"),
            )
            for call in message.get("tool_calls") or []
        ]
        usage = body.get("usage") or {}
        return LlmReply(
            content=message.get("content") or "",
            tool_calls=[c for c in calls if c.name],
            usage={
                "promptTokens": usage.get("prompt_tokens"),
                "completionTokens": usage.get("completion_tokens"),
                "totalTokens": usage.get("total_tokens"),
            },
            raw_finish_reason=choice.get("finish_reason"),
            provider=self.name,
            model=CONFIG.azure_deployment,
        )

    async def health(self) -> dict[str, Any]:
        # A one-token completion is the only honest reachability check: the
        # deployment can exist and still refuse the key.
        try:
            reply = await self.chat([{"role": "user", "content": "ping"}])
        except LlmError as exc:
            return {"reachable": False, "detail": str(exc)}
        return {
            "reachable": True,
            "model": CONFIG.azure_deployment,
            "modelPresent": True,
            "sample": reply.content[:40],
        }


def _single_provider(name: str) -> LlmProvider:
    if name in ("azure_openai", "auto"):
        return AzureOpenAIProvider()
    if name == "builtin":
        # Imported here: the planner imports this module's types.
        from .planner import BuiltinPlanner

        return BuiltinPlanner()
    raise LlmError(
        f"Unknown LLM provider '{name}'. The assistant runs on 'azure_openai' "
        "('builtin' answers from the ontology without a model)."
    )


async def build_provider() -> tuple[LlmProvider, str]:
    """Build the provider, returning it with the reason for the choice.

    Azure OpenAI is the model. Without its endpoint and key, the built-in
    planner answers instead: it runs the same tools (the feasibility check,
    metrics, proposals, boards) and says on every answer that no model wrote
    it, so a fresh install is usable before anyone has an Azure key.
    LLM_PROVIDER=builtin selects the planner on purpose (tests, demos).
    """
    if CONFIG.provider == "builtin":
        return _single_provider("builtin"), "LLM_PROVIDER=builtin: the built-in planner answers."
    if CONFIG.provider not in ("azure_openai", "auto"):
        raise LlmError(
            f"LLM_PROVIDER={CONFIG.provider!r} is not available: the assistant runs "
            "on azure_openai. Unset LLM_PROVIDER or set it to azure_openai."
        )
    try:
        provider = _single_provider("azure_openai")
    except LlmError as exc:
        log.warning("Azure OpenAI is not configured; the built-in planner answers. (%s)", exc)
        return _single_provider("builtin"), (
            "Azure OpenAI is not configured (AZURE_OPENAI_ENDPOINT and the key), so the "
            "built-in planner answers from the ontology."
        )
    log.info("LLM: azure_openai (%s).", CONFIG.azure_deployment)
    return provider, f"Azure OpenAI ({CONFIG.azure_deployment})."
