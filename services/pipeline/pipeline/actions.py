"""Stage 3d - the action and role layer.

Actions are the ontology's verbs: the operations a user (or the assistant on a
user's behalf) can invoke against an object. They matter here for two reasons
beyond completeness:

  * They are what makes the assistant more than a chart generator. "Put shipment
    S45435 on hold" is a request the agent can satisfy by calling a declared,
    validated, audited action rather than by writing an UPDATE.

  * is_read_only draws the safety line. A read-only action (a what-if, a
    recalculation, a report) has no external effect and the agent may invoke it
    unattended. Everything else requires explicit human confirmation in the UI,
    regardless of what the model decides it wants to do. That rule is enforced in
    the ontology service, not left to the prompt.

Shapes match the ActionType and RoleDefinition interfaces in
vendor/ontograph-core/src/types.ts and src/security/types.ts so the definitions
can be handed straight to ActionValidator and AccessController.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import psycopg

from .db import upsert_many

log = logging.getLogger("pipeline.actions")

NS = "tms"


def _param(
    name: str,
    label: str,
    ptype: str,
    required: bool = True,
    description: str | None = None,
    enum: list[Any] | None = None,
    default: Any = None,
) -> dict[str, Any]:
    param: dict[str, Any] = {
        "name": name,
        "label": {"en": label},
        "type": ptype,
        "required": required,
    }
    if description:
        param["description"] = {"en": description}
    if enum is not None:
        # ontograph's ActionParameter has no enum field of its own, so the
        # allowed set travels as a validation rule, which ActionValidator reads.
        param["validation"] = [{"type": "custom", "value": {"enum": enum}}]
    if default is not None:
        param["defaultValue"] = default
    return param


# ── Roles ───────────────────────────────────────────────────────────────────
# Kept small and recognisable: these are the five hats in a 3PL control tower.
ROLES: list[dict[str, Any]] = [
    {
        "@id": f"{NS}:AdminRole",
        "@type": "Role",
        "label": {"en": "Platform Administrator"},
        "description": {"en": "Full control over the ontology and every action."},
        "rules": [
            {"resource": "objectType", "resourceRef": "*", "permissions": ["view", "create", "edit", "delete", "export"]},
            {"resource": "actionType", "resourceRef": "*", "permissions": ["view", "execute"]},
        ],
    },
    {
        "@id": f"{NS}:OperationsManagerRole",
        "@type": "Role",
        "label": {"en": "Operations Manager"},
        "description": {"en": "Owns service delivery; approves exceptions and reroutes."},
        "rules": [
            {"resource": "objectType", "resourceRef": "*", "permissions": ["view", "edit", "export"]},
            {"resource": "actionType", "resourceRef": "*", "permissions": ["view", "execute"]},
            {"resource": "actionType", "resourceRef": f"{NS}:CancelOrder", "permissions": ["execute"], "effect": "deny"},
        ],
    },
    {
        "@id": f"{NS}:DispatcherRole",
        "@type": "Role",
        "label": {"en": "Dispatcher"},
        "description": {"en": "Plans routes, assigns carriers, manages appointments."},
        "rules": [
            {"resource": "objectType", "resourceRef": "*", "permissions": ["view"]},
            {"resource": "objectType", "resourceRef": f"{NS}:Transport", "permissions": ["view", "edit"]},
            {"resource": "objectType", "resourceRef": f"{NS}:TransportStop", "permissions": ["view", "edit"]},
            {"resource": "actionType", "resourceRef": f"{NS}:AssignCarrierToTransport", "permissions": ["view", "execute"]},
            {"resource": "actionType", "resourceRef": f"{NS}:RescheduleStopAppointment", "permissions": ["view", "execute"]},
            {"resource": "actionType", "resourceRef": f"{NS}:PlanOrder", "permissions": ["view", "execute"]},
        ],
    },
    {
        "@id": f"{NS}:FinanceRole",
        "@type": "Role",
        "label": {"en": "Freight Finance"},
        "description": {"en": "Rates shipments, approves accessorials, raises invoices."},
        "rules": [
            {"resource": "objectType", "resourceRef": "*", "permissions": ["view", "export"]},
            {"resource": "objectType", "resourceRef": f"{NS}:Shipment", "permissions": ["view", "edit"]},
            {"resource": "actionType", "resourceRef": f"{NS}:RateShipment", "permissions": ["view", "execute"]},
            {"resource": "actionType", "resourceRef": f"{NS}:GenerateShipmentInvoice", "permissions": ["view", "execute"]},
            {"resource": "actionType", "resourceRef": f"{NS}:ApproveAccessorialCharge", "permissions": ["view", "execute"]},
        ],
    },
    {
        "@id": f"{NS}:AnalystRole",
        "@type": "Role",
        "label": {"en": "Business Analyst"},
        "description": {
            "en": (
                "Reads everything, changes nothing. This is the role the assistant "
                "runs as by default, so a conversation cannot mutate operational data "
                "unless a user explicitly switches role."
            )
        },
        "rules": [
            {"resource": "objectType", "resourceRef": "*", "permissions": ["view", "export"]},
            {"resource": "view", "resourceRef": "*", "permissions": ["view"]},
            # No actionType rule, and that is now the whole point of the role:
            # every action left in the catalogue mutates, and the three
            # read-only ones it could execute were withdrawn with tms_sim. The
            # assistant runs as this role and can therefore execute nothing.
        ],
    },
]


# ── Actions ─────────────────────────────────────────────────────────────────
ACTIONS: list[dict[str, Any]] = [
    # ── Planning ───────────────────────────────────────────────────────────
    {
        "@id": f"{NS}:PlanOrder",
        "label": {"en": "Plan Order"},
        "description": {
            "en": (
                "Build a scheduled route for an order that has none. 29 of the 90 "
                "captured orders are in exactly this state."
            )
        },
        "targetTypes": [f"{NS}:Order"],
        "parameters": [
            _param("orderKey", "Order", "string", True, "Order to plan."),
            _param("transportationMode", "Mode", "string", False,
                   "Override the mode recorded on the order.",
                   enum=["Truckload", "Less Than Truckload", "Intermodal", "Rail", "Air", "Ocean"]),
            _param("plannedStart", "Planned Start", "datetime", False,
                   "Defaults to the order's pickup ready date."),
            _param("consolidate", "Consolidate With Nearby Orders", "boolean", False,
                   "Look for orders on the same lane in the same window.", default=False),
        ],
        "sideEffects": [
            {"type": "emitEvent", "config": {"event": "OrderPlanned"},
             "description": {"en": "Downstream systems pick the new route up from this event."}},
        ],
        "approvalPolicy": {"required": False},
        "auditConfig": {"enabled": True, "logLevel": "full", "retentionDays": 365},
        "permissions": {"allowedRoles": [f"{NS}:DispatcherRole", f"{NS}:OperationsManagerRole", f"{NS}:AdminRole"]},
        "is_read_only": False,
        "tags": ["planning", "order"],
    },
    {
        "@id": f"{NS}:AssignCarrierToTransport",
        "label": {"en": "Assign Carrier"},
        "description": {
            "en": (
                "Tender a transport to a carrier. No transport in the snapshot has a "
                "carrier, so this is the action that closes that gap."
            )
        },
        "targetTypes": [f"{NS}:Transport"],
        "parameters": [
            _param("transportKey", "Transport", "string", True),
            _param("carrierKey", "Carrier", "string", True, "Carrier to tender to."),
            _param("agreedRate", "Agreed Rate", "decimal", False, "Linehaul rate in USD."),
            _param("tenderNotes", "Notes", "string", False),
        ],
        "sideEffects": [
            {"type": "notification", "config": {"channel": "email", "recipient": "carrier"},
             "description": {"en": "Sends the tender to the carrier's general email address."}},
            {"type": "stateChange", "config": {"field": "status", "to": "Tendered"}},
        ],
        # Above a threshold a human signs off. autoApproveConditions is the hook
        # ontograph's ActionEngine reads to skip the queue for routine tenders.
        "approvalPolicy": {
            "required": True,
            "approvers": [f"{NS}:OperationsManagerRole"],
            "autoApproveConditions": ["agreedRate < 5000"],
            "timeout": 86400000,
        },
        "auditConfig": {"enabled": True, "logLevel": "full", "retentionDays": 2555},
        "permissions": {"allowedRoles": [f"{NS}:DispatcherRole", f"{NS}:OperationsManagerRole", f"{NS}:AdminRole"]},
        "is_read_only": False,
        "tags": ["procurement", "transport", "tender"],
    },
    {
        "@id": f"{NS}:RescheduleStopAppointment",
        "label": {"en": "Reschedule Stop Appointment"},
        "description": {"en": "Move the planned arrival window for a stop."},
        "targetTypes": [f"{NS}:TransportStop"],
        "parameters": [
            _param("transportStopKey", "Stop", "string", True),
            _param("arrivalFrom", "New Window Opens", "datetime", True),
            _param("arrivalTo", "New Window Closes", "datetime", True),
            _param("reason", "Reason", "string", True,
                   "Recorded against the stop for the service review.",
                   enum=["CUSTOMER_REQUEST", "CARRIER_REQUEST", "FACILITY_CONGESTION",
                         "WEATHER", "CAPACITY", "OTHER"]),
        ],
        "sideEffects": [
            {"type": "notification", "config": {"channel": "email", "recipient": "facility"}},
        ],
        "approvalPolicy": {"required": False},
        "auditConfig": {"enabled": True, "logLevel": "full", "retentionDays": 365},
        "permissions": {"allowedRoles": [f"{NS}:DispatcherRole", f"{NS}:OperationsManagerRole", f"{NS}:AdminRole"]},
        "is_read_only": False,
        "tags": ["operations", "appointment"],
    },

    # ── Exception handling ────────────────────────────────────────────────
    {
        "@id": f"{NS}:HoldShipment",
        "label": {"en": "Hold Shipment"},
        "description": {"en": "Stop a shipment from progressing and record why."},
        "targetTypes": [f"{NS}:Shipment"],
        "parameters": [
            _param("shipmentKey", "Shipment", "string", True),
            _param("holdReason", "Hold Reason", "string", True,
                   enum=["CREDIT_HOLD", "DOCUMENTATION", "CUSTOMS", "DAMAGE",
                         "CUSTOMER_REQUEST", "COMPLIANCE"]),
            _param("notes", "Notes", "string", False),
        ],
        "sideEffects": [
            {"type": "stateChange", "config": {"field": "is_on_hold", "to": True}},
            {"type": "emitEvent", "config": {"event": "ShipmentHeld"}},
        ],
        "approvalPolicy": {"required": False},
        "auditConfig": {"enabled": True, "logLevel": "full", "retentionDays": 2555},
        "permissions": {"allowedRoles": [f"{NS}:OperationsManagerRole", f"{NS}:FinanceRole", f"{NS}:AdminRole"]},
        "is_read_only": False,
        "tags": ["exception", "shipment"],
    },
    {
        "@id": f"{NS}:ReleaseShipmentHold",
        "label": {"en": "Release Shipment Hold"},
        "description": {"en": "Clear a hold so the shipment can move again."},
        "targetTypes": [f"{NS}:Shipment"],
        "parameters": [
            _param("shipmentKey", "Shipment", "string", True),
            _param("resolutionNotes", "Resolution", "string", True),
        ],
        "sideEffects": [{"type": "stateChange", "config": {"field": "is_on_hold", "to": False}}],
        "approvalPolicy": {"required": True, "approvers": [f"{NS}:OperationsManagerRole"], "timeout": 43200000},
        "auditConfig": {"enabled": True, "logLevel": "full", "retentionDays": 2555},
        "permissions": {"allowedRoles": [f"{NS}:OperationsManagerRole", f"{NS}:AdminRole"]},
        "is_read_only": False,
        "tags": ["exception", "shipment"],
    },
    {
        "@id": f"{NS}:CancelOrder",
        "label": {"en": "Cancel Order"},
        "description": {
            "en": (
                "Cancel an order and everything planned under it. Destructive and "
                "irreversible, so it always requires approval and is denied to the "
                "operations role by policy."
            )
        },
        "targetTypes": [f"{NS}:Order"],
        "parameters": [
            _param("orderKey", "Order", "string", True),
            _param("cancellationReason", "Reason", "string", True,
                   enum=["CUSTOMER_CANCELLED", "DUPLICATE", "NO_CAPACITY", "CREDIT_FAILURE", "DATA_ERROR"]),
            _param("confirmCascade", "Confirm Cascade", "boolean", True,
                   "Must be true: shipments and transports under this order are cancelled too."),
        ],
        "sideEffects": [
            {"type": "stateChange", "config": {"field": "status", "to": "Cancelled", "cascade": True}},
            {"type": "notification", "config": {"channel": "email", "recipient": "account"}},
        ],
        "approvalPolicy": {"required": True, "approvers": [f"{NS}:AdminRole"], "timeout": 86400000},
        "auditConfig": {"enabled": True, "logLevel": "full", "retentionDays": 2555},
        "permissions": {"allowedRoles": [f"{NS}:AdminRole"], "deniedRoles": [f"{NS}:AnalystRole", f"{NS}:DispatcherRole"]},
        "is_read_only": False,
        "tags": ["destructive", "order"],
    },

    # ── Finance ───────────────────────────────────────────────────────────
    {
        "@id": f"{NS}:RateShipment",
        "label": {"en": "Rate Shipment"},
        "description": {
            "en": (
                "Apply a freight charge to an unrated shipment. 47 of the 61 captured "
                "shipments have no charge in the source."
            )
        },
        "targetTypes": [f"{NS}:Shipment"],
        "parameters": [
            _param("shipmentKey", "Shipment", "string", True),
            _param("freightAmount", "Freight", "decimal", True),
            _param("fuelAmount", "Fuel Surcharge", "decimal", False, default=0),
            _param("accessorialAmount", "Accessorials", "decimal", False, default=0),
            _param("currencyCode", "Currency", "string", False, default="USD",
                   enum=["USD", "CAD", "MXN", "EUR"]),
        ],
        "sideEffects": [{"type": "emitEvent", "config": {"event": "ShipmentRated"}}],
        "approvalPolicy": {"required": False, "autoApproveConditions": ["freightAmount < 25000"]},
        "auditConfig": {"enabled": True, "logLevel": "full", "retentionDays": 2555},
        "permissions": {"allowedRoles": [f"{NS}:FinanceRole", f"{NS}:AdminRole"]},
        "is_read_only": False,
        "tags": ["finance", "shipment", "rating"],
    },
    {
        "@id": f"{NS}:GenerateShipmentInvoice",
        "label": {"en": "Generate Invoice"},
        "description": {"en": "Raise the customer invoice for a rated, delivered shipment."},
        "targetTypes": [f"{NS}:Shipment"],
        "parameters": [
            _param("shipmentKey", "Shipment", "string", True),
            _param("invoiceDate", "Invoice Date", "date", False),
            _param("requireVerifiedDocuments", "Require Verified Documents", "boolean", False,
                   "Block the invoice until paperwork is verified.", default=True),
        ],
        "sideEffects": [
            {"type": "stateChange", "config": {"field": "is_invoiced", "to": True}},
            {"type": "webhook", "config": {"target": "billing", "method": "POST"}},
        ],
        "approvalPolicy": {"required": False},
        "auditConfig": {"enabled": True, "logLevel": "full", "retentionDays": 2555},
        "permissions": {"allowedRoles": [f"{NS}:FinanceRole", f"{NS}:AdminRole"]},
        "is_read_only": False,
        "tags": ["finance", "billing"],
    },
    {
        "@id": f"{NS}:ApproveAccessorialCharge",
        "label": {"en": "Approve Accessorial Charge"},
        "description": {"en": "Sign off an accessorial a carrier has claimed."},
        "targetTypes": [f"{NS}:Shipment"],
        "parameters": [
            _param("shipmentKey", "Shipment", "string", True),
            _param("accessorialType", "Accessorial", "string", True,
                   enum=["DETENTION", "LAYOVER", "LIFTGATE", "INSIDE_DELIVERY",
                         "REDELIVERY", "STORAGE", "FUEL_ADJUSTMENT"]),
            _param("amount", "Amount", "decimal", True),
            _param("justification", "Justification", "string", True),
        ],
        "sideEffects": [{"type": "emitEvent", "config": {"event": "AccessorialApproved"}}],
        "approvalPolicy": {
            "required": True,
            "approvers": [f"{NS}:FinanceRole"],
            "autoApproveConditions": ["amount < 250"],
            "timeout": 172800000,
        },
        "auditConfig": {"enabled": True, "logLevel": "full", "retentionDays": 2555},
        "permissions": {"allowedRoles": [f"{NS}:FinanceRole", f"{NS}:OperationsManagerRole", f"{NS}:AdminRole"]},
        "is_read_only": False,
        "tags": ["finance", "accessorial"],
    },

    # ── Read-only analysis ─────────────────────────────────────────────────
    #
    #  There is none left. Simulate Rate Change, Project On-Time Impact and
    #  Recalculate Transport Cost lived here, and every number all three
    #  produced came from the generated execution data in tms_sim - a cost
    #  the snapshot does not carry, a carrier assignment it does not carry,
    #  a distance recorded as 0 m on every leg. Migration 0018 dropped that
    #  schema and the views they read, so they answered 409 and nothing
    #  else; they are withdrawn rather than left as three menu entries that
    #  can only fail.
    #
    #  The machinery for a read-only action is intact in the ontology
    #  service. One becomes possible again the moment the TMS starts
    #  sending actuals.
]


def action_types_for_ontology() -> list[dict[str, Any]]:
    """The ActionType documents, shaped for the ontology definition.

    is_read_only is a platform concept rather than part of ontograph's
    ActionType, so it travels as a tag on the way out and is stored in its own
    column in platform.action_type.
    """
    out = []
    for action in ACTIONS:
        document = {k: v for k, v in action.items() if k != "is_read_only"}
        document["@type"] = "ActionType"
        out.append(document)
    return out


def register_actions(conn: psycopg.Connection, ontology_version_id: int) -> int:
    rows = []
    for action in ACTIONS:
        approval = action.get("approvalPolicy", {})
        audit = action.get("auditConfig", {})
        permissions = action.get("permissions", {})
        api_name = action["@id"].split(":", 1)[1]
        rows.append(
            (
                action["@id"],
                ontology_version_id,
                api_name,
                action["label"]["en"],
                (action.get("description") or {}).get("en"),
                action.get("targetTypes", []),
                json.dumps(action.get("parameters", [])),
                bool(approval.get("required")),
                approval.get("approvers", []) or [],
                permissions.get("allowedRoles", []) or [],
                audit.get("logLevel", "full"),
                bool(action.get("is_read_only")),
                action.get("tags", []),
            )
        )

    written = upsert_many(
        conn,
        "platform.action_type",
        [
            "action_type_rid", "ontology_version_id", "api_name", "label", "description",
            "target_object_types", "parameters", "requires_approval", "approver_roles",
            "allowed_roles", "audit_level", "is_read_only", "tags",
        ],
        rows,
        ["ontology_version_id", "action_type_rid"],
    )
    read_only = sum(1 for a in ACTIONS if a.get("is_read_only"))
    log.info(
        "Registered %d action types (%d read-only and safe for unattended use, "
        "%d requiring approval) and %d roles.",
        written, read_only, sum(1 for a in ACTIONS if a.get("approvalPolicy", {}).get("required")),
        len(ROLES),
    )
    return written
