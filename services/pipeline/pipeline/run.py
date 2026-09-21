"""Pipeline entry point.

    python -m pipeline.run                 full run
    python -m pipeline.run --force         re-land the snapshot from scratch
    python -m pipeline.run --skip-ingest   regenerate ontology from existing data
    python -m pipeline.run --no-simulate   skip the execution simulation
    python -m pipeline.run --dry-run       report what would happen, write nothing

Stages, in order, each depending on the last:

    1  ingest      captured JSON payloads   -> tms_raw
    2  simulate    execution actuals        -> tms_sim
    3  introspect  tms_views schema         -> view descriptions
    4  discover    reference probing        -> link types
    5  generate    ontology document        -> platform.ontology_version + registry
    6  kpis        curated catalogue        -> platform.kpi_definition
    7  lineage     six-layer graph          -> platform.lineage_node / _edge / _column
    8  dashboards  starter dashboards       -> platform.dashboard

Everything after stage 1 is idempotent, so a re-run is always safe.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from typing import Any

from .config import CONFIG
from .dashboards import seed_dashboards, validate_dashboards
from .db import connect, count_rows, execute, query, query_one
from .ingest import run_ingest
from .introspect import introspect_views
from .kpi_catalog import register_kpis, validate_kpis
from .lineage_gen import build_lineage
from .ontology_gen import generate
from .relationships import discover_links
from .simulate import run_simulation

log = logging.getLogger("pipeline")


def _configure_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s  %(levelname)-7s %(name)-24s %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stdout,
    )
    logging.getLogger("psycopg").setLevel(logging.WARNING)


def _assert_schema_ready(conn) -> None:
    """Fail loudly if the init scripts did not fully replay.

    The postgres entrypoint only runs /docker-entrypoint-initdb.d when PGDATA is
    empty. If one of those scripts errors, the container exits, the restart policy
    brings it back, it finds a populated PGDATA, skips init and reports healthy -
    with half a schema. Checking here turns that into one clear message instead of
    a confusing failure three stages later.
    """
    missing: list[str] = []
    for schema, name, kind in [
        ("tms_raw", "tms_order", "table"),
        ("tms_sim", "transport_actual", "table"),
        ("tms_views", "v_order", "view"),
        ("tms_views", "v_kpi_data_coverage", "view"),
        ("platform", "ontology_version", "table"),
        ("platform", "kpi_definition", "table"),
        ("platform", "lineage_node", "table"),
    ]:
        found = query_one(
            conn,
            """
            SELECT 1 AS ok FROM information_schema.tables
            WHERE table_schema = %s AND table_name = %s
            """,
            (schema, name),
        )
        if not found:
            missing.append(f"{schema}.{name} ({kind})")

    if missing:
        raise RuntimeError(
            "The database schema is incomplete - missing: "
            + ", ".join(missing)
            + ".\nThis usually means a db/init script failed on first boot and the "
            "container then skipped initialisation on restart. Rebuild with:\n"
            "    docker compose down -v && docker compose up -d"
        )


class StageLog:
    """Timings and outcomes per stage, persisted to platform.generation_run."""

    def __init__(self) -> None:
        self.entries: list[dict[str, Any]] = []
        self._started = time.monotonic()

    def record(self, stage: str, status: str, detail: dict[str, Any] | None = None) -> None:
        elapsed = time.monotonic() - self._started
        self.entries.append(
            {
                "stage": stage,
                "status": status,
                "elapsedSeconds": round(elapsed, 2),
                "detail": detail or {},
            }
        )

    def as_json(self) -> str:
        return json.dumps(self.entries)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pipeline.run", description=__doc__)
    parser.add_argument("--force", action="store_true",
                        help="Re-land the snapshot even if the raw tables already hold it.")
    parser.add_argument("--skip-ingest", action="store_true",
                        help="Leave tms_raw alone and only regenerate the ontology layers.")
    parser.add_argument("--no-simulate", action="store_true",
                        help="Skip the execution simulation; execution KPIs will read as no data.")
    parser.add_argument("--reseed-dashboards", action="store_true",
                        help="Overwrite the starter dashboards even if they already exist.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Report what would be generated and roll the transaction back.")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    _configure_logging(args.verbose)
    log.info("TMS ontology pipeline starting.")
    log.info("    source directory   %s", CONFIG.source_dir)
    log.info("    simulate execution %s", CONFIG.simulate_execution and not args.no_simulate)
    log.info("    link min ratio     %.2f", CONFIG.link_min_match_ratio)

    conn = connect()
    _assert_schema_ready(conn)

    run_row = query_one(
        conn,
        "INSERT INTO platform.generation_run (status) VALUES ('running') RETURNING generation_run_id",
    )
    assert run_row is not None
    generation_run_id = int(run_row["generation_run_id"])
    conn.commit()

    stages = StageLog()
    try:
        # ── 1. ingest ─────────────────────────────────────────────────────
        ingest_run_id: int | None = None
        if args.skip_ingest:
            log.info("Stage 1/8 ingest: skipped (--skip-ingest).")
            stages.record("ingest", "skipped")
            existing = query_one(
                conn, "SELECT max(run_id) AS run_id FROM tms_raw.ingest_run WHERE status = 'success'"
            )
            ingest_run_id = existing["run_id"] if existing else None
            if count_rows(conn, "tms_raw.tms_order") == 0:
                raise RuntimeError(
                    "--skip-ingest was given but tms_raw.tms_order is empty; "
                    "there is nothing to generate an ontology from."
                )
        else:
            log.info("Stage 1/8 ingest: landing the captured payloads.")
            result = run_ingest(conn, force=args.force or CONFIG.force_reingest)
            ingest_run_id = result.get("run_id")
            stages.record("ingest", "skipped" if result.get("skipped") else "success", result)

        # ── 2. simulate ───────────────────────────────────────────────────
        log.info("Stage 2/8 simulate: execution actuals.")
        if args.no_simulate:
            object.__setattr__(CONFIG, "simulate_execution", False)
        simulation = run_simulation(conn, ingest_run_id)
        stages.record("simulate", "success" if simulation.get("enabled") else "disabled", simulation)

        # ── 3. introspect ─────────────────────────────────────────────────
        log.info("Stage 3/8 introspect: reading the semantic views.")
        views = introspect_views(conn)
        objects = [v for v in views if not v.is_metric]
        metrics = [v for v in views if v.is_metric]
        if not objects:
            raise RuntimeError(
                f"No object views found in {CONFIG.view_schema}. "
                "The ontology is generated from them, so there is nothing to do."
            )
        stages.record("introspect", "success", {
            "objectViews": len(objects), "metricViews": len(metrics),
            "columns": sum(len(v.properties) for v in views),
        })

        # ── 4. discover ───────────────────────────────────────────────────
        log.info("Stage 4/8 discover: probing references for link types.")
        discovery = discover_links(conn, views)
        stages.record("discover", "success", {
            "links": len(discovery.links),
            "complete": sum(1 for l in discovery.links if l.match_ratio >= 0.999),
            "unresolved": [
                {"column": f"{u.source_view}.{u.source_column}", "reason": u.reason}
                for u in discovery.unresolved
            ],
        })

        # ── 5. generate ───────────────────────────────────────────────────
        log.info("Stage 5/8 generate: assembling the ontology.")
        version_id, ontology, builder = generate(conn, views, discovery, ingest_run_id)
        stages.record("generate", "success", {
            "ontologyVersionId": version_id,
            "entityTypes": len(ontology["entityTypes"]),
            "eventTypes": len(ontology["eventTypes"]),
            "relationTypes": len(ontology["relationTypes"]),
            "attributes": len(ontology["attributes"]),
            "actionTypes": len(ontology["actionTypes"]),
            "documentBytes": len(json.dumps(ontology)),
        })

        # ── 6. KPI catalogue ──────────────────────────────────────────────
        log.info("Stage 6/8 kpis: registering the metric catalogue.")
        problems = validate_kpis(conn)
        if problems:
            raise RuntimeError(
                f"{len(problems)} KPI definitions reference columns that do not exist; "
                "refusing to register a catalogue the UI would fail on. First: "
                + problems[0]
            )
        kpi_count = register_kpis(conn)
        stages.record("kpis", "success", {"registered": kpi_count})

        # ── 7. lineage ────────────────────────────────────────────────────
        log.info("Stage 7/8 lineage: building the provenance graph.")
        lineage = build_lineage(conn, views, discovery, version_id)
        stages.record("lineage", "success", lineage)

        # ── 8. dashboards ─────────────────────────────────────────────────
        log.info("Stage 8/8 dashboards: seeding the starter set.")
        dashboard_problems = validate_dashboards(conn)
        if dashboard_problems:
            raise RuntimeError(
                f"{len(dashboard_problems)} dashboard widgets reference an unknown KPI "
                "or an unsupported dimension. First: " + dashboard_problems[0]
            )
        dashboard_count = seed_dashboards(conn, overwrite=args.reseed_dashboards)
        stages.record("dashboards", "success", {"seeded": dashboard_count})

        execute(
            conn,
            """
            UPDATE platform.generation_run
               SET finished_at = now(), status = 'success', stage_log = %s,
                   views_scanned = %s, object_types = %s, link_types = %s,
                   kpis = %s, lineage_nodes = %s
             WHERE generation_run_id = %s
            """,
            (
                stages.as_json(), len(views), len(objects), len(discovery.links),
                kpi_count, lineage["nodes"], generation_run_id,
            ),
        )

        if args.dry_run:
            conn.rollback()
            log.warning("--dry-run: everything above was rolled back.")
        else:
            conn.commit()

        _report(conn, version_id)
        log.info("Pipeline finished in %.1fs.", stages.entries[-1]["elapsedSeconds"])
        return 0

    except Exception as exc:
        conn.rollback()
        stages.record("failed", "failed", {"error": str(exc)})
        execute(
            conn,
            """
            UPDATE platform.generation_run
               SET finished_at = now(), status = 'failed', stage_log = %s, error_message = %s
             WHERE generation_run_id = %s
            """,
            (stages.as_json(), str(exc), generation_run_id),
        )
        conn.commit()
        log.error("Pipeline failed: %s", exc)
        if args.verbose:
            log.exception("Traceback:")
        return 1
    finally:
        conn.close()


def _report(conn, version_id: int) -> None:
    """Print the summary a human actually wants after a run."""
    log.info("=" * 78)
    log.info("ONTOLOGY VERSION %s IS NOW ACTIVE", version_id)
    log.info("=" * 78)

    rows = query(
        conn,
        """
        SELECT group_name, count(*) AS types, sum(row_count) AS rows
        FROM platform.object_type WHERE ontology_version_id = %s
        GROUP BY group_name ORDER BY min(display_order)
        """,
        (version_id,),
    )
    for row in rows:
        log.info("  %-12s %2d object types, %7s objects",
                 row["group_name"] or "Other", row["types"], f"{int(row['rows'] or 0):,}")

    coverage = query(
        conn,
        """
        SELECT metric_area, source_coverage_pct, rows_from_source, rows_simulated, total_rows
        FROM tms_views.v_kpi_data_coverage ORDER BY source_coverage_pct DESC, metric_area
        """,
    )
    log.info("-" * 78)
    log.info("  DATA COVERAGE (what is measured versus simulated)")
    for row in coverage:
        pct = row["source_coverage_pct"]
        log.info(
            "  %-22s %5s%% measured   %4s of %4s rows from source",
            row["metric_area"], f"{float(pct):.0f}" if pct is not None else "  ?",
            row["rows_from_source"], row["total_rows"],
        )
    log.info("-" * 78)


if __name__ == "__main__":
    raise SystemExit(main())
