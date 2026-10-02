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

    # Kept as a named setting so a misconfigured value fails loudly at startup
    # (build_provider refuses anything but azure_openai) rather than being
    # silently ignored.
    provider: str = field(
        default_factory=lambda: os.environ.get("LLM_PROVIDER", "azure_openai").strip().lower()
    )
    temperature: float = field(default_factory=lambda: _num("AI_FDE_TEMPERATURE", 0.1))
    # How many tool-calling rounds the agent gets before it must answer. A
    # question takes two or three; building an ontology from several datasets -
    # plan, profile, create, link, metrics, actions, answer - takes around ten,
    # so sixteen leaves room for a few refused calls to be corrected.
    max_tool_rounds: int = field(default_factory=lambda: int(_num("AI_FDE_MAX_TOOL_ROUNDS", 16)))

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

    # The role the assistant acts as. Analyst can read everything and mutate
    # nothing, so a conversation cannot stage a write unless a user changes this.
    default_role: str = field(
        default_factory=lambda: os.environ.get("AI_FDE_ROLE", "tms:AnalystRole")
    )
    azure_timeout: float = field(default_factory=lambda: _num("AZURE_OPENAI_TIMEOUT", 120))

    @property
    def model_name(self) -> str:
        return self.azure_deployment

    def model_for(self, provider: str) -> str:
        # One model backend; the built-in planner is named for what it is.
        if provider == "builtin":
            return "planner-1"
        return self.azure_deployment


CONFIG = Config()
