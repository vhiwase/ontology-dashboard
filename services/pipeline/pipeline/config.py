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
    database_url: str = field(
        default_factory=lambda: _secret(
            "DATABASE_URL",
            "postgresql://ontology:ontology@localhost:55432/tms_ontology",
        )
    )
    source_dir: str = field(
        default_factory=lambda: os.environ.get("PIPELINE_SOURCE_DIR", "/data/api_responses")
    )
    # OFF by default, deliberately.
    #
    # The captured snapshot is a PLANNING snapshot: it records what was
    # intended, not what happened. It carries no carrier assignment, no
    # execution actuals, no leg distance (every leg reports 0 m) and no
    # arrivals. Generating those made 17 of 31 KPIs - every cost-per-km,
    # transit-time and on-time figure - look authoritative while being
    # invented.
    #
    # The platform now reports the gap instead of filling it. Turning this on
    # is an explicit, deliberate act, and what it writes goes to tms_sim, which
    # is a separate schema from the captured tms_raw - the source data is never
    # modified.
    simulate_execution: bool = field(
        default_factory=lambda: _flag("PIPELINE_SIMULATE_EXECUTION", False)
    )
    sim_seed: int = field(default_factory=lambda: int(_num("PIPELINE_SIM_SEED", 20260919)))
    force_reingest: bool = field(default_factory=lambda: _flag("PIPELINE_FORCE_REINGEST", False))

    # A discovered join is promoted to a link type once at least this share of
    # non-null source values resolve to a target row. Deliberately low: the TMS
    # splits origin/destination references across several party projections, and
    # a 20% join is a real modelling fact worth surfacing, not noise.
    link_min_match_ratio: float = field(
        default_factory=lambda: _num("PIPELINE_LINK_MIN_MATCH_RATIO", 0.05)
    )

    # Schemas the pipeline owns.
    raw_schema: str = "tms_raw"
    sim_schema: str = "tms_sim"
    view_schema: str = "tms_views"
    platform_schema: str = "platform"

    # Which space this run publishes into.
    #
    # An ontology is published BY a pipeline, and pipelines belong to a space,
    # so the ontology this run produces belongs to the space it ran in. The
    # default is the sandbox because that is where unreviewed work belongs;
    # promoting to staging or production is a deliberate act of setting this.
    space: str = field(
        default_factory=lambda: os.environ.get("PIPELINE_SPACE", "sandbox").strip() or "sandbox"
    )

    # Ontology identity.
    ontology_id: str = "tms:TransportManagementOntology"
    ontology_namespace: str = "tms"
    ontology_version: str = "1.0.0"


CONFIG = Config()
