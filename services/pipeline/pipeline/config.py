"""Pipeline configuration, read once from the environment.

Every knob the pipeline honours is declared here so the compose file and the
README stay in sync with the code.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _secret(name: str, default: str = "") -> str:
    """A value from NAME, or from the file NAME_FILE.

    Docker secrets arrive as files under /run/secrets rather than as
    environment variables, and an environment variable is visible to anyone who
    can run `docker inspect` on the container. The _FILE form wins when both
    are set.
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


@dataclass(frozen=True)
class Config:
    database_url: str = field(
        default_factory=lambda: _secret(
            "DATABASE_URL",
            "postgresql://ontology:ontology@localhost:55432/tms_ontology",
        )
    )
    source_dir: str = field(
        default_factory=lambda: os.environ.get("PIPELINE_SOURCE_DIR", "/data/api_responses")
    )
    force_reingest: bool = field(default_factory=lambda: _flag("PIPELINE_FORCE_REINGEST", False))


CONFIG = Config()
