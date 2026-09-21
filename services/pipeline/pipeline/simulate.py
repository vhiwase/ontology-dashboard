"""Stage 2 - generate execution actuals into tms_sim.

WHY: the captured snapshot is a planning snapshot. Verified against
api_responses/orders_viewType1.json, it contains 0 transports with an
actualStart, 0 stops that have been arrived at, 0 legs with a non-zero distance
and 0 orders with a carrierId. Without actuals there is no on-time percentage,
no transit time, no cost per kilometre and no carrier scorecard - which is most
of what a TMS business user wants a dashboard for.

WHAT THIS IS NOT: a forecast or a model of the real operation. It is a
reproducible stand-in so the ontology, the KPI layer and the assistant can be
exercised end to end. Everything written here lands in tms_sim, never in
tms_raw, and every view that surfaces it reports data_origin = 'simulated'.

Determinism: all randomness is drawn from a Random seeded with
PIPELINE_SIM_SEED mixed with the row's own primary key, and rows are processed in
sorted key order. The same seed therefore produces byte-identical output, so a
number quoted in a dashboard today is the same number tomorrow.

ON DISTANCE: the demo coordinates are not geographically coherent - great-circle
distance between origin and destination has a median of 5,594 km and a maximum of
18,948 km, against planned transit windows of 0.06 to 3.4 days. Only 28 of 61
transports fall in a plausible road range. Road distance is therefore derived
from the planned transit window, which IS real data, using a nominal daily range
per transport mode. The great-circle figure is still stored in
tms_sim.leg_distance.haversine_km so the discrepancy stays visible rather than
being quietly discarded.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import random
from datetime import timedelta
from typing import Any

import psycopg

from .config import CONFIG
from .db import execute, query, query_one, truncate, upsert_many

log = logging.getLogger("pipeline.simulate")

SIM_TABLES = [
    "tms_sim.transport_actual",
    "tms_sim.stop_actual",
    "tms_sim.leg_distance",
    "tms_sim.shipment_charge",
    "tms_sim.sim_run",
]

# Nominal road kilometres achievable per elapsed transit day, by mode. These are
# planning rules of thumb, not measurements: a dry van covers roughly 800 km of a
# 24-hour window once hours-of-service and dock time are taken out, LTL less
# because of hub stops, air far more.
DAILY_KM_BY_MODE = {
    1: 550.0,   # Less Than Truckload
    2: 800.0,   # Truckload
    3: 700.0,   # Rail
    4: 2500.0,  # Air
    5: 450.0,   # Ocean
    6: 650.0,   # Intermodal
}
DEFAULT_DAILY_KM = 700.0

# Linehaul rate per kilometre by mode, in USD. Spread wide enough that the
# mode-mix and lane KPIs show real differences.
RATE_PER_KM_BY_MODE = {
    1: 2.35,
    2: 1.55,
    3: 0.85,
    4: 4.80,
    5: 0.40,
    6: 1.10,
}
DEFAULT_RATE_PER_KM = 1.55

# Fuel surcharge as a share of linehaul, and a flat accessorial per service.
FUEL_SHARE_RANGE = (0.16, 0.26)
ACCESSORIAL_UNIT_COST = (35.0, 145.0)

EXCEPTION_CODES = [
    ("CARRIER_DELAY", 0.30),
    ("FACILITY_CONGESTION", 0.24),
    ("TRAFFIC", 0.18),
    ("WEATHER", 0.14),
    ("EQUIPMENT_FAILURE", 0.08),
    ("CUSTOMS_HOLD", 0.06),
]


def _rng(seed: int, *parts: Any) -> random.Random:
    """A Random keyed on the seed plus the row identity.

    Mixing the primary key in means a row's simulated values do not shift when
    unrelated rows are added or the processing order changes - only the seed
    controls them.
    """
    digest = hashlib.sha256(("|".join(str(p) for p in parts)).encode("utf-8")).hexdigest()
    return random.Random(seed ^ int(digest[:16], 16))


def _unit_fraction(seed: int, *parts: Any) -> float:
    """A stable 0..1 value for a key, for reliability-style traits."""
    return _rng(seed, *parts).random()


def _pick_weighted(rng: random.Random, options: list[tuple[str, float]]) -> str:
    roll = rng.random()
    cumulative = 0.0
    for value, weight in options:
        cumulative += weight
        if roll <= cumulative:
            return value
    return options[-1][0]


def _haversine_km(lat1, lon1, lat2, lon2) -> float | None:
    if None in (lat1, lon1, lat2, lon2):
        return None
    radius = 6371.0088
    p1, p2 = math.radians(float(lat1)), math.radians(float(lat2))
    d_lat = p2 - p1
    d_lon = math.radians(float(lon2) - float(lon1))
    a = math.sin(d_lat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(d_lon / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(min(1.0, a)))


class ExecutionSimulator:
    def __init__(self, conn: psycopg.Connection, seed: int) -> None:
        self.conn = conn
        self.seed = seed
        self.sim_run_id: int | None = None
        self.stats: dict[str, int] = {}

    # ── carrier pool ──────────────────────────────────────────────────────

    def _carrier_pool(self) -> list[dict]:
        """Carriers, ordered deterministically, each with a reliability trait.

        Real freight spend is concentrated: a 3PL runs most volume through a
        handful of core carriers and spot-buys the rest. The pool is therefore
        weighted so the top carriers take the bulk of the loads, which is what
        makes a carrier scorecard worth looking at.
        """
        carriers = query(
            self.conn,
            """
            SELECT carrier_key::text AS carrier_key, carrier_name, scac_hint
            FROM tms_views.v_carrier
            WHERE is_active
            ORDER BY carrier_key
            """,
        )
        if not carriers:
            # Fall back to any carrier at all rather than producing no carrier
            # assignment, which would silently empty the scorecard.
            carriers = query(
                self.conn,
                "SELECT carrier_key::text AS carrier_key, carrier_name, scac_hint "
                "FROM tms_views.v_carrier ORDER BY carrier_key",
            )
        if not carriers:
            return []

        rng = random.Random(self.seed ^ 0xC0FFEE)
        pool = carriers[:]
        rng.shuffle(pool)
        # 8 core carriers carry ~70% of loads; the remainder are spot.
        core_count = min(8, max(1, len(pool) // 12))
        enriched: list[dict] = []
        for index, carrier in enumerate(pool):
            is_core = index < core_count
            key = carrier["carrier_key"]
            # Reliability is a stable per-carrier trait so a carrier that is bad
            # in one lane is bad in all of them - otherwise the scorecard is noise.
            reliability = 0.60 + 0.38 * _unit_fraction(self.seed, "reliability", key)
            enriched.append(
                {
                    "carrier_key": key,
                    "carrier_name": carrier["carrier_name"],
                    "scac": self._scac(carrier),
                    "weight": 9.0 if is_core else 1.0,
                    "reliability": reliability,
                    # Rate position: cheap carriers tend to be less reliable.
                    "rate_factor": 1.18 - 0.30 * reliability
                    + 0.10 * _unit_fraction(self.seed, "rate", key),
                }
            )
        return enriched

    @staticmethod
    def _scac(carrier: dict) -> str:
        """A 4-letter SCAC-shaped code derived from the carrier name.

        The snapshot has no SCAC for carriers (electronicReferenceIdentifier is a
        random token), so one is derived stably from the name for display.
        """
        name = (carrier.get("carrier_name") or "CARR").upper()
        letters = [c for c in name if c.isalpha()]
        code = "".join(letters[:4]) if len(letters) >= 4 else "".join(letters).ljust(4, "X")
        return code[:4]

    # ── run bookkeeping ───────────────────────────────────────────────────

    def start(self, ingest_run: int | None, notes: str) -> int:
        row = query_one(
            self.conn,
            """
            INSERT INTO tms_sim.sim_run (seed, ingest_run, profile, notes, details)
            VALUES (%s, %s, 'default', %s, %s)
            RETURNING sim_run_id
            """,
            (self.seed, ingest_run, notes, json.dumps({"daily_km_by_mode": DAILY_KM_BY_MODE})),
        )
        assert row is not None
        self.sim_run_id = int(row["sim_run_id"])
        return self.sim_run_id

    # ── stage entry point ─────────────────────────────────────────────────

    def run(self) -> dict[str, int]:
        carriers = self._carrier_pool()
        if not carriers:
            log.warning("No carriers in the snapshot; transports will be left unassigned.")

        transports = query(
            self.conn,
            """
            SELECT t.transport_id::text          AS transport_id,
                   t.order_id::text              AS order_id,
                   t.planned_start, t.planned_end, t.status,
                   o.transportation_mode_id      AS mode_id,
                   o.pickup_ready_date, o.delivery_close_date,
                   o.accessorial_count,
                   o.gross_weight_kg,
                   org.latitude AS org_lat, org.longitude AS org_lon,
                   dst.latitude AS dst_lat, dst.longitude AS dst_lon
            FROM tms_raw.transport t
            JOIN LATERAL (
                SELECT ord.transportation_mode_key AS transportation_mode_id,
                       ord.pickup_ready_at        AS pickup_ready_date,
                       ord.delivery_close_at      AS delivery_close_date,
                       ord.gross_weight_kg,
                       ord.accessorial_count
                FROM tms_views.v_order ord WHERE ord.order_key = t.order_id
            ) o ON true
            LEFT JOIN tms_raw.business_entity org ON org.id = t.origin_id
            LEFT JOIN tms_raw.business_entity dst ON dst.id = t.destination_id
            ORDER BY t.transport_id
            """,
        )

        # Leg numbers are fetched once and grouped, rather than queried per
        # transport: 61 extra round trips is nothing on a unix socket but costs
        # ~20 s through a Docker Desktop port forward.
        legs_by_transport: dict[str, list[int]] = {}
        for leg in query(
            self.conn,
            "SELECT transport_id::text AS transport_id, leg_number "
            "FROM tms_raw.transport_leg ORDER BY transport_id, leg_number",
        ):
            legs_by_transport.setdefault(leg["transport_id"], []).append(leg["leg_number"])

        transport_rows: list[tuple] = []
        leg_rows: list[tuple] = []
        stop_rows: list[tuple] = []
        assignment: dict[str, dict] = {}

        for transport in transports:
            transport_id = transport["transport_id"]
            rng = _rng(self.seed, "transport", transport_id)
            carrier = self._assign_carrier(carriers, rng, transport_id)

            road_km, haversine_km, circuity = self._distance(transport, rng)

            # A transport's punctuality is its carrier's reliability, nudged by
            # the length of the run: long hauls accumulate more risk.
            reliability = carrier["reliability"] if carrier else 0.75
            length_penalty = min(0.18, road_km / 12000.0)
            on_time_chance = max(0.25, reliability - length_penalty)

            planned_start = transport["planned_start"] or transport["pickup_ready_date"]
            if planned_start is None:
                continue

            departure_slip_hours = self._slip_hours(rng, on_time_chance)
            actual_start = planned_start + timedelta(hours=departure_slip_hours)

            mode_id = transport["mode_id"]
            daily_km = DAILY_KM_BY_MODE.get(mode_id, DEFAULT_DAILY_KM)
            # Driving time implied by the distance, plus dock and rest time.
            drive_hours = 24.0 * road_km / max(daily_km, 1.0)
            transit_hours = drive_hours * rng.uniform(0.94, 1.22)
            actual_end = actual_start + timedelta(hours=transit_hours)

            costs = self._costs(transport, road_km, carrier, rng)

            transport_rows.append(
                (
                    transport_id,
                    self.sim_run_id,
                    actual_start,
                    actual_end,
                    carrier["carrier_key"] if carrier else None,
                    carrier["carrier_name"] if carrier else None,
                    carrier["scac"] if carrier else None,
                    round(road_km, 2),
                    costs["linehaul"],
                    costs["fuel"],
                    costs["accessorial"],
                    costs["total"],
                    "USD",
                )
            )
            assignment[transport_id] = {
                "on_time_chance": on_time_chance,
                "actual_start": actual_start,
                "actual_end": actual_end,
                "road_km": road_km,
            }

            leg_rows.extend(
                self._leg_rows(
                    transport_id,
                    legs_by_transport.get(transport_id, []),
                    road_km,
                    haversine_km,
                    circuity,
                )
            )

        stop_rows = self._stop_rows(assignment)
        charge_rows = self._charge_rows()

        self.stats["transport_actual"] = upsert_many(
            self.conn,
            "tms_sim.transport_actual",
            [
                "transport_id", "sim_run_id", "actual_start", "actual_end", "carrier_id",
                "carrier_name", "scac", "total_km", "linehaul_cost", "fuel_cost",
                "accessorial_cost", "total_cost", "currency_code",
            ],
            transport_rows,
            ["transport_id"],
        )
        self.stats["leg_distance"] = upsert_many(
            self.conn,
            "tms_sim.leg_distance",
            ["transport_id", "leg_number", "sim_run_id", "haversine_km", "circuity_factor", "road_km"],
            leg_rows,
            ["transport_id", "leg_number"],
        )
        self.stats["stop_actual"] = upsert_many(
            self.conn,
            "tms_sim.stop_actual",
            [
                "stop_id", "sim_run_id", "actual_arrival", "actual_departure", "is_arrived",
                "is_departed", "dwell_minutes", "arrival_variance_minutes", "exception_code",
            ],
            stop_rows,
            ["stop_id"],
        )
        self.stats["shipment_charge"] = upsert_many(
            self.conn,
            "tms_sim.shipment_charge",
            [
                "shipment_id", "sim_run_id", "freight_amount", "fuel_amount",
                "accessorial_amount", "total_rate_amount", "currency_code", "rate_basis",
            ],
            charge_rows,
            ["shipment_id"],
        )
        return self.stats

    # ── per-aspect generators ─────────────────────────────────────────────

    def _assign_carrier(
        self, carriers: list[dict], rng: random.Random, transport_id: str
    ) -> dict | None:
        if not carriers:
            return None
        total = sum(c["weight"] for c in carriers)
        roll = rng.random() * total
        cumulative = 0.0
        for carrier in carriers:
            cumulative += carrier["weight"]
            if roll <= cumulative:
                return carrier
        return carriers[-1]

    def _distance(
        self, transport: dict, rng: random.Random
    ) -> tuple[float, float | None, float | None]:
        """Road kilometres for the move, plus the great-circle figure for audit."""
        haversine = _haversine_km(
            transport.get("org_lat"), transport.get("org_lon"),
            transport.get("dst_lat"), transport.get("dst_lon"),
        )

        pickup = transport.get("pickup_ready_date")
        delivery = transport.get("delivery_close_date")
        transit_days = None
        if pickup and delivery and delivery > pickup:
            transit_days = (delivery - pickup).total_seconds() / 86400.0

        daily_km = DAILY_KM_BY_MODE.get(transport.get("mode_id"), DEFAULT_DAILY_KM)
        if transit_days:
            road = transit_days * daily_km * rng.uniform(0.85, 1.15)
        elif haversine:
            road = haversine * rng.uniform(1.15, 1.32)
        else:
            road = daily_km * rng.uniform(0.5, 1.5)

        road = max(60.0, road)
        circuity = (road / haversine) if haversine and haversine > 0 else None
        return road, haversine, circuity

    def _slip_hours(self, rng: random.Random, on_time_chance: float) -> float:
        """Hours between planned and actual departure.

        Most loads leave inside the window; the late tail is deliberately long,
        because in freight the distribution of lateness is not symmetric.
        """
        if rng.random() < on_time_chance:
            return rng.uniform(-1.5, 0.5)
        return rng.uniform(0.5, 14.0) ** 1.25

    def _costs(
        self, transport: dict, road_km: float, carrier: dict | None, rng: random.Random
    ) -> dict[str, float]:
        mode_id = transport.get("mode_id")
        base_rate = RATE_PER_KM_BY_MODE.get(mode_id, DEFAULT_RATE_PER_KM)
        rate_factor = carrier["rate_factor"] if carrier else 1.0
        linehaul = road_km * base_rate * rate_factor * rng.uniform(0.94, 1.08)

        # Heavy freight attracts a weight-based uplift over the pure distance rate.
        weight_kg = float(transport.get("gross_weight_kg") or 0)
        if weight_kg > 15000:
            linehaul *= 1.0 + min(0.22, (weight_kg - 15000) / 120000.0)

        fuel = linehaul * rng.uniform(*FUEL_SHARE_RANGE)
        accessorial_count = int(transport.get("accessorial_count") or 0)
        accessorial = sum(rng.uniform(*ACCESSORIAL_UNIT_COST) for _ in range(accessorial_count))

        return {
            "linehaul": round(linehaul, 2),
            "fuel": round(fuel, 2),
            "accessorial": round(accessorial, 2),
            "total": round(linehaul + fuel + accessorial, 2),
        }

    def _leg_rows(
        self,
        transport_id: str,
        leg_numbers: list[int],
        road_km: float,
        haversine: float | None,
        circuity: float | None,
    ) -> list[tuple]:
        """Split the transport's distance evenly across its legs.

        Even is the honest split: the snapshot gives no per-leg distance to
        weight by, so pretending one leg is longer than another would be
        invention on top of invention.
        """
        if not leg_numbers:
            return []
        share = road_km / len(leg_numbers)
        hav_share = (haversine / len(leg_numbers)) if haversine else None
        return [
            (
                transport_id,
                leg_number,
                self.sim_run_id,
                round(hav_share, 2) if hav_share else None,
                round(circuity, 4) if circuity else None,
                round(share, 2),
            )
            for leg_number in leg_numbers
        ]

    def _stop_rows(self, assignment: dict[str, dict]) -> list[tuple]:
        """Arrival and departure per stop, measured against the planned window."""
        stops = query(
            self.conn,
            """
            SELECT stop_id::text AS stop_id, transport_id::text AS transport_id,
                   leg_number, stop_role, arrival_begin, arrival_end,
                   departure_begin, departure_end
            FROM tms_raw.transport_stop
            ORDER BY transport_id, leg_number, stop_role
            """,
        )
        rows: list[tuple] = []
        for stop in stops:
            context = assignment.get(stop["transport_id"])
            if context is None:
                continue
            rng = _rng(self.seed, "stop", stop["stop_id"])
            window_start = stop["arrival_begin"]
            window_end = stop["arrival_end"] or window_start
            if window_start is None:
                continue

            on_time = rng.random() < context["on_time_chance"]
            if on_time:
                # Arrive somewhere inside the window, or a little early.
                variance = rng.uniform(-90.0, 0.0)
            else:
                # Long right tail: most late arrivals are under two hours, a few
                # are a whole shift out.
                variance = min(1440.0, rng.uniform(5.0, 240.0) * rng.uniform(1.0, 2.4))

            actual_arrival = window_end + timedelta(minutes=variance)
            dwell = rng.uniform(25.0, 210.0)
            actual_departure = actual_arrival + timedelta(minutes=dwell)
            exception = (
                _pick_weighted(rng, EXCEPTION_CODES) if variance > 30.0 else None
            )

            rows.append(
                (
                    stop["stop_id"],
                    self.sim_run_id,
                    actual_arrival,
                    actual_departure,
                    True,
                    True,
                    round(dwell, 1),
                    round(variance, 1),
                    exception,
                )
            )
        return rows

    def _charge_rows(self) -> list[tuple]:
        """Rate the shipments the snapshot left unrated.

        Shipments that already carry a charge from the API are skipped entirely,
        so a measured value is never overwritten by a generated one.
        """
        shipments = query(
            self.conn,
            """
            SELECT s.shipment_key::text AS shipment_id,
                   s.gross_weight_kg, s.piece_count,
                   o.transportation_mode_key AS mode_id,
                   ta.total_km, ta.total_cost
            FROM tms_views.v_shipment s
            JOIN tms_raw.shipment rs ON rs.shipment_id = s.shipment_key
            LEFT JOIN tms_views.v_order o ON o.order_key = s.order_key
            LEFT JOIN tms_raw.transport t ON t.order_id = s.order_key
            LEFT JOIN tms_sim.transport_actual ta ON ta.transport_id = t.transport_id
            WHERE rs.total_rate_amount IS NULL
            ORDER BY s.shipment_key
            """,
        )
        rows: list[tuple] = []
        for shipment in shipments:
            rng = _rng(self.seed, "charge", shipment["shipment_id"])
            cost = float(shipment["total_cost"] or 0)
            if cost <= 0:
                # No simulated transport cost to mark up: fall back to a
                # weight-and-distance rate so the shipment is still rated.
                weight = float(shipment["gross_weight_kg"] or 0)
                km = float(shipment["total_km"] or 0) or 600.0
                rate = RATE_PER_KM_BY_MODE.get(shipment["mode_id"], DEFAULT_RATE_PER_KM)
                cost = km * rate + weight * 0.06

            # Gross margin on a 3PL brokered load sits in the mid teens, with
            # real spread and the occasional loss-making move.
            margin = rng.gauss(0.155, 0.075)
            margin = max(-0.06, min(0.38, margin))
            total = cost / (1.0 - margin) if margin < 0.95 else cost * 1.2

            fuel_share = rng.uniform(*FUEL_SHARE_RANGE)
            accessorial = total * rng.uniform(0.0, 0.09)
            fuel = (total - accessorial) * fuel_share
            freight = total - accessorial - fuel

            rows.append(
                (
                    shipment["shipment_id"],
                    self.sim_run_id,
                    round(freight, 2),
                    round(fuel, 2),
                    round(accessorial, 2),
                    round(total, 2),
                    "USD",
                    "distance_and_weight_markup",
                )
            )
        return rows


def run_simulation(conn: psycopg.Connection, ingest_run: int | None = None) -> dict[str, Any]:
    """Rebuild tms_sim from scratch, or clear it when simulation is disabled."""
    if not CONFIG.simulate_execution:
        log.info(
            "PIPELINE_SIMULATE_EXECUTION is false: clearing tms_sim. "
            "On-time, transit-time, carrier and cost-per-km KPIs will read as no data."
        )
        truncate(conn, SIM_TABLES)
        conn.commit()
        return {"enabled": False}

    truncate(conn, SIM_TABLES)
    simulator = ExecutionSimulator(conn, CONFIG.sim_seed)
    simulator.start(
        ingest_run,
        "Execution actuals for a planning-only snapshot: arrivals, distances, "
        "carrier assignment and charges for unrated shipments.",
    )
    stats = simulator.run()
    conn.commit()

    log.info("Execution simulation complete (seed %s):", CONFIG.sim_seed)
    for table, count in sorted(stats.items()):
        log.info("    tms_sim.%-22s %6d", table, count)

    # Report what the simulation actually bought us, so a false sense of
    # completeness is not the takeaway from a green log line.
    coverage = query(
        conn,
        "SELECT metric_area, total_rows, rows_from_source, rows_simulated, source_coverage_pct "
        "FROM tms_views.v_kpi_data_coverage ORDER BY metric_area",
    )
    for row in coverage:
        log.info(
            "    coverage  %-22s total=%-5s source=%-5s simulated=%-5s",
            row["metric_area"], row["total_rows"], row["rows_from_source"], row["rows_simulated"],
        )

    return {"enabled": True, "seed": CONFIG.sim_seed, "stats": stats}
