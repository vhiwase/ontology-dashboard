"""Stage 5 - seed the starter dashboards.

These exist so the UI has something real on first load, and so the assistant has
worked examples of the layout contract to imitate when a user asks it for a new
dashboard. Every widget references a KPI by api_name from platform.kpi_definition
rather than carrying SQL, which is what keeps a generated dashboard auditable:
the chart can only ever show a metric someone defined.

WIDGET CONTRACT (platform.dashboard.layout is an array of these):

    {
      "type":        "stat" | "chart" | "table" | "note",
      "kpi":         api_name from platform.kpi_definition   (not for "note")
      "title":       optional override of the KPI label
      "dimension":   column to group by; defaults to the KPI's default_dimension
      "chart":       "bar" | "hbar" | "line" | "area" | "donut"   (type=chart)
      "limit":       max categories to plot, default 12
      "sort":        "value_desc" | "value_asc" | "dimension_asc"
      "filters":     {column: value} applied to the metric view
      "width":       1..4 grid columns out of 4
      "body":        markdown text (type=note only)
    }
"""

from __future__ import annotations

import json
import logging
from typing import Any

import psycopg

from .config import CONFIG
from .db import execute, space_id, upsert_many
from .kpi_catalog import KPI_SPECS

log = logging.getLogger("pipeline.dashboards")

DASHBOARDS: list[dict[str, Any]] = [
    {
        "slug": "control-tower",
        "title": "Control Tower",
        "description": "The one screen a 3PL operations lead opens first: volume in, exceptions out.",
        "audience": "Operations leadership",
        "is_pinned": True,
        "layout": [
            {"type": "stat", "kpi": "order_count", "width": 1},
            {"type": "stat", "kpi": "shipped_weight_kg", "width": 1},
            {"type": "stat", "kpi": "planned_rate_pct", "width": 1},
            {"type": "stat", "kpi": "on_time_pct", "width": 1},
            {
                "type": "chart", "kpi": "order_count", "chart": "line",
                "dimension": "pickup_date", "sort": "dimension_asc", "width": 2,
                "title": "Daily order intake",
            },
            {
                "type": "chart", "kpi": "shipment_count_by_status", "chart": "donut",
                "dimension": "shipment_status", "width": 2,
                "title": "Shipment book by status",
            },
            {
                "type": "table", "kpi": "exception_count", "dimension": "exception_type",
                "sort": "value_desc", "width": 2, "title": "Exception worklist",
            },
            {
                "type": "chart", "kpi": "mode_order_share_pct", "chart": "donut",
                "dimension": "transportation_mode", "width": 2, "title": "Mode mix",
            },
            {
                "type": "note", "width": 4,
                "title": "What is measured and what is not",
                "body": (
                    "Order volume, weight, planning rate and the shipment status "
                    "funnel come straight from the captured TMS payloads. On-time "
                    "percentage does not: the snapshot contains no arrivals at all, "
                    "so that tile rests on the seeded execution simulation. The Data "
                    "Trust dashboard breaks this down metric by metric."
                ),
            },
        ],
    },
    {
        "slug": "service-performance",
        "title": "Service Performance",
        "description": "On-time delivery, lateness and dwell, by carrier and lane.",
        "audience": "Operations managers and carrier managers",
        "is_pinned": True,
        "layout": [
            {"type": "stat", "kpi": "on_time_pct", "width": 1},
            {"type": "stat", "kpi": "late_stop_count", "width": 1},
            {"type": "stat", "kpi": "avg_late_minutes", "width": 1},
            {"type": "stat", "kpi": "avg_dwell_minutes", "width": 1},
            {
                "type": "chart", "kpi": "on_time_pct", "chart": "line",
                "dimension": "service_week", "sort": "dimension_asc", "width": 4,
                "title": "On-time trend by week",
            },
            {
                "type": "chart", "kpi": "on_time_pct", "chart": "hbar",
                "dimension": "carrier_name", "sort": "value_asc", "limit": 12, "width": 2,
                "title": "Worst on-time carriers",
            },
            {
                "type": "chart", "kpi": "lane_on_time_pct", "chart": "hbar",
                "dimension": "lane", "sort": "value_asc", "limit": 12, "width": 2,
                "title": "Worst on-time lanes",
            },
            {
                "type": "table", "kpi": "avg_dwell_minutes", "dimension": "location_name",
                "sort": "value_desc", "limit": 15, "width": 4,
                "title": "Facilities by average dwell",
            },
        ],
    },
    {
        "slug": "freight-spend-margin",
        "title": "Freight Spend and Margin",
        "description": "What we bill, what we pay, and what is left.",
        "audience": "Freight finance",
        "is_pinned": True,
        "layout": [
            {"type": "stat", "kpi": "freight_revenue", "width": 1},
            {"type": "stat", "kpi": "transport_cost", "width": 1},
            {"type": "stat", "kpi": "gross_margin", "width": 1},
            {"type": "stat", "kpi": "gross_margin_pct", "width": 1},
            {
                "type": "chart", "kpi": "freight_revenue", "chart": "bar",
                "dimension": "account_name", "sort": "value_desc", "width": 2,
                "title": "Revenue by account",
            },
            {
                "type": "chart", "kpi": "gross_margin_pct", "chart": "hbar",
                "dimension": "account_name", "sort": "value_asc", "width": 2,
                "title": "Margin by account",
            },
            {
                "type": "chart", "kpi": "transport_cost", "chart": "hbar",
                "dimension": "carrier_name", "sort": "value_desc", "limit": 12, "width": 2,
                "title": "Spend by carrier",
            },
            {
                "type": "chart", "kpi": "cost_per_km", "chart": "hbar",
                "dimension": "carrier_name", "sort": "value_desc", "limit": 12, "width": 2,
                "title": "Unit cost by carrier",
            },
            {"type": "stat", "kpi": "unrated_shipment_count", "width": 2},
            {"type": "stat", "kpi": "fuel_share_pct", "width": 2},
        ],
    },
    {
        "slug": "network-lanes",
        "title": "Network and Lanes",
        "description": "Where the freight actually goes, and what each lane costs.",
        "audience": "Network planning",
        "layout": [
            {"type": "stat", "kpi": "lane_order_count", "width": 2},
            {"type": "stat", "kpi": "facility_stop_count", "width": 2},
            {
                "type": "chart", "kpi": "lane_order_count", "chart": "hbar",
                "dimension": "lane", "sort": "value_desc", "limit": 15, "width": 2,
                "title": "Busiest lanes",
            },
            {
                "type": "chart", "kpi": "lane_cost_per_km", "chart": "hbar",
                "dimension": "lane", "sort": "value_desc", "limit": 15, "width": 2,
                "title": "Most expensive lanes per km",
            },
            {
                "type": "chart", "kpi": "facility_stop_count", "chart": "hbar",
                "dimension": "location_name", "sort": "value_desc", "limit": 15, "width": 2,
                "title": "Busiest facilities",
            },
            {
                "type": "chart", "kpi": "shipped_weight_kg", "chart": "bar",
                "dimension": "transportation_mode", "sort": "value_desc", "width": 2,
                "title": "Weight by mode",
            },
        ],
    },
    {
        "slug": "data-trust",
        "title": "Data Trust",
        "description": "How much of this platform is measured and how much is simulated.",
        "audience": "Anyone about to quote a number from here",
        "is_pinned": True,
        "layout": [
            {
                "type": "note", "width": 4,
                "title": "Read this before quoting a figure",
                "body": (
                    "The captured snapshot in TMS_MCP/api_responses is a **planning** "
                    "snapshot. It was verified to contain zero transports with an "
                    "actual start, zero stops that have been arrived at, zero legs "
                    "with a non-zero distance and zero orders with a carrier id.\n\n"
                    "Rather than leave half the KPI catalogue empty, the pipeline "
                    "generates execution actuals deterministically into a separate "
                    "`tms_sim` schema, and every view that surfaces them reports "
                    "`data_origin = 'simulated'`. Order volume, weight, party master "
                    "data, planning rate and the status funnel are fully measured. "
                    "On-time, transit time, dwell, distance, carrier attribution and "
                    "cost are not."
                ),
            },
            {
                "type": "chart", "kpi": "source_coverage_pct", "chart": "hbar",
                "dimension": "metric_area", "sort": "value_desc", "width": 2,
                "title": "Source coverage by metric area",
            },
            {
                "type": "table", "kpi": "source_coverage_pct", "dimension": "metric_area",
                "sort": "value_desc", "width": 2, "title": "Coverage detail",
            },
            {"type": "stat", "kpi": "unrated_shipment_count", "width": 2},
            {"type": "stat", "kpi": "unplanned_order_count", "width": 2},
        ],
    },
]


def seed_dashboards(conn: psycopg.Connection, overwrite: bool = False) -> int:
    """Insert the starter dashboards.

    A user's own edits are never overwritten: an already-seeded dashboard is
    skipped unless overwrite is set.

    Identity is seed_key, not slug. Dashboards can be renamed, and a rename
    rewrites the slug - so matching on slug meant a renamed starter dashboard
    looked absent, got seeded again, and the user was left with two of them.
    seed_key never changes, so the renamed one is recognised and left alone.
    """
    # Scoped to the space this run publishes into. Checking globally meant a
    # starter dashboard that exists in the sandbox counted as present in every
    # space, so a freshly published space got none of them — and had the check
    # passed, the insert would have failed anyway, because space_id is NOT NULL
    # and nothing below was supplying it.
    space = space_id(conn, CONFIG.space)
    existing = {
        row["seed_key"]
        for row in conn.execute(
            "SELECT seed_key FROM platform.dashboard "
            "WHERE seed_key IS NOT NULL AND space_id = %s",
            (space,),
        ).fetchall()
    }

    # A slug already taken by something that is NOT this seeded dashboard - a
    # user's own dashboard, say - would collide on insert.
    taken = {
        row["slug"]: row["seed_key"]
        for row in conn.execute(
            "SELECT slug, seed_key FROM platform.dashboard WHERE space_id = %s",
            (space,),
        ).fetchall()
    }

    # Which metrics actually exist in this space. A widget naming one that was
    # withdrawn - because its source data does not exist - is dropped rather
    # than seeded, so a dashboard never carries a tile with nothing behind it.
    available = {
        row["api_name"]
        for row in conn.execute(
            "SELECT api_name FROM platform.kpi_definition WHERE space_id = %s", (space,)
        ).fetchall()
    }

    rows = []
    skipped = 0
    dropped_widgets = 0
    for dashboard in DASHBOARDS:
        seed_key = dashboard["slug"]
        if seed_key in existing and not overwrite:
            skipped += 1
            continue
        if taken.get(dashboard["slug"]) not in (None, seed_key):
            log.warning(
                "Slug %r is used by another dashboard, so %r was not seeded.",
                dashboard["slug"],
                seed_key,
            )
            skipped += 1
            continue
        # Keep notes (which carry no metric) and widgets whose KPI is present.
        layout = [
            widget
            for widget in dashboard["layout"]
            if widget.get("type") == "note" or widget.get("kpi") in available
        ]
        dropped_widgets += len(dashboard["layout"]) - len(layout)

        # A dashboard left with nothing but its notes has no content to show.
        # Seeding it would present an empty board as though it were a report.
        if not any(widget.get("type") != "note" for widget in layout):
            log.info(
                "Not seeding %r: every metric it charts rests on data the source does not carry.",
                dashboard["slug"],
            )
            skipped += 1
            continue

        rows.append(
            (
                space,
                seed_key,
                dashboard["slug"],
                dashboard["title"],
                dashboard.get("description"),
                json.dumps(layout),
                json.dumps(dashboard.get("filters", {})),
                dashboard.get("audience"),
                False,
                None,
                "pipeline",
                dashboard.get("is_pinned", False),
            )
        )

    written = upsert_many(
        conn,
        "platform.dashboard",
        [
            "space_id",
            "seed_key", "slug", "title", "description", "layout", "filters",
            "audience", "is_ai_generated", "source_prompt", "created_by", "is_pinned",
        ],
        rows,
        ["space_id", "seed_key"],
        # updated_at is deliberately not in the update list so a reseed does not
        # look like a user edit in the dashboard list ordering.
        update_columns=[
            "title", "description", "layout", "filters", "audience", "is_pinned",
        ],
    )
    log.info(
        "Seeded %d dashboards (%d left alone or empty).", written, skipped
    )
    if dropped_widgets:
        log.info(
            "    %d widget(s) omitted: their metric has no real source data.", dropped_widgets
        )
    return written


def prune_unavailable_widgets(conn: psycopg.Connection) -> int:
    """Remove widgets whose metric no longer exists.

    Seeding only writes dashboards that are absent, so a board created before a
    metric was withdrawn would keep charting it. The tile cannot render
    anything real - the metric is gone precisely because its source data does
    not exist - so it is removed rather than left to display a blank or a
    fabricated figure.

    Touches only the widget list. Titles, descriptions, notes and every widget
    that still resolves are left exactly as they were.
    """
    space = space_id(conn, CONFIG.space)
    available = {
        row["api_name"]
        for row in conn.execute(
            "SELECT api_name FROM platform.kpi_definition WHERE space_id = %s", (space,)
        ).fetchall()
    }

    boards = conn.execute(
        "SELECT dashboard_id, slug, layout FROM platform.dashboard WHERE space_id = %s",
        (space,),
    ).fetchall()

    # What each starter board was specified to chart, so a board pruned on an
    # EARLIER run is still explained. Comparing against the spec rather than
    # against this run's removals makes the reconciliation idempotent.
    specified: dict[str, set[str]] = {
        spec["slug"]: {
            w["kpi"] for w in spec["layout"] if w.get("type") != "note" and w.get("kpi")
        }
        for spec in DASHBOARDS
    }

    pruned = 0
    for board in boards:
        layout = board["layout"] or []
        kept = [
            widget
            for widget in layout
            if widget.get("type") == "note" or widget.get("kpi") in available
        ]
        removed_now = len(layout) - len(kept)

        # Figures this board was meant to show that no longer have a source,
        # whether they were stripped just now or on a previous run.
        missing = specified.get(board["slug"], set()) - available
        if removed_now == 0 and not missing:
            continue

        removed = removed_now or len(missing)
        pruned += removed_now

        # Say why the board is thinner than it was. A dashboard titled
        # "Freight Spend and Margin" showing a single unrelated tile reads as
        # broken; the same board saying which figures were withdrawn and why
        # is doing its job. The note replaces any earlier one so repeated runs
        # do not stack them up.
        kept = [w for w in kept if w.get("id") != "coverage-note"]
        kept.insert(
            0,
            {
                "id": "coverage-note",
                "type": "note",
                "width": 4,
                "title": f"{removed} figure(s) removed",
                "body": (
                    "These charts were withdrawn because the captured snapshot carries no "
                    "data for them - no carrier assignment, no execution actuals, no leg "
                    "distance and no arrivals. They were previously drawn from generated "
                    "values. Nothing shown here is simulated; what remains is measured."
                ),
            },
        )

        execute(
            conn,
            "UPDATE platform.dashboard SET layout = %s, updated_at = now() WHERE dashboard_id = %s",
            (json.dumps(kept), board["dashboard_id"]),
        )
        if removed_now:
            log.info(
                "    %s: removed %d widget(s) with no real source data.",
                board["slug"], removed_now,
            )

    conn.commit()
    if pruned:
        log.info("Pruned %d dashboard widget(s) that had no measurable metric behind them.", pruned)
    return pruned


def validate_dashboards(conn: psycopg.Connection) -> list[str]:
    """Check every widget references a KPI that exists and a dimension it allows."""
    catalogue = {
        row["api_name"]: (row["dimensions"] or [])
        for row in conn.execute(
            "SELECT k.api_name, k.dimensions FROM platform.kpi_definition k "
            "JOIN platform.space s ON s.space_id = k.space_id WHERE s.slug = %s",
            (CONFIG.space,),
        ).fetchall()
    }
    # Metrics deliberately withdrawn because the source carries no data for
    # them. A widget naming one is not a defect in the spec - it is a chart the
    # platform correctly declines to draw - so it is reported as an omission
    # and not as a problem that should stop a publish.
    #
    # This distinction matters: conflating the two took the whole ontology
    # down. validate_dashboards raised before the widgets could be pruned, the
    # publish rolled back, and the database was left with no active ontology at
    # all because seventeen metrics were legitimately absent.
    withdrawn = {
        spec["api_name"]
        for spec in KPI_SPECS
        if spec.get("depends_on_simulation")
    } if not CONFIG.simulate_execution else set()

    problems: list[str] = []
    omitted = 0
    for dashboard in DASHBOARDS:
        for index, widget in enumerate(dashboard["layout"]):
            if widget["type"] == "note":
                continue
            kpi = widget.get("kpi")
            if kpi in withdrawn:
                omitted += 1
                continue
            if kpi not in catalogue:
                problems.append(f"{dashboard['slug']}[{index}]: unknown KPI {kpi!r}")
                continue
            dimension = widget.get("dimension")
            if dimension and dimension not in catalogue[kpi]:
                problems.append(
                    f"{dashboard['slug']}[{index}]: KPI {kpi} cannot be grouped by "
                    f"{dimension!r} (allowed: {', '.join(catalogue[kpi])})"
                )
    if omitted:
        log.info(
            "%d dashboard widget(s) omitted: their metric has no real source data.", omitted
        )
    for problem in problems:
        log.error("Dashboard seed: %s", problem)
    return problems
