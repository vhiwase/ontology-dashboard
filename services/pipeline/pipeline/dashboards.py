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

from .db import upsert_many

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

    A user's own edits are never overwritten: an existing slug is skipped unless
    overwrite is set. Only AI-generated and seeded dashboards are replaceable.
    """
    existing = {
        row["slug"]: row["is_ai_generated"]
        for row in conn.execute("SELECT slug, is_ai_generated FROM platform.dashboard").fetchall()
    }

    rows = []
    skipped = 0
    for dashboard in DASHBOARDS:
        if dashboard["slug"] in existing and not overwrite:
            skipped += 1
            continue
        rows.append(
            (
                dashboard["slug"],
                dashboard["title"],
                dashboard.get("description"),
                json.dumps(dashboard["layout"]),
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
            "slug", "title", "description", "layout", "filters", "audience",
            "is_ai_generated", "source_prompt", "created_by", "is_pinned",
        ],
        rows,
        ["slug"],
        # updated_at is deliberately not in the update list so a reseed does not
        # look like a user edit in the dashboard list ordering.
        update_columns=[
            "title", "description", "layout", "filters", "audience", "is_pinned",
        ],
    )
    log.info(
        "Seeded %d dashboards (%d left alone because they already exist).", written, skipped
    )
    return written


def validate_dashboards(conn: psycopg.Connection) -> list[str]:
    """Check every widget references a KPI that exists and a dimension it allows."""
    catalogue = {
        row["api_name"]: (row["dimensions"] or [])
        for row in conn.execute(
            "SELECT api_name, dimensions FROM platform.kpi_definition"
        ).fetchall()
    }
    problems: list[str] = []
    for dashboard in DASHBOARDS:
        for index, widget in enumerate(dashboard["layout"]):
            if widget["type"] == "note":
                continue
            kpi = widget.get("kpi")
            if kpi not in catalogue:
                problems.append(f"{dashboard['slug']}[{index}]: unknown KPI {kpi!r}")
                continue
            dimension = widget.get("dimension")
            if dimension and dimension not in catalogue[kpi]:
                problems.append(
                    f"{dashboard['slug']}[{index}]: KPI {kpi} cannot be grouped by "
                    f"{dimension!r} (allowed: {', '.join(catalogue[kpi])})"
                )
    for problem in problems:
        log.error("Dashboard seed: %s", problem)
    return problems
