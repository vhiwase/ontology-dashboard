"""Pipeline configuration, read once from the environment.

Every knob the pipeline honours is declared here so the compose file and the
README stay in sync with the code.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field


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
        default_factory=lambda: os.environ.get(
            "DATABASE_URL",
            "postgresql://ontology:ontology@localhost:55432/tms_ontology",
        )
    )
    source_dir: str = field(
        default_factory=lambda: os.environ.get("PIPELINE_SOURCE_DIR", "/data/api_responses")
    )
    simulate_execution: bool = field(
        default_factory=lambda: _flag("PIPELINE_SIMULATE_EXECUTION", True)
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

    # Ontology identity.
    ontology_id: str = "tms:TransportManagementOntology"
    ontology_namespace: str = "tms"
    ontology_version: str = "1.0.0"


CONFIG = Config()
