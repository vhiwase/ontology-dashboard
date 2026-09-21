-- ============================================================================
--  TMS Ontology Platform - Layer 1: RAW LANDING SCHEMA
--  ---------------------------------------------------------------------------
--  Mirrors the shape of the TMS REST payloads captured under
--  TMS_MCP/api_responses. Nothing here is modelled for analytics: every table
--  is a faithful landing zone so the pipeline can be re-run idempotently and
--  so lineage can point at a concrete physical origin for every ontology
--  property.
--
--  Layer 2 (02_views.sql) reshapes these into the semantic views that the
--  ontology object types are generated from.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS tms_raw;
CREATE SCHEMA IF NOT EXISTS tms_views;
CREATE SCHEMA IF NOT EXISTS platform;

SET search_path = tms_raw, public;

-- --- Pipeline bookkeeping --------------------------------------------------
-- One row per pipeline run. Every landed row carries the run that produced it,
-- which is what makes the lineage graph in platform.lineage_node real rather
-- than decorative.
CREATE TABLE IF NOT EXISTS ingest_run (
    run_id          BIGSERIAL PRIMARY KEY,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    status          TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','success','failed')),
    source_dir      TEXT,
    files_processed INTEGER NOT NULL DEFAULT 0,
    rows_landed     INTEGER NOT NULL DEFAULT 0,
    error_message   TEXT,
    details         JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- One row per source file consumed, so a view column can be traced back to the
-- exact HTTP endpoint it originated from.
CREATE TABLE IF NOT EXISTS ingest_source (
    source_id     BIGSERIAL PRIMARY KEY,
    run_id        BIGINT NOT NULL REFERENCES ingest_run(run_id) ON DELETE CASCADE,
    endpoint_name TEXT NOT NULL,
    url           TEXT,
    http_method   TEXT,
    status_code   INTEGER,
    file_name     TEXT NOT NULL,
    record_count  INTEGER NOT NULL DEFAULT 0,
    target_tables TEXT[] NOT NULL DEFAULT '{}',
    ingested_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --- Reference / enum lookups ---------------------------------------------
-- Codes and labels are taken from TMS_MCP/scripts/tms_models.py where that file
-- documents them. The captured payloads contain codes beyond the documented
-- range (shipment status up to 11, transport status up to 8); those labels are
-- inferred from standard TMS lifecycle naming and carry is_inferred = true so
-- nothing downstream presents a guess as fact.
CREATE TABLE IF NOT EXISTS ref_entity_type (
    code        INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT
);

CREATE TABLE IF NOT EXISTS ref_order_status (
    code        INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    is_inferred BOOLEAN NOT NULL DEFAULT false,
    is_terminal BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS ref_shipment_status (
    code        INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    is_inferred BOOLEAN NOT NULL DEFAULT false,
    is_terminal BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS ref_transport_status (
    code        INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    is_inferred BOOLEAN NOT NULL DEFAULT false,
    is_terminal BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS ref_order_type (
    code INTEGER PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ref_country (
    code INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    iso2 TEXT
);

CREATE TABLE IF NOT EXISTS ref_association (
    code        INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT
);

CREATE TABLE IF NOT EXISTS ref_stop_event_type (
    code INTEGER PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ref_shape (
    code INTEGER PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ref_phone_type (
    code INTEGER PRIMARY KEY,
    name TEXT NOT NULL
);

-- --- Tenancy and accounts -------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant (
    id                 UUID PRIMARY KEY,
    name               TEXT,
    alias              TEXT,
    display_id         TEXT,
    general_email      TEXT,
    general_phone      TEXT,
    general_phone_type INTEGER,
    street_address     TEXT,
    city               TEXT,
    province_state     TEXT,
    postal_zip_code    TEXT,
    country_code       INTEGER,
    latitude           DOUBLE PRECISION,
    longitude          DOUBLE PRECISION,
    logo_url           TEXT,
    description        TEXT,
    iana_timezone      TEXT,
    is_active          BOOLEAN,
    run_id             BIGINT REFERENCES ingest_run(run_id)
);

CREATE TABLE IF NOT EXISTS account (
    id               UUID PRIMARY KEY,
    tenant_id        UUID,
    name             TEXT,
    alias            TEXT,
    display_id       TEXT,
    general_email    TEXT,
    general_phone    TEXT,
    street_address   TEXT,
    city             TEXT,
    province_state   TEXT,
    postal_zip_code  TEXT,
    country_code     INTEGER,
    latitude         DOUBLE PRECISION,
    longitude        DOUBLE PRECISION,
    logo_url         TEXT,
    description      TEXT,
    iana_timezone    TEXT,
    is_active        BOOLEAN,
    entity_type_mask INTEGER,
    run_id           BIGINT REFERENCES ingest_run(run_id)
);

-- --- Business entities (the TMS party master) ------------------------------
-- A single physical party carries a bitmask of roles (Carrier|Location|...),
-- which is why entity_type_mask is kept alongside the exploded role rows.
CREATE TABLE IF NOT EXISTS business_entity (
    id                 UUID PRIMARY KEY,
    tenant_id          UUID,
    name               TEXT,
    alias              TEXT,
    display_id         TEXT,
    entity_type_mask   INTEGER NOT NULL DEFAULT 0,
    general_email      TEXT,
    general_phone      TEXT,
    general_phone_type INTEGER,
    street_address     TEXT,
    city               TEXT,
    province_state     TEXT,
    postal_zip_code    TEXT,
    country_code       INTEGER,
    latitude           DOUBLE PRECISION,
    longitude          DOUBLE PRECISION,
    logo_url           TEXT,
    description        TEXT,
    iana_timezone      TEXT,
    is_active          BOOLEAN,
    electronic_ref_id  TEXT,
    is_open_24_hours   BOOLEAN,
    is_custom_hours    BOOLEAN,
    source_entity_type INTEGER,   -- the entityType= query param it arrived under
    run_id             BIGINT REFERENCES ingest_run(run_id)
);

CREATE TABLE IF NOT EXISTS business_entity_role (
    entity_id   UUID NOT NULL REFERENCES business_entity(id) ON DELETE CASCADE,
    role_name   TEXT NOT NULL,
    entity_type INTEGER NOT NULL,
    settings_id UUID,
    run_id      BIGINT REFERENCES ingest_run(run_id),
    PRIMARY KEY (entity_id, role_name)
);

CREATE TABLE IF NOT EXISTS business_entity_contact (
    contact_id   UUID NOT NULL,
    entity_id    UUID NOT NULL,
    whole_name   TEXT,
    title        TEXT,
    email        TEXT,
    phone_number TEXT,
    is_primary   BOOLEAN,
    relationship INTEGER,
    run_id       BIGINT REFERENCES ingest_run(run_id),
    PRIMARY KEY (entity_id, contact_id)
);

-- The declared parent/child graph between parties. This is the backbone that
-- the ontology's org-hierarchy link types are generated from.
CREATE TABLE IF NOT EXISTS business_entity_relationship (
    id                 UUID PRIMARY KEY,
    parent_id          UUID,
    parent_entity_type INTEGER,
    parent_descriptor  TEXT,
    child_id           UUID,
    child_entity_type  INTEGER,
    child_descriptor   TEXT,
    association        INTEGER,
    run_id             BIGINT REFERENCES ingest_run(run_id)
);

-- --- Configuration masters ------------------------------------------------
CREATE TABLE IF NOT EXISTS transportation_mode (
    id                   INTEGER PRIMARY KEY,
    display_name         TEXT,
    tender_response_time INTERVAL,
    edi_codes            TEXT,
    is_active            BOOLEAN,
    run_id               BIGINT REFERENCES ingest_run(run_id)
);

CREATE TABLE IF NOT EXISTS unit_of_measure (
    id         UUID PRIMARY KEY,
    category   TEXT,
    unit       TEXT,
    symbol     TEXT,
    is_active  BOOLEAN,
    is_default BOOLEAN,
    run_id     BIGINT REFERENCES ingest_run(run_id)
);

CREATE TABLE IF NOT EXISTS app_user (
    id           UUID PRIMARY KEY,
    contact_id   UUID,
    language_id  UUID,
    time_zone_id UUID,
    version      INTEGER,
    event_count  INTEGER,
    role_ids     UUID[],
    location_ids UUID[],
    run_id       BIGINT REFERENCES ingest_run(run_id)
);

-- --- Orders ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tms_order (
    id                        UUID PRIMARY KEY,
    order_number              TEXT,
    account_id                UUID,
    origin_id                 UUID,
    destination_id            UUID,
    bill_to_id                UUID,
    carrier_id                UUID,
    origin_care_of_contact_id UUID,
    dest_care_of_contact_id   UUID,
    payment_term_id           UUID,
    service_level_id          UUID,
    shipment_type_id          UUID,
    transportation_mode_id    INTEGER,
    order_type                INTEGER,
    status                    INTEGER,
    pickup_ready_date         TIMESTAMPTZ,
    pickup_close_date         TIMESTAMPTZ,
    pickup_instructions       TEXT,
    delivery_ready_date       TIMESTAMPTZ,
    delivery_close_date       TIMESTAMPTZ,
    delivery_instructions     TEXT,
    special_instructions      TEXT,
    trailer_number            TEXT,
    seal_number               TEXT,
    scac_number               TEXT,
    pro_number                TEXT,
    bol_number                TEXT,
    cod_amount                NUMERIC(18,4),
    declared_value            NUMERIC(18,4),
    units                     INTEGER,
    fee_terms                 INTEGER,
    trailer_loaded_by         INTEGER,
    freight_counted_by        INTEGER,
    has_scheduled_route       BOOLEAN NOT NULL DEFAULT false,
    route_is_complete         BOOLEAN,
    view_type                 INTEGER,
    run_id                    BIGINT REFERENCES ingest_run(run_id)
);

CREATE TABLE IF NOT EXISTS order_accessorial (
    order_id       UUID NOT NULL,
    accessorial_id UUID NOT NULL,
    run_id         BIGINT REFERENCES ingest_run(run_id),
    PRIMARY KEY (order_id, accessorial_id)
);

CREATE TABLE IF NOT EXISTS order_reference (
    order_id  UUID NOT NULL,
    seq       INTEGER NOT NULL,
    ref_type  TEXT,
    ref_value TEXT,
    run_id    BIGINT REFERENCES ingest_run(run_id),
    PRIMARY KEY (order_id, seq)
);

-- --- Handling units -------------------------------------------------------
-- Handling units appear in three places in the payload: on the order, on the
-- shipment, and on the scheduled route. `scope` keeps them distinguishable
-- rather than silently collapsing three different business meanings. The
-- natural key needs COALESCE over two owner columns, which a PRIMARY KEY
-- cannot express, so the uniqueness lives in an expression index instead.
CREATE TABLE IF NOT EXISTS handling_unit (
    row_id               BIGSERIAL PRIMARY KEY,
    handling_unit_id     UUID NOT NULL,
    scope                TEXT NOT NULL CHECK (scope IN ('order','shipment','route')),
    order_id             UUID,
    shipment_id          UUID,
    quantity             INTEGER,
    shape                INTEGER,
    length_value         DOUBLE PRECISION,
    length_unit          TEXT,
    width_value          DOUBLE PRECISION,
    width_unit           TEXT,
    height_value         DOUBLE PRECISION,
    height_unit          TEXT,
    diameter_value       DOUBLE PRECISION,
    diameter_unit        TEXT,
    weight_value         DOUBLE PRECISION,
    weight_unit          TEXT,
    nmfc_id              UUID,
    nmfc_code            TEXT,
    description          TEXT,
    has_hazmat           BOOLEAN,
    has_temperature_ctrl BOOLEAN,
    is_non_stackable     BOOLEAN,
    run_id               BIGINT REFERENCES ingest_run(run_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_handling_unit_natural
    ON handling_unit (scope, handling_unit_id, COALESCE(order_id, shipment_id));

-- --- Shipments ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shipment (
    shipment_id               UUID PRIMARY KEY,
    shipment_number           TEXT,
    order_id                  UUID,
    status                    INTEGER,
    is_manual_rate            BOOLEAN,
    is_invoice_generated      BOOLEAN,
    is_all_documents_verified BOOLEAN,
    has_hold                  BOOLEAN,
    has_pod                   BOOLEAN,
    freight_amount            NUMERIC(18,4),
    fuel_amount               NUMERIC(18,4),
    accessorial_amount        NUMERIC(18,4),
    total_rate_amount         NUMERIC(18,4),
    currency_id               UUID,
    approved_freight_amount   NUMERIC(18,4),
    approved_fuel_amount      NUMERIC(18,4),
    approved_total_amount     NUMERIC(18,4),
    run_id                    BIGINT REFERENCES ingest_run(run_id)
);

-- --- Transports, legs, stops, stop events ---------------------------------
CREATE TABLE IF NOT EXISTS transport (
    transport_id         UUID PRIMARY KEY,
    transport_number     TEXT,
    order_id             UUID,
    virtual_transport_id UUID,
    origin_id            UUID,
    destination_id       UUID,
    planned_start        TIMESTAMPTZ,
    planned_end          TIMESTAMPTZ,
    actual_start         TIMESTAMPTZ,
    actual_end           TIMESTAMPTZ,
    is_virtual           BOOLEAN,
    status               INTEGER,
    leg_count            INTEGER NOT NULL DEFAULT 0,
    run_id               BIGINT REFERENCES ingest_run(run_id)
);

CREATE TABLE IF NOT EXISTS transport_leg (
    transport_id     UUID NOT NULL,
    leg_number       INTEGER NOT NULL,
    from_stop_id     UUID,
    to_stop_id       UUID,
    distance_value   DOUBLE PRECISION,
    distance_unit    TEXT,
    duration_seconds DOUBLE PRECISION,
    run_id           BIGINT REFERENCES ingest_run(run_id),
    PRIMARY KEY (transport_id, leg_number)
);

CREATE TABLE IF NOT EXISTS transport_stop (
    stop_id          UUID PRIMARY KEY,
    transport_id     UUID NOT NULL,
    leg_number       INTEGER NOT NULL,
    stop_role        TEXT NOT NULL CHECK (stop_role IN ('from','to')),
    name             TEXT,
    identifier       TEXT,
    location_id      UUID,
    arrival_begin    TIMESTAMPTZ,
    arrival_end      TIMESTAMPTZ,
    departure_begin  TIMESTAMPTZ,
    departure_end    TIMESTAMPTZ,
    cut_time         TIMESTAMPTZ,
    actual_arrival   TIMESTAMPTZ,
    actual_departure TIMESTAMPTZ,
    is_arrived       BOOLEAN,
    is_departed      BOOLEAN,
    run_id           BIGINT REFERENCES ingest_run(run_id)
);

CREATE TABLE IF NOT EXISTS stop_event (
    event_id          UUID NOT NULL,
    stop_id           UUID NOT NULL,
    transport_id      UUID,
    event_type        INTEGER,   -- 1 = pickup, 2 = delivery
    event_category    TEXT NOT NULL CHECK (event_category IN ('pickup','delivery')),
    window_start      TIMESTAMPTZ,
    window_end        TIMESTAMPTZ,
    shipment_number   TEXT,
    handling_unit_ids UUID[],
    run_id            BIGINT REFERENCES ingest_run(run_id),
    PRIMARY KEY (stop_id, event_id, event_category)
);

-- --- Indexes the generated views and KPI queries actually use -------------
CREATE INDEX IF NOT EXISTS ix_be_entity_type_mask ON business_entity (entity_type_mask);
CREATE INDEX IF NOT EXISTS ix_be_tenant           ON business_entity (tenant_id);
CREATE INDEX IF NOT EXISTS ix_be_role_type        ON business_entity_role (entity_type);
CREATE INDEX IF NOT EXISTS ix_ber_parent          ON business_entity_relationship (parent_id);
CREATE INDEX IF NOT EXISTS ix_ber_child           ON business_entity_relationship (child_id);
CREATE INDEX IF NOT EXISTS ix_order_account       ON tms_order (account_id);
CREATE INDEX IF NOT EXISTS ix_order_origin        ON tms_order (origin_id);
CREATE INDEX IF NOT EXISTS ix_order_destination   ON tms_order (destination_id);
CREATE INDEX IF NOT EXISTS ix_order_bill_to       ON tms_order (bill_to_id);
CREATE INDEX IF NOT EXISTS ix_order_pickup_ready  ON tms_order (pickup_ready_date);
CREATE INDEX IF NOT EXISTS ix_shipment_order      ON shipment (order_id);
CREATE INDEX IF NOT EXISTS ix_shipment_number     ON shipment (shipment_number);
CREATE INDEX IF NOT EXISTS ix_transport_order     ON transport (order_id);
CREATE INDEX IF NOT EXISTS ix_transport_origin    ON transport (origin_id);
CREATE INDEX IF NOT EXISTS ix_transport_dest      ON transport (destination_id);
CREATE INDEX IF NOT EXISTS ix_stop_transport      ON transport_stop (transport_id);
CREATE INDEX IF NOT EXISTS ix_stop_location       ON transport_stop (location_id);
CREATE INDEX IF NOT EXISTS ix_stop_event_shipment ON stop_event (shipment_number);
CREATE INDEX IF NOT EXISTS ix_hu_order            ON handling_unit (order_id);
CREATE INDEX IF NOT EXISTS ix_hu_shipment         ON handling_unit (shipment_id);
