-- ============================================================================
--  TMS Ontology Platform - Layer 2: SEMANTIC VIEWS
--  ---------------------------------------------------------------------------
--  These views ARE the contract with the ontology. services/pipeline
--  introspects information_schema against this schema and emits one ontology
--  object type per v_* view, one property per column, and one link type per
--  discovered join. Consequences worth knowing before editing:
--
--    * Column names become property labels. Name them the way a business user
--      would say them, not the way the API spells them.
--    * Every object view exposes exactly one primary-key column named
--      <object>_key, which becomes the object's identity property.
--    * Every object view exposes a title_property column, which becomes the
--      object's display title in the explorer and in LLM answers.
--    * Columns ending in _key that are not this view's own key are treated as
--      foreign keys and become candidate link types.
--    * Views prefixed v_kpi_ are registered as metric views, not object types.
--
--  data_origin is 'api' where the value came from the captured TMS payloads and
--  'simulated' where it came from tms_sim (see 03_simulation_schema.sql).
-- ============================================================================

SET search_path = tms_views, tms_raw, public;

-- ===========================================================================
--  PARTY MASTER
-- ===========================================================================

-- Every party the tenant transacts with, with the role bitmask exploded into
-- the boolean flags the ontology exposes as properties.
CREATE OR REPLACE VIEW tms_views.v_business_entity AS
SELECT
    be.id                                    AS business_entity_key,
    be.name                                  AS title_property,
    be.tenant_id                             AS tenant_key,
    be.name                                  AS entity_name,
    NULLIF(be.alias, '')                     AS entity_alias,
    NULLIF(be.display_id, '')                AS display_code,
    be.entity_type_mask                      AS role_bitmask,
    tms_raw.decode_entity_type(be.entity_type_mask) AS roles,
    array_to_string(tms_raw.decode_entity_type(be.entity_type_mask), ' / ') AS role_summary,
    (be.entity_type_mask & 1)    = 1    AS is_tenant,
    (be.entity_type_mask & 2)    = 2    AS is_account,
    (be.entity_type_mask & 4)    = 4    AS is_agent,
    (be.entity_type_mask & 8)    = 8    AS is_broker,
    (be.entity_type_mask & 16)   = 16   AS is_carrier,
    (be.entity_type_mask & 32)   = 32   AS is_supplier,
    (be.entity_type_mask & 64)   = 64   AS is_customer,
    (be.entity_type_mask & 128)  = 128  AS is_location,
    (be.entity_type_mask & 256)  = 256  AS is_bill_to,
    (be.entity_type_mask & 512)  = 512  AS is_hub,
    (be.entity_type_mask & 1024) = 1024 AS is_contact,
    (be.entity_type_mask & 2048) = 2048 AS is_group,
    be.street_address                        AS street_address,
    be.city                                  AS city,
    be.province_state                        AS province_state,
    be.postal_zip_code                       AS postal_code,
    c.name                                   AS country,
    c.iso2                                   AS country_iso2,
    be.latitude                              AS latitude,
    be.longitude                             AS longitude,
    NULLIF(concat_ws(', ', NULLIF(be.city,''), NULLIF(be.province_state,''), c.iso2), '')
                                             AS geo_label,
    be.general_email                         AS general_email,
    be.general_phone                         AS general_phone,
    be.iana_timezone                         AS timezone,
    be.description                           AS description,
    be.electronic_ref_id                     AS electronic_reference,
    be.is_open_24_hours                      AS is_open_24_hours,
    COALESCE(be.is_active, false)            AS is_active,
    (SELECT count(*) FROM tms_raw.business_entity_contact bc
      WHERE bc.entity_id = be.id)            AS contact_count,
    'api'::text                              AS data_origin
FROM tms_raw.business_entity be
LEFT JOIN tms_raw.ref_country c ON c.code = be.country_code;

COMMENT ON VIEW tms_views.v_business_entity IS
'Party master. One row per physical party; roles are additive (a DC can be both Carrier and Location).';

-- Role-scoped projections. These exist because a business user thinks in terms
-- of "carriers" and "facilities", not "business entities with bit 16 set", and
-- because the ontology needs distinct object types to hang distinct link types
-- and actions off.
CREATE OR REPLACE VIEW tms_views.v_location AS
SELECT business_entity_key AS location_key, title_property, tenant_key,
       entity_name AS location_name, display_code, street_address, city,
       province_state, postal_code, country, country_iso2, latitude, longitude,
       geo_label, timezone, general_email, general_phone, is_open_24_hours,
       is_hub, is_active, description, data_origin
FROM tms_views.v_business_entity WHERE is_location;

CREATE OR REPLACE VIEW tms_views.v_carrier AS
SELECT business_entity_key AS carrier_key, title_property, tenant_key,
       entity_name AS carrier_name, display_code, electronic_reference AS scac_hint,
       city, province_state, country, country_iso2, geo_label, general_email,
       general_phone, is_broker, is_active, description, data_origin
FROM tms_views.v_business_entity WHERE is_carrier;

CREATE OR REPLACE VIEW tms_views.v_customer AS
SELECT business_entity_key AS customer_key, title_property, tenant_key,
       entity_name AS customer_name, display_code, city, province_state, country,
       country_iso2, geo_label, general_email, general_phone, is_location,
       is_active, description, data_origin
FROM tms_views.v_business_entity WHERE is_customer;

CREATE OR REPLACE VIEW tms_views.v_supplier AS
SELECT business_entity_key AS supplier_key, title_property, tenant_key,
       entity_name AS supplier_name, display_code, city, province_state, country,
       country_iso2, geo_label, general_email, general_phone, is_active,
       description, data_origin
FROM tms_views.v_business_entity WHERE is_supplier;

CREATE OR REPLACE VIEW tms_views.v_bill_to AS
SELECT business_entity_key AS bill_to_key, title_property, tenant_key,
       entity_name AS bill_to_name, display_code, street_address, city,
       province_state, postal_code, country, country_iso2, geo_label,
       general_email, general_phone, is_active, description, data_origin
FROM tms_views.v_business_entity WHERE is_bill_to;

CREATE OR REPLACE VIEW tms_views.v_broker AS
SELECT business_entity_key AS broker_key, title_property, tenant_key,
       entity_name AS broker_name, display_code, city, province_state, country,
       geo_label, general_email, general_phone, is_active, description, data_origin
FROM tms_views.v_business_entity WHERE is_broker;

CREATE OR REPLACE VIEW tms_views.v_agent AS
SELECT business_entity_key AS agent_key, title_property, tenant_key,
       entity_name AS agent_name, display_code, city, province_state, country,
       geo_label, general_email, general_phone, is_active, description, data_origin
FROM tms_views.v_business_entity WHERE is_agent;

CREATE OR REPLACE VIEW tms_views.v_tenant AS
SELECT t.id AS tenant_key, t.name AS title_property, t.name AS tenant_name,
       NULLIF(t.alias,'') AS tenant_alias, t.street_address, t.city,
       t.province_state, t.postal_zip_code AS postal_code, c.name AS country,
       c.iso2 AS country_iso2, t.latitude, t.longitude, t.general_email,
       t.general_phone, t.iana_timezone AS timezone, t.description,
       COALESCE(t.is_active, true) AS is_active,
       (SELECT count(*) FROM tms_raw.account a WHERE a.tenant_id = t.id) AS account_count,
       (SELECT count(*) FROM tms_raw.business_entity be WHERE be.tenant_id = t.id) AS party_count,
       'api'::text AS data_origin
FROM tms_raw.tenant t
LEFT JOIN tms_raw.ref_country c ON c.code = t.country_code;

CREATE OR REPLACE VIEW tms_views.v_account AS
SELECT a.id AS account_key, a.name AS title_property, a.tenant_id AS tenant_key,
       a.name AS account_name, NULLIF(a.alias,'') AS account_alias,
       a.street_address, a.city, a.province_state,
       a.postal_zip_code AS postal_code, c.name AS country, c.iso2 AS country_iso2,
       a.latitude, a.longitude, a.general_email, a.general_phone,
       a.iana_timezone AS timezone, a.description,
       COALESCE(a.is_active, true) AS is_active,
       (SELECT count(*) FROM tms_raw.tms_order o WHERE o.account_id = a.id) AS order_count,
       'api'::text AS data_origin
FROM tms_raw.account a
LEFT JOIN tms_raw.ref_country c ON c.code = a.country_code;

-- The declared party hierarchy: which parties sit under which, and how.
CREATE OR REPLACE VIEW tms_views.v_entity_relationship AS
SELECT r.id AS entity_relationship_key,
       COALESCE(r.parent_descriptor, pp.name) || ' -> ' || COALESCE(r.child_descriptor, cc.name)
                                    AS title_property,
       r.parent_id                  AS parent_business_entity_key,
       pp.name                      AS parent_name,
       array_to_string(tms_raw.decode_entity_type(r.parent_entity_type), ' / ') AS parent_roles,
       r.child_id                   AS child_business_entity_key,
       cc.name                      AS child_name,
       array_to_string(tms_raw.decode_entity_type(r.child_entity_type), ' / ')  AS child_roles,
       r.association                AS association_code,
       ra.name                      AS association_type,
       ra.description               AS association_description,
       (r.parent_id = r.child_id)   AS is_self_reference,
       'api'::text                  AS data_origin
FROM tms_raw.business_entity_relationship r
LEFT JOIN tms_raw.business_entity pp ON pp.id = r.parent_id
LEFT JOIN tms_raw.business_entity cc ON cc.id = r.child_id
LEFT JOIN tms_raw.ref_association ra ON ra.code = r.association;

-- ===========================================================================
--  CONFIGURATION MASTERS
-- ===========================================================================

CREATE OR REPLACE VIEW tms_views.v_transportation_mode AS
SELECT m.id AS transportation_mode_key, m.display_name AS title_property,
       m.display_name AS mode_name, m.edi_codes AS edi_code,
       m.tender_response_time AS tender_response_window,
       EXTRACT(EPOCH FROM m.tender_response_time) / 3600.0 AS tender_response_hours,
       COALESCE(m.is_active, false) AS is_active,
       (SELECT count(*) FROM tms_raw.tms_order o WHERE o.transportation_mode_id = m.id) AS order_count,
       'api'::text AS data_origin
FROM tms_raw.transportation_mode m;

CREATE OR REPLACE VIEW tms_views.v_unit_of_measure AS
SELECT u.id AS unit_of_measure_key,
       u.unit || ' (' || COALESCE(u.symbol, '') || ')' AS title_property,
       u.category AS measurement_category, u.unit AS unit_name, u.symbol,
       COALESCE(u.is_active, false) AS is_active,
       COALESCE(u.is_default, false) AS is_default,
       'api'::text AS data_origin
FROM tms_raw.unit_of_measure u;

-- ===========================================================================
--  ORDER  (the demand-side root object)
-- ===========================================================================

CREATE OR REPLACE VIEW tms_views.v_order AS
WITH hu AS (
    SELECT order_id,
           sum(quantity)                                              AS piece_count,
           sum(tms_raw.to_kilograms(weight_value, weight_unit)
               * GREATEST(COALESCE(quantity, 1), 1))                   AS gross_weight_kg,
           -- The heaviest single handling unit on the order. Kept because the
           -- captured demo data contains at least one unit of 530 x 77,936 lb
           -- (18,736 t), which is ~500x a legal truckload and would otherwise
           -- silently dominate every weight-based KPI.
           max(tms_raw.to_kilograms(weight_value, weight_unit)
               * GREATEST(COALESCE(quantity, 1), 1))                   AS max_unit_weight_kg,
           bool_or(COALESCE(has_hazmat, false))                        AS has_hazmat,
           bool_or(COALESCE(has_temperature_ctrl, false))              AS is_temperature_controlled,
           bool_or(COALESCE(is_non_stackable, false))                  AS has_non_stackable,
           count(*)                                                    AS handling_unit_count
    FROM tms_raw.handling_unit
    WHERE scope = 'order' AND order_id IS NOT NULL
    GROUP BY order_id
),
sh AS (
    SELECT order_id, count(*) AS shipment_count,
           count(*) FILTER (WHERE COALESCE(is_invoice_generated, false)) AS invoiced_shipment_count
    FROM tms_raw.shipment WHERE order_id IS NOT NULL GROUP BY order_id
),
tr AS (
    SELECT order_id, count(*) AS transport_count, min(planned_start) AS first_planned_start,
           max(COALESCE(planned_end, planned_start)) AS last_planned_end
    FROM tms_raw.transport WHERE order_id IS NOT NULL GROUP BY order_id
),
acc AS (
    SELECT order_id, count(*) AS accessorial_count
    FROM tms_raw.order_accessorial GROUP BY order_id
)
SELECT
    o.id                                    AS order_key,
    o.order_number                          AS title_property,
    o.order_number                          AS order_number,
    o.account_id                            AS account_key,
    a.name                                  AS account_name,
    o.origin_id                             AS origin_location_key,
    org.entity_name                         AS origin_name,
    org.city                                AS origin_city,
    org.province_state                      AS origin_state,
    org.country_iso2                        AS origin_country,
    org.latitude                            AS origin_latitude,
    org.longitude                           AS origin_longitude,
    o.destination_id                        AS destination_location_key,
    dst.entity_name                         AS destination_name,
    dst.city                                AS destination_city,
    dst.province_state                      AS destination_state,
    dst.country_iso2                        AS destination_country,
    dst.latitude                            AS destination_latitude,
    dst.longitude                           AS destination_longitude,
    -- The lane is the single most-used grouping key in TMS analytics, so it is
    -- materialised here rather than re-derived in every KPI.
    NULLIF(concat_ws(' -> ',
        NULLIF(concat_ws(', ', NULLIF(org.city,''), NULLIF(org.province_state,'')), ''),
        NULLIF(concat_ws(', ', NULLIF(dst.city,''), NULLIF(dst.province_state,'')), '')), ' -> ')
                                            AS lane,
    o.bill_to_id                            AS bill_to_key,
    bt.name                                 AS bill_to_name,
    o.carrier_id                            AS carrier_key,
    car.name                                AS carrier_name,
    o.transportation_mode_id                AS transportation_mode_key,
    m.display_name                          AS transportation_mode,
    o.order_type                            AS order_type_code,
    ot.name                                 AS order_type,
    o.status                                AS status_code,
    os.name                                 AS order_status,
    COALESCE(os.is_terminal, false)         AS is_closed,
    COALESCE(os.is_inferred, false)         AS status_label_is_inferred,
    o.service_level_id                      AS service_level_key,
    o.shipment_type_id                      AS shipment_type_key,
    o.payment_term_id                       AS payment_term_key,
    o.pickup_ready_date                     AS pickup_ready_at,
    o.pickup_close_date                     AS pickup_close_at,
    o.delivery_ready_date                   AS delivery_ready_at,
    o.delivery_close_date                   AS delivery_close_at,
    o.pickup_ready_date::date               AS pickup_date,
    date_trunc('week',  o.pickup_ready_date)::date AS pickup_week,
    date_trunc('month', o.pickup_ready_date)::date AS pickup_month,
    -- Planned transit is the committed door-to-door promise for the order.
    EXTRACT(EPOCH FROM (o.delivery_close_date - o.pickup_ready_date)) / 86400.0
                                            AS planned_transit_days,
    EXTRACT(EPOCH FROM (o.pickup_close_date - o.pickup_ready_date)) / 3600.0
                                            AS pickup_window_hours,
    EXTRACT(EPOCH FROM (o.delivery_close_date - o.delivery_ready_date)) / 3600.0
                                            AS delivery_window_hours,
    COALESCE(hu.piece_count, 0)             AS piece_count,
    ROUND(COALESCE(hu.gross_weight_kg, 0)::numeric, 2) AS gross_weight_kg,
    COALESCE(hu.handling_unit_count, 0)     AS handling_unit_count,
    ROUND(COALESCE(hu.max_unit_weight_kg, 0)::numeric, 2) AS max_unit_weight_kg,
    -- 40 t is above any legal single-truck gross weight in North America, so a
    -- single handling unit heavier than that is a data-entry fault, not freight.
    -- Surfaced as a property so it can be filtered out of an analysis rather than
    -- quietly skewing it.
    (COALESCE(hu.max_unit_weight_kg, 0) > 40000) AS has_implausible_weight,
    COALESCE(hu.has_hazmat, false)          AS has_hazmat,
    COALESCE(hu.is_temperature_controlled, false) AS is_temperature_controlled,
    COALESCE(hu.has_non_stackable, false)   AS has_non_stackable,
    COALESCE(acc.accessorial_count, 0)      AS accessorial_count,
    COALESCE(sh.shipment_count, 0)          AS shipment_count,
    COALESCE(sh.invoiced_shipment_count, 0) AS invoiced_shipment_count,
    COALESCE(tr.transport_count, 0)         AS transport_count,
    tr.first_planned_start                  AS route_planned_start,
    tr.last_planned_end                     AS route_planned_end,
    o.has_scheduled_route                   AS is_planned,
    COALESCE(o.route_is_complete, false)    AS is_route_complete,
    -- 29 of 90 captured orders have no scheduledRoute: unplanned demand is a
    -- first-class KPI, so it gets its own flag rather than a NULL join.
    (NOT o.has_scheduled_route)             AS is_unplanned,
    NULLIF(o.pro_number, '')                AS pro_number,
    NULLIF(o.bol_number, '')                AS bol_number,
    NULLIF(o.trailer_number, '')            AS trailer_number,
    NULLIF(o.scac_number, '')               AS scac_number,
    o.declared_value                        AS declared_value,
    o.cod_amount                            AS cod_amount,
    NULLIF(o.special_instructions, '')      AS special_instructions,
    'api'::text                             AS data_origin
FROM tms_raw.tms_order o
LEFT JOIN tms_raw.account a               ON a.id = o.account_id
LEFT JOIN tms_views.v_business_entity org ON org.business_entity_key = o.origin_id
LEFT JOIN tms_views.v_business_entity dst ON dst.business_entity_key = o.destination_id
LEFT JOIN tms_raw.business_entity bt      ON bt.id = o.bill_to_id
LEFT JOIN tms_raw.business_entity car     ON car.id = o.carrier_id
LEFT JOIN tms_raw.transportation_mode m   ON m.id = o.transportation_mode_id
LEFT JOIN tms_raw.ref_order_type ot       ON ot.code = o.order_type
LEFT JOIN tms_raw.ref_order_status os     ON os.code = o.status
LEFT JOIN hu  ON hu.order_id  = o.id
LEFT JOIN sh  ON sh.order_id  = o.id
LEFT JOIN tr  ON tr.order_id  = o.id
LEFT JOIN acc ON acc.order_id = o.id;

COMMENT ON VIEW tms_views.v_order IS
'Customer order: the demand record. One order fans out to shipments and transports once planned.';

-- ===========================================================================
--  SHIPMENT  (the rated, invoiceable unit of freight)
-- ===========================================================================

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
    COALESCE(s.total_rate_amount, sc.total_rate_amount)   AS total_charge,
    COALESCE(s.freight_amount,    sc.freight_amount)      AS freight_charge,
    COALESCE(s.fuel_amount,       sc.fuel_amount)         AS fuel_charge,
    COALESCE(s.accessorial_amount, sc.accessorial_amount) AS accessorial_charge,
    COALESCE(sc.currency_code, 'USD')       AS currency_code,
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
    ROUND((COALESCE(s.total_rate_amount, sc.total_rate_amount)
           / NULLIF(hu.gross_weight_kg, 0))::numeric, 4) AS charge_per_kg,
    CASE WHEN s.total_rate_amount IS NOT NULL THEN 'api'
         WHEN sc.shipment_id IS NOT NULL      THEN 'simulated'
         ELSE 'unrated' END                  AS charge_origin,
    'api'::text                              AS data_origin
FROM tms_raw.shipment s
LEFT JOIN tms_views.v_order o        ON o.order_key = s.order_id
LEFT JOIN tms_raw.ref_shipment_status ss ON ss.code = s.status
LEFT JOIN tms_sim.shipment_charge sc ON sc.shipment_id = s.shipment_id
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
           sum(COALESCE(ld.road_km,
                        tms_raw.to_kilometres(l.distance_value, l.distance_unit))) AS total_km,
           bool_or(ld.transport_id IS NOT NULL) AS has_simulated_distance
    FROM tms_raw.transport_leg l
    LEFT JOIN tms_sim.leg_distance ld
           ON ld.transport_id = l.transport_id AND ld.leg_number = l.leg_number
    GROUP BY l.transport_id
),
stops AS (
    SELECT ts.transport_id,
           count(*) AS stop_count,
           count(*) FILTER (WHERE COALESCE(sa.is_arrived, ts.is_arrived, false)) AS arrived_stop_count,
           -- A transport counts as on time when no stop arrived late.
           bool_and(COALESCE(sa.arrival_variance_minutes, 0) <= 0)
             FILTER (WHERE sa.stop_id IS NOT NULL) AS all_stops_on_time,
           max(sa.arrival_variance_minutes)        AS worst_arrival_variance_minutes,
           avg(sa.dwell_minutes)                   AS avg_dwell_minutes
    FROM tms_raw.transport_stop ts
    LEFT JOIN tms_sim.stop_actual sa ON sa.stop_id = ts.stop_id
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
    COALESCE(t.actual_start, ta.actual_start) AS actual_start_at,
    COALESCE(t.actual_end,   ta.actual_end)   AS actual_end_at,
    t.planned_start::date                   AS planned_start_date,
    date_trunc('week',  t.planned_start)::date  AS planned_start_week,
    date_trunc('month', t.planned_start)::date  AS planned_start_month,
    EXTRACT(EPOCH FROM (COALESCE(t.actual_end, ta.actual_end)
                        - COALESCE(t.actual_start, ta.actual_start))) / 3600.0
                                            AS actual_transit_hours,
    EXTRACT(EPOCH FROM (t.planned_end - t.planned_start)) / 3600.0
                                            AS planned_transit_hours,
    -- Departure and arrival variance in hours, positive = late.
    EXTRACT(EPOCH FROM (COALESCE(t.actual_start, ta.actual_start) - t.planned_start)) / 3600.0
                                            AS departure_variance_hours,
    ta.carrier_id                           AS carrier_key,
    ta.carrier_name                         AS carrier_name,
    ta.scac                                 AS carrier_scac,
    ROUND(COALESCE(legs.total_km, ta.total_km)::numeric, 2) AS total_distance_km,
    ta.linehaul_cost                        AS linehaul_cost,
    ta.fuel_cost                            AS fuel_cost,
    ta.accessorial_cost                     AS accessorial_cost,
    ta.total_cost                           AS total_cost,
    COALESCE(ta.currency_code, 'USD')       AS currency_code,
    ROUND((ta.total_cost / NULLIF(COALESCE(legs.total_km, ta.total_km), 0))::numeric, 4)
                                            AS cost_per_km,
    COALESCE(legs.leg_count, t.leg_count, 0) AS leg_count,
    COALESCE(stops.stop_count, 0)           AS stop_count,
    COALESCE(stops.arrived_stop_count, 0)   AS arrived_stop_count,
    stops.all_stops_on_time                 AS is_on_time,
    ROUND(stops.worst_arrival_variance_minutes::numeric, 1) AS worst_arrival_variance_minutes,
    ROUND(stops.avg_dwell_minutes::numeric, 1)              AS avg_dwell_minutes,
    (ta.transport_id IS NOT NULL)           AS has_actuals,
    CASE WHEN t.actual_start IS NOT NULL   THEN 'api'
         WHEN ta.transport_id IS NOT NULL  THEN 'simulated'
         ELSE 'planned_only' END            AS execution_origin,
    'api'::text                             AS data_origin
FROM tms_raw.transport t
LEFT JOIN tms_views.v_order o            ON o.order_key = t.order_id
LEFT JOIN tms_views.v_business_entity org ON org.business_entity_key = t.origin_id
LEFT JOIN tms_views.v_business_entity dst ON dst.business_entity_key = t.destination_id
LEFT JOIN tms_raw.ref_transport_status tstat ON tstat.code = t.status
LEFT JOIN tms_sim.transport_actual ta    ON ta.transport_id = t.transport_id
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
    ROUND(COALESCE(ld.road_km,
        tms_raw.to_kilometres(l.distance_value, l.distance_unit))::numeric, 2) AS distance_km,
    ROUND(ld.haversine_km::numeric, 2) AS straight_line_km,
    ld.circuity_factor              AS circuity_factor,
    l.duration_seconds / 3600.0     AS planned_duration_hours,
    fs.departure_begin              AS planned_departure_at,
    ts2.arrival_begin               AS planned_arrival_at,
    CASE WHEN COALESCE(l.distance_value, 0) > 0 THEN 'api'
         WHEN ld.transport_id IS NOT NULL       THEN 'simulated'
         ELSE 'unknown' END         AS distance_origin,
    'api'::text                     AS data_origin
FROM tms_raw.transport_leg l
JOIN tms_raw.transport t        ON t.transport_id = l.transport_id
LEFT JOIN tms_raw.transport_stop fs  ON fs.stop_id = l.from_stop_id
LEFT JOIN tms_raw.transport_stop ts2 ON ts2.stop_id = l.to_stop_id
LEFT JOIN tms_sim.leg_distance ld
       ON ld.transport_id = l.transport_id AND ld.leg_number = l.leg_number;

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
    COALESCE(ts.actual_arrival,   sa.actual_arrival)   AS actual_arrival_at,
    COALESCE(ts.actual_departure, sa.actual_departure) AS actual_departure_at,
    COALESCE(sa.is_arrived,  ts.is_arrived,  false)    AS is_arrived,
    COALESCE(sa.is_departed, ts.is_departed, false)    AS is_departed,
    ROUND(sa.arrival_variance_minutes::numeric, 1)     AS arrival_variance_minutes,
    ROUND(sa.dwell_minutes::numeric, 1)                AS dwell_minutes,
    -- On time means the truck arrived at or before the end of the planned
    -- window. NULL where no arrival has been recorded at all.
    CASE WHEN sa.arrival_variance_minutes IS NULL THEN NULL
         ELSE sa.arrival_variance_minutes <= 0 END     AS is_on_time,
    sa.exception_code                                  AS exception_code,
    (SELECT count(*) FROM tms_raw.stop_event e WHERE e.stop_id = ts.stop_id) AS event_count,
    CASE WHEN ts.actual_arrival IS NOT NULL THEN 'api'
         WHEN sa.stop_id IS NOT NULL        THEN 'simulated'
         ELSE 'planned_only' END            AS execution_origin,
    'api'::text                             AS data_origin
FROM tms_raw.transport_stop ts
JOIN tms_raw.transport t ON t.transport_id = ts.transport_id
LEFT JOIN tms_views.v_business_entity loc ON loc.business_entity_key = ts.location_id
LEFT JOIN tms_sim.stop_actual sa ON sa.stop_id = ts.stop_id;

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
    sa.actual_arrival               AS actual_arrival_at,
    ROUND(sa.arrival_variance_minutes::numeric, 1) AS arrival_variance_minutes,
    CASE WHEN sa.arrival_variance_minutes IS NULL THEN NULL
         ELSE sa.arrival_variance_minutes <= 0 END  AS is_on_time,
    'api'::text                     AS data_origin
FROM tms_raw.stop_event e
LEFT JOIN tms_raw.transport_stop ts ON ts.stop_id = e.stop_id
LEFT JOIN tms_raw.transport t       ON t.transport_id = e.transport_id
LEFT JOIN tms_raw.ref_stop_event_type evt ON evt.code = e.event_type
LEFT JOIN tms_raw.shipment s        ON s.shipment_number = e.shipment_number
LEFT JOIN tms_sim.stop_actual sa    ON sa.stop_id = e.stop_id;

-- ===========================================================================
--  HANDLING UNIT  (the freight itself)
-- ===========================================================================

CREATE OR REPLACE VIEW tms_views.v_handling_unit AS
SELECT
    h.row_id::text                  AS handling_unit_key,
    COALESCE(NULLIF(h.description,''), 'HU ' || left(h.handling_unit_id::text, 8)) AS title_property,
    h.handling_unit_id              AS handling_unit_id,
    h.scope                         AS scope,
    h.order_id                      AS order_key,
    h.shipment_id                   AS shipment_key,
    h.quantity                      AS quantity,
    h.shape                         AS shape_code,
    sp.name                         AS shape,
    ROUND(tms_raw.to_centimetres(h.length_value, h.length_unit)::numeric, 2)   AS length_cm,
    ROUND(tms_raw.to_centimetres(h.width_value, h.width_unit)::numeric, 2)     AS width_cm,
    ROUND(tms_raw.to_centimetres(h.height_value, h.height_unit)::numeric, 2)   AS height_cm,
    ROUND(tms_raw.to_centimetres(h.diameter_value, h.diameter_unit)::numeric, 2) AS diameter_cm,
    ROUND(tms_raw.to_kilograms(h.weight_value, h.weight_unit)::numeric, 3)     AS weight_kg,
    ROUND((tms_raw.to_kilograms(h.weight_value, h.weight_unit)
           * GREATEST(COALESCE(h.quantity, 1), 1))::numeric, 3)                AS total_weight_kg,
    -- Volume: rectangular uses l*w*h, cylindrical uses pi*r^2*l.
    ROUND((CASE
        WHEN h.shape = 2 AND h.diameter_value IS NOT NULL THEN
            pi() * power(tms_raw.to_centimetres(h.diameter_value, h.diameter_unit) / 2.0, 2)
                 * COALESCE(tms_raw.to_centimetres(h.length_value, h.length_unit), 0)
        ELSE
            COALESCE(tms_raw.to_centimetres(h.length_value, h.length_unit), 0)
          * COALESCE(tms_raw.to_centimetres(h.width_value,  h.width_unit),  0)
          * COALESCE(tms_raw.to_centimetres(h.height_value, h.height_unit), 0)
    END / 1000000.0)::numeric, 4)   AS volume_m3,
    h.nmfc_code                     AS nmfc_code,
    h.nmfc_id                       AS nmfc_key,
    NULLIF(h.description, '')       AS description,
    COALESCE(h.has_hazmat, false)           AS has_hazmat,
    COALESCE(h.has_temperature_ctrl, false) AS is_temperature_controlled,
    COALESCE(h.is_non_stackable, false)     AS is_non_stackable,
    'api'::text                     AS data_origin
FROM tms_raw.handling_unit h
LEFT JOIN tms_raw.ref_shape sp ON sp.code = h.shape;
