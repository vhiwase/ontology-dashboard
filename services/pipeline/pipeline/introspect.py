"""Stage 3a - read the semantic views out of information_schema.

The views in tms_views are the contract. This module turns each of them into a
structured description - key column, title column, and a typed, role-classified
property list - which stages 3b/3c turn into ontology object types and link
types.

The classification is the interesting part. A column's SQL type tells you it is a
numeric; it does not tell you whether summing it means anything. `gross_weight_kg`
sums; `latitude` does not; `status_code` is an identifier that happens to be an
integer. Getting that wrong is how an assistant ends up charting the average of a
primary key, so the rules below are explicit and ordered.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any

import psycopg

from .config import CONFIG
from .db import query

log = logging.getLogger("pipeline.introspect")

# ── SQL type -> ontograph DataType (see vendor/ontograph-core/src/types.ts) ──
TYPE_MAP = {
    "uuid": "string",
    "text": "string",
    "character varying": "string",
    "character": "string",
    "name": "string",
    "smallint": "integer",
    "integer": "integer",
    "bigint": "integer",
    "numeric": "decimal",
    "real": "float",
    "double precision": "float",
    "boolean": "boolean",
    "date": "date",
    "timestamp with time zone": "datetime",
    "timestamp without time zone": "datetime",
    "time with time zone": "string",
    "time without time zone": "string",
    "interval": "duration",
    "json": "object",
    "jsonb": "object",
    "ARRAY": "array",
}

# Columns that describe where a value came from rather than the business fact.
PROVENANCE_COLUMNS = {"data_origin", "charge_origin", "execution_origin", "distance_origin"}
PROVENANCE_SUFFIXES = ("_is_inferred", "_origin")

# Measure detection. Ordered: the first pattern that matches wins, so
# `*_count` beats the generic numeric fallback.
MEASURE_PATTERNS: list[tuple[str, str, str | None]] = [
    # (regex on column name, default aggregation, unit)
    (r"_count$|^count$", "sum", None),
    (r"_pct$|_percentage$|_rate_pct$|_share_pct$", "avg", "%"),
    (r"_kg$", "sum", "kg"),
    (r"_km$", "sum", "km"),
    (r"_m3$", "sum", "m3"),
    (r"_cm$", "avg", "cm"),
    (r"_hours$|_hour$", "avg", "h"),
    (r"_days$|_day$", "avg", "d"),
    (r"_minutes$", "avg", "min"),
    (r"^revenue$|^cost$|_charge$|_cost$|_amount$|_spend$|^gross_margin$", "sum", "USD"),
    (r"_per_kg$|_per_km$|_per_shipment$|_per_load$|_per_load$", "avg", "USD"),
    (r"^quantity$|^piece_count$|^units$", "sum", None),
    (r"^declared_value$|^cod_amount$|^total_charge$", "sum", "USD"),
]

# Numeric columns that must never be treated as measures.
NON_MEASURE_NUMERIC = re.compile(
    r"(^|_)(latitude|longitude|code|bitmask|seq|version|leg_number|"
    r"status_code|event_type_code|shape_code|order_type_code)$"
)

TEMPORAL_HINT = re.compile(r"(_at|_date|_week|_month|_time)$|^(pickup|delivery)_date$")
GEO_HINT = re.compile(r"^(latitude|longitude)$")


def humanize(identifier: str) -> str:
    """order_number -> Order Number; keeps known acronyms upper-case."""
    acronyms = {
        "id": "ID", "kg": "kg", "km": "km", "m3": "m3", "cm": "cm", "pct": "%",
        "usd": "USD", "scac": "SCAC", "nmfc": "NMFC", "bol": "BOL", "pro": "PRO",
        "cod": "COD", "iso2": "ISO2", "pod": "POD", "edi": "EDI", "kpi": "KPI",
        "ltl": "LTL", "tl": "TL",
    }
    words = [w for w in identifier.split("_") if w]
    out = []
    for word in words:
        lower = word.lower()
        if lower in acronyms:
            out.append(acronyms[lower])
        else:
            out.append(word[:1].upper() + word[1:])
    return " ".join(out)


def pascal_case(identifier: str) -> str:
    return "".join(w[:1].upper() + w[1:] for w in identifier.split("_") if w)


def camel_case(identifier: str) -> str:
    text = pascal_case(identifier)
    return text[:1].lower() + text[1:] if text else text


# Irregular plurals the naive rule would get wrong.
IRREGULAR_PLURALS = {
    "Party": "Parties",
    "Facility": "Facilities",
    "Delivery": "Deliveries",
    "Company": "Companies",
}


def pluralize(name: str) -> str:
    if name in IRREGULAR_PLURALS:
        return IRREGULAR_PLURALS[name]
    if name.endswith("y") and len(name) > 1 and name[-2].lower() not in "aeiou":
        return name[:-1] + "ies"
    if name.endswith(("s", "x", "z", "ch", "sh")):
        return name + "es"
    return name + "s"


@dataclass
class PropertyInfo:
    name: str
    label: str
    datatype: str
    sql_type: str
    is_nullable: bool
    ordinal: int
    semantic_role: str = "attribute"
    default_aggregation: str | None = None
    unit: str | None = None
    is_identity: bool = False
    is_title: bool = False
    is_foreign_key: bool = False
    description: str | None = None


@dataclass
class ViewInfo:
    view_name: str            # v_order
    qualified: str            # tms_views.v_order
    base_name: str            # order
    is_metric: bool           # v_kpi_* views describe metrics, not objects
    comment: str | None
    properties: list[PropertyInfo] = field(default_factory=list)
    key_column: str | None = None
    title_column: str | None = None
    row_count: int = 0

    @property
    def api_name(self) -> str:
        return pascal_case(self.base_name)

    @property
    def foreign_keys(self) -> list[PropertyInfo]:
        return [p for p in self.properties if p.is_foreign_key]

    @property
    def measures(self) -> list[PropertyInfo]:
        return [p for p in self.properties if p.semantic_role == "measure"]

    @property
    def dimensions(self) -> list[PropertyInfo]:
        return [p for p in self.properties if p.semantic_role in ("dimension", "flag")]

    @property
    def temporals(self) -> list[PropertyInfo]:
        return [p for p in self.properties if p.semantic_role == "temporal"]


def classify(column_name: str, datatype: str, view: ViewInfo) -> tuple[str, str | None, str | None]:
    """Return (semantic_role, default_aggregation, unit) for one column.

    Order matters; the first rule that fires wins.
    """
    name = column_name.lower()

    if name == view.key_column:
        return "identity", None, None
    if name == "title_property":
        return "title", None, None
    if name in PROVENANCE_COLUMNS or name.endswith(PROVENANCE_SUFFIXES):
        return "provenance", None, None
    if GEO_HINT.match(name):
        return "geo", None, "deg"
    if datatype == "boolean":
        return "flag", None, None
    if datatype in ("datetime", "date"):
        return "temporal", None, None
    if TEMPORAL_HINT.search(name) and datatype in ("datetime", "date", "string"):
        return "temporal", None, None
    # A trailing _key that is not this view's own key is a reference to another
    # object, so it is a dimension you group by, never something you sum.
    if name.endswith("_key"):
        return "dimension", None, None
    if datatype in ("integer", "decimal", "float"):
        if NON_MEASURE_NUMERIC.search(name):
            return "dimension", None, None
        for pattern, aggregation, unit in MEASURE_PATTERNS:
            if re.search(pattern, name):
                return "measure", aggregation, unit
        return "measure", "sum", None
    if datatype == "duration":
        return "measure", "avg", None
    if datatype == "array":
        return "attribute", None, None
    return "dimension", None, None


def _resolve_key_column(view_name: str, base_name: str, columns: list[str]) -> str | None:
    """Find the view's own primary key.

    Convention is <base_name>_key, e.g. v_order -> order_key. Falling back to the
    first _key column would silently pick a foreign key and produce an object type
    keyed on the wrong thing, so the fallback is narrow and loud.
    """
    preferred = f"{base_name}_key"
    if preferred in columns:
        return preferred
    key_columns = [c for c in columns if c.endswith("_key")]
    if len(key_columns) == 1:
        return key_columns[0]
    log.warning(
        "%s has no %s column and %d candidate _key columns (%s); "
        "it will be registered without an identity property.",
        view_name, preferred, len(key_columns), ", ".join(key_columns) or "none",
    )
    return None


def introspect_views(conn: psycopg.Connection) -> list[ViewInfo]:
    """Describe every v_* view in the semantic schema."""
    view_rows = query(
        conn,
        """
        SELECT c.relname AS view_name,
               obj_description(c.oid, 'pg_class') AS comment
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = %s AND c.relkind IN ('v', 'm')
          AND c.relname LIKE 'v\\_%%'
        ORDER BY c.relname
        """,
        (CONFIG.view_schema,),
    )

    column_rows = query(
        conn,
        """
        SELECT table_name, column_name, data_type, udt_name, is_nullable, ordinal_position
        FROM information_schema.columns
        WHERE table_schema = %s
        ORDER BY table_name, ordinal_position
        """,
        (CONFIG.view_schema,),
    )
    columns_by_view: dict[str, list[dict]] = {}
    for row in column_rows:
        columns_by_view.setdefault(row["table_name"], []).append(row)

    views: list[ViewInfo] = []
    for row in view_rows:
        view_name = row["view_name"]
        is_metric = view_name.startswith("v_kpi_")
        base_name = view_name[len("v_kpi_"):] if is_metric else view_name[len("v_"):]
        columns = columns_by_view.get(view_name, [])
        column_names = [c["column_name"] for c in columns]

        view = ViewInfo(
            view_name=view_name,
            qualified=f"{CONFIG.view_schema}.{view_name}",
            base_name=base_name,
            is_metric=is_metric,
            comment=row["comment"],
        )
        if not is_metric:
            view.key_column = _resolve_key_column(view_name, base_name, column_names)
            view.title_column = "title_property" if "title_property" in column_names else None

        for column in columns:
            name = column["column_name"]
            sql_type = column["data_type"]
            datatype = TYPE_MAP.get(sql_type)
            if datatype is None:
                # ARRAY arrives as data_type='ARRAY' with the element type in
                # udt_name; anything else unmapped degrades to string rather
                # than dropping the column.
                datatype = TYPE_MAP.get(column["udt_name"], "string")
            role, aggregation, unit = classify(name, datatype, view)
            view.properties.append(
                PropertyInfo(
                    name=name,
                    label=humanize(name),
                    datatype=datatype,
                    sql_type=sql_type,
                    is_nullable=(column["is_nullable"] == "YES"),
                    ordinal=column["ordinal_position"],
                    semantic_role=role,
                    default_aggregation=aggregation,
                    unit=unit,
                    is_identity=(role == "identity"),
                    is_title=(role == "title"),
                    is_foreign_key=(
                        name.endswith("_key") and name != view.key_column and not is_metric
                    ),
                )
            )
        views.append(view)

    # Row counts drive the explorer's object-type list, so they are read once
    # here rather than on every UI request.
    for view in views:
        try:
            view.row_count = int(
                query(conn, f'SELECT count(*) AS n FROM {CONFIG.view_schema}."{view.view_name}"')[0]["n"]
            )
        except psycopg.Error as exc:
            log.warning("Could not count %s: %s", view.qualified, exc)
            conn.rollback()

    objects = [v for v in views if not v.is_metric]
    metrics = [v for v in views if v.is_metric]
    log.info(
        "Introspected %d object views and %d metric views (%d columns total).",
        len(objects), len(metrics), sum(len(v.properties) for v in views),
    )
    return views
