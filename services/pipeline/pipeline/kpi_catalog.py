"""Stage 3c - the KPI catalogue.

These are deliberately hand-authored rather than derived from the metric views'
columns. A KPI is a business definition, not a column: "on-time delivery" has to
say which stop role counts, what tolerance applies, and what the denominator is.
Auto-generating one metric per numeric column would produce a few hundred
meaningless entries and hand the assistant a catalogue it cannot reason about.

Every entry states the business question it answers, so the assistant can match a
user's phrasing to a definition instead of inventing SQL. Entries whose value
depends on the simulated execution data carry depends_on_simulation = True and a
coverage note, which the UI renders as a caveat on the tile and the assistant
repeats in its answer.
"""

from __future__ import annotations

import logging
from typing import Any

import psycopg

from .db import upsert_many

log = logging.getLogger("pipeline.kpi")

# Shorthand for the coverage caveats, so the wording stays consistent.
SIM_EXECUTION = (
    "The captured snapshot contains no execution actuals (no arrivals, no "
    "transit times). This figure rests on the seeded simulation in tms_sim."
)
SIM_CARRIER = (
    "No order or transport in the snapshot carries a carrierId. Carrier "
    "attribution rests on the seeded simulation in tms_sim."
)
SIM_COST = (
    "Transport cost is not present in the snapshot at all; it is generated from "
    "simulated distance and rate. Treat absolute values as illustrative."
)
SIM_DISTANCE = (
    "Every captured leg reported a distance of 0 m, and the demo coordinates are "
    "not geographically coherent, so distance is derived from the planned transit "
    "window rather than measured."
)
PART_RATED = (
    "14 of 61 shipments carry a charge from the source; the remaining 47 are "
    "rated by the simulation. The mix is visible in the Charge Origin property."
)

# fmt: off
KPI_SPECS: list[dict[str, Any]] = [
    # ── Demand / volume ────────────────────────────────────────────────────
    {
        "api_name": "order_count",
        "label": "Orders",
        "business_question": "How many orders did we take on?",
        "description": "Count of customer orders by pickup date.",
        "category": "demand",
        "source_view": "tms_views.v_kpi_order_volume_daily",
        "measure_column": "order_count", "aggregation": "sum",
        "dimensions": ["pickup_date", "pickup_week", "pickup_month", "transportation_mode"],
        "default_dimension": "pickup_date", "time_column": "pickup_date",
        "value_format": "integer", "higher_is_better": True,
        "related_object_types": ["tms:Order"], "display_order": 10,
    },
    {
        "api_name": "shipped_weight_kg",
        "label": "Shipped Weight",
        "business_question": "How much freight did we move, by weight?",
        "description": "Gross weight across all handling units on the order.",
        "category": "demand",
        "source_view": "tms_views.v_kpi_order_volume_daily",
        "measure_column": "gross_weight_kg", "aggregation": "sum",
        "dimensions": ["pickup_date", "pickup_week", "pickup_month", "transportation_mode"],
        "default_dimension": "pickup_month", "time_column": "pickup_date",
        "unit": "kg", "value_format": "weight_kg", "higher_is_better": True,
        "related_object_types": ["tms:Order", "tms:HandlingUnit"], "display_order": 20,
    },
    {
        "api_name": "piece_count",
        "label": "Pieces Shipped",
        "business_question": "How many pieces went out?",
        "description": "Total handling-unit quantity across orders.",
        "category": "demand",
        "source_view": "tms_views.v_kpi_order_volume_daily",
        "measure_column": "piece_count", "aggregation": "sum",
        "dimensions": ["pickup_date", "pickup_month", "transportation_mode"],
        "default_dimension": "pickup_month", "time_column": "pickup_date",
        "value_format": "integer", "higher_is_better": True,
        "related_object_types": ["tms:Order"], "display_order": 30,
    },
    {
        "api_name": "planned_rate_pct",
        "label": "Planning Rate",
        "business_question": "What share of demand actually got onto a route?",
        "description": (
            "Share of orders that carry a scheduled route. The gap is unplanned "
            "demand: 29 of the 90 captured orders have no route at all."
        ),
        "category": "demand",
        "source_view": "tms_views.v_kpi_order_volume_daily",
        "aggregation": "ratio",
        "numerator_column": "planned_order_count", "denominator_column": "order_count",
        "dimensions": ["pickup_date", "pickup_month", "transportation_mode"],
        "default_dimension": "pickup_month", "time_column": "pickup_date",
        "unit": "%", "value_format": "percent", "higher_is_better": True,
        "target_value": 98.0, "warning_threshold": 90.0, "critical_threshold": 80.0,
        "related_object_types": ["tms:Order"], "display_order": 40,
    },
    {
        "api_name": "unplanned_order_count",
        "label": "Unplanned Orders",
        "business_question": "Which orders still need a route?",
        "description": "Orders with no scheduled route. This is a work queue, not a statistic.",
        "category": "demand",
        "source_view": "tms_views.v_kpi_order_volume_daily",
        "measure_column": "unplanned_order_count", "aggregation": "sum",
        "dimensions": ["pickup_date", "pickup_month", "transportation_mode"],
        "default_dimension": "pickup_date", "time_column": "pickup_date",
        "value_format": "integer", "higher_is_better": False,
        "target_value": 0.0, "related_object_types": ["tms:Order"], "display_order": 50,
    },

    # ── Service / on-time ──────────────────────────────────────────────────
    {
        "api_name": "on_time_pct",
        "label": "On-Time Performance",
        "business_question": "Are we hitting the delivery windows we promised?",
        "description": (
            "Share of stops where the truck arrived at or before the end of the "
            "planned arrival window. Early counts as on time; there is no grace "
            "period applied after the window closes."
        ),
        "category": "service",
        "source_view": "tms_views.v_kpi_on_time_performance",
        "aggregation": "ratio",
        "numerator_column": "on_time_count", "denominator_column": "measured_count",
        "dimensions": ["service_date", "service_week", "service_event", "carrier_name", "lane"],
        "default_dimension": "service_week", "time_column": "service_date",
        "unit": "%", "value_format": "percent", "higher_is_better": True,
        "target_value": 95.0, "warning_threshold": 90.0, "critical_threshold": 85.0,
        "related_object_types": ["tms:TransportStop", "tms:Transport"],
        "depends_on_simulation": True, "coverage_note": SIM_EXECUTION, "display_order": 100,
    },
    {
        "api_name": "on_time_delivery_pct",
        "label": "On-Time Delivery",
        "business_question": "Are deliveries arriving on time?",
        "description": "On-time percentage restricted to delivery stops.",
        "category": "service",
        "source_view": "tms_views.v_kpi_on_time_performance",
        "aggregation": "ratio",
        "numerator_column": "on_time_count", "denominator_column": "measured_count",
        "dimensions": ["service_date", "service_week", "carrier_name", "lane"],
        "default_dimension": "service_week", "time_column": "service_date",
        "unit": "%", "value_format": "percent", "higher_is_better": True,
        "target_value": 95.0, "warning_threshold": 90.0, "critical_threshold": 85.0,
        "related_object_types": ["tms:TransportStop"],
        "depends_on_simulation": True, "coverage_note": SIM_EXECUTION, "display_order": 110,
    },
    {
        "api_name": "avg_late_minutes",
        "label": "Average Lateness",
        "business_question": "When we are late, how late are we?",
        "description": "Mean minutes past the window close, counting late arrivals only.",
        "category": "service",
        "source_view": "tms_views.v_kpi_on_time_performance",
        "measure_column": "avg_late_minutes", "aggregation": "avg",
        "dimensions": ["service_date", "service_week", "carrier_name", "lane"],
        "default_dimension": "carrier_name", "time_column": "service_date",
        "unit": "min", "value_format": "number", "higher_is_better": False,
        "target_value": 30.0, "warning_threshold": 60.0, "critical_threshold": 120.0,
        "related_object_types": ["tms:TransportStop"],
        "depends_on_simulation": True, "coverage_note": SIM_EXECUTION, "display_order": 120,
    },
    {
        "api_name": "avg_dwell_minutes",
        "label": "Average Dwell",
        "business_question": "How long are trucks sitting at our facilities?",
        "description": "Mean minutes between arrival and departure at a stop.",
        "category": "service",
        "source_view": "tms_views.v_kpi_facility_throughput",
        "measure_column": "avg_dwell_minutes", "aggregation": "avg",
        "dimensions": ["location_name", "city", "province_state", "country"],
        "default_dimension": "location_name",
        "unit": "min", "value_format": "number", "higher_is_better": False,
        "target_value": 60.0, "warning_threshold": 120.0, "critical_threshold": 180.0,
        "related_object_types": ["tms:Location", "tms:TransportStop"],
        "depends_on_simulation": True, "coverage_note": SIM_EXECUTION, "display_order": 130,
    },
    {
        "api_name": "late_stop_count",
        "label": "Late Stops",
        "business_question": "How many stops missed their window?",
        "description": "Count of stops that arrived after the planned window closed.",
        "category": "service",
        "source_view": "tms_views.v_kpi_on_time_performance",
        "measure_column": "late_count", "aggregation": "sum",
        "dimensions": ["service_date", "service_week", "carrier_name", "lane", "service_event"],
        "default_dimension": "carrier_name", "time_column": "service_date",
        "value_format": "integer", "higher_is_better": False,
        "related_object_types": ["tms:TransportStop"],
        "depends_on_simulation": True, "coverage_note": SIM_EXECUTION, "display_order": 140,
    },
    {
        "api_name": "avg_transit_hours",
        "label": "Average Transit Time",
        "business_question": "How long is a load actually taking door to door?",
        "description": "Mean hours between actual departure and actual arrival.",
        "category": "service",
        "source_view": "tms_views.v_kpi_carrier_scorecard",
        "measure_column": "avg_transit_hours", "aggregation": "avg",
        "dimensions": ["carrier_name", "carrier_scac"],
        "default_dimension": "carrier_name",
        "unit": "h", "value_format": "duration_hours", "higher_is_better": False,
        "related_object_types": ["tms:Transport"],
        "depends_on_simulation": True, "coverage_note": SIM_EXECUTION, "display_order": 150,
    },

    # ── Cost / procurement ────────────────────────────────────────────────
    {
        "api_name": "transport_cost",
        "label": "Transport Cost",
        "business_question": "What are we paying carriers?",
        "description": "Linehaul plus fuel plus accessorials paid to carriers.",
        "category": "cost",
        "source_view": "tms_views.v_kpi_carrier_scorecard",
        "measure_column": "total_cost", "aggregation": "sum",
        "dimensions": ["carrier_name", "carrier_scac"],
        "default_dimension": "carrier_name",
        "unit": "USD", "value_format": "currency", "higher_is_better": False,
        "related_object_types": ["tms:Transport", "tms:Carrier"],
        "depends_on_simulation": True, "coverage_note": SIM_COST, "display_order": 200,
    },
    {
        "api_name": "cost_per_km",
        "label": "Cost per Kilometre",
        "business_question": "What is our unit cost of linehaul?",
        "description": "Total carrier cost divided by kilometres run.",
        "category": "cost",
        "source_view": "tms_views.v_kpi_carrier_scorecard",
        "aggregation": "ratio",
        "numerator_column": "total_cost", "denominator_column": "total_km",
        "dimensions": ["carrier_name", "carrier_scac"],
        "default_dimension": "carrier_name",
        "unit": "USD/km", "value_format": "currency", "higher_is_better": False,
        "related_object_types": ["tms:Transport"],
        "depends_on_simulation": True,
        "coverage_note": SIM_COST + " " + SIM_DISTANCE, "display_order": 210,
    },
    {
        "api_name": "avg_cost_per_load",
        "label": "Cost per Load",
        "business_question": "What does an average load cost us?",
        "description": "Mean carrier cost per transport.",
        "category": "cost",
        "source_view": "tms_views.v_kpi_carrier_scorecard",
        "measure_column": "avg_cost_per_load", "aggregation": "avg",
        "dimensions": ["carrier_name"], "default_dimension": "carrier_name",
        "unit": "USD", "value_format": "currency", "higher_is_better": False,
        "related_object_types": ["tms:Transport"],
        "depends_on_simulation": True, "coverage_note": SIM_COST, "display_order": 220,
    },
    {
        "api_name": "carrier_load_count",
        "label": "Loads per Carrier",
        "business_question": "How is volume spread across the carrier base?",
        "description": "Transports assigned to each carrier. Shows spend concentration.",
        "category": "cost",
        "source_view": "tms_views.v_kpi_carrier_scorecard",
        "measure_column": "load_count", "aggregation": "sum",
        "dimensions": ["carrier_name", "carrier_scac"],
        "default_dimension": "carrier_name",
        "value_format": "integer", "higher_is_better": None,
        "related_object_types": ["tms:Carrier", "tms:Transport"],
        "depends_on_simulation": True, "coverage_note": SIM_CARRIER, "display_order": 230,
    },

    # ── Revenue / finance ─────────────────────────────────────────────────
    {
        "api_name": "freight_revenue",
        "label": "Freight Revenue",
        "business_question": "What are we billing our customers?",
        "description": "Total shipment charge: freight plus fuel plus accessorials.",
        "category": "finance",
        "source_view": "tms_views.v_kpi_freight_spend_monthly",
        "measure_column": "total_charge", "aggregation": "sum",
        "dimensions": ["spend_month", "transportation_mode", "account_name", "bill_to_name"],
        "default_dimension": "account_name", "time_column": "spend_month",
        "unit": "USD", "value_format": "currency", "higher_is_better": True,
        "related_object_types": ["tms:Shipment"],
        "depends_on_simulation": True, "coverage_note": PART_RATED, "display_order": 300,
    },
    {
        "api_name": "fuel_share_pct",
        "label": "Fuel Share of Revenue",
        "business_question": "How much of the bill is fuel surcharge?",
        "description": "Fuel charge as a share of total charge.",
        "category": "finance",
        "source_view": "tms_views.v_kpi_freight_spend_monthly",
        "aggregation": "ratio",
        "numerator_column": "fuel_charge", "denominator_column": "total_charge",
        "dimensions": ["spend_month", "transportation_mode", "account_name"],
        "default_dimension": "spend_month", "time_column": "spend_month",
        "unit": "%", "value_format": "percent", "higher_is_better": None,
        "related_object_types": ["tms:Shipment"],
        "depends_on_simulation": True, "coverage_note": PART_RATED, "display_order": 310,
    },
    {
        "api_name": "charge_per_kg",
        "label": "Revenue per Kilogram",
        "business_question": "What are we earning per kilo moved?",
        "description": "Total charge divided by gross weight.",
        "category": "finance",
        "source_view": "tms_views.v_kpi_freight_spend_monthly",
        "aggregation": "ratio",
        "numerator_column": "total_charge", "denominator_column": "gross_weight_kg",
        "dimensions": ["spend_month", "transportation_mode", "account_name"],
        "default_dimension": "account_name", "time_column": "spend_month",
        "unit": "USD/kg", "value_format": "currency", "higher_is_better": True,
        "related_object_types": ["tms:Shipment"],
        "depends_on_simulation": True, "coverage_note": PART_RATED, "display_order": 320,
    },
    {
        "api_name": "gross_margin",
        "label": "Gross Margin",
        "business_question": "Are we making money on this account?",
        "description": "Revenue billed to the customer less cost paid to the carrier.",
        "category": "finance",
        "source_view": "tms_views.v_kpi_account_scorecard",
        "measure_column": "gross_margin", "aggregation": "sum",
        "dimensions": ["account_name"], "default_dimension": "account_name",
        "unit": "USD", "value_format": "currency", "higher_is_better": True,
        "related_object_types": ["tms:Account"],
        "depends_on_simulation": True,
        "coverage_note": PART_RATED + " " + SIM_COST, "display_order": 330,
    },
    {
        "api_name": "gross_margin_pct",
        "label": "Gross Margin %",
        "business_question": "What margin are we running at?",
        "description": "Gross margin as a share of revenue.",
        "category": "finance",
        "source_view": "tms_views.v_kpi_account_scorecard",
        "aggregation": "ratio",
        "numerator_column": "gross_margin", "denominator_column": "revenue",
        "dimensions": ["account_name"], "default_dimension": "account_name",
        "unit": "%", "value_format": "percent", "higher_is_better": True,
        "target_value": 18.0, "warning_threshold": 12.0, "critical_threshold": 8.0,
        "related_object_types": ["tms:Account"],
        "depends_on_simulation": True,
        "coverage_note": PART_RATED + " " + SIM_COST, "display_order": 340,
    },
    {
        "api_name": "unrated_shipment_count",
        "label": "Unrated Shipments",
        "business_question": "Which shipments are still missing a rate?",
        "description": "Shipments with no freight charge. Revenue leakage if left alone.",
        "category": "finance",
        "source_view": "tms_views.v_kpi_freight_spend_monthly",
        "measure_column": "unrated_count", "aggregation": "sum",
        "dimensions": ["spend_month", "account_name", "transportation_mode"],
        "default_dimension": "account_name", "time_column": "spend_month",
        "value_format": "integer", "higher_is_better": False, "target_value": 0.0,
        "related_object_types": ["tms:Shipment"], "display_order": 350,
    },

    # ── Operations ────────────────────────────────────────────────────────
    {
        "api_name": "shipment_count_by_status",
        "label": "Shipments by Status",
        "business_question": "Where is the shipment book sitting right now?",
        "description": "Shipment count per lifecycle status.",
        "category": "operations",
        "source_view": "tms_views.v_kpi_shipment_status_funnel",
        "measure_column": "shipment_count", "aggregation": "sum",
        "dimensions": ["shipment_status"], "default_dimension": "shipment_status",
        "value_format": "integer", "higher_is_better": None,
        "related_object_types": ["tms:Shipment"], "display_order": 400,
    },
    {
        "api_name": "invoiced_shipment_count",
        "label": "Invoiced Shipments",
        "business_question": "How much of the book has been billed?",
        "description": "Shipments with an invoice generated.",
        "category": "operations",
        "source_view": "tms_views.v_kpi_shipment_status_funnel",
        "measure_column": "invoiced_count", "aggregation": "sum",
        "dimensions": ["shipment_status"], "default_dimension": "shipment_status",
        "value_format": "integer", "higher_is_better": True,
        "related_object_types": ["tms:Shipment"], "display_order": 410,
    },
    {
        "api_name": "exception_count",
        "label": "Open Exceptions",
        "business_question": "What needs my attention today?",
        "description": "Count of items in each exception category.",
        "category": "operations",
        "source_view": "tms_views.v_kpi_exception_summary",
        "measure_column": "item_count", "aggregation": "sum",
        "dimensions": ["exception_type", "object_type", "severity"],
        "default_dimension": "exception_type",
        "value_format": "integer", "higher_is_better": False,
        "related_object_types": ["tms:Order", "tms:Shipment", "tms:Transport"],
        "display_order": 420,
    },
    {
        "api_name": "documents_verified_count",
        "label": "Documents Verified",
        "business_question": "Is the paperwork keeping up with the freight?",
        "description": "Shipments whose documents have all been verified.",
        "category": "operations",
        "source_view": "tms_views.v_kpi_shipment_status_funnel",
        "measure_column": "documents_verified_count", "aggregation": "sum",
        "dimensions": ["shipment_status"], "default_dimension": "shipment_status",
        "value_format": "integer", "higher_is_better": True,
        "related_object_types": ["tms:Shipment"], "display_order": 430,
    },

    # ── Network ───────────────────────────────────────────────────────────
    {
        "api_name": "lane_order_count",
        "label": "Orders per Lane",
        "business_question": "Which lanes carry our volume?",
        "description": "Order count grouped by origin-destination city pair.",
        "category": "network",
        "source_view": "tms_views.v_kpi_lane_performance",
        "measure_column": "order_count", "aggregation": "sum",
        "dimensions": ["lane", "origin_state", "destination_state", "transportation_mode"],
        "default_dimension": "lane",
        "value_format": "integer", "higher_is_better": None,
        "related_object_types": ["tms:Order"], "display_order": 500,
    },
    {
        "api_name": "lane_cost_per_km",
        "label": "Lane Cost per Kilometre",
        "business_question": "Which lanes are expensive to run?",
        "description": "Carrier cost per kilometre, by lane.",
        "category": "network",
        "source_view": "tms_views.v_kpi_lane_performance",
        "measure_column": "cost_per_km", "aggregation": "avg",
        "dimensions": ["lane", "origin_state", "destination_state", "transportation_mode"],
        "default_dimension": "lane",
        "unit": "USD/km", "value_format": "currency", "higher_is_better": False,
        "related_object_types": ["tms:Transport"],
        "depends_on_simulation": True,
        "coverage_note": SIM_COST + " " + SIM_DISTANCE, "display_order": 510,
    },
    {
        "api_name": "lane_on_time_pct",
        "label": "Lane On-Time %",
        "business_question": "Which lanes are unreliable?",
        "description": "On-time percentage by lane.",
        "category": "network",
        "source_view": "tms_views.v_kpi_lane_performance",
        "aggregation": "ratio",
        "numerator_column": "on_time_sample_size", "denominator_column": "transport_count",
        "dimensions": ["lane", "origin_state", "destination_state"],
        "default_dimension": "lane",
        "unit": "%", "value_format": "percent", "higher_is_better": True,
        "target_value": 95.0, "warning_threshold": 90.0,
        "related_object_types": ["tms:Transport"],
        "depends_on_simulation": True, "coverage_note": SIM_EXECUTION, "display_order": 520,
    },
    {
        "api_name": "mode_order_share_pct",
        "label": "Mode Mix",
        "business_question": "How is volume split across transport modes?",
        "description": "Share of orders carried by each mode.",
        "category": "network",
        "source_view": "tms_views.v_kpi_mode_mix",
        "measure_column": "order_share_pct", "aggregation": "passthrough",
        "dimensions": ["transportation_mode"], "default_dimension": "transportation_mode",
        "unit": "%", "value_format": "percent", "higher_is_better": None,
        "related_object_types": ["tms:TransportationMode", "tms:Order"], "display_order": 530,
    },
    {
        "api_name": "facility_stop_count",
        "label": "Facility Throughput",
        "business_question": "Which facilities are busiest?",
        "description": "Stop count per facility, split pickup and delivery.",
        "category": "network",
        "source_view": "tms_views.v_kpi_facility_throughput",
        "measure_column": "stop_count", "aggregation": "sum",
        "dimensions": ["location_name", "city", "province_state", "country"],
        "default_dimension": "location_name",
        "value_format": "integer", "higher_is_better": None,
        "related_object_types": ["tms:Location"], "display_order": 540,
    },

    # ── Data quality ──────────────────────────────────────────────────────
    {
        "api_name": "source_coverage_pct",
        "label": "Source Data Coverage",
        "business_question": "How much of this dashboard is measured rather than simulated?",
        "description": (
            "Share of rows in each metric area that came from the captured TMS "
            "payloads. Read this before trusting any tile flagged as simulated."
        ),
        "category": "data_quality",
        "source_view": "tms_views.v_kpi_data_coverage",
        "measure_column": "source_coverage_pct", "aggregation": "passthrough",
        "dimensions": ["metric_area", "object_type"], "default_dimension": "metric_area",
        "unit": "%", "value_format": "percent", "higher_is_better": True,
        "target_value": 100.0, "warning_threshold": 80.0, "critical_threshold": 40.0,
        "related_object_types": [], "display_order": 900,
    },
]
# fmt: on


def register_kpis(conn: psycopg.Connection) -> int:
    """Write the catalogue, replacing any earlier version of each entry."""
    rows = []
    for spec in KPI_SPECS:
        rows.append(
            (
                f"kpi:{spec['api_name']}",
                spec["api_name"],
                spec["label"],
                spec.get("description"),
                spec.get("business_question"),
                spec.get("category", "operations"),
                spec["source_view"],
                spec.get("measure_column"),
                spec.get("aggregation", "sum"),
                spec.get("numerator_column"),
                spec.get("denominator_column"),
                spec.get("dimensions", []),
                spec.get("default_dimension"),
                spec.get("time_column"),
                spec.get("unit"),
                spec.get("value_format", "number"),
                spec.get("higher_is_better"),
                spec.get("target_value"),
                spec.get("warning_threshold"),
                spec.get("critical_threshold"),
                spec.get("related_object_types", []),
                spec.get("depends_on_simulation", False),
                spec.get("coverage_note"),
                spec.get("display_order", 100),
            )
        )

    written = upsert_many(
        conn,
        "platform.kpi_definition",
        [
            "kpi_rid", "api_name", "label", "description", "business_question", "category",
            "source_view", "measure_column", "aggregation", "numerator_column",
            "denominator_column", "dimensions", "default_dimension", "time_column", "unit",
            "value_format", "higher_is_better", "target_value", "warning_threshold",
            "critical_threshold", "related_object_types", "depends_on_simulation",
            "coverage_note", "display_order",
        ],
        rows,
        ["kpi_rid"],
    )
    simulated = sum(1 for s in KPI_SPECS if s.get("depends_on_simulation"))
    log.info(
        "Registered %d KPI definitions across %d categories (%d flagged as resting on simulated data).",
        written, len({s.get("category") for s in KPI_SPECS}), simulated,
    )
    return written


def validate_kpis(conn: psycopg.Connection) -> list[str]:
    """Check every KPI actually points at columns that exist.

    A catalogue entry naming a column that was renamed is worse than no entry:
    the assistant offers the metric, builds a chart, and the query fails at the
    point a business user is looking at it.
    """
    problems: list[str] = []
    columns_by_view: dict[str, set[str]] = {}
    for row in conn.execute(
        """
        SELECT table_schema || '.' || table_name AS view_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'tms_views'
        """
    ).fetchall():
        columns_by_view.setdefault(row["view_name"], set()).add(row["column_name"])

    for spec in KPI_SPECS:
        view = spec["source_view"]
        available = columns_by_view.get(view)
        if available is None:
            problems.append(f"{spec['api_name']}: source view {view} does not exist")
            continue
        referenced = [
            spec.get("measure_column"),
            spec.get("numerator_column"),
            spec.get("denominator_column"),
            spec.get("time_column"),
            spec.get("default_dimension"),
            *spec.get("dimensions", []),
        ]
        for column in referenced:
            if column and column not in available:
                problems.append(f"{spec['api_name']}: {view} has no column {column}")

    if problems:
        for problem in problems:
            log.error("KPI catalogue: %s", problem)
    return problems
