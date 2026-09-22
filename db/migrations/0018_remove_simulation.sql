-- ============================================================================
--  0018: the views stop reading generated data, and tms_sim is removed.
--
--  0017 and before left tms_sim in place but empty: simulation was off, so
--  every column sourced from it resolved to NULL. That was honest on screen
--  and dishonest in the schema. A column like v_transport.carrier_name or
--  v_transport.total_cost could ONLY ever hold an invented value - the
--  snapshot carries no carrierId and no transport cost at all - so leaving it
--  in place is an invitation to fill it in later.
--
--  Two kinds of column were treated differently, deliberately:
--
--    * COALESCE(source, simulated) - the source operand is kept and the
--      simulated one dropped. actual_start_at, total_distance_km and
--      charge_per_kg are NULL today and become real the moment the TMS starts
--      sending actuals. These are genuine columns awaiting genuine data.
--
--    * simulated-only - removed outright. carrier_key, carrier_name,
--      carrier_scac, linehaul_cost, fuel_cost, accessorial_cost, total_cost,
--      cost_per_km, arrival_variance_minutes, dwell_minutes, is_on_time,
--      straight_line_km and circuity_factor have no source operand. Nothing
--      real could ever populate them.
--
--  Three KPI views are dropped entirely because every metric they fed was
--  withdrawn: the carrier scorecard, on-time performance and the account
--  scorecard were composed wholly of generated figures.
-- ============================================================================

-- Dropped rather than replaced: CREATE OR REPLACE VIEW cannot remove a column,
-- and these lose several. CASCADE takes the dependent KPI views with them;
-- 05_kpi_views.sql recreates the ones that still have real metrics behind them.
DROP VIEW IF EXISTS tms_views.v_kpi_carrier_scorecard   CASCADE;
DROP VIEW IF EXISTS tms_views.v_kpi_on_time_performance CASCADE;
DROP VIEW IF EXISTS tms_views.v_kpi_account_scorecard   CASCADE;
DROP VIEW IF EXISTS tms_views.v_stop_event      CASCADE;
DROP VIEW IF EXISTS tms_views.v_transport_stop  CASCADE;
DROP VIEW IF EXISTS tms_views.v_transport_leg   CASCADE;
DROP VIEW IF EXISTS tms_views.v_transport       CASCADE;
DROP VIEW IF EXISTS tms_views.v_shipment        CASCADE;

CREATE OR REPLACE VIEW tms_views.v_shipment AS
WITH hu AS (
    SELECT shipment_id,
           sum(quantity) AS piece_count,
           sum(tms_raw.to_kilograms(weight_value, weight_unit)
               * GREATEST(COALESCE(quantity, 1), 1)) AS gross_weight_kg,
           count(*) AS handling_unit_count,
           bool_or(COALESCE(has_hazmat, false)) AS has_hazmat
    FROM tms_raw.handling_unit
    WHERE scope = 'shipment' AND shipment_id IS NOT NULL
    GROUP BY shipment_id
),
ev AS (
    -- Stop events are keyed by shipment_number, not shipment_id, in the source
    -- payload; this is the only place that join is made.
    SELECT shipment_number,
           min(window_start) FILTER (WHERE event_category = 'pickup')   AS planned_pickup_at,
           max(window_end)   FILTER (WHERE event_category = 'delivery') AS planned_delivery_at,
           count(*) FILTER (WHERE event_category = 'pickup')   AS pickup_event_count,
           count(*) FILTER (WHERE event_category = 'delivery') AS delivery_event_count
    FROM tms_raw.stop_event
    WHERE shipment_number IS NOT NULL
    GROUP BY shipment_number
)
SELECT
    s.shipment_id                           AS shipment_key,
    s.shipment_number                       AS title_property,
    s.shipment_number                       AS shipment_number,
    s.order_id                              AS order_key,
    o.order_number                          AS order_number,
    o.account_key                           AS account_key,
    o.account_name                          AS account_name,
    o.origin_location_key                   AS origin_location_key,
    o.origin_name                           AS origin_name,
    o.destination_location_key              AS destination_location_key,
    o.destination_name                      AS destination_name,
    o.lane                                  AS lane,
    o.bill_to_key                           AS bill_to_key,
    o.bill_to_name                          AS bill_to_name,
    o.transportation_mode                   AS transportation_mode,
    s.status                                AS status_code,
    ss.name                                 AS shipment_status,
    COALESCE(ss.is_terminal, false)         AS is_closed,
    COALESCE(ss.is_inferred, false)         AS status_label_is_inferred,
    COALESCE(s.is_manual_rate, false)       AS is_manual_rate,
    COALESCE(s.is_invoice_generated, false) AS is_invoiced,
    COALESCE(s.is_all_documents_verified, false) AS are_documents_verified,
    COALESCE(s.has_hold, false)             AS is_on_hold,
    COALESCE(s.has_pod, false)              AS has_proof_of_delivery,
    -- Charges: the API value wins wherever it exists; the simulated charge only
    -- fills the 47 of 61 shipments the snapshot left unrated.
    -- The rated amounts, straight from the snapshot. 14 of 61 shipments carry
    -- them; the other 47 are NULL because the source never rated them, and are
    -- no longer topped up with a generated rate.
    s.total_rate_amount                     AS total_charge,
    s.freight_amount                        AS freight_charge,
    s.fuel_amount                           AS fuel_charge,
    s.accessorial_amount                    AS accessorial_charge,
    -- The snapshot carries a currency_id, not a code, and no reference table
    -- to resolve it. Reported as-is rather than assumed to be USD.
    s.currency_id                           AS currency_key,
    (s.total_rate_amount IS NOT NULL)       AS is_rated_in_source,
    ev.planned_pickup_at                    AS planned_pickup_at,
    ev.planned_delivery_at                  AS planned_delivery_at,
    COALESCE(ev.pickup_event_count, 0)      AS pickup_event_count,
    COALESCE(ev.delivery_event_count, 0)    AS delivery_event_count,
    COALESCE(hu.piece_count, 0)             AS piece_count,
    ROUND(COALESCE(hu.gross_weight_kg, 0)::numeric, 2) AS gross_weight_kg,
    COALESCE(hu.handling_unit_count, 0)     AS handling_unit_count,
    COALESCE(hu.has_hazmat, false)          AS has_hazmat,
    -- Cost per kilo is the headline unit-economics metric for a 3PL; NULLIF
    -- guards the zero-weight shipments the snapshot contains.
    ROUND((s.total_rate_amount
           / NULLIF(hu.gross_weight_kg, 0))::numeric, 4) AS charge_per_kg,
    -- Only two outcomes now: the snapshot rated this shipment, or it did not.
    -- 14 of 61 are rated; the rest are honestly unrated rather than filled in.
    CASE WHEN s.total_rate_amount IS NOT NULL THEN 'api'
         ELSE 'unrated' END                  AS charge_origin,
    'api'::text                              AS data_origin
FROM tms_raw.shipment s
LEFT JOIN tms_views.v_order o        ON o.order_key = s.order_id
LEFT JOIN tms_raw.ref_shipment_status ss ON ss.code = s.status
LEFT JOIN hu ON hu.shipment_id = s.shipment_id
LEFT JOIN ev ON ev.shipment_number = s.shipment_number;

COMMENT ON VIEW tms_views.v_shipment IS
'Shipment: the rated and invoiceable unit of freight carved out of an order.';

-- ===========================================================================
--  TRANSPORT / LEG / STOP / EVENT  (the execution chain)
-- ===========================================================================

CREATE OR REPLACE VIEW tms_views.v_transport AS
WITH legs AS (
    SELECT l.transport_id,
           count(*) AS leg_count,
           -- Summed from the source only. Every captured leg reports 0 m, so
           -- this is NULL today and becomes real the moment the TMS sends a
           -- distance. It is no longer back-filled with an estimate.
           sum(tms_raw.to_kilometres(l.distance_value, l.distance_unit)) AS total_km
    FROM tms_raw.transport_leg l
    GROUP BY l.transport_id
),
stops AS (
    SELECT ts.transport_id,
           count(*) AS stop_count,
           count(*) FILTER (WHERE COALESCE(ts.is_arrived, false)) AS arrived_stop_count
           -- all_stops_on_time, worst_arrival_variance_minutes and
           -- avg_dwell_minutes are gone: no stop in the snapshot has been
           -- arrived at, so punctuality cannot be computed from real data.
    FROM tms_raw.transport_stop ts
    GROUP BY ts.transport_id
)
SELECT
    t.transport_id                          AS transport_key,
    t.transport_number                      AS title_property,
    t.transport_number                      AS transport_number,
    t.order_id                              AS order_key,
    o.order_number                          AS order_number,
    o.account_key                           AS account_key,
    o.account_name                          AS account_name,
    t.origin_id                             AS origin_location_key,
    org.entity_name                         AS origin_name,
    org.city                                AS origin_city,
    org.province_state                      AS origin_state,
    t.destination_id                        AS destination_location_key,
    dst.entity_name                         AS destination_name,
    dst.city                                AS destination_city,
    dst.province_state                      AS destination_state,
    o.lane                                  AS lane,
    o.transportation_mode                   AS transportation_mode,
    t.status                                AS status_code,
    tstat.name                              AS transport_status,
    COALESCE(tstat.is_terminal, false)      AS is_closed,
    COALESCE(tstat.is_inferred, false)      AS status_label_is_inferred,
    COALESCE(t.is_virtual, false)           AS is_virtual,
    t.planned_start                         AS planned_start_at,
    t.planned_end                           AS planned_end_at,
    t.actual_start                          AS actual_start_at,
    t.actual_end                            AS actual_end_at,
    t.planned_start::date                   AS planned_start_date,
    date_trunc('week',  t.planned_start)::date  AS planned_start_week,
    date_trunc('month', t.planned_start)::date  AS planned_start_month,
    EXTRACT(EPOCH FROM (t.actual_end - t.actual_start)) / 3600.0
                                            AS actual_transit_hours,
    EXTRACT(EPOCH FROM (t.planned_end - t.planned_start)) / 3600.0
                                            AS planned_transit_hours,
    -- Departure and arrival variance in hours, positive = late.
    EXTRACT(EPOCH FROM (t.actual_start - t.planned_start)) / 3600.0
                                            AS departure_variance_hours,
    -- carrier_key / carrier_name / carrier_scac, the four cost columns and
    -- cost_per_km are GONE. Unlike the columns above they had no source
    -- operand at all: the snapshot carries no carrierId and no transport cost,
    -- so those columns could only ever hold a generated number. A column that
    -- can never be real is a trap, not a placeholder.
    ROUND(legs.total_km::numeric, 2)        AS total_distance_km,
    COALESCE(legs.leg_count, t.leg_count, 0) AS leg_count,
    COALESCE(stops.stop_count, 0)           AS stop_count,
    COALESCE(stops.arrived_stop_count, 0)   AS arrived_stop_count,
    (t.actual_start IS NOT NULL)            AS has_actuals,
    CASE WHEN t.actual_start IS NOT NULL THEN 'api'
         ELSE 'planned_only' END            AS execution_origin,
    'api'::text                             AS data_origin
FROM tms_raw.transport t
LEFT JOIN tms_views.v_order o            ON o.order_key = t.order_id
LEFT JOIN tms_views.v_business_entity org ON org.business_entity_key = t.origin_id
LEFT JOIN tms_views.v_business_entity dst ON dst.business_entity_key = t.destination_id
LEFT JOIN tms_raw.ref_transport_status tstat ON tstat.code = t.status
LEFT JOIN legs  ON legs.transport_id  = t.transport_id
LEFT JOIN stops ON stops.transport_id = t.transport_id;

COMMENT ON VIEW tms_views.v_transport IS
'Transport: the physical move. Carries the execution actuals and the cost of moving the freight.';

CREATE OR REPLACE VIEW tms_views.v_transport_leg AS
SELECT
    l.transport_id::text || ':' || l.leg_number::text AS transport_leg_key,
    t.transport_number || ' leg ' || l.leg_number     AS title_property,
    l.transport_id                  AS transport_key,
    t.transport_number              AS transport_number,
    l.leg_number                    AS leg_number,
    l.from_stop_id                  AS from_transport_stop_key,
    fs.name                         AS from_stop_name,
    fs.location_id                  AS from_location_key,
    l.to_stop_id                    AS to_transport_stop_key,
    ts2.name                        AS to_stop_name,
    ts2.location_id                 AS to_location_key,
    -- Every captured leg reports 0 m, so this is almost always NULL. It stays
    -- because the column is real: it populates the moment the source sends a
    -- distance. straight_line_km and circuity_factor are gone - both were
    -- computed from demo coordinates that are not geographically coherent.
    ROUND(tms_raw.to_kilometres(l.distance_value, l.distance_unit)::numeric, 2) AS distance_km,
    l.duration_seconds / 3600.0     AS planned_duration_hours,
    fs.departure_begin              AS planned_departure_at,
    ts2.arrival_begin               AS planned_arrival_at,
    CASE WHEN COALESCE(l.distance_value, 0) > 0 THEN 'api'
         ELSE 'unknown' END         AS distance_origin,
    'api'::text                     AS data_origin
FROM tms_raw.transport_leg l
JOIN tms_raw.transport t        ON t.transport_id = l.transport_id
LEFT JOIN tms_raw.transport_stop fs  ON fs.stop_id = l.from_stop_id
LEFT JOIN tms_raw.transport_stop ts2 ON ts2.stop_id = l.to_stop_id
;

CREATE OR REPLACE VIEW tms_views.v_transport_stop AS
SELECT
    ts.stop_id                      AS transport_stop_key,
    COALESCE(ts.name, ts.identifier, ts.stop_id::text) AS title_property,
    ts.transport_id                 AS transport_key,
    t.transport_number              AS transport_number,
    t.order_id                       AS order_key,
    ts.leg_number                   AS leg_number,
    ts.stop_role                    AS stop_role,
    ts.name                         AS stop_name,
    ts.identifier                   AS stop_identifier,
    ts.location_id                  AS location_key,
    loc.entity_name                 AS location_name,
    loc.city                        AS location_city,
    loc.province_state              AS location_state,
    loc.country_iso2                AS location_country,
    loc.latitude                    AS latitude,
    loc.longitude                   AS longitude,
    ts.arrival_begin                AS planned_arrival_from,
    ts.arrival_end                  AS planned_arrival_to,
    ts.departure_begin              AS planned_departure_from,
    ts.departure_end                AS planned_departure_to,
    ts.cut_time                     AS cut_time,
    ts.actual_arrival                                  AS actual_arrival_at,
    ts.actual_departure                                AS actual_departure_at,
    COALESCE(ts.is_arrived,  false)                    AS is_arrived,
    COALESCE(ts.is_departed, false)                    AS is_departed,
    -- arrival_variance_minutes, dwell_minutes, is_on_time and exception_code
    -- are gone. No stop in the snapshot has been arrived at, so every one of
    -- them could only ever have been computed from an invented arrival time.
    (SELECT count(*) FROM tms_raw.stop_event e WHERE e.stop_id = ts.stop_id) AS event_count,
    CASE WHEN ts.actual_arrival IS NOT NULL THEN 'api'
         ELSE 'planned_only' END            AS execution_origin,
    'api'::text                             AS data_origin
FROM tms_raw.transport_stop ts
JOIN tms_raw.transport t ON t.transport_id = ts.transport_id
LEFT JOIN tms_views.v_business_entity loc ON loc.business_entity_key = ts.location_id
;

CREATE OR REPLACE VIEW tms_views.v_stop_event AS
SELECT
    e.event_id::text || ':' || e.event_category AS stop_event_key,
    initcap(e.event_category) || ' ' || COALESCE(e.shipment_number, '') AS title_property,
    e.event_id                      AS event_id,
    e.stop_id                       AS transport_stop_key,
    ts.name                         AS stop_name,
    ts.location_id                  AS location_key,
    e.transport_id                  AS transport_key,
    t.transport_number              AS transport_number,
    e.event_category                AS event_category,
    e.event_type                    AS event_type_code,
    evt.name                        AS event_type,
    e.shipment_number               AS shipment_number,
    s.shipment_id                   AS shipment_key,
    s.order_id                      AS order_key,
    e.window_start                  AS window_start_at,
    e.window_end                    AS window_end_at,
    EXTRACT(EPOCH FROM (e.window_end - e.window_start)) / 3600.0 AS window_hours,
    COALESCE(array_length(e.handling_unit_ids, 1), 0) AS handling_unit_count,
    -- The arrival columns are taken from the stop itself, which is where the
    -- source would record them. They are NULL throughout this snapshot
    -- because nothing has been arrived at yet.
    ts.actual_arrival               AS actual_arrival_at,
    'api'::text                     AS data_origin
FROM tms_raw.stop_event e
LEFT JOIN tms_raw.transport_stop ts ON ts.stop_id = e.stop_id
LEFT JOIN tms_raw.transport t       ON t.transport_id = e.transport_id
LEFT JOIN tms_raw.ref_stop_event_type evt ON evt.code = e.event_type
LEFT JOIN tms_raw.shipment s        ON s.shipment_number = e.shipment_number
;

-- ===========================================================================
--  HANDLING UNIT  (the freight itself)
-- ===========================================================================

-- The schema itself goes. Nothing reads it any more, and an empty schema named
-- for simulation is a standing invitation to start generating again.
DROP SCHEMA IF EXISTS tms_sim CASCADE;
