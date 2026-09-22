"""Stage 4 - build the lineage graph.

Answers "where did this number come from?" for every figure the platform shows,
across six layers:

    source        the HTTP endpoint the payload was captured from
    raw           the landing table it was parsed into
    simulation    the tms_sim table, where a value was generated rather than measured
    view          the semantic view that reshaped it
    ontology      the object type and its properties
    metric        the KPI definition built on top
    consumer      the dashboard or assistant answer that used it

Node and edge shapes follow the LineageNode / LineageEdge interfaces in
vendor/ontograph-core/src/lineage.ts, so the rows can be handed to the library's
trace functions without translation.

Column-level lineage is read from pg_depend rather than guessed. A view's
dependency on a base column is recorded by Postgres itself when the view is
created, so "v_order.gross_weight_kg reads tms_raw.handling_unit.weight_value" is
a fact from the catalogue, not a name-matching heuristic. What pg_depend does NOT
record is which output column a given input feeds, so the mapping is stored at
view-to-column granularity and the transform note says so, rather than the
platform implying a precision it does not have.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import psycopg

from .config import CONFIG
from .db import delete_for_space, query, space_id, upsert_many
from .introspect import ViewInfo
from .relationships import DiscoveryResult

log = logging.getLogger("pipeline.lineage")

NS = "lineage"


class LineageBuilder:
    def __init__(self, conn: psycopg.Connection) -> None:
        self.conn = conn
        self.nodes: dict[str, tuple] = {}
        self.edges: dict[str, tuple] = {}
        self.columns: list[tuple] = []

    # ── primitives ────────────────────────────────────────────────────────

    def node(
        self,
        rid: str,
        node_type: str,
        label: str,
        layer: str,
        description: str | None = None,
        object_id: str | None = None,
        payload: dict[str, Any] | None = None,
        tags: list[str] | None = None,
    ) -> str:
        self.nodes[rid] = (
            rid, node_type, label, description, object_id,
            json.dumps(payload or {}), 1, layer, "pipeline", tags or [],
        )
        return rid

    def edge(
        self,
        source: str,
        target: str,
        relation: str = "flowsTo",
        weight: float | None = None,
        payload: dict[str, Any] | None = None,
    ) -> None:
        rid = f"{NS}:edge:{relation}:{source}->{target}"
        self.edges[rid] = (rid, source, target, relation, weight, json.dumps(payload or {}))

    # ── layers ────────────────────────────────────────────────────────────

    def add_sources(self) -> dict[str, list[str]]:
        """One dataSource node per captured endpoint; returns table -> source nodes."""
        rows = query(
            self.conn,
            """
            SELECT endpoint_name, url, http_method, status_code, file_name,
                   sum(record_count) AS record_count,
                   max(ingested_at)  AS ingested_at,
                   array_agg(DISTINCT t) FILTER (WHERE t IS NOT NULL) AS target_tables
            FROM tms_raw.ingest_source
            LEFT JOIN LATERAL unnest(target_tables) AS t ON true
            GROUP BY endpoint_name, url, http_method, status_code, file_name
            ORDER BY endpoint_name
            """,
        )
        by_table: dict[str, list[str]] = {}
        for row in rows:
            rid = f"{NS}:source:{row['endpoint_name']}"
            self.node(
                rid,
                "dataSource",
                row["endpoint_name"],
                "source",
                description=f"{row['http_method'] or 'GET'} {row['url'] or row['file_name']}",
                payload={
                    "@type": "DataSource",
                    "type": "api",
                    "url": row["url"],
                    "method": row["http_method"],
                    "statusCode": row["status_code"],
                    "fileName": row["file_name"],
                    "recordCount": int(row["record_count"] or 0),
                    "lastSyncAt": row["ingested_at"].isoformat() if row["ingested_at"] else None,
                    "syncStatus": "success" if row["status_code"] in (200, None) else "failed",
                },
                tags=["api", "captured"],
            )
            for table in row["target_tables"] or []:
                by_table.setdefault(table, []).append(rid)
        log.info("Lineage: %d source endpoints.", len(rows))
        return by_table

    def add_ingest(self, sources_by_table: dict[str, list[str]]) -> None:
        """The ingest transformation, plus a node per raw table it fed."""
        run = query(
            self.conn,
            """
            SELECT run_id, started_at, finished_at, status, rows_landed, files_processed, details
            FROM tms_raw.ingest_run ORDER BY run_id DESC LIMIT 1
            """,
        )
        if not run:
            return
        run = run[0]
        transform_rid = self.node(
            f"{NS}:transform:ingest",
            "transformation",
            "Ingest captured payloads",
            "raw",
            description=(
                "Parses the JSON envelopes into typed landing tables. Coerces the "
                "all-zero UUID sentinel to NULL and keeps measurement units verbatim."
            ),
            payload={
                "@type": "Transformation",
                "type": "import",
                "executionLog": {
                    "startedAt": run["started_at"].isoformat(),
                    "finishedAt": run["finished_at"].isoformat() if run["finished_at"] else None,
                    "status": "success" if run["status"] == "success" else run["status"],
                    "recordsProcessed": int(run["rows_landed"] or 0),
                },
            },
            tags=["etl"],
        )

        table_counts = (run["details"] or {}).get("table_counts", {})
        for table, count in sorted(table_counts.items()):
            rid = self.node(
                f"{NS}:table:{table}",
                "object",
                table,
                "raw",
                description=f"Landing table, {count} rows from the captured snapshot.",
                object_id=table,
                payload={"rowCount": count, "schema": CONFIG.raw_schema},
                tags=["table", "raw"],
            )
            for source_rid in sources_by_table.get(table, []):
                self.edge(source_rid, transform_rid, "flowsTo")
            self.edge(transform_rid, rid, "flowsTo", weight=float(count))

        # Endpoints whose rows all landed in tables the run did not itemise still
        # belong on the graph, so wire any stragglers straight to the transform.
        for source_rids in sources_by_table.values():
            for source_rid in source_rids:
                self.edge(source_rid, transform_rid, "flowsTo")

    def add_simulation(self) -> None:
        """The execution simulation, where one exists.

        It does not, since migration 0018 removed tms_sim: nothing in this
        platform generates data any more. The method is kept because a lineage
        graph that CANNOT represent generated data would be the wrong shape if
        a future source ever needs it - but it now finds nothing and adds
        nothing, rather than failing the run looking for a dropped table.
        """
        exists = query(
            self.conn,
            "SELECT 1 AS n FROM information_schema.tables "
            "WHERE table_schema = 'tms_sim' AND table_name = 'sim_run'",
        )
        if not exists:
            return

        run = query(
            self.conn,
            "SELECT sim_run_id, seed, created_at, notes FROM tms_sim.sim_run "
            "ORDER BY sim_run_id DESC LIMIT 1",
        )
        if not run:
            return
        run = run[0]
        transform_rid = self.node(
            f"{NS}:transform:simulate",
            "transformation",
            "Generate execution actuals",
            "simulation",
            description=(
                "The captured snapshot has no arrivals, distances, carrier assignment "
                f"or cost. This step generates them deterministically from seed "
                f"{run['seed']} into tms_sim. Values it produces are NOT measured."
            ),
            payload={
                "@type": "Transformation",
                "type": "transform",
                "seed": run["seed"],
                "isSimulated": True,
                "executionLog": {
                    "startedAt": run["created_at"].isoformat(),
                    "status": "success",
                },
            },
            tags=["simulation", "not-measured"],
        )
        self.edge(f"{NS}:table:tms_raw.transport", transform_rid, "flowsTo")
        self.edge(f"{NS}:table:tms_raw.transport_stop", transform_rid, "flowsTo")
        self.edge(f"{NS}:table:tms_raw.shipment", transform_rid, "flowsTo")

        for table, description in [
            ("tms_sim.transport_actual", "Actual departure and arrival, carrier, and cost per transport."),
            ("tms_sim.stop_actual", "Arrival, departure, dwell and variance against the planned window."),
            ("tms_sim.leg_distance", "Road distance per leg, derived from the planned transit window."),
            ("tms_sim.shipment_charge", "Freight charges for the shipments the snapshot left unrated."),
        ]:
            try:
                count = query(self.conn, f"SELECT count(*) AS n FROM {table}")[0]["n"]
            except psycopg.Error:
                self.conn.rollback()
                continue
            rid = self.node(
                f"{NS}:table:{table}",
                "object",
                table,
                "simulation",
                description=f"{description} {count} simulated rows.",
                object_id=table,
                payload={"rowCount": int(count), "isSimulated": True},
                tags=["table", "simulated", "not-measured"],
            )
            self.edge(transform_rid, rid, "flowsTo", weight=float(count))

    def add_views(self, views: list[ViewInfo]) -> None:
        """A transformation and object node per view, wired from real dependencies."""
        dependencies = self._view_dependencies()

        for view in views:
            layer = "metric" if view.is_metric else "view"
            transform_rid = self.node(
                f"{NS}:transform:view:{view.view_name}",
                "transformation",
                f"Build {view.view_name}",
                layer,
                description=(
                    view.comment
                    or f"SQL view assembling {view.view_name} from its dependencies."
                ),
                payload={
                    "@type": "Transformation",
                    "type": "transform",
                    "sqlObject": view.qualified,
                    "columnCount": len(view.properties),
                },
                tags=["sql", "view"],
            )
            view_rid = self.node(
                f"{NS}:view:{view.view_name}",
                "object",
                view.qualified,
                layer,
                description=view.comment,
                object_id=view.qualified,
                payload={
                    "rowCount": view.row_count,
                    "isMetricView": view.is_metric,
                    "keyColumn": view.key_column,
                    "titleColumn": view.title_column,
                },
                tags=["view", "metric" if view.is_metric else "object"],
            )
            self.edge(transform_rid, view_rid, "flowsTo", weight=float(view.row_count))

            for dependency in dependencies.get(view.view_name, set()):
                schema, _, name = dependency.partition(".")
                if schema == CONFIG.view_schema:
                    upstream = f"{NS}:view:{name}"
                else:
                    upstream = f"{NS}:table:{dependency}"
                if upstream in self.nodes:
                    self.edge(upstream, transform_rid, "flowsTo")
                else:
                    # A dependency the earlier layers did not register (a ref
                    # table the ingest run did not itemise). Add it so the graph
                    # stays connected rather than showing an orphan view.
                    self.node(
                        upstream, "object", dependency,
                        "simulation" if schema == CONFIG.sim_schema else "raw",
                        description="Reference or lookup table.",
                        object_id=dependency, tags=["table"],
                    )
                    self.edge(upstream, transform_rid, "flowsTo")

    def _view_dependencies(self) -> dict[str, set[str]]:
        """Which relations each view reads, straight out of pg_depend.

        This is the catalogue's own record of the dependency, created when the
        view was created - not a guess from parsing SQL text.
        """
        rows = query(
            self.conn,
            """
            SELECT DISTINCT
                   dependent.relname                          AS view_name,
                   source_ns.nspname || '.' || source.relname AS source_relation
            FROM pg_depend d
            JOIN pg_rewrite r        ON r.oid = d.objid
            JOIN pg_class dependent  ON dependent.oid = r.ev_class
            JOIN pg_class source     ON source.oid = d.refobjid
            JOIN pg_namespace source_ns ON source_ns.oid = source.relnamespace
            JOIN pg_namespace dep_ns    ON dep_ns.oid = dependent.relnamespace
            WHERE d.classid    = 'pg_rewrite'::regclass
              AND d.refclassid = 'pg_class'::regclass
              AND dep_ns.nspname = %s
              AND dependent.oid <> source.oid
              AND source.relkind IN ('r', 'v', 'm')
            """,
            (CONFIG.view_schema,),
        )
        out: dict[str, set[str]] = {}
        for row in rows:
            out.setdefault(row["view_name"], set()).add(row["source_relation"])
        return out

    def add_column_lineage(self) -> None:
        """Record which base columns each view reads."""
        rows = query(
            self.conn,
            """
            SELECT DISTINCT
                   dep_ns.nspname || '.' || dependent.relname AS view_name,
                   source_ns.nspname || '.' || source.relname AS source_table,
                   att.attname                                AS source_column
            FROM pg_depend d
            JOIN pg_rewrite r        ON r.oid = d.objid
            JOIN pg_class dependent  ON dependent.oid = r.ev_class
            JOIN pg_class source     ON source.oid = d.refobjid
            JOIN pg_attribute att    ON att.attrelid = source.oid AND att.attnum = d.refobjsubid
            JOIN pg_namespace source_ns ON source_ns.oid = source.relnamespace
            JOIN pg_namespace dep_ns    ON dep_ns.oid = dependent.relnamespace
            WHERE d.classid    = 'pg_rewrite'::regclass
              AND d.refclassid = 'pg_class'::regclass
              AND d.refobjsubid > 0
              AND dep_ns.nspname = %s
              AND dependent.oid <> source.oid
            """,
            (CONFIG.view_schema,),
        )
        # pg_depend records that the view reads the column, not which output
        # column it feeds, so target_column carries the sentinel '*' and the note
        # says what the row actually asserts.
        self.columns = [
            (
                row["view_name"],
                "*",
                row["source_table"],
                row["source_column"],
                "Read by this view (recorded by pg_depend when the view was created).",
            )
            for row in rows
        ]
        log.info("Lineage: %d view-to-base-column dependencies.", len(self.columns))

    def add_ontology(self, views: list[ViewInfo], version_id: int) -> None:
        """Object types hang off the view they were generated from."""
        transform_rid = self.node(
            f"{NS}:transform:ontology",
            "transformation",
            "Generate ontology",
            "ontology",
            description=(
                "Reads the view schema from information_schema, classifies every "
                "column into a semantic role, probes candidate joins against the "
                "data, and emits the OntologyDefinition."
            ),
            payload={"@type": "Transformation", "type": "transform", "ontologyVersionId": version_id},
            tags=["ontology", "codegen"],
        )

        types = query(
            self.conn,
            """
            SELECT object_type_rid, api_name, label, source_view, row_count, group_name
            FROM platform.object_type WHERE ontology_version_id = %s ORDER BY api_name
            """,
            (version_id,),
        )
        for row in types:
            rid = self.node(
                f"{NS}:objecttype:{row['api_name']}",
                "object",
                row["label"],
                "ontology",
                description=f"Ontology object type backed by {row['source_view']}.",
                object_id=row["object_type_rid"],
                payload={
                    "rowCount": row["row_count"],
                    "sourceView": row["source_view"],
                    "group": row["group_name"],
                },
                tags=["objectType", row["group_name"] or "other"],
            )
            view_name = row["source_view"].split(".", 1)[-1]
            self.edge(f"{NS}:view:{view_name}", transform_rid, "flowsTo")
            self.edge(transform_rid, rid, "flowsTo", weight=float(row["row_count"] or 0))

        links = query(
            self.conn,
            """
            SELECT link_type_rid, api_name, label, source_object_type, target_object_type,
                   match_ratio, discovery_method
            FROM platform.link_type WHERE ontology_version_id = %s
            """,
            (version_id,),
        )
        # A link is a derivation between two object types, so it is drawn as a
        # derivedFrom edge rather than another node - the graph stays readable.
        for row in links:
            source = row["source_object_type"].split(":", 1)[-1]
            target = row["target_object_type"].split(":", 1)[-1]
            self.edge(
                f"{NS}:objecttype:{source}",
                f"{NS}:objecttype:{target}",
                "derivedFrom",
                weight=float(row["match_ratio"] or 0),
                payload={
                    "linkType": row["link_type_rid"],
                    "label": row["label"],
                    "matchRatio": float(row["match_ratio"] or 0),
                    "discoveryMethod": row["discovery_method"],
                },
            )

    def add_metrics(self) -> None:
        """KPI definitions, wired to the metric view they read."""
        kpis = query(
            self.conn,
            """
            SELECT k.kpi_rid, k.api_name, k.label, k.source_view, k.category,
                   k.depends_on_simulation, k.related_object_types
              FROM platform.kpi_definition k
              JOIN platform.space s ON s.space_id = k.space_id
             WHERE s.slug = %s
             ORDER BY k.api_name
            """,
            (CONFIG.space,),
        )
        for row in kpis:
            rid = self.node(
                f"{NS}:kpi:{row['api_name']}",
                "object",
                row["label"],
                "metric",
                description=(
                    f"KPI in the {row['category']} category."
                    + (
                        " Depends on simulated execution data."
                        if row["depends_on_simulation"]
                        else ""
                    )
                ),
                object_id=row["kpi_rid"],
                payload={
                    "category": row["category"],
                    "dependsOnSimulation": row["depends_on_simulation"],
                },
                tags=["kpi", row["category"]]
                + (["simulated"] if row["depends_on_simulation"] else []),
            )
            view_name = row["source_view"].split(".", 1)[-1]
            view_rid = f"{NS}:view:{view_name}"
            if view_rid in self.nodes:
                self.edge(view_rid, rid, "flowsTo")
            for object_type in row["related_object_types"] or []:
                type_rid = f"{NS}:objecttype:{object_type.split(':', 1)[-1]}"
                if type_rid in self.nodes:
                    self.edge(type_rid, rid, "usedBy")

    def add_consumers(self) -> None:
        """Usage nodes for the two things that read the metric layer."""
        for rid, label, description, usage_type in [
            (f"{NS}:usage:dashboards", "Dashboards", "Saved dashboards in platform.dashboard.", "report"),
            (f"{NS}:usage:assistant", "AI-FDE Assistant", "Answers composed by the assistant from the KPI catalogue.", "api_output"),
            (f"{NS}:usage:explorer", "Object Explorer", "Ad-hoc object queries from the UI.", "read"),
        ]:
            self.node(
                rid, "usage", label, "consumer", description=description,
                payload={"@type": "Usage", "type": usage_type},
                tags=["consumer"],
            )

        for node_rid, node in list(self.nodes.items()):
            if node[7] == "metric" and node[1] == "object":
                self.edge(node_rid, f"{NS}:usage:dashboards", "usedBy")
                self.edge(node_rid, f"{NS}:usage:assistant", "usedBy")
            if node[7] == "ontology" and node[1] == "object":
                self.edge(node_rid, f"{NS}:usage:explorer", "usedBy")
                self.edge(node_rid, f"{NS}:usage:assistant", "usedBy")

    # ── persist ───────────────────────────────────────────────────────────

    def persist(self) -> dict[str, int]:
        # Per-space delete, not TRUNCATE: the graph belongs to the space that
        # produced it, and wiping the table would take every other space's
        # lineage with it.
        space = space_id(self.conn, CONFIG.space)
        delete_for_space(
            self.conn,
            ["platform.lineage_edge", "platform.lineage_node", "platform.lineage_column"],
            space,
        )

        upsert_many(
            self.conn,
            "platform.lineage_node",
            [
                "space_id",
                "lineage_node_rid", "node_type", "label", "description", "object_id",
                "payload", "node_version", "layer", "created_by", "tags",
            ],
            [(space, *row) for row in self.nodes.values()],
            ["space_id", "lineage_node_rid"],
        )
        # Edges whose endpoints were never registered would violate the FK; they
        # are dropped with a count rather than failing the whole stage.
        valid_edges = [e for e in self.edges.values() if e[1] in self.nodes and e[2] in self.nodes]
        dropped = len(self.edges) - len(valid_edges)
        upsert_many(
            self.conn,
            "platform.lineage_edge",
            [
                "space_id",
                "lineage_edge_rid", "source_node_rid", "target_node_rid",
                "relation_type", "weight", "payload",
            ],
            [(space, *row) for row in valid_edges],
            ["space_id", "lineage_edge_rid"],
        )
        upsert_many(
            self.conn,
            "platform.lineage_column",
            ["space_id", "target_view", "target_column", "source_table", "source_column", "transform_note"],
            [(space, *row) for row in self.columns],
            ["space_id", "target_view", "target_column", "source_table", "source_column"],
        )

        if dropped:
            log.info("Lineage: dropped %d edges with an unregistered endpoint.", dropped)
        return {
            "nodes": len(self.nodes),
            "edges": len(valid_edges),
            "columns": len(self.columns),
        }


def build_lineage(
    conn: psycopg.Connection,
    views: list[ViewInfo],
    discovery: DiscoveryResult,
    ontology_version_id: int,
) -> dict[str, int]:
    builder = LineageBuilder(conn)
    sources_by_table = builder.add_sources()
    builder.add_ingest(sources_by_table)
    builder.add_simulation()
    builder.add_views(views)
    builder.add_column_lineage()
    builder.add_ontology(views, ontology_version_id)
    builder.add_metrics()
    builder.add_consumers()
    stats = builder.persist()

    by_layer = query(
        conn,
        "SELECT layer, count(*) AS n FROM platform.lineage_node GROUP BY layer ORDER BY layer",
    )
    log.info(
        "Lineage graph: %d nodes, %d edges, %d column dependencies.",
        stats["nodes"], stats["edges"], stats["columns"],
    )
    for row in by_layer:
        log.info("    layer %-12s %3d nodes", row["layer"], row["n"])
    return stats
