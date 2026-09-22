-- ============================================================================
--  0019: rebuild the KPI views the simulation removal took with it.
--
--  0018 dropped the five core views with CASCADE, which also removed nine KPI
--  views built on them. Three of those are not coming back: the carrier
--  scorecard, on-time performance and the account scorecard were composed
--  entirely of figures the snapshot cannot produce, and every metric they fed
--  was withdrawn.
--
--  The six here return without their simulated columns:
--
--    lane_performance      loses cost, cost_per_km and on-time; keeps volume,
--                          weight and the revenue the source really rated
--    facility_throughput   loses dwell and punctuality; keeps stop volume
--    exception_summary     loses 'Late stops' and 'Transports without a
--                          carrier' - an exception list that invents
--                          exceptions is worse than a shorter one
--    data_coverage         now reports measured versus ABSENT rather than
--                          measured versus simulated
--
--  shipment_status_funnel and freight_spend_monthly needed no change: both
--  were already built from source columns only.
-- ============================================================================

CREATE OR REPLACE VIEW tms_views.v_kpi_lane_performance AS
WITH base AS (
    SELECT o.lane, o.origin_city, o.origin_state, o.destination_city,
           o.destination_state, o.transportation_mode,
           o.order_key, o.gross_weight_kg, o.piece_count, o.planned_transit_days
    FROM tms_views.v_order o
    WHERE o.lane IS NOT NULL
),
trp AS (
    SELECT t.lane,
           count(*)                                      AS transport_count,
           avg(t.total_distance_km)                       AS avg_km,
           -- Cost and punctuality are gone: the snapshot carries neither a
           -- transport cost nor an arrival, so both could only ever have been
           -- computed from generated values. Volume and weight per lane are
           -- real and remain.
           sum(t.total_distance_km)                        AS total_km,
           avg(t.actual_transit_hours)                     AS avg_actual_transit_hours
    FROM tms_views.v_transport t
    WHERE t.lane IS NOT NULL
    GROUP BY t.lane
),
shp AS (
    SELECT s.lane, sum(s.total_charge) AS total_charge, count(*) AS shipment_count
    FROM tms_views.v_shipment s WHERE s.lane IS NOT NULL GROUP BY s.lane
)
SELECT
    base.lane                                   AS lane,
    max(base.origin_city)                       AS origin_city,
    max(base.origin_state)                      AS origin_state,
    max(base.destination_city)                  AS destination_city,
    max(base.destination_state)                 AS destination_state,
    max(base.transportation_mode)               AS transportation_mode,
    count(DISTINCT base.order_key)              AS order_count,
    max(shp.shipment_count)                     AS shipment_count,
    max(trp.transport_count)                    AS transport_count,
    ROUND(sum(base.gross_weight_kg), 2)         AS gross_weight_kg,
    sum(base.piece_count)                       AS piece_count,
    ROUND(avg(base.planned_transit_days)::numeric, 2) AS avg_planned_transit_days,
    ROUND(max(trp.avg_actual_transit_hours)::numeric, 2) AS avg_actual_transit_hours,
    ROUND(max(trp.avg_km)::numeric, 1)          AS avg_distance_km,
    -- Revenue is real where the snapshot rated the shipment (14 of 61) and
    -- NULL where it did not. Cost, cost per km and on-time are removed.
    ROUND(max(shp.total_charge), 2)             AS revenue,
    ROUND(max(shp.total_charge) / NULLIF(sum(base.gross_weight_kg), 0), 4) AS revenue_per_kg
FROM base
LEFT JOIN trp ON trp.lane = base.lane
LEFT JOIN shp ON shp.lane = base.lane
GROUP BY base.lane;

COMMENT ON VIEW tms_views.v_kpi_lane_performance IS
'Origin-destination lane performance: volume, distance, unit cost and service level.';

-- ---------------------------------------------------------------------------
--  Procurement: carrier scorecard
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW tms_views.v_kpi_shipment_status_funnel AS
SELECT
    s.status_code                                AS status_code,
    s.shipment_status                            AS shipment_status,
    s.status_label_is_inferred                   AS status_label_is_inferred,
    s.is_closed                                  AS is_terminal_status,
    count(*)                                     AS shipment_count,
    ROUND(100.0 * count(*) / NULLIF(sum(count(*)) OVER (), 0), 1) AS share_pct,
    ROUND(sum(s.gross_weight_kg), 2)             AS gross_weight_kg,
    ROUND(sum(s.total_charge), 2)                AS total_charge,
    count(*) FILTER (WHERE s.is_invoiced)        AS invoiced_count,
    count(*) FILTER (WHERE s.are_documents_verified) AS documents_verified_count,
    count(*) FILTER (WHERE s.is_on_hold)         AS on_hold_count,
    count(DISTINCT s.account_key)                AS account_count
FROM tms_views.v_shipment s
GROUP BY s.status_code, s.shipment_status, s.status_label_is_inferred, s.is_closed;

COMMENT ON VIEW tms_views.v_kpi_shipment_status_funnel IS
'Where the shipment book currently sits by lifecycle status.';

-- ---------------------------------------------------------------------------
--  Service: on-time performance over time
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW tms_views.v_kpi_freight_spend_monthly AS
SELECT
    o.pickup_month                               AS spend_month,
    o.transportation_mode                        AS transportation_mode,
    o.account_name                               AS account_name,
    o.bill_to_name                               AS bill_to_name,
    count(DISTINCT s.shipment_key)               AS shipment_count,
    ROUND(sum(s.freight_charge), 2)              AS freight_charge,
    ROUND(sum(s.fuel_charge), 2)                 AS fuel_charge,
    ROUND(sum(s.accessorial_charge), 2)          AS accessorial_charge,
    ROUND(sum(s.total_charge), 2)                AS total_charge,
    ROUND(100.0 * sum(s.fuel_charge) / NULLIF(sum(s.total_charge), 0), 1) AS fuel_share_pct,
    ROUND(sum(s.gross_weight_kg), 2)             AS gross_weight_kg,
    ROUND(sum(s.total_charge) / NULLIF(sum(s.gross_weight_kg), 0), 4) AS charge_per_kg,
    ROUND(avg(s.total_charge), 2)                AS avg_charge_per_shipment,
    count(*) FILTER (WHERE s.charge_origin = 'api')       AS charges_from_source,
    count(*) FILTER (WHERE s.charge_origin = 'simulated') AS charges_simulated,
    count(*) FILTER (WHERE s.charge_origin = 'unrated')   AS unrated_count
FROM tms_views.v_shipment s
JOIN tms_views.v_order o ON o.order_key = s.order_key
WHERE o.pickup_month IS NOT NULL
GROUP BY 1, 2, 3, 4;

COMMENT ON VIEW tms_views.v_kpi_freight_spend_monthly IS
'Monthly freight spend split by mode, account and bill-to, with charge provenance.';

-- ---------------------------------------------------------------------------
--  Network: facility throughput
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW tms_views.v_kpi_facility_throughput AS
SELECT
    ts.location_key                              AS location_key,
    ts.location_name                             AS location_name,
    ts.location_city                             AS city,
    ts.location_state                            AS province_state,
    ts.location_country                          AS country,
    count(*)                                     AS stop_count,
    count(*) FILTER (WHERE ts.stop_role = 'from') AS pickup_stop_count,
    count(*) FILTER (WHERE ts.stop_role = 'to')   AS delivery_stop_count,
    count(DISTINCT ts.transport_key)             AS transport_count,
    count(DISTINCT ts.order_key)                 AS order_count,
    sum(ts.event_count)                          AS event_count,
    -- Dwell and punctuality removed: no stop in the snapshot has been
    -- arrived at, so neither can be measured. Stop volume per facility is
    -- real and is what this view now reports.
    count(*) FILTER (WHERE ts.is_arrived)        AS arrived_stop_count
FROM tms_views.v_transport_stop ts
WHERE ts.location_key IS NOT NULL
GROUP BY 1, 2, 3, 4, 5;

COMMENT ON VIEW tms_views.v_kpi_facility_throughput IS
'Per-facility stop volume. Dwell and punctuality need arrivals the snapshot does not carry.';

-- ---------------------------------------------------------------------------
--  Network: mode mix
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW tms_views.v_kpi_exception_summary AS
SELECT 'Unplanned orders' AS exception_type,
       'Order' AS object_type, 'high' AS severity,
       count(*) AS item_count,
       'Demand with no scheduled route' AS description
FROM tms_views.v_order WHERE is_unplanned
UNION ALL
SELECT 'Unrated shipments', 'Shipment', 'high', count(*),
       'Shipments carrying no freight charge'
FROM tms_views.v_shipment WHERE charge_origin = 'unrated'
UNION ALL
SELECT 'Shipments on hold', 'Shipment', 'high', count(*),
       'Shipments blocked by an operational hold'
FROM tms_views.v_shipment WHERE is_on_hold
UNION ALL
SELECT 'Documents not verified', 'Shipment', 'medium', count(*),
       'Delivered shipments whose paperwork is still open'
FROM tms_views.v_shipment WHERE NOT are_documents_verified
UNION ALL
SELECT 'Uninvoiced shipments', 'Shipment', 'medium', count(*),
       'Shipments not yet billed'
FROM tms_views.v_shipment WHERE NOT is_invoiced
-- 'Late stops' and 'Transports without a carrier' are gone. Lateness needs an
-- arrival and carrier attribution needs a carrierId; the snapshot carries
-- neither, so both rows could only ever have counted generated data. An
-- exception list that invents exceptions is worse than a shorter one.
UNION ALL
SELECT 'Implausible handling unit weight', 'Order', 'high', count(*),
       'A single handling unit weighs more than 40 t, which exceeds any legal truck gross weight'
FROM tms_views.v_order WHERE has_implausible_weight
UNION ALL
SELECT 'Hazmat orders', 'Order', 'medium', count(*),
       'Orders carrying hazardous materials that need compliance review'
FROM tms_views.v_order WHERE has_hazmat
UNION ALL
SELECT 'Temperature controlled orders', 'Order', 'low', count(*),
       'Orders needing reefer equipment'
FROM tms_views.v_order WHERE is_temperature_controlled;

COMMENT ON VIEW tms_views.v_kpi_exception_summary IS
'Operational worklist: the exception counts an operations manager opens the day with.';

-- ---------------------------------------------------------------------------
--  Meta: data coverage
-- ---------------------------------------------------------------------------
--  This view exists so the assistant can answer "can I trust this number?".
--  Every metric that depends on data the captured snapshot does not contain is
--  listed here with its real coverage, so a dashboard can grey out a tile
--  instead of showing a confident zero.

CREATE OR REPLACE VIEW tms_views.v_kpi_data_coverage AS
--  How much of each metric area the captured snapshot actually carries.
--
--  This used to report "measured versus simulated", because the gaps were
--  filled with generated rows. Nothing is generated any more, so it reports
--  measured versus ABSENT: rows_simulated is retained as a column and is
--  always zero, because dashboards and the assistant read it by name.
--
--  An area at 0% is not a fault. It is the snapshot honestly saying it records
--  what was planned, not what happened.
WITH orders AS (
    SELECT count(*) AS n,
           count(*) FILTER (WHERE is_planned) AS routed
    FROM tms_views.v_order
),
shipments AS (
    SELECT count(*) AS n,
           count(*) FILTER (WHERE charge_origin = 'api') AS rated
    FROM tms_views.v_shipment
),
transports AS (
    SELECT count(*) AS n,
           count(*) FILTER (WHERE actual_start_at IS NOT NULL) AS with_actuals,
           count(*) FILTER (WHERE total_distance_km > 0)       AS with_distance
    FROM tms_views.v_transport
),
stops AS (
    SELECT count(*) AS n,
           count(*) FILTER (WHERE actual_arrival_at IS NOT NULL) AS arrived
    FROM tms_views.v_transport_stop
)
SELECT 'Order intake'::text AS metric_area, 'Order'::text AS object_type,
       o.n AS total_rows, o.n AS rows_from_source, 0::bigint AS rows_simulated,
       100.0::numeric AS source_coverage_pct,
       'Fully present in the captured snapshot'::text AS note
FROM orders o
UNION ALL
SELECT 'Route planning', 'Order', o.n, o.routed, 0::bigint,
       ROUND(100.0 * o.routed / NULLIF(o.n, 0), 1),
       'Orders that carry a scheduledRoute in the source payload'
FROM orders o
UNION ALL
SELECT 'Freight charges', 'Shipment', sh.n, sh.rated, 0::bigint,
       ROUND(100.0 * sh.rated / NULLIF(sh.n, 0), 1),
       'Shipments the source rated. The rest are reported unrated rather than estimated'
FROM shipments sh
UNION ALL
SELECT 'Execution actuals', 'Transport', tr.n, tr.with_actuals, 0::bigint,
       ROUND(100.0 * tr.with_actuals / NULLIF(tr.n, 0), 1),
       'The snapshot contains no actualStart/actualEnd, so transit time is not measured'
FROM transports tr
UNION ALL
SELECT 'Leg distance', 'Transport', tr.n, tr.with_distance, 0::bigint,
       ROUND(100.0 * tr.with_distance / NULLIF(tr.n, 0), 1),
       'Every captured leg reports a distance of 0 m, so distance is not measured'
FROM transports tr
UNION ALL
SELECT 'On-time measurement', 'TransportStop', st.n, st.arrived, 0::bigint,
       ROUND(100.0 * st.arrived / NULLIF(st.n, 0), 1),
       'No stop in the snapshot has been arrived at, so punctuality is not measured'
FROM stops st;

COMMENT ON VIEW tms_views.v_kpi_data_coverage IS
'How much of each metric area the snapshot measures. An area at 0% is absent at source, not estimated.';
