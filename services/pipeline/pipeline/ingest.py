"""Stage 1 - land the captured TMS payloads into tms_raw.

Reads the JSON files written by TMS_MCP/scripts/fetch_all_apis.py. Each file is
an envelope: {endpoint_name, url, method, status_code, response_headers, data}.
Only `data` is modelled; the envelope is recorded in tms_raw.ingest_source so a
view column can be traced back to the HTTP endpoint it came from.

Deliberately not ingested:
  * businessentities_entityType_0_None.json - the API returns HTTP 400 for
    entityType=0, so there is no payload.
  * users_permissions.json - despite the name this is the front-end module and
    route registry (micro-frontend paths and ports), not TMS business data. It
    describes the UI, so it has no place in a TMS ontology.
"""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

import psycopg

from .config import CONFIG
from .db import count_rows, execute, query_one, truncate, upsert_many

log = logging.getLogger("pipeline.ingest")

NULL_UUID = "00000000-0000-0000-0000-000000000000"
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)

# Tables emptied before a re-ingest, ordered so CASCADE has nothing to complain
# about. tms_sim is not listed: it is rebuilt by its own stage.
RAW_TABLES = [
    "tms_raw.stop_event",
    "tms_raw.transport_leg",
    "tms_raw.transport_stop",
    "tms_raw.transport",
    "tms_raw.handling_unit",
    "tms_raw.shipment",
    "tms_raw.order_accessorial",
    "tms_raw.order_reference",
    "tms_raw.tms_order",
    "tms_raw.business_entity_relationship",
    "tms_raw.business_entity_contact",
    "tms_raw.business_entity_role",
    "tms_raw.business_entity",
    "tms_raw.account",
    "tms_raw.tenant",
    "tms_raw.transportation_mode",
    "tms_raw.unit_of_measure",
    "tms_raw.app_user",
]

# entityType query parameter -> label, used only for provenance on the row.
ENTITY_FILES = {
    "businessentities_entityType_1_Tenant.json": 1,
    "businessentities_entityType_2_Account.json": 2,
    "businessentities_entityType_4_Agent.json": 4,
    "businessentities_entityType_8_Broker.json": 8,
    "businessentities_entityType_16_Carrier.json": 16,
    "businessentities_entityType_32_Supplier.json": 32,
    "businessentities_entityType_64_Customer.json": 64,
    "businessentities_entityType_128_Location.json": 128,
    "businessentities_entityType_256_BillTo.json": 256,
    "businessentities_entityType_512_Hub.json": 512,
    "businessentities_entityType_1024_Contact.json": 1024,
    "businessentities_entityType_2048_Group.json": 2048,
}


# ── value coercion ──────────────────────────────────────────────────────────

def uuid_or_none(value: Any) -> str | None:
    """Return a real UUID, or None for the all-zero sentinel the TMS uses."""
    if not value:
        return None
    text = str(value).strip()
    if not text or text == NULL_UUID:
        return None
    return text if UUID_RE.match(text) else None


def text_or_none(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def as_ts(value: Any) -> datetime | None:
    """Parse the ISO-8601 timestamps the TMS emits (always Z-suffixed)."""
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def as_interval(value: Any) -> timedelta | None:
    """Parse the HH:MM:SS strings used for tender response windows."""
    if not value:
        return None
    parts = str(value).split(":")
    try:
        nums = [float(p) for p in parts]
    except ValueError:
        return None
    while len(nums) < 3:
        nums.append(0.0)
    return timedelta(hours=nums[0], minutes=nums[1], seconds=nums[2])


def measure(node: Any) -> tuple[float | None, str | None]:
    """Split a {"Unit": "MassUnit.Pound", "Value": 110} node into (value, unit).

    The unit token is landed verbatim; conversion to kg/cm happens in SQL so the
    raw layer stays a faithful copy of what the API said.
    """
    if not isinstance(node, dict):
        return None, None
    value = node.get("Value", node.get("value"))
    unit = node.get("Unit", node.get("unit"))
    try:
        numeric = float(value) if value is not None else None
    except (TypeError, ValueError):
        numeric = None
    return numeric, text_or_none(unit)


def address_parts(node: Any) -> dict[str, Any]:
    if not isinstance(node, dict):
        node = {}
    street = node.get("streetAddress")
    if isinstance(street, list):
        street = ", ".join(str(s) for s in street if s)
    return {
        "street_address": text_or_none(street),
        "city": text_or_none(node.get("city")),
        "province_state": text_or_none(node.get("provinceState")),
        "postal_zip_code": text_or_none(node.get("postalZipCode")),
        "country_code": node.get("country"),
        "latitude": node.get("latitude"),
        "longitude": node.get("longitude"),
    }


def phone_parts(node: Any) -> tuple[str | None, int | None]:
    if not isinstance(node, dict):
        return None, None
    return text_or_none(node.get("phoneNumber")), node.get("phoneType")


def first_phone(node: Any) -> str | None:
    """Contacts carry a list of phones; take the lowest displayOrder."""
    if isinstance(node, dict):
        return text_or_none(node.get("phoneNumber"))
    if isinstance(node, list) and node:
        ordered = sorted(
            (p for p in node if isinstance(p, dict)),
            key=lambda p: p.get("displayOrder") or 0,
        )
        if ordered:
            return text_or_none(ordered[0].get("phoneNumber"))
    return None


# ── file access ─────────────────────────────────────────────────────────────

def load_envelope(path: str) -> tuple[dict, Any]:
    with open(path, "r", encoding="utf-8") as handle:
        envelope = json.load(handle)
    if isinstance(envelope, dict) and "data" in envelope:
        return envelope, envelope.get("data")
    # Tolerate a bare payload in case a file was hand-saved without the wrapper.
    return {}, envelope


def as_list(data: Any) -> list[dict]:
    if isinstance(data, list):
        return [d for d in data if isinstance(d, dict)]
    if isinstance(data, dict):
        return [data]
    return []


class Ingestor:
    """Owns one ingest run and the row counters that feed the lineage graph."""

    def __init__(self, conn: psycopg.Connection, source_dir: str) -> None:
        self.conn = conn
        self.source_dir = source_dir
        self.run_id: int | None = None
        self.rows_landed = 0
        self.files_processed = 0
        self.table_counts: dict[str, int] = {}
        # Orders arrive in two files with an overlap; the first sighting wins so
        # view_type stays meaningful.
        self.seen_orders: set[str] = set()

    # ── run bookkeeping ────────────────────────────────────────────────────

    def start(self) -> int:
        row = query_one(
            self.conn,
            """
            INSERT INTO tms_raw.ingest_run (source_dir, status)
            VALUES (%s, 'running') RETURNING run_id
            """,
            (self.source_dir,),
        )
        assert row is not None
        self.run_id = int(row["run_id"])
        log.info("Ingest run %s started from %s", self.run_id, self.source_dir)
        return self.run_id

    def finish(self, status: str, error: str | None = None) -> None:
        execute(
            self.conn,
            """
            UPDATE tms_raw.ingest_run
               SET finished_at = now(), status = %s, files_processed = %s,
                   rows_landed = %s, error_message = %s, details = %s
             WHERE run_id = %s
            """,
            (
                status,
                self.files_processed,
                self.rows_landed,
                error,
                json.dumps({"table_counts": self.table_counts}),
                self.run_id,
            ),
        )

    def record_source(
        self, envelope: dict, file_name: str, record_count: int, targets: list[str]
    ) -> None:
        upsert_many(
            self.conn,
            "tms_raw.ingest_source",
            [
                "run_id",
                "endpoint_name",
                "url",
                "http_method",
                "status_code",
                "file_name",
                "record_count",
                "target_tables",
            ],
            [
                (
                    self.run_id,
                    envelope.get("endpoint_name") or os.path.splitext(file_name)[0],
                    envelope.get("url"),
                    envelope.get("method"),
                    envelope.get("status_code"),
                    file_name,
                    record_count,
                    targets,
                )
            ],
        )
        self.files_processed += 1

    def _land(
        self,
        table: str,
        columns: list[str],
        rows: Iterable[tuple],
        conflict: list[str] | None = None,
        update: list[str] | None = None,
    ) -> int:
        landed = upsert_many(self.conn, table, columns, rows, conflict, update)
        self.rows_landed += landed
        self.table_counts[table] = self.table_counts.get(table, 0) + landed
        return landed

    def path(self, file_name: str) -> str | None:
        candidate = os.path.join(self.source_dir, file_name)
        return candidate if os.path.exists(candidate) else None

    # ── stage entry point ─────────────────────────────────────────────────

    def run(self) -> None:
        self.ingest_reference_masters()
        self.ingest_tenants()
        self.ingest_accounts()
        self.ingest_business_entities()
        self.ingest_users()
        self.ingest_orders()

    # ── configuration masters ─────────────────────────────────────────────

    def ingest_reference_masters(self) -> None:
        path = self.path("transportationmodes.json")
        if path:
            envelope, data = load_envelope(path)
            records = as_list(data)
            rows = [
                (
                    rec.get("id"),
                    text_or_none(rec.get("displayName")),
                    as_interval(rec.get("tenderResponseTime")),
                    text_or_none(rec.get("ediCodes")),
                    rec.get("isActive"),
                    self.run_id,
                )
                for rec in records
                if rec.get("id") is not None
            ]
            self._land(
                "tms_raw.transportation_mode",
                ["id", "display_name", "tender_response_time", "edi_codes", "is_active", "run_id"],
                rows,
                ["id"],
            )
            self.record_source(
                envelope, "transportationmodes.json", len(rows), ["tms_raw.transportation_mode"]
            )

        path = self.path("unitsofmeasures.json")
        if path:
            envelope, data = load_envelope(path)
            records = as_list(data)
            rows = [
                (
                    uuid_or_none(rec.get("id")),
                    text_or_none(rec.get("category")),
                    text_or_none(rec.get("unit")),
                    text_or_none(rec.get("symbol")),
                    rec.get("isActive"),
                    rec.get("isDefault"),
                    self.run_id,
                )
                for rec in records
                if uuid_or_none(rec.get("id"))
            ]
            self._land(
                "tms_raw.unit_of_measure",
                ["id", "category", "unit", "symbol", "is_active", "is_default", "run_id"],
                rows,
                ["id"],
            )
            self.record_source(
                envelope, "unitsofmeasures.json", len(rows), ["tms_raw.unit_of_measure"]
            )

    # ── tenants ───────────────────────────────────────────────────────────

    def ingest_tenants(self) -> None:
        path = self.path("tenants.json")
        if not path:
            return
        envelope, data = load_envelope(path)
        records = as_list(data)
        rows = []
        contacts: list[tuple] = []
        for rec in records:
            tenant_id = uuid_or_none(rec.get("id")) or uuid_or_none(rec.get("tenantId"))
            if not tenant_id:
                continue
            addr = address_parts(rec.get("address"))
            phone, phone_type = phone_parts(rec.get("generalPhoneNumber"))
            rows.append(
                (
                    tenant_id,
                    text_or_none(rec.get("name")),
                    text_or_none(rec.get("alias")),
                    text_or_none(rec.get("displayId")),
                    text_or_none(rec.get("generalEmailAddress")),
                    phone,
                    phone_type,
                    addr["street_address"],
                    addr["city"],
                    addr["province_state"],
                    addr["postal_zip_code"],
                    addr["country_code"],
                    addr["latitude"],
                    addr["longitude"],
                    text_or_none(rec.get("logoUrl")),
                    text_or_none(rec.get("description")),
                    text_or_none(rec.get("ianaTimezoneString")),
                    rec.get("isActive"),
                    self.run_id,
                )
            )
            contacts.extend(self._contact_rows(tenant_id, rec.get("contacts")))

        self._land(
            "tms_raw.tenant",
            [
                "id", "name", "alias", "display_id", "general_email", "general_phone",
                "general_phone_type", "street_address", "city", "province_state",
                "postal_zip_code", "country_code", "latitude", "longitude", "logo_url",
                "description", "iana_timezone", "is_active", "run_id",
            ],
            rows,
            ["id"],
        )
        # Tenant contacts are held against the party table, which tenants are
        # also members of; land them once the party rows exist.
        self.pending_tenant_contacts = contacts
        self.record_source(envelope, "tenants.json", len(rows), ["tms_raw.tenant"])

    def _contact_rows(self, entity_id: str, contacts: Any) -> list[tuple]:
        rows = []
        for contact in contacts or []:
            if not isinstance(contact, dict):
                continue
            contact_id = uuid_or_none(contact.get("contactId"))
            if not contact_id:
                continue
            rows.append(
                (
                    contact_id,
                    entity_id,
                    text_or_none(contact.get("wholeName")),
                    text_or_none(contact.get("title")),
                    text_or_none(contact.get("email")),
                    first_phone(contact.get("phoneNumber")),
                    contact.get("isPrimary"),
                    contact.get("relationship"),
                    self.run_id,
                )
            )
        return rows

    # ── accounts ──────────────────────────────────────────────────────────

    def ingest_accounts(self) -> None:
        path = self.path("accounts.json")
        if not path:
            return
        envelope, data = load_envelope(path)
        records = as_list(data)
        rows, relationships = [], []
        for rec in records:
            account_id = uuid_or_none(rec.get("id"))
            if not account_id:
                continue
            addr = address_parts(rec.get("address"))
            phone, _ = phone_parts(rec.get("generalPhoneNumber"))
            rows.append(
                (
                    account_id,
                    uuid_or_none(rec.get("tenantId")),
                    text_or_none(rec.get("name")),
                    text_or_none(rec.get("alias")),
                    text_or_none(rec.get("displayId")),
                    text_or_none(rec.get("generalEmailAddress")),
                    phone,
                    addr["street_address"],
                    addr["city"],
                    addr["province_state"],
                    addr["postal_zip_code"],
                    addr["country_code"],
                    addr["latitude"],
                    addr["longitude"],
                    text_or_none(rec.get("logoUrl")),
                    text_or_none(rec.get("description")),
                    text_or_none(rec.get("ianaTimezoneString")),
                    rec.get("isActive"),
                    rec.get("entityType"),
                    self.run_id,
                )
            )
            relationships.extend(self._relationship_rows(rec.get("relationships")))

        self._land(
            "tms_raw.account",
            [
                "id", "tenant_id", "name", "alias", "display_id", "general_email",
                "general_phone", "street_address", "city", "province_state",
                "postal_zip_code", "country_code", "latitude", "longitude", "logo_url",
                "description", "iana_timezone", "is_active", "entity_type_mask", "run_id",
            ],
            rows,
            ["id"],
        )
        self.pending_account_relationships = relationships
        self.record_source(envelope, "accounts.json", len(rows), ["tms_raw.account"])

    def _relationship_rows(self, relationships: Any) -> list[tuple]:
        rows = []
        for rel in relationships or []:
            if not isinstance(rel, dict):
                continue
            rel_id = uuid_or_none(rel.get("id"))
            if not rel_id:
                continue
            rows.append(
                (
                    rel_id,
                    uuid_or_none(rel.get("parentId")),
                    rel.get("parentEntityType"),
                    text_or_none(rel.get("parentDescriptor")),
                    uuid_or_none(rel.get("childId")),
                    rel.get("childEntityType"),
                    text_or_none(rel.get("childDescriptor")),
                    rel.get("association"),
                    self.run_id,
                )
            )
        return rows

    # ── business entities ─────────────────────────────────────────────────

    def ingest_business_entities(self) -> None:
        entity_rows: dict[str, tuple] = {}
        role_rows: dict[tuple[str, str], tuple] = {}
        contact_rows: dict[tuple[str, str], tuple] = {}
        relationship_rows: dict[str, tuple] = {}

        for file_name, source_type in ENTITY_FILES.items():
            path = self.path(file_name)
            if not path:
                continue
            envelope, data = load_envelope(path)
            if envelope.get("status_code") not in (None, 200):
                log.info("Skipping %s: source returned HTTP %s", file_name, envelope.get("status_code"))
                self.record_source(envelope, file_name, 0, [])
                continue
            records = as_list(data)
            for rec in records:
                entity_id = uuid_or_none(rec.get("id"))
                if not entity_id:
                    continue
                addr = address_parts(rec.get("address"))
                phone, phone_type = phone_parts(rec.get("generalPhoneNumber"))
                hours = rec.get("businessHours") or {}
                # A party appears once per role file it qualifies for. The rows
                # are identical apart from source_entity_type, so first sighting
                # wins and the full role set comes from EntityRoles below.
                entity_rows.setdefault(
                    entity_id,
                    (
                        entity_id,
                        uuid_or_none(rec.get("tenantId")),
                        text_or_none(rec.get("name")),
                        text_or_none(rec.get("alias")),
                        text_or_none(rec.get("displayId")),
                        rec.get("entityType") or 0,
                        text_or_none(rec.get("generalEmailAddress")),
                        phone,
                        phone_type,
                        addr["street_address"],
                        addr["city"],
                        addr["province_state"],
                        addr["postal_zip_code"],
                        addr["country_code"],
                        addr["latitude"],
                        addr["longitude"],
                        text_or_none(rec.get("logoUrl")),
                        text_or_none(rec.get("description")),
                        text_or_none(rec.get("ianaTimezoneString")),
                        rec.get("isActive"),
                        text_or_none(rec.get("electronicReferenceIdentifier")),
                        hours.get("isOpen24Hours"),
                        hours.get("isCustomWorkingHours"),
                        source_type,
                        self.run_id,
                    ),
                )
                for role in rec.get("EntityRoles") or []:
                    if not isinstance(role, dict):
                        continue
                    role_name = text_or_none(role.get("roleName"))
                    if not role_name:
                        continue
                    role_rows[(entity_id, role_name)] = (
                        entity_id,
                        role_name,
                        role.get("entityType") or 0,
                        uuid_or_none(role.get("settingsId")),
                        self.run_id,
                    )
                for contact in self._contact_rows(entity_id, rec.get("contacts")):
                    contact_rows[(contact[1], contact[0])] = contact
                for rel in self._relationship_rows(rec.get("relationships")):
                    relationship_rows[rel[0]] = rel

            self.record_source(
                envelope,
                file_name,
                len(records),
                ["tms_raw.business_entity", "tms_raw.business_entity_role"],
            )

        # Tenants and accounts also participate in the party graph; fold in the
        # contacts and relationships parked by the earlier stages.
        for contact in getattr(self, "pending_tenant_contacts", []):
            contact_rows.setdefault((contact[1], contact[0]), contact)
        for rel in getattr(self, "pending_account_relationships", []):
            relationship_rows.setdefault(rel[0], rel)

        self._land(
            "tms_raw.business_entity",
            [
                "id", "tenant_id", "name", "alias", "display_id", "entity_type_mask",
                "general_email", "general_phone", "general_phone_type", "street_address",
                "city", "province_state", "postal_zip_code", "country_code", "latitude",
                "longitude", "logo_url", "description", "iana_timezone", "is_active",
                "electronic_ref_id", "is_open_24_hours", "is_custom_hours",
                "source_entity_type", "run_id",
            ],
            list(entity_rows.values()),
            ["id"],
        )
        self._land(
            "tms_raw.business_entity_role",
            ["entity_id", "role_name", "entity_type", "settings_id", "run_id"],
            list(role_rows.values()),
            ["entity_id", "role_name"],
        )
        # Contacts and relationships can reference a party the snapshot never
        # returned a full record for (a tenant contact, say). Keep only the ones
        # whose owner landed, so the FK holds.
        known = set(entity_rows)
        self._land(
            "tms_raw.business_entity_contact",
            [
                "contact_id", "entity_id", "whole_name", "title", "email",
                "phone_number", "is_primary", "relationship", "run_id",
            ],
            [c for c in contact_rows.values() if c[1] in known],
            ["entity_id", "contact_id"],
        )
        self._land(
            "tms_raw.business_entity_relationship",
            [
                "id", "parent_id", "parent_entity_type", "parent_descriptor",
                "child_id", "child_entity_type", "child_descriptor", "association", "run_id",
            ],
            list(relationship_rows.values()),
            ["id"],
        )

    # ── users ─────────────────────────────────────────────────────────────

    def ingest_users(self) -> None:
        path = self.path("users_details.json")
        if not path:
            return
        envelope, data = load_envelope(path)
        records = as_list(data)
        rows = []
        for rec in records:
            user_id = uuid_or_none(rec.get("id"))
            if not user_id:
                continue
            prefs = rec.get("preferences") or {}
            perms = rec.get("permissions") or {}
            rows.append(
                (
                    user_id,
                    uuid_or_none(rec.get("contactId")),
                    uuid_or_none(prefs.get("languageId")),
                    uuid_or_none(prefs.get("timeZoneId")),
                    rec.get("version"),
                    rec.get("eventCount"),
                    [u for u in (rec.get("roleIds") or []) if uuid_or_none(u)],
                    [u for u in (perms.get("locationIds") or []) if uuid_or_none(u)],
                    self.run_id,
                )
            )
        self._land(
            "tms_raw.app_user",
            [
                "id", "contact_id", "language_id", "time_zone_id", "version",
                "event_count", "role_ids", "location_ids", "run_id",
            ],
            rows,
            ["id"],
        )
        self.record_source(envelope, "users_details.json", len(rows), ["tms_raw.app_user"])

    # ── orders and the whole execution chain ──────────────────────────────

    def ingest_orders(self) -> None:
        for file_name, view_type in (("orders_viewType1.json", 1), ("orders_viewType2.json", 2)):
            path = self.path(file_name)
            if not path:
                continue
            envelope, data = load_envelope(path)
            records = as_list(data)
            self._ingest_order_batch(records, view_type)
            self.record_source(
                envelope,
                file_name,
                len(records),
                [
                    "tms_raw.tms_order", "tms_raw.shipment", "tms_raw.transport",
                    "tms_raw.transport_leg", "tms_raw.transport_stop",
                    "tms_raw.stop_event", "tms_raw.handling_unit",
                ],
            )

    def _ingest_order_batch(self, records: list[dict], view_type: int) -> None:
        orders: list[tuple] = []
        accessorials: list[tuple] = []
        references: list[tuple] = []
        handling_units: list[tuple] = []
        shipments: list[tuple] = []
        transports: list[tuple] = []
        legs: list[tuple] = []
        stops: list[tuple] = []
        events: list[tuple] = []

        for rec in records:
            order_id = uuid_or_none(rec.get("id"))
            if not order_id:
                continue
            route = rec.get("scheduledRoute") or None
            # The overlap between the two order files is the same 23 orders, so
            # keep the first sighting and only note the second view.
            if order_id in self.seen_orders:
                continue
            self.seen_orders.add(order_id)

            pickup = rec.get("pickup") or {}
            delivery = rec.get("delivery") or {}
            orders.append(
                (
                    order_id,
                    text_or_none(rec.get("orderNumber")),
                    uuid_or_none(rec.get("accountId")),
                    uuid_or_none(rec.get("originId")),
                    uuid_or_none(rec.get("destinationId")),
                    uuid_or_none(rec.get("billToId")),
                    uuid_or_none(rec.get("carrierId")),
                    uuid_or_none(rec.get("originCareOfContactId")),
                    uuid_or_none(rec.get("destinationCareOfContactId")),
                    uuid_or_none(rec.get("paymentTermId")),
                    uuid_or_none(rec.get("serviceLevelId")),
                    uuid_or_none(rec.get("shipmentTypeId")),
                    rec.get("transportationModeId"),
                    rec.get("orderType"),
                    rec.get("status"),
                    as_ts(pickup.get("readyDate")),
                    as_ts(pickup.get("closeDate")),
                    text_or_none(pickup.get("instructions")),
                    as_ts(delivery.get("readyDate")),
                    as_ts(delivery.get("closeDate")),
                    text_or_none(delivery.get("instructions")),
                    text_or_none(rec.get("specialInstructions")),
                    text_or_none(rec.get("trailerNumber")),
                    text_or_none(rec.get("sealNumber")),
                    text_or_none(rec.get("scacNumber")),
                    text_or_none(rec.get("proNumber")),
                    text_or_none(rec.get("bolNumber")),
                    rec.get("codAmount"),
                    rec.get("value"),
                    rec.get("units"),
                    rec.get("feeTerms"),
                    rec.get("trailerLoadedBy"),
                    rec.get("freightCountedBy"),
                    route is not None,
                    (route or {}).get("isComplete"),
                    view_type,
                    self.run_id,
                )
            )

            for accessorial_id in rec.get("accessorials") or []:
                resolved = uuid_or_none(accessorial_id)
                if resolved:
                    accessorials.append((order_id, resolved, self.run_id))

            for seq, reference in enumerate(rec.get("references") or [], start=1):
                if isinstance(reference, dict):
                    references.append(
                        (
                            order_id,
                            seq,
                            text_or_none(reference.get("type") or reference.get("referenceType")),
                            text_or_none(reference.get("value") or reference.get("referenceValue")),
                            self.run_id,
                        )
                    )
                else:
                    references.append((order_id, seq, None, text_or_none(reference), self.run_id))

            handling_units.extend(
                self._handling_unit_rows(rec.get("handlingUnits"), "order", order_id, None)
            )

            if not route:
                continue

            handling_units.extend(
                self._handling_unit_rows(route.get("handlingUnits"), "route", order_id, None)
            )

            for shipment in route.get("shipments") or []:
                if not isinstance(shipment, dict):
                    continue
                shipment_id = uuid_or_none(shipment.get("shipmentId"))
                if not shipment_id:
                    continue
                charge = shipment.get("charge") or {}
                approved = shipment.get("proposalApprovedCharges") or {}
                shipments.append(
                    (
                        shipment_id,
                        text_or_none(shipment.get("shipmentNumber")),
                        uuid_or_none(shipment.get("orderId")) or order_id,
                        shipment.get("status"),
                        shipment.get("isManualRate"),
                        shipment.get("isInvoiceGenerated"),
                        shipment.get("isAllDocumentsVerified"),
                        shipment.get("shipmentHoldInfo") is not None,
                        shipment.get("proofOfDeliveryDetails") is not None,
                        _sum_items(charge.get("freightItems")),
                        _money(charge.get("fuelRate")),
                        _sum_items(charge.get("accessorialItems")),
                        _money(charge.get("totalRate")),
                        _currency(charge.get("totalRate")),
                        _sum_items(approved.get("freightItems")),
                        _money(approved.get("fuelRate")),
                        _money(approved.get("totalRate")),
                        self.run_id,
                    )
                )
                handling_units.extend(
                    self._handling_unit_rows(
                        shipment.get("handlingUnits"), "shipment", None, shipment_id
                    )
                )

            for transport in route.get("transports") or []:
                if not isinstance(transport, dict):
                    continue
                transport_id = uuid_or_none(transport.get("transportId"))
                if not transport_id:
                    continue
                leg_map = transport.get("legs") or {}
                transports.append(
                    (
                        transport_id,
                        text_or_none(transport.get("transportNumber")),
                        order_id,
                        uuid_or_none(transport.get("virtualTransportId")),
                        uuid_or_none(transport.get("originId")),
                        uuid_or_none(transport.get("destinationId")),
                        as_ts(transport.get("plannedStart")),
                        as_ts(transport.get("plannedEnd")),
                        as_ts(transport.get("actualStart")),
                        as_ts(transport.get("actualEnd")),
                        transport.get("isVirtual"),
                        transport.get("status"),
                        len(leg_map),
                        self.run_id,
                    )
                )

                for leg in leg_map.values():
                    if not isinstance(leg, dict):
                        continue
                    leg_number = leg.get("legNumber")
                    if leg_number is None:
                        continue
                    distance_value, distance_unit = measure(leg.get("distance"))
                    duration_value, _ = measure(leg.get("duration"))
                    from_stop = leg.get("from") or {}
                    to_stop = leg.get("to") or {}
                    legs.append(
                        (
                            transport_id,
                            leg_number,
                            uuid_or_none(from_stop.get("id")),
                            uuid_or_none(to_stop.get("id")),
                            distance_value,
                            distance_unit,
                            duration_value,
                            self.run_id,
                        )
                    )
                    for role, node in (("from", from_stop), ("to", to_stop)):
                        stop_row = self._stop_row(transport_id, leg_number, role, node)
                        if stop_row:
                            stops.append(stop_row)
                            events.extend(self._event_rows(transport_id, node))

        self._land(
            "tms_raw.tms_order",
            [
                "id", "order_number", "account_id", "origin_id", "destination_id",
                "bill_to_id", "carrier_id", "origin_care_of_contact_id",
                "dest_care_of_contact_id", "payment_term_id", "service_level_id",
                "shipment_type_id", "transportation_mode_id", "order_type", "status",
                "pickup_ready_date", "pickup_close_date", "pickup_instructions",
                "delivery_ready_date", "delivery_close_date", "delivery_instructions",
                "special_instructions", "trailer_number", "seal_number", "scac_number",
                "pro_number", "bol_number", "cod_amount", "declared_value", "units",
                "fee_terms", "trailer_loaded_by", "freight_counted_by",
                "has_scheduled_route", "route_is_complete", "view_type", "run_id",
            ],
            orders,
            ["id"],
        )
        self._land(
            "tms_raw.order_accessorial",
            ["order_id", "accessorial_id", "run_id"],
            accessorials,
            ["order_id", "accessorial_id"],
        )
        self._land(
            "tms_raw.order_reference",
            ["order_id", "seq", "ref_type", "ref_value", "run_id"],
            references,
            ["order_id", "seq"],
        )
        self._land(
            "tms_raw.shipment",
            [
                "shipment_id", "shipment_number", "order_id", "status", "is_manual_rate",
                "is_invoice_generated", "is_all_documents_verified", "has_hold", "has_pod",
                "freight_amount", "fuel_amount", "accessorial_amount", "total_rate_amount",
                "currency_id", "approved_freight_amount", "approved_fuel_amount",
                "approved_total_amount", "run_id",
            ],
            shipments,
            ["shipment_id"],
        )
        self._land(
            "tms_raw.transport",
            [
                "transport_id", "transport_number", "order_id", "virtual_transport_id",
                "origin_id", "destination_id", "planned_start", "planned_end",
                "actual_start", "actual_end", "is_virtual", "status", "leg_count", "run_id",
            ],
            transports,
            ["transport_id"],
        )
        self._land(
            "tms_raw.transport_stop",
            [
                "stop_id", "transport_id", "leg_number", "stop_role", "name", "identifier",
                "location_id", "arrival_begin", "arrival_end", "departure_begin",
                "departure_end", "cut_time", "actual_arrival", "actual_departure",
                "is_arrived", "is_departed", "run_id",
            ],
            stops,
            ["stop_id"],
        )
        # Legs reference stops, so they land after them.
        self._land(
            "tms_raw.transport_leg",
            [
                "transport_id", "leg_number", "from_stop_id", "to_stop_id",
                "distance_value", "distance_unit", "duration_seconds", "run_id",
            ],
            legs,
            ["transport_id", "leg_number"],
        )
        self._land(
            "tms_raw.stop_event",
            [
                "event_id", "stop_id", "transport_id", "event_type", "event_category",
                "window_start", "window_end", "shipment_number", "handling_unit_ids", "run_id",
            ],
            events,
            ["stop_id", "event_id", "event_category"],
        )
        # ux_handling_unit_natural is an expression index, which ON CONFLICT
        # cannot name, so duplicates are collapsed here instead. The same unit id
        # legitimately appears under more than one scope (an order unit is
        # re-stated on the route), and those are distinct rows by design.
        deduped = {
            (row[1], row[0], row[2] or row[3]): row for row in handling_units
        }
        self._land(
            "tms_raw.handling_unit",
            [
                "handling_unit_id", "scope", "order_id", "shipment_id", "quantity", "shape",
                "length_value", "length_unit", "width_value", "width_unit", "height_value",
                "height_unit", "diameter_value", "diameter_unit", "weight_value",
                "weight_unit", "nmfc_id", "nmfc_code", "description", "has_hazmat",
                "has_temperature_ctrl", "is_non_stackable", "run_id",
            ],
            list(deduped.values()),
        )

    def _stop_row(self, transport_id: str, leg_number: int, role: str, node: Any) -> tuple | None:
        if not isinstance(node, dict):
            return None
        stop_id = uuid_or_none(node.get("id"))
        if not stop_id:
            return None
        planned = node.get("plannedStopInfo") or {}
        actual = node.get("actualStopInfo") or {}
        return (
            stop_id,
            transport_id,
            leg_number,
            role,
            text_or_none(node.get("name")),
            text_or_none(node.get("identifier")),
            uuid_or_none(node.get("locationId")),
            as_ts(planned.get("arrivalBegin")),
            as_ts(planned.get("arrivalEnd")),
            as_ts(planned.get("departureBegin")),
            as_ts(planned.get("departureEnd")),
            as_ts(planned.get("cutTime")),
            as_ts(actual.get("arrivalBegin") or actual.get("actualArrival")),
            as_ts(actual.get("departureBegin") or actual.get("actualDeparture")),
            node.get("isArrived"),
            node.get("isDeparted"),
            self.run_id,
        )

    def _event_rows(self, transport_id: str, node: Any) -> list[tuple]:
        rows = []
        if not isinstance(node, dict):
            return rows
        stop_id = uuid_or_none(node.get("id"))
        if not stop_id:
            return rows
        for category, key in (("pickup", "pickups"), ("delivery", "deliveries")):
            for event in node.get(key) or []:
                if not isinstance(event, dict):
                    continue
                event_id = uuid_or_none(event.get("id"))
                if not event_id:
                    continue
                rows.append(
                    (
                        event_id,
                        stop_id,
                        transport_id,
                        event.get("type"),
                        category,
                        as_ts(event.get("start")),
                        as_ts(event.get("end")),
                        text_or_none(event.get("shipmentNumber")),
                        [u for u in (event.get("handlingUnitIds") or []) if uuid_or_none(u)],
                        self.run_id,
                    )
                )
        return rows

    def _handling_unit_rows(
        self, units: Any, scope: str, order_id: str | None, shipment_id: str | None
    ) -> list[tuple]:
        rows = []
        for unit in units or []:
            if not isinstance(unit, dict):
                continue
            unit_id = uuid_or_none(unit.get("handlingUnitId"))
            if not unit_id:
                continue
            dims = unit.get("dimensions") or {}
            length_v, length_u = measure(dims.get("length"))
            width_v, width_u = measure(dims.get("width"))
            height_v, height_u = measure(dims.get("height"))
            diameter_v, diameter_u = measure(dims.get("diameter"))
            weight_v, weight_u = measure(unit.get("weight"))
            rows.append(
                (
                    unit_id,
                    scope,
                    order_id,
                    shipment_id,
                    unit.get("quantity"),
                    dims.get("shape"),
                    length_v, length_u,
                    width_v, width_u,
                    height_v, height_u,
                    diameter_v, diameter_u,
                    weight_v, weight_u,
                    uuid_or_none(unit.get("nmfcId")),
                    text_or_none(unit.get("nmfcCode")),
                    text_or_none(unit.get("description")),
                    unit.get("hasHazmat"),
                    unit.get("hasTemperatureControl"),
                    unit.get("isNonStackable"),
                    self.run_id,
                )
            )
        return rows


def _money(node: Any) -> float | None:
    """Pull the amount out of a {amount, value, currencyId} money node."""
    if not isinstance(node, dict):
        return None
    amount = node.get("amount")
    if amount in (None, 0) and node.get("value") not in (None, 0):
        amount = node.get("value")
    try:
        return float(amount) if amount is not None else None
    except (TypeError, ValueError):
        return None


def _currency(node: Any) -> str | None:
    if not isinstance(node, dict):
        return None
    return uuid_or_none(node.get("currencyId"))


def _sum_items(items: Any) -> float | None:
    """Total a list of {name, amount:{...}} charge lines."""
    if not isinstance(items, list) or not items:
        return None
    total = 0.0
    seen = False
    for item in items:
        if not isinstance(item, dict):
            continue
        value = _money(item.get("amount")) if isinstance(item.get("amount"), dict) else _money(item)
        if value is not None:
            total += value
            seen = True
    return total if seen else None


def run_ingest(conn: psycopg.Connection, force: bool = False) -> dict[str, Any]:
    """Land every recognised file under the source directory."""
    source_dir = CONFIG.source_dir
    if not os.path.isdir(source_dir):
        raise RuntimeError(
            f"Source directory {source_dir} does not exist. "
            "docker-compose mounts TMS_MCP/api_responses there; check the volume."
        )

    already = count_rows(conn, "tms_raw.tms_order")
    if already and not force:
        log.info("tms_raw.tms_order already holds %s rows; skipping ingest (use --force).", already)
        return {"skipped": True, "orders": already}

    if already:
        log.info("Re-ingest requested; clearing %s raw tables.", len(RAW_TABLES))
        truncate(conn, RAW_TABLES)

    ingestor = Ingestor(conn, source_dir)
    ingestor.start()
    try:
        ingestor.run()
    except Exception as exc:
        ingestor.finish("failed", str(exc))
        conn.commit()
        raise
    ingestor.finish("success")
    conn.commit()

    log.info(
        "Ingest complete: %s files, %s rows across %s tables.",
        ingestor.files_processed,
        ingestor.rows_landed,
        len(ingestor.table_counts),
    )
    for table, count in sorted(ingestor.table_counts.items()):
        log.info("    %-38s %6d", table, count)

    return {
        "skipped": False,
        "run_id": ingestor.run_id,
        "files": ingestor.files_processed,
        "rows": ingestor.rows_landed,
        "table_counts": ingestor.table_counts,
    }
