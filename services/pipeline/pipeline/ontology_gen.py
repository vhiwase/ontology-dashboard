"""Stage 3e - assemble the ontology and write the registry.

Produces one OntologyDefinition document in exactly the shape
vendor/ontograph-core consumes (src/types.ts), and shreds the same content into
the platform.* tables so the UI and the assistant can query it without parsing a
300 KB blob per request. Both are written in one transaction so they cannot drift.

Two modelling decisions worth stating plainly:

ATTRIBUTE SHARING. ontograph keeps attributes in one flat global list that entity
types reference by id. Naming every attribute per type (tms:Order.city,
tms:Location.city) would be trivially correct but throws away the fact that they
are the same concept. So an attribute is shared under a plain id (tms:city) when
every view that exposes that column agrees on the datatype, and only falls back
to a type-qualified id when they genuinely disagree. The split is reported so the
choice is visible rather than silent.

BIDIRECTIONAL RELATIONS. Every discovered link produces two RelationTypes - the
forward reference and its inverse - because a graph you can only walk one way is
not much use for exploration, and because ontograph's validator requires both
ends of a relation to resolve to a declared type.
"""

from __future__ import annotations

import json
import logging
from collections import defaultdict
from typing import Any

import psycopg

from .actions import ACTIONS, ROLES, action_types_for_ontology, register_actions
from .config import CONFIG
from .db import execute, query, query_one, space_id, upsert_many
from .replay import replay_edits
from .introspect import PropertyInfo, ViewInfo, camel_case, humanize, pluralize
from .relationships import DiscoveryResult, LinkCandidate

log = logging.getLogger("pipeline.ontology")

NS = CONFIG.ontology_namespace

# Presentation metadata per object type. Auto-generating a colour per type gives
# a graph nobody can read, so the palette is assigned by domain: demand in
# amber, execution in blue, parties in green, reference data in grey.
UI_HINTS: dict[str, dict[str, str]] = {
    "Order":              {"color": "#E8A33D", "icon": "clipboard-list", "group": "Demand"},
    "Shipment":           {"color": "#D98324", "icon": "package",        "group": "Demand"},
    "HandlingUnit":       {"color": "#C06C24", "icon": "box",            "group": "Demand"},
    "Transport":          {"color": "#3D7FE8", "icon": "truck",          "group": "Execution"},
    "TransportLeg":       {"color": "#5590E8", "icon": "route",          "group": "Execution"},
    "TransportStop":      {"color": "#6BA3E8", "icon": "map-pin",        "group": "Execution"},
    "StopEvent":          {"color": "#84B6EA", "icon": "clock",          "group": "Execution"},
    "BusinessEntity":     {"color": "#3E9A6D", "icon": "building",       "group": "Party"},
    "Location":           {"color": "#4CAF7D", "icon": "warehouse",      "group": "Party"},
    "Carrier":            {"color": "#2E8B57", "icon": "truck-loading",  "group": "Party"},
    "Customer":           {"color": "#5EBD8E", "icon": "users",          "group": "Party"},
    "Supplier":           {"color": "#6FC79C", "icon": "factory",        "group": "Party"},
    "BillTo":             {"color": "#7FD1AB", "icon": "receipt",        "group": "Party"},
    "Broker":             {"color": "#8FDAB9", "icon": "handshake",      "group": "Party"},
    "Agent":              {"color": "#9FE3C6", "icon": "user-tie",       "group": "Party"},
    "Account":            {"color": "#2F7D5B", "icon": "briefcase",      "group": "Party"},
    "Tenant":             {"color": "#1F5C42", "icon": "building-shield","group": "Party"},
    "EntityRelationship": {"color": "#8C8C8C", "icon": "sitemap",        "group": "Structure"},
    "TransportationMode": {"color": "#7A7A7A", "icon": "shuffle",        "group": "Reference"},
    "UnitOfMeasure":      {"color": "#6E6E6E", "icon": "ruler",          "group": "Reference"},
}

# Object types that read as business events rather than things. ontograph keeps
# these in eventTypes, which lets the UI lay out a timeline separately from the
# entity graph.
EVENT_TYPES = {"StopEvent"}

DISPLAY_ORDER = {
    "Order": 10, "Shipment": 20, "Transport": 30, "TransportStop": 40,
    "StopEvent": 50, "TransportLeg": 60, "HandlingUnit": 70,
    "Account": 100, "Location": 110, "Carrier": 120, "Customer": 130,
    "BillTo": 140, "Supplier": 150, "Broker": 160, "Agent": 170,
    "BusinessEntity": 180, "Tenant": 190,
    "EntityRelationship": 300, "TransportationMode": 310, "UnitOfMeasure": 320,
}

# Human-written descriptions. The view COMMENT is used where present; this fills
# the gap for the role projections, which share one comment upstream.
TYPE_DESCRIPTIONS = {
    "Location": "A physical facility: distribution centre, terminal, plant or yard.",
    "Carrier": "A party that moves freight, asset-based or brokered.",
    "Customer": "A consignee or ship-to party.",
    "Supplier": "A goods supplier or vendor.",
    "BillTo": "The party invoiced for freight charges.",
    "Broker": "A freight broker arranging capacity.",
    "Agent": "A freight agent acting for the tenant.",
    "Account": "A shipper account the 3PL transacts on behalf of.",
    "Tenant": "The 3PL operating this TMS instance.",
    "TransportLeg": "One origin-to-destination hop within a transport.",
    "TransportStop": "A scheduled call at a facility, with its planned window and actuals.",
    "StopEvent": "A pickup or delivery of a specific shipment at a stop.",
    "HandlingUnit": "The physical freight: a pallet, crate or drum with its dimensions and weight.",
    "TransportationMode": "How freight moves: truckload, LTL, rail, air, ocean, intermodal.",
    "UnitOfMeasure": "A configured unit for length, mass or volume.",
    "EntityRelationship": "A declared parent-child association between two parties.",
}


# ── Interfaces: shared shape across otherwise unrelated types ───────────────
def _interfaces(objects: list[ViewInfo], attribute_of) -> list[dict[str, Any]]:
    """Declare the shapes several object types genuinely share.

    Only interfaces whose every required attribute really does exist on every
    implementor are emitted; an interface nothing satisfies is noise.
    """
    interfaces: list[dict[str, Any]] = []

    geo_attrs = ["latitude", "longitude", "city", "province_state", "country"]
    if all(attribute_of("Location", a) for a in geo_attrs):
        interfaces.append(
            {
                "@id": f"{NS}:Geolocatable",
                "@type": "Interface",
                "label": {"en": "Geolocatable"},
                "description": {
                    "en": "Anything that can be placed on a map: has coordinates and an address."
                },
                "requiredAttributes": [
                    {"ref": attribute_of("Location", a), "required": False} for a in geo_attrs
                ],
            }
        )

    party_attrs = ["entity_name", "is_active", "tenant_key"]
    if all(attribute_of("BusinessEntity", a) for a in party_attrs):
        interfaces.append(
            {
                "@id": f"{NS}:Party",
                "@type": "Interface",
                "label": {"en": "Party"},
                "description": {
                    "en": (
                        "A counterparty in the transport network. The TMS keeps one "
                        "party master and projects it per role, so every role type "
                        "implements this."
                    )
                },
                "requiredAttributes": [
                    {"ref": attribute_of("BusinessEntity", a), "required": a != "tenant_key"}
                    for a in party_attrs
                ],
            }
        )

    if attribute_of("Order", "data_origin"):
        interfaces.append(
            {
                "@id": f"{NS}:ProvenanceTracked",
                "@type": "Interface",
                "label": {"en": "Provenance Tracked"},
                "description": {
                    "en": (
                        "Carries a data_origin property saying whether the row came "
                        "from the captured TMS payloads or from the execution "
                        "simulation. Everything in this ontology implements it."
                    )
                },
                "requiredAttributes": [
                    {"ref": attribute_of("Order", "data_origin"), "required": True}
                ],
            }
        )

    return interfaces


PARTY_ROLE_TYPES = {"Location", "Carrier", "Customer", "Supplier", "BillTo", "Broker", "Agent"}


def _constraints(objects: list[ViewInfo]) -> list[dict[str, Any]]:
    """Business rules worth asserting, written as structured expressions.

    Structured Expr rather than rule strings so ontograph's evaluator can
    actually check them instead of the constraint being a comment.
    """
    available = {v.api_name for v in objects}
    out: list[dict[str, Any]] = []

    def add(cid: str, on: str, label: str, message: str, expr: dict, severity: str = "error") -> None:
        if on.split(":", 1)[1] in available:
            out.append(
                {
                    "@id": cid,
                    "@type": "Constraint",
                    "label": {"en": label},
                    "on": on,
                    "rule": json.dumps(expr),
                    "expr": expr,
                    "message": {"en": message},
                    "severity": severity,
                }
            )

    add(
        f"{NS}:OrderMustHaveNumber", f"{NS}:Order",
        "Order number present",
        "Every order must carry an order number; it is the only identifier a customer quotes.",
        {"type": "compare", "op": "neq",
         "left": {"type": "property", "path": "orderNumber"},
         "right": {"type": "literal", "value": None}},
    )
    add(
        f"{NS}:OrderDeliveryAfterPickup", f"{NS}:Order",
        "Delivery window after pickup",
        "The delivery window cannot close before the pickup window opens.",
        {"type": "compare", "op": "gt",
         "left": {"type": "property", "path": "deliveryCloseAt"},
         "right": {"type": "property", "path": "pickupReadyAt"}},
    )
    add(
        f"{NS}:ShipmentChargeNotNegative", f"{NS}:Shipment",
        "Charge not negative",
        "A freight charge below zero is a credit note, not a shipment charge.",
        {"type": "compare", "op": "gte",
         "left": {"type": "property", "path": "totalCharge"},
         "right": {"type": "literal", "value": 0}},
    )
    add(
        f"{NS}:InvoicedShipmentMustBeRated", f"{NS}:Shipment",
        "Invoiced shipments are rated",
        "A shipment cannot be invoiced while it carries no charge.",
        {"type": "logical", "op": "or", "operands": [
            {"type": "compare", "op": "eq",
             "left": {"type": "property", "path": "isInvoiced"},
             "right": {"type": "literal", "value": False}},
            {"type": "compare", "op": "gt",
             "left": {"type": "property", "path": "totalCharge"},
             "right": {"type": "literal", "value": 0}},
        ]},
    )
    add(
        f"{NS}:TransportEndAfterStart", f"{NS}:Transport",
        "Arrival after departure",
        "A transport cannot finish before it started.",
        {"type": "compare", "op": "gte",
         "left": {"type": "property", "path": "actualEndAt"},
         "right": {"type": "property", "path": "actualStartAt"}},
    )
    add(
        f"{NS}:TransportNeedsCarrierOnceMoving", f"{NS}:Transport",
        "Moving transports have a carrier",
        "A transport that has physically departed must have a carrier assigned.",
        {"type": "logical", "op": "or", "operands": [
            {"type": "compare", "op": "eq",
             "left": {"type": "property", "path": "actualStartAt"},
             "right": {"type": "literal", "value": None}},
            {"type": "compare", "op": "neq",
             "left": {"type": "property", "path": "carrierKey"},
             "right": {"type": "literal", "value": None}},
        ]},
        severity="warning",
    )
    add(
        f"{NS}:StopWindowOrdered", f"{NS}:TransportStop",
        "Arrival window ordered",
        "The arrival window must open before it closes.",
        {"type": "compare", "op": "lte",
         "left": {"type": "property", "path": "plannedArrivalFrom"},
         "right": {"type": "property", "path": "plannedArrivalTo"}},
    )
    add(
        f"{NS}:HandlingUnitPositiveWeight", f"{NS}:HandlingUnit",
        "Weight recorded",
        "A handling unit with no weight cannot be rated or loaded.",
        {"type": "compare", "op": "gt",
         "left": {"type": "property", "path": "weightKg"},
         "right": {"type": "literal", "value": 0}},
        severity="warning",
    )
    return out


def _logic_rules(objects: list[ViewInfo]) -> list[dict[str, Any]]:
    """Automated reasoning rules: the alerts an operations team wants raised."""
    available = {v.api_name for v in objects}
    rules: list[dict[str, Any]] = []

    if "Transport" in available:
        rules.append(
            {
                "@id": f"{NS}:LateArrivalAlertRule",
                "@type": "LogicRule",
                "label": {"en": "Late arrival alert"},
                "description": {
                    "en": "Raise an alert when a transport's worst stop is more than an hour late."
                },
                "category": "trigger",
                "trigger": {
                    "mode": "on_change",
                    "targetTypes": [f"{NS}:Transport"],
                    "watchedAttributes": ["worstArrivalVarianceMinutes"],
                    "priority": 100,
                },
                "condition": {
                    "language": "typescript",
                    "body": "obj.worstArrivalVarianceMinutes > 60",
                    "expr": {
                        "type": "compare", "op": "gt",
                        "left": {"type": "property", "path": "worstArrivalVarianceMinutes"},
                        "right": {"type": "literal", "value": 60},
                    },
                },
                "action": {
                    "language": "natural",
                    "body": "Notify the operations manager and flag the transport for service review.",
                },
                "enabled": True,
                "tags": ["service", "alert"],
            }
        )
    if "Order" in available:
        rules.append(
            {
                "@id": f"{NS}:UnplannedOrderEscalationRule",
                "@type": "LogicRule",
                "label": {"en": "Unplanned order escalation"},
                "description": {
                    "en": "An order still unplanned inside its pickup window needs a dispatcher now."
                },
                "category": "trigger",
                "trigger": {
                    "mode": "scheduled",
                    "targetTypes": [f"{NS}:Order"],
                    "cronExpression": "0 */2 * * *",
                    "priority": 90,
                },
                "condition": {
                    "language": "typescript",
                    "body": "obj.isUnplanned === true",
                    "expr": {
                        "type": "compare", "op": "eq",
                        "left": {"type": "property", "path": "isUnplanned"},
                        "right": {"type": "literal", "value": True},
                    },
                },
                "action": {"language": "natural", "body": "Escalate to the dispatch queue."},
                "enabled": True,
                "tags": ["planning", "alert"],
            }
        )
    if "Shipment" in available:
        rules.append(
            {
                "@id": f"{NS}:UnratedDeliveredShipmentRule",
                "@type": "LogicRule",
                "label": {"en": "Unrated shipment revenue leak"},
                "description": {
                    "en": "A shipment that has no charge is revenue we will never bill."
                },
                "category": "validation",
                "trigger": {
                    "mode": "on_change",
                    "targetTypes": [f"{NS}:Shipment"],
                    "watchedAttributes": ["chargeOrigin", "statusCode"],
                    "priority": 80,
                },
                "condition": {
                    "language": "typescript",
                    "body": "obj.chargeOrigin === 'unrated'",
                    "expr": {
                        "type": "compare", "op": "eq",
                        "left": {"type": "property", "path": "chargeOrigin"},
                        "right": {"type": "literal", "value": "unrated"},
                    },
                },
                "action": {"language": "natural", "body": "Add to the finance rating worklist."},
                "enabled": True,
                "tags": ["finance", "data-quality"],
            }
        )
    return rules


class OntologyBuilder:
    def __init__(self, conn: psycopg.Connection, views: list[ViewInfo], discovery: DiscoveryResult):
        self.conn = conn
        self.views = views
        self.objects = [v for v in views if not v.is_metric and v.key_column]
        self.metrics = [v for v in views if v.is_metric]
        self.discovery = discovery

        # column name -> attribute @id, once resolved
        self.shared_attributes: dict[str, str] = {}
        self.qualified_attributes: dict[tuple[str, str], str] = {}
        self.attribute_definitions: dict[str, dict[str, Any]] = {}
        self.conflicted_columns: set[str] = set()

    # ── attributes ────────────────────────────────────────────────────────

    def attribute_id(self, object_api_name: str, column: str) -> str | None:
        if (object_api_name, column) in self.qualified_attributes:
            return self.qualified_attributes[(object_api_name, column)]
        return self.shared_attributes.get(column)

    def build_attributes(self) -> None:
        """Decide which attributes are shared and which must be type-qualified."""
        by_column: dict[str, set[str]] = defaultdict(set)
        occurrences: dict[str, list[tuple[ViewInfo, PropertyInfo]]] = defaultdict(list)
        for view in self.objects:
            for prop in view.properties:
                by_column[prop.name].add(prop.datatype)
                occurrences[prop.name].append((view, prop))

        for column, datatypes in by_column.items():
            if len(datatypes) == 1:
                attribute_id = f"{NS}:{camel_case(column)}"
                self.shared_attributes[column] = attribute_id
                view, prop = occurrences[column][0]
                self.attribute_definitions[attribute_id] = self._attribute_document(
                    attribute_id, prop, shared_by=len(occurrences[column])
                )
            else:
                # Genuine disagreement: the same column name means different
                # things in different views, so each gets its own attribute.
                self.conflicted_columns.add(column)
                for view, prop in occurrences[column]:
                    attribute_id = f"{NS}:{view.api_name}_{camel_case(column)}"
                    self.qualified_attributes[(view.api_name, column)] = attribute_id
                    self.attribute_definitions[attribute_id] = self._attribute_document(
                        attribute_id, prop, shared_by=1, qualified_for=view.api_name
                    )

        if self.conflicted_columns:
            log.info(
                "%d column names carry different datatypes across views and were "
                "type-qualified rather than shared: %s",
                len(self.conflicted_columns), ", ".join(sorted(self.conflicted_columns)),
            )
        log.info(
            "Built %d attribute definitions (%d shared across types, %d type-qualified).",
            len(self.attribute_definitions), len(self.shared_attributes),
            len(self.qualified_attributes),
        )

    def _attribute_document(
        self, attribute_id: str, prop: PropertyInfo, shared_by: int, qualified_for: str | None = None
    ) -> dict[str, Any]:
        document: dict[str, Any] = {
            "@id": attribute_id,
            "@type": "Attribute",
            "label": {"en": prop.label},
            "datatype": prop.datatype,
        }
        notes = []
        if prop.unit:
            notes.append(f"Unit: {prop.unit}.")
        if prop.semantic_role == "measure":
            notes.append(f"Aggregate with {prop.default_aggregation}.")
        if prop.semantic_role == "provenance":
            notes.append("Provenance, not a business fact: says where the value came from.")
        if qualified_for:
            notes.append(f"Specific to {qualified_for}; the name is reused with a different type elsewhere.")
        elif shared_by > 1:
            notes.append(f"Shared by {shared_by} object types.")
        if notes:
            document["description"] = {"en": " ".join(notes)}
        if prop.is_identity:
            document["identity"] = True
            document["required"] = True
        return document

    # ── relations ─────────────────────────────────────────────────────────

    def build_relations(self) -> tuple[list[dict[str, Any]], dict[str, list[str]]]:
        """Forward and inverse RelationTypes, plus which type owns which."""
        relations: list[dict[str, Any]] = []
        owned: dict[str, list[str]] = defaultdict(list)

        for link in self.discovery.links:
            source = f"{NS}:{link.source_view.api_name}"
            target = f"{NS}:{link.target_view.api_name}"
            forward_id = f"{NS}:{link.api_name}"          # type: ignore[attr-defined]
            inverse_id = f"{NS}:{link.inverse_api_name}"  # type: ignore[attr-defined]

            relations.append(
                {
                    "@id": forward_id,
                    "@type": "RelationType",
                    "label": {"en": link.label},           # type: ignore[attr-defined]
                    "description": {"en": link.description},  # type: ignore[attr-defined]
                    "domain": source,
                    "range": target,
                    "min": 0,
                    "max": 1,
                    "inverse": inverse_id,
                }
            )
            relations.append(
                {
                    "@id": inverse_id,
                    "@type": "RelationType",
                    "label": {"en": link.inverse_label},   # type: ignore[attr-defined]
                    "description": {
                        "en": (
                            f"Inverse of {link.label}: the "  # type: ignore[attr-defined]
                            f"{pluralize(humanize(link.source_view.base_name)).lower()} "
                            f"that reference this {humanize(link.target_view.base_name).lower()}."
                        )
                    },
                    "domain": target,
                    "range": source,
                    "min": 0,
                    "max": None,
                    "inverse": forward_id,
                }
            )
            owned[source].append(forward_id)
            owned[target].append(inverse_id)

        return relations, owned

    # ── entity types ──────────────────────────────────────────────────────

    def build_entity_types(
        self, owned_relations: dict[str, list[str]]
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        entity_types: list[dict[str, Any]] = []
        event_types: list[dict[str, Any]] = []

        for view in sorted(self.objects, key=lambda v: DISPLAY_ORDER.get(v.api_name, 500)):
            api_name = view.api_name
            type_id = f"{NS}:{api_name}"
            kind = "event" if api_name in EVENT_TYPES else "entity"

            attribute_refs = []
            for prop in view.properties:
                attribute_id = self.attribute_id(api_name, prop.name)
                if attribute_id is None:
                    continue
                ref: dict[str, Any] = {"ref": attribute_id}
                if prop.is_identity:
                    ref["identity"] = True
                    ref["required"] = True
                elif not prop.is_nullable:
                    ref["required"] = True
                attribute_refs.append(ref)

            implements = []
            if api_name in PARTY_ROLE_TYPES or api_name in ("BusinessEntity", "Account", "Tenant"):
                implements.append(f"{NS}:Party")
            if any(p.name == "latitude" for p in view.properties):
                implements.append(f"{NS}:Geolocatable")
            if any(p.name == "data_origin" for p in view.properties):
                implements.append(f"{NS}:ProvenanceTracked")

            document: dict[str, Any] = {
                "@id": type_id,
                "@type": "EntityType",
                "label": {"en": humanize(view.base_name)},
                "description": {
                    "en": TYPE_DESCRIPTIONS.get(api_name) or view.comment
                    or f"Generated from {view.qualified}."
                },
                "kind": kind,
                "attributes": attribute_refs,
                "relations": [{"ref": r} for r in sorted(set(owned_relations.get(type_id, [])))],
                "constraints": [],
                "ui": {
                    **UI_HINTS.get(api_name, {"color": "#8C8C8C", "icon": "circle", "group": "Other"}),
                    "visible": True,
                },
            }
            if implements:
                document["implements"] = implements

            (event_types if kind == "event" else entity_types).append(document)

        return entity_types, event_types

    # ── value types from the reference tables ─────────────────────────────

    def build_value_types(self) -> list[dict[str, Any]]:
        """Turn the enum decode tables into ValueTypes.

        Read from the database rather than hard-coded, so adding a status code to
        tms_raw.ref_shipment_status is enough to have it appear in the ontology.
        """
        sources = [
            ("ShipmentStatus", "ref_shipment_status", "Lifecycle status of a shipment."),
            ("TransportStatus", "ref_transport_status", "Lifecycle status of a transport."),
            ("OrderStatus", "ref_order_status", "Lifecycle status of an order."),
            ("OrderType", "ref_order_type", "Whether the order is a pickup or a delivery."),
            ("EntityRole", "ref_entity_type", "The roles a party can hold."),
            ("AssociationType", "ref_association", "How two parties are associated."),
            ("Country", "ref_country", "Countries the network operates in."),
            ("HandlingUnitShape", "ref_shape", "Geometry of a handling unit."),
            ("StopEventType", "ref_stop_event_type", "Pickup or delivery."),
        ]
        value_types: list[dict[str, Any]] = []
        for api_name, table, description in sources:
            try:
                rows = query(
                    self.conn,
                    f"SELECT name FROM {CONFIG.raw_schema}.{table} ORDER BY code",
                )
            except psycopg.Error:
                self.conn.rollback()
                continue
            values = [r["name"] for r in rows if r["name"]]
            if not values:
                continue
            value_types.append(
                {
                    "@id": f"{NS}:{api_name}",
                    "@type": "ValueType",
                    "label": {"en": humanize(api_name)},
                    "values": values,
                }
            )
        return value_types

    # ── datasource + object mappings ──────────────────────────────────────

    def build_datasource(self) -> list[dict[str, Any]]:
        return [
            {
                "@id": f"{NS}:TmsPostgres",
                "@type": "Datasource",
                "label": {"en": "TMS Semantic Views (Postgres)"},
                "description": {
                    "en": (
                        "The tms_views schema. Every object type in this ontology is "
                        "backed by exactly one view here, and every view was built "
                        "from the captured TMS REST payloads landed in tms_raw."
                    )
                },
                "type": "postgresql",
                "connection": {
                    # The connection string is never written into the ontology
                    # document: only the name of the variable that holds it.
                    "urlEnvVar": "DATABASE_URL",
                    "options": {"schema": CONFIG.view_schema},
                },
                "sync": {
                    "mode": "batch",
                    "fullSync": True,
                    "batchSize": 500,
                },
            }
        ]

    def build_object_mappings(self) -> list[dict[str, Any]]:
        mappings: list[dict[str, Any]] = []
        for view in self.objects:
            api_name = view.api_name
            key_prop = next((p for p in view.properties if p.is_identity), None)
            title_prop = next((p for p in view.properties if p.is_title), None)
            if key_prop is None:
                continue

            field_mappings = []
            for prop in view.properties:
                attribute_id = self.attribute_id(api_name, prop.name)
                if attribute_id is None or prop.is_identity:
                    continue
                field_mappings.append(
                    {
                        "sourceField": prop.name,
                        "targetAttribute": attribute_id,
                        "transform": "identity",
                    }
                )

            link_mappings = []
            for link in self.discovery.links:
                if link.source_view.view_name != view.view_name:
                    continue
                link_mappings.append(
                    {
                        "relationTypeRef": f"{NS}:{link.api_name}",  # type: ignore[attr-defined]
                        "sourceField": link.source_column,
                        "targetTable": link.target_view.qualified,
                        "targetField": link.target_column,
                        "joinType": "left",
                    }
                )

            mappings.append(
                {
                    "objectTypeRef": f"{NS}:{api_name}",
                    "datasourceRef": f"{NS}:TmsPostgres",
                    "primaryKeyMapping": {
                        "sourceField": key_prop.name,
                        "targetAttribute": self.attribute_id(api_name, key_prop.name),
                        "transform": "identity",
                    },
                    "titleMapping": (
                        {
                            "sourceField": title_prop.name,
                            "targetAttribute": self.attribute_id(api_name, title_prop.name),
                            "transform": "identity",
                        }
                        if title_prop
                        else None
                    ),
                    "fieldMappings": field_mappings,
                    "linkMappings": link_mappings,
                    "conflictStrategy": "datasource_wins",
                    "enabled": True,
                }
            )
        return mappings

    # ── graph views ───────────────────────────────────────────────────────

    def build_views(self) -> list[dict[str, Any]]:
        """Saved graph layouts for the explorer, one per way of reading the network."""
        return [
            {
                "@id": f"{NS}:OrderToCashView",
                "@type": "View",
                "label": {"en": "Order to Cash"},
                "forType": f"{NS}:Order",
                "layout": "hierarchical",
                "filter": [],
                "highlight": [
                    {"condition": "isUnplanned == true", "style": {"color": "#D9534F", "size": 2}},
                    {"condition": "isInvoiced == true", "style": {"color": "#4CAF7D"}},
                ],
            },
            {
                "@id": f"{NS}:ExecutionChainView",
                "@type": "View",
                "label": {"en": "Execution Chain"},
                "forType": f"{NS}:Transport",
                "layout": "hierarchical",
                "filter": [],
                "highlight": [
                    {"condition": "isOnTime == false", "style": {"color": "#D9534F", "size": 2}},
                ],
            },
            {
                "@id": f"{NS}:PartyNetworkView",
                "@type": "View",
                "label": {"en": "Party Network"},
                "forType": f"{NS}:BusinessEntity",
                "layout": "force",
                "filter": [{"type": "entity", "property": "isActive", "operator": "eq", "value": True}],
                "highlight": [
                    {"condition": "isCarrier == true", "style": {"color": "#2E8B57"}},
                ],
            },
        ]

    # ── assemble ──────────────────────────────────────────────────────────

    def build(self) -> dict[str, Any]:
        self.build_attributes()
        relations, owned = self.build_relations()
        entity_types, event_types = self.build_entity_types(owned)

        constraints = _constraints(self.objects)
        # Attach each constraint to the type it guards so the UI can show it in
        # context rather than only in a flat list.
        by_type: dict[str, list[str]] = defaultdict(list)
        for constraint in constraints:
            by_type[constraint["on"]].append(constraint["@id"])
        for document in entity_types + event_types:
            document["constraints"] = [{"ref": c} for c in by_type.get(document["@id"], [])]

        ontology = {
            "@context": {
                "ontograph": "https://ontograph.dev/schema#",
                "tms": "https://grctechllc.com/tms/ontology#",
                "xsd": "http://www.w3.org/2001/XMLSchema#",
            },
            "@id": CONFIG.ontology_id,
            "@type": "Ontology",
            "version": CONFIG.ontology_version,
            "label": {"en": "TMS Transport Management Ontology"},
            "description": {
                "en": (
                    "Generated from the semantic views in tms_views, which were built "
                    "from the TMS REST payloads captured under TMS_MCP/api_responses. "
                    "Object types, properties and link types are derived from the view "
                    "schema and probed against the data; actions, roles, constraints "
                    "and KPI definitions are authored."
                )
            },
            "entityTypes": entity_types,
            "eventTypes": event_types,
            "relationTypes": relations,
            "valueTypes": self.build_value_types(),
            "attributes": list(self.attribute_definitions.values()),
            "constraints": constraints,
            "interfaces": _interfaces(self.objects, self.attribute_id),
            "views": self.build_views(),
            "actionTypes": action_types_for_ontology(),
            "logicRules": _logic_rules(self.objects),
            "datasources": self.build_datasource(),
            "objectMappings": self.build_object_mappings(),
            "roles": ROLES,
        }
        return ontology


# ── registry persistence ────────────────────────────────────────────────────

def _semantic_role_of(prop: PropertyInfo) -> str:
    return prop.semantic_role


def persist(
    conn: psycopg.Connection,
    ontology: dict[str, Any],
    views: list[ViewInfo],
    discovery: DiscoveryResult,
    builder: OntologyBuilder,
    generated_from_run: int | None,
    validation: dict[str, Any],
) -> int:
    """Write the ontology document and its shredded form in one transaction."""
    objects = builder.objects

    space = space_id(conn, CONFIG.space)

    # A new version supersedes the old one rather than overwriting it, so an
    # ontology change is reviewable and revertible. Scoped to this space: a
    # publish into the sandbox must not deactivate production's ontology.
    execute(
        conn,
        "UPDATE platform.ontology_version SET is_active = false "
        "WHERE is_active AND space_id = %s",
        (space,),
    )

    row = query_one(
        conn,
        """
        INSERT INTO platform.ontology_version
            (space_id, version, ontology_id, label, description, definition, validation,
             object_type_count, link_type_count, action_type_count,
             generated_from_run, is_active, created_by)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, true, 'pipeline')
        RETURNING ontology_version_id
        """,
        (
            space,
            CONFIG.ontology_version,
            CONFIG.ontology_id,
            ontology["label"]["en"],
            ontology["description"]["en"],
            json.dumps(ontology),
            json.dumps(validation),
            len(ontology["entityTypes"]) + len(ontology["eventTypes"]),
            len(discovery.links),
            len(ontology["actionTypes"]),
            generated_from_run,
        ),
    )
    assert row is not None
    version_id = int(row["ontology_version_id"])

    # Object types.
    type_rows = []
    property_rows = []
    for view in objects:
        api_name = view.api_name
        type_rid = f"{NS}:{api_name}"
        hints = UI_HINTS.get(api_name, {})
        type_rows.append(
            (
                type_rid,
                version_id,
                api_name,
                humanize(view.base_name),
                pluralize(humanize(view.base_name)),
                TYPE_DESCRIPTIONS.get(api_name) or view.comment,
                "event" if api_name in EVENT_TYPES else "entity",
                view.qualified,
                view.key_column,
                view.title_column,
                hints.get("icon"),
                hints.get("color"),
                hints.get("group"),
                view.row_count,
                DISPLAY_ORDER.get(api_name, 500),
            )
        )
        for prop in view.properties:
            attribute_id = builder.attribute_id(api_name, prop.name)
            if attribute_id is None:
                continue
            property_rows.append(
                (
                    f"{type_rid}.{camel_case(prop.name)}",
                    type_rid,
                    camel_case(prop.name),
                    prop.label,
                    (builder.attribute_definitions.get(attribute_id, {}).get("description") or {}).get("en"),
                    prop.datatype,
                    prop.name,
                    prop.sql_type,
                    prop.is_identity,
                    prop.is_title,
                    prop.is_nullable,
                    prop.is_foreign_key,
                    _semantic_role_of(prop),
                    prop.default_aggregation,
                    prop.unit,
                    prop.ordinal,
                )
            )

    upsert_many(
        conn,
        "platform.object_type",
        [
            "object_type_rid", "ontology_version_id", "api_name", "label", "plural_label",
            "description", "kind", "source_view", "primary_key_column", "title_column",
            "icon", "color", "group_name", "row_count", "display_order",
        ],
        type_rows,
        # Keyed by version (0013): conflicting on the RID alone would update
        # another version's row and move it onto this one, which is how
        # publishing into a second space used to empty the first.
        ["ontology_version_id", "object_type_rid"],
    )
    upsert_many(
        conn,
        "platform.object_property",
        [
            "ontology_version_id",
            "object_property_rid", "object_type_rid", "api_name", "label", "description",
            "datatype", "sql_column", "sql_type", "is_identity", "is_title", "is_nullable",
            "is_foreign_key", "semantic_role", "default_aggregation", "unit", "display_order",
        ],
        [(version_id, *row) for row in property_rows],
        ["ontology_version_id", "object_property_rid"],
    )

    # Link types.
    link_rows = []
    for link in discovery.links:
        link_rows.append(
            (
                f"{NS}:{link.api_name}",           # type: ignore[attr-defined]
                version_id,
                link.api_name,                     # type: ignore[attr-defined]
                link.label,                        # type: ignore[attr-defined]
                link.description,                  # type: ignore[attr-defined]
                f"{NS}:{link.source_view.api_name}",
                f"{NS}:{link.target_view.api_name}",
                link.source_column,
                link.target_column,
                link.cardinality,
                link.inverse_api_name,             # type: ignore[attr-defined]
                link.inverse_label,                # type: ignore[attr-defined]
                link.discovery_method,
                round(link.match_ratio, 4),
                link.matched_rows,
                link.candidate_rows,
                link.match_ratio >= 0.999,
            )
        )
    upsert_many(
        conn,
        "platform.link_type",
        [
            "link_type_rid", "ontology_version_id", "api_name", "label", "description",
            "source_object_type", "target_object_type", "source_column", "target_column",
            "cardinality", "inverse_api_name", "inverse_label", "discovery_method",
            "match_ratio", "matched_rows", "candidate_rows", "is_verified",
        ],
        link_rows,
        ["ontology_version_id", "link_type_rid"],
    )

    register_actions(conn, version_id)

    log.info(
        "Ontology version %s written: %d object types, %d properties, %d link types, "
        "%d attributes, %d actions, %d value types, %d constraints.",
        version_id, len(type_rows), len(property_rows), len(link_rows),
        len(ontology["attributes"]), len(ontology["actionTypes"]),
        len(ontology["valueTypes"]), len(ontology["constraints"]),
    )
    return version_id


def generate(
    conn: psycopg.Connection,
    views: list[ViewInfo],
    discovery: DiscoveryResult,
    generated_from_run: int | None = None,
) -> tuple[int, dict[str, Any], OntologyBuilder]:
    builder = OntologyBuilder(conn, views, discovery)
    ontology = builder.build()

    validation = _self_validate(ontology)
    if validation["errors"]:
        for error in validation["errors"][:20]:
            log.error("Ontology validation: %s", error)
        raise RuntimeError(
            f"Generated ontology failed {len(validation['errors'])} internal reference checks; "
            "refusing to publish it."
        )

    version_id = persist(
        conn, ontology, views, discovery, builder, generated_from_run, validation
    )

    # Anything a person changed by hand is re-applied to the version just
    # written. Without this the generated ontology would quietly overwrite
    # every corrected label and every hand-drawn link on each run.
    replay_edits(conn, version_id)

    return version_id, ontology, builder


def _self_validate(ontology: dict[str, Any]) -> dict[str, Any]:
    """Re-implement ontograph's reference checks here.

    The authoritative validator lives in the Node service and runs against the
    published document. Repeating the reference checks at generation time means a
    broken ontology is never written in the first place, which is a much easier
    failure to diagnose than a service that will not start.
    """
    errors: list[str] = []
    warnings: list[str] = []

    attribute_ids = {a["@id"] for a in ontology["attributes"]}
    relation_ids = {r["@id"] for r in ontology["relationTypes"]}
    type_ids = {t["@id"] for t in ontology["entityTypes"] + ontology["eventTypes"]}
    type_ids |= {v["@id"] for v in ontology.get("valueTypes", [])}
    interface_ids = {i["@id"] for i in ontology.get("interfaces", [])}

    for document in ontology["entityTypes"] + ontology["eventTypes"]:
        for ref in document["attributes"]:
            if ref["ref"] not in attribute_ids:
                errors.append(f"{document['@id']} references undefined attribute {ref['ref']}")
        for ref in document["relations"]:
            if ref["ref"] not in relation_ids:
                errors.append(f"{document['@id']} references undefined relation {ref['ref']}")
        for iface in document.get("implements", []):
            if iface not in interface_ids:
                errors.append(f"{document['@id']} implements undefined interface {iface}")

    for relation in ontology["relationTypes"]:
        if relation["domain"] not in type_ids:
            errors.append(f"{relation['@id']} domain {relation['domain']} is not a declared type")
        if relation["range"] not in type_ids:
            errors.append(f"{relation['@id']} range {relation['range']} is not a declared type")
        inverse = relation.get("inverse")
        if inverse and inverse not in relation_ids:
            errors.append(f"{relation['@id']} inverse {inverse} is not a declared relation")

    for action in ontology["actionTypes"]:
        for target in action.get("targetTypes", []):
            if target not in type_ids:
                warnings.append(
                    f"{action['@id']} targets {target}, which this ontology does not define"
                )

    for interface in ontology.get("interfaces", []):
        for ref in interface["requiredAttributes"]:
            if ref["ref"] not in attribute_ids:
                errors.append(f"{interface['@id']} requires undefined attribute {ref['ref']}")

    return {"valid": not errors, "errors": errors, "warnings": warnings}
