"""LLM providers with tool calling.

Two backends behind one interface:

  * ollama       - the default. Runs an open-source model locally, no keys, no
                   data leaving the machine.
  * azure_openai - the Azure AI Foundry deployment already used elsewhere in
                   TMS_MCP.

They differ in ways that matter to a tool-calling agent, and normalising those
differences here is the whole point of this module:

  * Ollama returns tool-call arguments as a JSON object; Azure returns them as a
    JSON-encoded string. A caller that assumes either one breaks on the other.
  * Ollama's tool calls carry no id, but the OpenAI message format requires a
    tool_call_id on every tool result. Ids are synthesised so the transcript is
    valid for both.
  * A small local model will occasionally emit a tool call as text instead of
    using the tool channel. That is recovered from rather than shown to the user.
"""

from __future__ import annotations

import json
import logging
import re
import time
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
    # Which provider and model actually produced this, which is not always the
    # configured primary once failover is in play.
    provider: str = ""
    model: str = ""
    # Set when the primary was skipped or failed, so the UI can say why.
    failover_reason: str | None = None


class LlmError(RuntimeError):
    pass


def _coerce_arguments(raw: Any, tool_name: str) -> dict[str, Any]:
    """Normalise tool arguments from either provider into a dict."""
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


# A small model sometimes writes the call it wanted to make into the content
# instead of using the tool channel. Recognising the two shapes it usually
# produces turns a dead turn into a working one.
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
    ) -> LlmReply:
        raise NotImplementedError

    async def health(self) -> dict[str, Any]:
        raise NotImplementedError


class OllamaProvider(LlmProvider):
    name = "ollama"

    def __init__(self) -> None:
        self.base_url = CONFIG.ollama_base_url
        self.model = CONFIG.ollama_model

    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> LlmReply:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": _to_ollama_messages(messages),
            "stream": False,
            "options": {
                "temperature": CONFIG.temperature,
                # A long ontology catalogue plus a few tool results outgrows the
                # 2048-token default context, and silent truncation there makes
                # the model "forget" the tool output it just received.
                "num_ctx": 16384,
            },
        }
        if tools:
            payload["tools"] = tools

        async with httpx.AsyncClient(timeout=CONFIG.ollama_timeout) as client:
            try:
                response = await client.post(f"{self.base_url}/api/chat", json=payload)
            except httpx.TimeoutException as exc:
                raise LlmError(
                    f"Ollama did not answer within {CONFIG.ollama_timeout:.0f}s. "
                    "A 7B model on CPU-only hardware is often slower than that with a "
                    "large tool schema; give it a GPU, use a smaller model, or rely on "
                    "the fallback provider."
                ) from exc
            except httpx.HTTPError as exc:
                raise LlmError(
                    f"Could not reach Ollama at {self.base_url}: {exc}. "
                    "Is the ollama service up, and has the model been pulled?"
                ) from exc

        if response.status_code == 404:
            raise LlmError(
                f"Ollama has no model named '{self.model}'. Pull it with:\n"
                f"    docker compose exec ollama ollama pull {self.model}"
            )
        if response.status_code >= 400:
            raise LlmError(f"Ollama returned {response.status_code}: {response.text[:400]}")

        body = response.json()
        message = body.get("message") or {}
        calls = [
            ToolCall(
                id=call.get("id") or f"call_{uuid.uuid4().hex[:8]}",
                name=(call.get("function") or {}).get("name", ""),
                arguments=_coerce_arguments((call.get("function") or {}).get("arguments"), "?"),
            )
            for call in message.get("tool_calls") or []
        ]
        return LlmReply(
            content=message.get("content") or "",
            tool_calls=[c for c in calls if c.name],
            usage={
                "promptTokens": body.get("prompt_eval_count"),
                "completionTokens": body.get("eval_count"),
                "totalDurationMs": (body.get("total_duration") or 0) // 1_000_000,
            },
            raw_finish_reason=body.get("done_reason"),
            provider=self.name,
            model=self.model,
        )

    async def has_gpu(self) -> tuple[bool | None, str]:
        """Whether Ollama is running the model on a GPU.

        Ollama reports per-model VRAM in /api/ps, so a loaded model with
        size_vram > 0 is proof of GPU offload - which is a better signal than
        looking for a GPU device, because it also catches the common case of a GPU
        that exists on the host but was never passed into the container.

        Loading the model costs a few seconds, so this runs once at startup. If
        nothing is loaded and loading fails, the answer is None (unknown) rather
        than a guess.
        """
        async with httpx.AsyncClient(timeout=20) as client:
            try:
                running = await client.get(f"{self.base_url}/api/ps")
                running.raise_for_status()
                loaded = running.json().get("models") or []
            except httpx.HTTPError as exc:
                return None, f"Ollama not reachable: {exc}"

            if not loaded:
                # Nothing resident yet: load the model with a zero-token request,
                # which Ollama honours without generating anything.
                try:
                    await client.post(
                        f"{self.base_url}/api/generate",
                        json={"model": self.model, "prompt": "", "stream": False},
                        timeout=180,
                    )
                    running = await client.get(f"{self.base_url}/api/ps")
                    loaded = running.json().get("models") or []
                except httpx.HTTPError as exc:
                    return None, f"Could not load {self.model} to check for GPU: {exc}"

        if not loaded:
            return None, "Ollama reported no resident model, so GPU use is unknown."

        entry = next((m for m in loaded if (m.get("name") or "").startswith(self.model.split(":")[0])), loaded[0])
        vram = int(entry.get("size_vram") or 0)
        total = int(entry.get("size") or 0)
        if vram > 0:
            share = (vram / total * 100) if total else 100
            return True, f"{self.model} has {vram / 1e9:.1f} GB on GPU ({share:.0f}% offloaded)."
        return False, f"{self.model} is resident entirely in system RAM: no GPU offload."

    async def health(self) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=10) as client:
            try:
                response = await client.get(f"{self.base_url}/api/tags")
                response.raise_for_status()
            except httpx.HTTPError as exc:
                return {"reachable": False, "detail": str(exc)}
        models = [m.get("name") for m in response.json().get("models", [])]
        # Compare on the bare name too: "qwen2.5:7b-instruct" is listed by Ollama
        # with its tag, and a partial match is what tells us a pull finished.
        base = self.model.split(":")[0]
        return {
            "reachable": True,
            "model": self.model,
            "modelPresent": any(
                m == self.model or (m or "").startswith(base) for m in models
            ),
            "availableModels": models,
        }


def _to_ollama_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Ollama accepts the OpenAI shape but ignores tool_call_id on tool results.

    It matches a tool result to its call by position, so the name is carried
    instead and the id dropped.
    """
    out: list[dict[str, Any]] = []
    for message in messages:
        role = message.get("role")
        if role == "tool":
            out.append(
                {
                    "role": "tool",
                    "content": message.get("content") or "",
                    **({"name": message["name"]} if message.get("name") else {}),
                }
            )
        elif role == "assistant" and message.get("tool_calls"):
            out.append(
                {
                    "role": "assistant",
                    "content": message.get("content") or "",
                    "tool_calls": [
                        {
                            "function": {
                                "name": call["function"]["name"],
                                "arguments": _coerce_arguments(
                                    call["function"].get("arguments"), call["function"]["name"]
                                ),
                            }
                        }
                        for call in message["tool_calls"]
                    ],
                }
            )
        else:
            out.append({"role": role, "content": message.get("content") or ""})
    return out


class AzureOpenAIProvider(LlmProvider):
    name = "azure_openai"

    def __init__(self) -> None:
        if not CONFIG.azure_endpoint or not CONFIG.azure_key:
            raise LlmError(
                "LLM_PROVIDER=azure_openai needs AZURE_OPENAI_ENDPOINT and "
                "AZURE_OPENAI_KEY. Set them in .env, or switch to LLM_PROVIDER=ollama "
                "to run entirely locally."
            )
        self.url = (
            f"{CONFIG.azure_endpoint}/openai/deployments/{CONFIG.azure_deployment}"
            f"/chat/completions?api-version={CONFIG.azure_api_version}"
        )

    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> LlmReply:
        payload: dict[str, Any] = {
            "messages": messages,
            "temperature": CONFIG.temperature,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"

        async with httpx.AsyncClient(timeout=CONFIG.azure_timeout) as client:
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


class FallbackProvider(LlmProvider):
    """Primary provider with automatic failover to a second one.

    WHY THIS EXISTS: a local open-source model is the right default - no keys, no
    data leaving the machine - but on CPU-only hardware a 7B model with a
    fifteen-tool schema can take minutes per call, and a tool-calling agent makes
    several calls per question. Failing over to a hosted model keeps the product
    usable on a laptop without giving up the local-first default on a machine that
    can actually run it.

    THE CIRCUIT BREAKER is the part that matters. Without it, a turn against a
    dead or slow primary pays the primary's timeout on every one of up to eight
    tool rounds - 90 s x 8 before an answer. After a failure the primary is
    skipped for LLM_FALLBACK_COOLDOWN seconds, so the first question is slow once
    and every question after it is fast. The breaker closes again on its own, so
    a primary that recovers is picked back up without a restart.
    """

    name = "fallback"

    def __init__(self, primary: LlmProvider, fallback: LlmProvider) -> None:
        self.primary = primary
        self.fallback = fallback
        self._open_until: float = 0.0
        self._last_reason: str | None = None

    @property
    def breaker_open(self) -> bool:
        return time.monotonic() < self._open_until

    def _trip(self, reason: str) -> None:
        self._open_until = time.monotonic() + CONFIG.fallback_cooldown_seconds
        self._last_reason = reason
        log.warning(
            "%s failed (%s). Using %s for the next %.0fs.",
            self.primary.name, reason, self.fallback.name, CONFIG.fallback_cooldown_seconds,
        )

    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> LlmReply:
        if self.breaker_open:
            reply = await self.fallback.chat(messages, tools)
            reply.failover_reason = (
                f"{self.primary.name} is in cooldown after: {self._last_reason}"
            )
            return reply

        try:
            return await self.primary.chat(messages, tools)
        except LlmError as exc:
            self._trip(str(exc))
            # If the fallback also fails there is nothing left to try, so its error
            # propagates - but it carries both, because "Ollama timed out AND the
            # Azure key is wrong" is two different fixes.
            try:
                reply = await self.fallback.chat(messages, tools)
            except LlmError as fallback_exc:
                raise LlmError(
                    f"Both providers failed. {self.primary.name}: {exc} | "
                    f"{self.fallback.name}: {fallback_exc}"
                ) from fallback_exc
            reply.failover_reason = f"{self.primary.name} failed: {exc}"
            return reply

    async def health(self) -> dict[str, Any]:
        primary = await self.primary.health()
        fallback = await self.fallback.health()
        # Reachable if EITHER can answer: that is what the user experiences.
        return {
            "reachable": bool(primary.get("reachable") or fallback.get("reachable")),
            "model": primary.get("model") if primary.get("reachable") else fallback.get("model"),
            "modelPresent": (
                primary.get("modelPresent", True)
                if primary.get("reachable")
                else fallback.get("modelPresent", True)
            ),
            "activeProvider": (
                self.fallback.name
                if self.breaker_open or not primary.get("reachable")
                else self.primary.name
            ),
            "breakerOpen": self.breaker_open,
            "lastFailoverReason": self._last_reason,
            "primary": {"provider": self.primary.name, **primary},
            "fallback": {"provider": self.fallback.name, **fallback},
            "detail": None
            if primary.get("reachable") or fallback.get("reachable")
            else f"{primary.get('detail')} / {fallback.get('detail')}",
        }


def _single_provider(name: str) -> LlmProvider:
    if name == "azure_openai":
        return AzureOpenAIProvider()
    if name == "ollama":
        return OllamaProvider()
    raise LlmError(f"Unknown LLM provider '{name}'. Use 'ollama' or 'azure_openai'.")


async def resolve_provider_order() -> tuple[str, str, str]:
    """Decide (primary, fallback, why) for the configured mode.

    In `auto` mode the deciding question is whether Ollama can actually offload to
    a GPU. OLLAMA_GPU, set by scripts/bootstrap.sh from whether nvidia-smi works on
    the host, answers it without a probe; otherwise Ollama is asked directly.
    """
    explicit = CONFIG.provider
    if explicit != "auto":
        fallback = CONFIG.fallback_provider
        if fallback == explicit:
            fallback = ""
        return explicit, fallback, f"LLM_PROVIDER={explicit} was set explicitly."

    if CONFIG.ollama_gpu == "true":
        return (
            "ollama",
            "azure_openai",
            "A GPU was detected, so the local open-source model runs primary.",
        )
    if CONFIG.ollama_gpu == "false":
        return (
            "azure_openai",
            "ollama",
            "No GPU was detected (nvidia-smi absent or failing), so Ollama would be "
            "CPU-only. Azure OpenAI runs primary and Ollama stays available as the "
            "fallback.",
        )

    # Nothing told us, so ask Ollama.
    try:
        gpu, detail = await OllamaProvider().has_gpu()
    except Exception as exc:  # noqa: BLE001
        gpu, detail = None, str(exc)

    if gpu is True:
        return "ollama", "azure_openai", f"GPU offload confirmed. {detail}"
    if gpu is False:
        return (
            "azure_openai",
            "ollama",
            f"CPU-only Ollama. {detail} Azure OpenAI runs primary; Ollama stays as fallback.",
        )
    return (
        "azure_openai",
        "ollama",
        f"Could not determine whether Ollama has a GPU ({detail}) so the hosted model "
        "runs primary, which is the safe assumption.",
    )


async def build_provider() -> tuple[LlmProvider, str]:
    """Build the provider chain, returning it with the reason for the choice."""
    primary_name, fallback_name, why = await resolve_provider_order()

    try:
        primary = _single_provider(primary_name)
    except LlmError as exc:
        # The chosen primary cannot even be constructed (no Azure key, say). Fall
        # straight to the other one rather than refusing to start.
        if fallback_name:
            log.warning("Primary '%s' unavailable: %s. Using '%s' alone.", primary_name, exc, fallback_name)
            return _single_provider(fallback_name), f"{why} Primary unavailable: {exc}"
        raise

    if not fallback_name:
        log.info("LLM: %s only. %s", primary.name, why)
        return primary, why

    try:
        fallback = _single_provider(fallback_name)
    except LlmError as exc:
        # A misconfigured fallback must not stop the primary from working; the
        # reason is logged and health() reports the primary alone.
        log.warning("Fallback provider '%s' unavailable: %s", fallback_name, exc)
        return primary, f"{why} Fallback {fallback_name} unavailable: {exc}"

    log.info("LLM: primary=%s fallback=%s. %s", primary.name, fallback.name, why)
    return FallbackProvider(primary, fallback), why
