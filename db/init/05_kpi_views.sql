-- ============================================================================
--  TMS Ontology Platform - Layer 3: KPI / METRIC VIEWS
--  ---------------------------------------------------------------------------
--  Pre-aggregated business metrics. The pipeline registers every v_kpi_* view
--  as a metric view rather than an object type, and the AI-FDE assistant is
--  given their column metadata so it can compose dashboards without writing
--  free-form SQL against the raw tables.
--
--  Each view exposes grain columns first, then measures. Measures that depend on
--  simulated execution data carry an explicit *_coverage or sample-size column
--  so a dashboard can show the denominator and the assistant can caveat the
--  answer instead of quoting a number built on two rows.
-- ============================================================================

SET search_path = tms_views, tms_raw, public;

-- ---------------------------------------------------------------------------
--  Demand: order volume over time
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW tms_views.v_kpi_order_volume_daily AS
SELECT
    pickup_date                                              AS pickup_date,
    pickup_week                                              AS pickup_week,
    pickup_month                                             AS pickup_month,
    transportation_mode                                      AS transportation_mode,
    count(*)                                                 AS order_count,
    count(*) FILTER (WHERE is_planned)                       AS planned_order_count,
    count(*) FILTER (WHERE is_unplanned)                     AS unplanned_order_count,
    ROUND(100.0 * count(*) FILTER (WHERE is_planned) / NULLIF(count(*), 0), 1)
                                                             AS planned_rate_pct,
    sum(shipment_count)                                      AS shipment_count,
    sum(transport_count)                                     AS transport_count,
    sum(piece_count)                                         AS piece_count,
    ROUND(sum(gross_weight_kg), 2)                           AS gross_weight_kg,
    ROUND(avg(gross_weight_kg), 2)                           AS avg_order_weight_kg,
    ROUND(avg(planned_transit_days)::numeric, 2)             AS avg_planned_transit_days,
    count(*) FILTER (WHERE has_hazmat)                       AS hazmat_order_count,
    count(*) FILTER (WHERE is_temperature_controlled)        AS reefer_order_count
FROM tms_views.v_order
WHERE pickup_date IS NOT NULL
GROUP BY pickup_date, pickup_week, pickup_month, transportation_mode;

COMMENT ON VIEW tms_views.v_kpi_order_volume_daily IS
'Daily order intake by mode: volume, weight, and how much of the demand got planned.';

-- ---------------------------------------------------------------------------
--  Customer: account scorecard
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW tms_views.v_kpi_account_scorecard AS
WITH ord AS (
    SELECT account_key, account_name,
           count(*)                            AS order_count,
           count(*) FILTER (WHERE is_unplanned) AS unplanned_order_count,
           sum(piece_count)                    AS piece_count,
           sum(gross_weight_kg)                AS gross_weight_kg,
           avg(planned_transit_days)           AS avg_planned_transit_days,
           count(DISTINCT lane)                AS lane_count,
           min(pickup_date)                    AS first_pickup_date,
           max(pickup_date)                    AS last_pickup_date
    FROM tms_views.v_order
    WHERE account_key IS NOT NULL
    GROUP BY account_key, account_name
),
shp AS (
    SELECT account_key,
           count(*)                                          AS shipment_count,
           count(*) FILTER (WHERE is_invoiced)                AS invoiced_count,
           count(*) FILTER (WHERE is_on_hold)                 AS on_hold_count,
           sum(total_charge)                                  AS total_charge,
           sum(total_charge) FILTER (WHERE charge_origin = 'api') AS charge_from_source,
           count(*) FILTER (WHERE charge_origin <> 'unrated') AS rated_count
    FROM tms_views.v_shipment
    WHERE account_key IS NOT NULL
    GROUP BY account_key
),
trp AS (
    SELECT account_key,
           count(*)                                       AS transport_count,
           count(*) FILTER (WHERE is_on_time IS TRUE)      AS on_time_count,
           count(*) FILTER (WHERE is_on_time IS NOT NULL)  AS measured_count,
           sum(total_cost)                                 AS total_cost,
           sum(total_distance_km)                          AS total_km
    FROM tms_views.v_transport
    WHERE account_key IS NOT NULL
    GROUP BY account_key
)
SELECT
    ord.account_key                            AS account_key,
    ord.account_name                           AS account_name,
    ord.order_count                            AS order_count,
    ord.unplanned_order_count                  AS unplanned_order_count,
    COALESCE(shp.shipment_count, 0)            AS shipment_count,
    COALESCE(trp.transport_count, 0)           AS transport_count,
    ord.lane_count                             AS lane_count,
    ord.piece_count                            AS piece_count,
    ROUND(ord.gross_weight_kg, 2)              AS gross_weight_kg,
    ROUND(ord.avg_planned_transit_days::numeric, 2) AS avg_planned_transit_days,
    ROUND(shp.total_charge, 2)                 AS revenue,
    ROUND(trp.total_cost, 2)                   AS cost,
    ROUND((shp.total_charge - trp.total_cost), 2) AS gross_margin,
    ROUND(100.0 * (shp.total_charge - trp.total_cost) / NULLIF(shp.total_charge, 0), 1)
                                               AS gross_margin_pct,
    ROUND(shp.total_charge / NULLIF(ord.gross_weight_kg, 0), 4) AS revenue_per_kg,
    ROUND(trp.total_cost / NULLIF(trp.total_km, 0), 4)          AS cost_per_km,
    COALESCE(shp.invoiced_count, 0)            AS invoiced_shipment_count,
    COALESCE(shp.on_hold_count, 0)             AS on_hold_shipment_count,
    ROUND(100.0 * trp.on_time_count / NULLIF(trp.measured_count, 0), 1) AS on_time_pct,
    trp.measured_count                         AS on_time_sample_size,
    COALESCE(shp.rated_count, 0)               AS rated_shipment_count,
    ROUND(100.0 * shp.charge_from_source / NULLIF(shp.total_charge, 0), 1)
                                               AS revenue_pct_from_source,
    ord.first_pickup_date                      AS first_pickup_date,
    ord.last_pickup_date                       AS last_pickup_date
FROM ord
LEFT JOIN shp ON shp.account_key = ord.account_key
LEFT JOIN trp ON trp.account_key = ord.account_key;

COMMENT ON VIEW tms_views.v_kpi_account_scorecard IS
'Per-account commercial scorecard: volume, revenue, cost, margin and service level.';

-- ---------------------------------------------------------------------------
--  Network: lane performance
-- ---------------------------------------------------------------------------
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
           sum(t.total_cost)                              AS total_cost,
           sum(t.total_distance_km)                        AS total_km,
           avg(t.actual_transit_hours)                     AS avg_actual_transit_hours,
           count(*) FILTER (WHERE t.is_on_time IS TRUE)     AS on_time_count,
           count(*) FILTER (WHERE t.is_on_time IS NOT NULL) AS measured_count,
           avg(t.worst_arrival_variance_minutes)           AS avg_worst_variance_minutes
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
    ROUND(max(shp.total_charge), 2)             AS revenue,
    ROUND(max(trp.total_cost), 2)               AS cost,
    ROUND(max(trp.total_cost) / NULLIF(max(trp.total_km), 0), 4) AS cost_per_km,
    ROUND(max(shp.total_charge) / NULLIF(sum(base.gross_weight_kg), 0), 4) AS revenue_per_kg,
    ROUND(100.0 * max(trp.on_time_count) / NULLIF(max(trp.measured_count), 0), 1) AS on_time_pct,
    max(trp.measured_count)                     AS on_time_sample_size,
    ROUND(max(trp.avg_worst_variance_minutes)::numeric, 1) AS avg_worst_variance_minutes
FROM base
LEFT JOIN trp ON trp.lane = base.lane
LEFT JOIN shp ON shp.lane = base.lane
GROUP BY base.lane;

COMMENT ON VIEW tms_views.v_kpi_lane_performance IS
'Origin-destination lane performance: volume, distance, unit cost and service level.';

-- ---------------------------------------------------------------------------
--  Procurement: carrier scorecard
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW tms_views.v_kpi_carrier_scorecard AS
SELECT
    t.carrier_key                                AS carrier_key,
    t.carrier_name                               AS carrier_name,
    t.carrier_scac                               AS carrier_scac,
    count(*)                                     AS load_count,
    count(DISTINCT t.lane)                       AS lane_count,
    count(DISTINCT t.account_key)                AS account_count,
    ROUND(sum(t.total_distance_km)::numeric, 1)  AS total_km,
    ROUND(avg(t.total_distance_km)::numeric, 1)  AS avg_km_per_load,
    ROUND(sum(t.total_cost), 2)                  AS total_cost,
    ROUND(avg(t.total_cost), 2)                  AS avg_cost_per_load,
    ROUND(sum(t.total_cost) / NULLIF(sum(t.total_distance_km), 0), 4) AS cost_per_km,
    count(*) FILTER (WHERE t.is_on_time IS TRUE)       AS on_time_count,
    count(*) FILTER (WHERE t.is_on_time IS FALSE)      AS late_count,
    count(*) FILTER (WHERE t.is_on_time IS NOT NULL)   AS measured_count,
    ROUND(100.0 * count(*) FILTER (WHERE t.is_on_time IS TRUE)
          / NULLIF(count(*) FILTER (WHERE t.is_on_time IS NOT NULL), 0), 1) AS on_time_pct,
    ROUND(avg(t.worst_arrival_variance_minutes)::numeric, 1) AS avg_late_minutes,
    ROUND(avg(t.avg_dwell_minutes)::numeric, 1)              AS avg_dwell_minutes,
    ROUND(avg(t.actual_transit_hours)::numeric, 2)           AS avg_transit_hours,
    max(t.execution_origin)                      AS execution_origin
FROM tms_views.v_transport t
WHERE t.carrier_key IS NOT NULL
GROUP BY t.carrier_key, t.carrier_name, t.carrier_scac;

COMMENT ON VIEW tms_views.v_kpi_carrier_scorecard IS
'Per-carrier procurement scorecard: spend, unit cost and on-time reliability.';

-- ---------------------------------------------------------------------------
--  Operations: shipment status funnel
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
CREATE OR REPLACE VIEW tms_views.v_kpi_on_time_performance AS
SELECT
    ts.planned_arrival_from::date                 AS service_date,
    date_trunc('week', ts.planned_arrival_from)::date  AS service_week,
    ts.stop_role                                  AS stop_role,
    CASE WHEN ts.stop_role = 'from' THEN 'Pickup' ELSE 'Delivery' END AS service_event,
    t.carrier_name                                AS carrier_name,
    t.lane                                        AS lane,
    count(*)                                      AS stop_count,
    count(*) FILTER (WHERE ts.is_on_time IS TRUE)     AS on_time_count,
    count(*) FILTER (WHERE ts.is_on_time IS FALSE)    AS late_count,
    count(*) FILTER (WHERE ts.is_on_time IS NOT NULL) AS measured_count,
    ROUND(100.0 * count(*) FILTER (WHERE ts.is_on_time IS TRUE)
          / NULLIF(count(*) FILTER (WHERE ts.is_on_time IS NOT NULL), 0), 1) AS on_time_pct,
    ROUND(avg(ts.arrival_variance_minutes)
          FILTER (WHERE ts.arrival_variance_minutes > 0)::numeric, 1) AS avg_late_minutes,
    ROUND(max(ts.arrival_variance_minutes)::numeric, 1) AS worst_late_minutes,
    ROUND(avg(ts.dwell_minutes)::numeric, 1)            AS avg_dwell_minutes,
    count(*) FILTER (WHERE ts.exception_code IS NOT NULL) AS exception_count
FROM tms_views.v_transport_stop ts
JOIN tms_views.v_transport t ON t.transport_key = ts.transport_key
WHERE ts.planned_arrival_from IS NOT NULL
GROUP BY 1, 2, 3, 4, 5, 6;

COMMENT ON VIEW tms_views.v_kpi_on_time_performance IS
'On-time pickup and delivery by day, carrier and lane. Requires execution actuals.';

-- ---------------------------------------------------------------------------
--  Finance: freight spend
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
    ROUND(avg(ts.dwell_minutes)::numeric, 1)     AS avg_dwell_minutes,
    ROUND(max(ts.dwell_minutes)::numeric, 1)     AS max_dwell_minutes,
    count(*) FILTER (WHERE ts.is_on_time IS TRUE)     AS on_time_count,
    count(*) FILTER (WHERE ts.is_on_time IS NOT NULL) AS measured_count,
    ROUND(100.0 * count(*) FILTER (WHERE ts.is_on_time IS TRUE)
          / NULLIF(count(*) FILTER (WHERE ts.is_on_time IS NOT NULL), 0), 1) AS on_time_pct
FROM tms_views.v_transport_stop ts
WHERE ts.location_key IS NOT NULL
GROUP BY 1, 2, 3, 4, 5;

COMMENT ON VIEW tms_views.v_kpi_facility_throughput IS
'Per-facility stop volume, dwell time and punctuality.';

-- ---------------------------------------------------------------------------
--  Network: mode mix
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW tms_views.v_kpi_mode_mix AS
SELECT
    COALESCE(o.transportation_mode, 'Unassigned')  AS transportation_mode,
    count(*)                                       AS order_count,
    ROUND(100.0 * count(*) / NULLIF(sum(count(*)) OVER (), 0), 1) AS order_share_pct,
    sum(o.shipment_count)                          AS shipment_count,
    sum(o.transport_count)                         AS transport_count,
    ROUND(sum(o.gross_weight_kg), 2)               AS gross_weight_kg,
    ROUND(100.0 * sum(o.gross_weight_kg)
          / NULLIF(sum(sum(o.gross_weight_kg)) OVER (), 0), 1) AS weight_share_pct,
    ROUND(avg(o.planned_transit_days)::numeric, 2) AS avg_planned_transit_days,
    count(*) FILTER (WHERE o.is_unplanned)         AS unplanned_order_count,
    count(DISTINCT o.lane)                         AS lane_count,
    count(DISTINCT o.account_key)                  AS account_count
FROM tms_views.v_order o
GROUP BY COALESCE(o.transportation_mode, 'Unassigned');

COMMENT ON VIEW tms_views.v_kpi_mode_mix IS
'Share of demand carried by each transportation mode.';

-- ---------------------------------------------------------------------------
--  Exceptions: the operational worklist
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
UNION ALL
SELECT 'Late stops', 'TransportStop', 'high', count(*),
       'Stops that arrived after the end of the planned window'
FROM tms_views.v_transport_stop WHERE is_on_time IS FALSE
UNION ALL
SELECT 'Transports without a carrier', 'Transport', 'high', count(*),
       'Planned moves with no carrier assigned'
FROM tms_views.v_transport WHERE carrier_key IS NULL
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
WITH o AS (SELECT count(*) n, count(*) FILTER (WHERE is_planned) planned FROM tms_views.v_order),
     s AS (SELECT count(*) n,
                  count(*) FILTER (WHERE charge_origin = 'api') api_rated,
                  count(*) FILTER (WHERE charge_origin = 'simulated') sim_rated
           FROM tms_views.v_shipment),
     t AS (SELECT count(*) n,
                  count(*) FILTER (WHERE execution_origin = 'api') api_exec,
                  count(*) FILTER (WHERE execution_origin = 'simulated') sim_exec,
                  count(*) FILTER (WHERE carrier_key IS NOT NULL) with_carrier,
                  count(*) FILTER (WHERE total_distance_km > 0) with_distance
           FROM tms_views.v_transport),
     st AS (SELECT count(*) n,
                   count(*) FILTER (WHERE is_on_time IS NOT NULL) measured
            FROM tms_views.v_transport_stop)
SELECT 'Order intake' AS metric_area, 'Order' AS object_type,
       o.n AS total_rows, o.n AS rows_from_source, 0::bigint AS rows_simulated,
       100.0 AS source_coverage_pct,
       'Fully present in the captured snapshot' AS note
FROM o
UNION ALL
SELECT 'Route planning', 'Order', o.n, o.planned, 0::bigint,
       ROUND(100.0 * o.planned / NULLIF(o.n, 0), 1),
       'Orders that carry a scheduledRoute in the source payload'
FROM o
UNION ALL
SELECT 'Freight charges', 'Shipment', s.n, s.api_rated, s.sim_rated,
       ROUND(100.0 * s.api_rated / NULLIF(s.n, 0), 1),
       'Revenue KPIs mix source charges with simulated ones where the snapshot left a shipment unrated'
FROM s
UNION ALL
SELECT 'Execution actuals', 'Transport', t.n, t.api_exec, t.sim_exec,
       ROUND(100.0 * t.api_exec / NULLIF(t.n, 0), 1),
       'The snapshot contains no actualStart/actualEnd at all; transit-time KPIs rest on simulated execution'
FROM t
UNION ALL
SELECT 'Carrier assignment', 'Transport', t.n, 0::bigint, t.with_carrier,
       0.0,
       'No order or transport in the snapshot carries a carrierId; carrier scorecards rest on simulated assignment'
FROM t
UNION ALL
SELECT 'Leg distance', 'Transport', t.n, 0::bigint, t.with_distance,
       0.0,
       'Every captured leg reported a distance of 0 m; distance and cost-per-km rest on great-circle estimates'
FROM t
UNION ALL
SELECT 'On-time measurement', 'TransportStop', st.n, 0::bigint, st.measured,
       0.0,
       'No stop in the snapshot has been arrived at; on-time percentages rest on simulated arrivals'
FROM st;

COMMENT ON VIEW tms_views.v_kpi_data_coverage IS
'How much of each metric area is measured versus simulated. Read this before trusting a tile.';
