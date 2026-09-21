-- ============================================================================
--  TMS Ontology Platform - Layer 1c: EXECUTION SIMULATION SCHEMA
--  ---------------------------------------------------------------------------
--  WHY THIS SCHEMA EXISTS
--
--  The captured snapshot in TMS_MCP/api_responses is a *planning* snapshot. It
--  was verified to contain:
--      - 0 of 61 transports with actualStart / actualEnd
--      - 0 of 122 stops with actualStopInfo (every isArrived = false)
--      - 0 of 61 legs with a non-zero distance
--      - 14 of 61 shipments with a charge
--      - 0 of 90 orders with a carrierId
--
--  That means on-time performance, transit-time, cost-per-km and carrier
--  scorecard KPIs - the questions a TMS business user actually asks - cannot be
--  computed from the snapshot alone.
--
--  Rather than silently inventing values inside the raw tables, execution
--  actuals live here, in their own schema, generated deterministically from a
--  fixed seed. tms_views joins them in and every affected view exposes a
--  data_origin column ('api' or 'simulated'), so a dashboard, an LLM answer and
--  the lineage graph can all tell measured facts from simulated ones.
--
--  Disable it entirely with PIPELINE_SIMULATE_EXECUTION=false; the views keep
--  working and simply report has_actuals = false everywhere.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS tms_sim;

SET search_path = tms_sim, public;

-- One row per simulation pass, so the generated values are reproducible and
-- attributable in the lineage graph.
CREATE TABLE IF NOT EXISTS sim_run (
    sim_run_id  BIGSERIAL PRIMARY KEY,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    seed        INTEGER NOT NULL,
    ingest_run  BIGINT,
    profile     TEXT NOT NULL DEFAULT 'default',
    notes       TEXT,
    details     JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Transport-level execution: when the truck actually rolled and closed, and
-- which carrier took the load.
CREATE TABLE IF NOT EXISTS transport_actual (
    transport_id  UUID PRIMARY KEY,
    sim_run_id    BIGINT NOT NULL REFERENCES sim_run(sim_run_id) ON DELETE CASCADE,
    actual_start  TIMESTAMPTZ,
    actual_end    TIMESTAMPTZ,
    carrier_id    UUID,
    carrier_name  TEXT,
    scac          TEXT,
    total_km      DOUBLE PRECISION,
    linehaul_cost NUMERIC(18,4),
    fuel_cost     NUMERIC(18,4),
    accessorial_cost NUMERIC(18,4),
    total_cost    NUMERIC(18,4),
    currency_code TEXT NOT NULL DEFAULT 'USD'
);

-- Stop-level execution: arrival and departure against the planned window. This
-- is what on-time pickup / on-time delivery are measured from.
CREATE TABLE IF NOT EXISTS stop_actual (
    stop_id           UUID PRIMARY KEY,
    sim_run_id        BIGINT NOT NULL REFERENCES sim_run(sim_run_id) ON DELETE CASCADE,
    actual_arrival    TIMESTAMPTZ,
    actual_departure  TIMESTAMPTZ,
    is_arrived        BOOLEAN NOT NULL DEFAULT false,
    is_departed       BOOLEAN NOT NULL DEFAULT false,
    dwell_minutes     DOUBLE PRECISION,
    -- Signed minutes against the planned arrival window: negative = early,
    -- 0 = inside the window, positive = late.
    arrival_variance_minutes DOUBLE PRECISION,
    exception_code    TEXT
);

-- Leg distance, because every captured leg reported LengthUnit.Meter = 0. The
-- value is the great-circle distance between the two stop locations times a
-- road-circuity factor, so lane distances are at least geographically sane.
CREATE TABLE IF NOT EXISTS leg_distance (
    transport_id     UUID NOT NULL,
    leg_number       INTEGER NOT NULL,
    sim_run_id       BIGINT NOT NULL REFERENCES sim_run(sim_run_id) ON DELETE CASCADE,
    haversine_km     DOUBLE PRECISION,
    circuity_factor  DOUBLE PRECISION,
    road_km          DOUBLE PRECISION,
    PRIMARY KEY (transport_id, leg_number)
);

-- Charges for the shipments the snapshot left unrated, so freight-spend KPIs
-- have a full denominator. Shipments that already carry a charge from the API
-- are NOT overwritten - the pipeline skips them and the view prefers the API
-- value.
CREATE TABLE IF NOT EXISTS shipment_charge (
    shipment_id         UUID PRIMARY KEY,
    sim_run_id          BIGINT NOT NULL REFERENCES sim_run(sim_run_id) ON DELETE CASCADE,
    freight_amount      NUMERIC(18,4),
    fuel_amount         NUMERIC(18,4),
    accessorial_amount  NUMERIC(18,4),
    total_rate_amount   NUMERIC(18,4),
    currency_code       TEXT NOT NULL DEFAULT 'USD',
    rate_basis          TEXT
);

CREATE INDEX IF NOT EXISTS ix_sim_transport_carrier ON transport_actual (carrier_id);
CREATE INDEX IF NOT EXISTS ix_sim_stop_variance     ON stop_actual (arrival_variance_minutes);
