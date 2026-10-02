"""AI-FDE configuration."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _secret(name: str, default: str = "") -> str:
    """A value from NAME, or from the file NAME_FILE.

    Docker secrets arrive as files under /run/secrets rather than as
    environment variables, and an environment variable is visible to anyone who
    can run `docker inspect` on the container. The _FILE form is preferred when
    both are set.
    """
    path = os.environ.get(f"{name}_FILE")
    if path:
        try:
            with open(path, encoding="utf-8") as handle:
                return handle.read().strip()
        except OSError as exc:
            raise RuntimeError(f"Could not read {name}_FILE ({path}): {exc}") from exc
    return os.environ.get(name, default)


def _flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _num(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class Config:
    port: int = field(default_factory=lambda: int(_num("PORT", 4100)))
    database_url: str = field(
        default_factory=lambda: _secret(
            "DATABASE_URL", "postgresql://ontology:ontology@127.0.0.1:55432/tms_ontology"
        )
    )
    ontology_service_url: str = field(
        default_factory=lambda: os.environ.get(
            "ONTOLOGY_SERVICE_URL", "http://127.0.0.1:4000"
        ).rstrip("/")
    )

    # `auto` (the default), or one of: anthropic, openai, azure_openai, ollama,
    # builtin (the deterministic planner, which needs no model at all).
    #
    # `auto` resolves at startup from whether Ollama has a GPU:
    #   GPU present -> ollama primary, azure_openai fallback
    #   CPU only    -> azure_openai primary, ollama fallback
    # A 7B model with a fifteen-tool schema takes minutes per call on CPU, and a
    # tool-calling agent makes several calls per question, so on CPU-only hardware
    # local-first is the wrong default even though it is the nicer one.
    provider: str = field(
        default_factory=lambda: os.environ.get("LLM_PROVIDER", "auto").strip().lower()
    )
    # Tri-state, set by scripts/bootstrap.sh from whether nvidia-smi works on the
    # host: "true", "false", or empty meaning "probe Ollama and find out".
    ollama_gpu: str = field(
        default_factory=lambda: os.environ.get("OLLAMA_GPU", "").strip().lower()
    )
    # Used automatically when the primary provider errors or times out. Set empty
    # to disable failover and surface the primary's error instead.
    fallback_provider: str = field(
        default_factory=lambda: os.environ.get("LLM_FALLBACK_PROVIDER", "").strip().lower()
    )
    # After the primary fails, it is skipped for this long rather than retried on
    # every tool round. Without it, a turn against a dead or very slow local model
    # pays the full primary timeout eight times over.
    fallback_cooldown_seconds: float = field(
        default_factory=lambda: _num("LLM_FALLBACK_COOLDOWN", 300)
    )
    temperature: float = field(default_factory=lambda: _num("AI_FDE_TEMPERATURE", 0.1))
    # How many tool-calling rounds the agent gets before it must answer. Eight is
    # enough for "describe the type, query it, chart it, save the dashboard" with
    # room for one wrong turn; beyond that a model is usually looping.
    max_tool_rounds: int = field(default_factory=lambda: int(_num("AI_FDE_MAX_TOOL_ROUNDS", 8)))

    ollama_base_url: str = field(
        default_factory=lambda: os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")
    )
    ollama_model: str = field(
        default_factory=lambda: os.environ.get("OLLAMA_MODEL", "qwen2.5:7b-instruct")
    )

    azure_endpoint: str = field(
        default_factory=lambda: os.environ.get("AZURE_OPENAI_ENDPOINT", "").rstrip("/")
    )
    azure_key: str = field(default_factory=lambda: _secret("AZURE_OPENAI_KEY"))
    azure_deployment: str = field(
        default_factory=lambda: os.environ.get("AZURE_OPENAI_DEPLOYMENT", "gpt-4.1")
    )
    azure_api_version: str = field(
        default_factory=lambda: os.environ.get("AZURE_OPENAI_API_VERSION", "2024-12-01-preview")
    )

    # ── Claude (Anthropic) ──────────────────────────────────────────────────
    # Read ONLY from these names. The Anthropic SDK would otherwise pick up an
    # ambient ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL from the environment the
    # service happens to run in, which is how a deployment ends up billed to,
    # or routed through, an account nobody configured for it.
    anthropic_api_key: str = field(default_factory=lambda: _secret("AI_FDE_ANTHROPIC_API_KEY"))
    anthropic_base_url: str = field(
        default_factory=lambda: os.environ.get("AI_FDE_ANTHROPIC_BASE_URL", "https://api.anthropic.com").rstrip("/")
    )
    anthropic_model: str = field(
        default_factory=lambda: os.environ.get("AI_FDE_ANTHROPIC_MODEL", "claude-opus-5-5")
    )
    # low | medium | high | xhigh | max. Claude Opus 5.5 defaults to medium;
    # set here explicitly rather than inherited.
    anthropic_effort: str = field(
        default_factory=lambda: os.environ.get("AI_FDE_ANTHROPIC_EFFORT", "medium").strip().lower()
    )
    anthropic_timeout: float = field(default_factory=lambda: _num("AI_FDE_ANTHROPIC_TIMEOUT", 180))
    # Server-side refusal fallback ("default" lets the API pick the model by
    # refusal category). "off" disables it.
    anthropic_fallbacks: str = field(
        default_factory=lambda: os.environ.get("AI_FDE_ANTHROPIC_FALLBACKS", "default").strip().lower()
    )

    # ── any OpenAI-compatible endpoint (OpenAI, a gateway, vLLM, LM Studio) ──
    openai_api_key: str = field(default_factory=lambda: _secret("AI_FDE_OPENAI_API_KEY"))
    openai_base_url: str = field(
        default_factory=lambda: os.environ.get("AI_FDE_OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    )
    openai_model: str = field(default_factory=lambda: os.environ.get("AI_FDE_OPENAI_MODEL", "gpt-4.1"))
    openai_timeout: float = field(default_factory=lambda: _num("AI_FDE_OPENAI_TIMEOUT", 120))

    # The role the assistant acts as. Analyst can read everything and mutate
    # nothing, so a conversation cannot stage a write unless a user changes this.
    default_role: str = field(
        default_factory=lambda: os.environ.get("AI_FDE_ROLE", "tms:AnalystRole")
    )
    # Per-provider timeouts. Ollama's is deliberately short: on CPU-only hardware a
    # 7B model can take minutes per call, and failing over to a hosted model in 90 s
    # beats waiting five minutes for a local answer.
    ollama_timeout: float = field(default_factory=lambda: _num("OLLAMA_TIMEOUT", 300))
    azure_timeout: float = field(default_factory=lambda: _num("AZURE_OPENAI_TIMEOUT", 120))

    @property
    def model_name(self) -> str:
        return self.model_for(self.provider)

    def model_for(self, provider: str) -> str:
        return {
            "azure_openai": self.azure_deployment,
            "anthropic": self.anthropic_model,
            "openai": self.openai_model,
            "builtin": "planner-1",
        }.get(provider, self.ollama_model)


CONFIG = Config()
