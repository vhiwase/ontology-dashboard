-- ============================================================================
--  TMS Ontology Platform - Layer 1b: REFERENCE DATA
--  ---------------------------------------------------------------------------
--  Enum decode tables. Codes marked is_inferred = true are NOT documented in
--  TMS_MCP/scripts/tms_models.py; they were observed in the captured payloads
--  (shipment status reaches 11, transport status reaches 8) and the label is a
--  best-fit against conventional TMS lifecycle naming. The flag is carried all
--  the way into the ontology so a business user reading a dashboard can tell a
--  documented status from an inferred one.
-- ============================================================================

SET search_path = tms_raw, public;

-- --- Entity type bitmask (IntFlag: a party may hold several roles) ---------
INSERT INTO ref_entity_type (code, name, description) VALUES
    (0,    'None',     'Unassigned / invalid'),
    (1,    'Tenant',   'The 3PL operating the TMS instance'),
    (2,    'Account',  'A shipper account the 3PL transacts on behalf of'),
    (4,    'Agent',    'Freight agent acting for the tenant'),
    (8,    'Broker',   'Freight broker'),
    (16,   'Carrier',  'Asset or non-asset carrier moving freight'),
    (32,   'Supplier', 'Goods supplier / vendor'),
    (64,   'Customer', 'Consignee or ship-to customer'),
    (128,  'Location', 'Physical facility: DC, terminal, plant, yard'),
    (256,  'BillTo',   'Party invoiced for the freight charges'),
    (512,  'Hub',      'Cross-dock or consolidation hub'),
    (1024, 'Contact',  'Named person attached to a party'),
    (2048, 'Group',    'Logical grouping of parties')
ON CONFLICT (code) DO UPDATE
    SET name = EXCLUDED.name, description = EXCLUDED.description;

-- --- Order lifecycle (documented in tms_models.py) ------------------------
INSERT INTO ref_order_status (code, name, is_inferred, is_terminal) VALUES
    (1, 'Open',      false, false),
    (2, 'Assigned',  false, false),
    (3, 'Completed', false, true),
    (4, 'Cancelled', false, true)
ON CONFLICT (code) DO UPDATE
    SET name = EXCLUDED.name, is_inferred = EXCLUDED.is_inferred,
        is_terminal = EXCLUDED.is_terminal;

-- --- Shipment lifecycle ---------------------------------------------------
-- 1/2/3 documented; 4..11 observed in api_responses and inferred.
INSERT INTO ref_shipment_status (code, name, is_inferred, is_terminal) VALUES
    (1,  'Open',           false, false),
    (2,  'In Transit',     false, false),
    (3,  'Delivered',      false, true),
    (4,  'Tendered',       true,  false),
    (5,  'Booked',         true,  false),
    (6,  'Dispatched',     true,  false),
    (7,  'At Delivery',    true,  false),
    (8,  'POD Received',   true,  false),
    (9,  'Invoiced',       true,  true),
    (10, 'Closed',         true,  true),
    (11, 'Cancelled',      true,  true)
ON CONFLICT (code) DO UPDATE
    SET name = EXCLUDED.name, is_inferred = EXCLUDED.is_inferred,
        is_terminal = EXCLUDED.is_terminal;

-- --- Transport lifecycle --------------------------------------------------
-- 1/2/3 documented; 4..8 observed and inferred.
INSERT INTO ref_transport_status (code, name, is_inferred, is_terminal) VALUES
    (1, 'Open',       false, false),
    (2, 'In Transit', false, false),
    (3, 'Completed',  false, true),
    (4, 'Tendered',   true,  false),
    (5, 'Assigned',   true,  false),
    (6, 'Dispatched', true,  false),
    (7, 'Arrived',    true,  false),
    (8, 'Cancelled',  true,  true)
ON CONFLICT (code) DO UPDATE
    SET name = EXCLUDED.name, is_inferred = EXCLUDED.is_inferred,
        is_terminal = EXCLUDED.is_terminal;

INSERT INTO ref_order_type (code, name) VALUES
    (1, 'Pickup'),
    (2, 'Delivery')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO ref_country (code, name, iso2) VALUES
    (1, 'Canada', 'CA'),
    (2, 'United States', 'US'),
    (3, 'Mexico', 'MX')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, iso2 = EXCLUDED.iso2;

INSERT INTO ref_association (code, name, description) VALUES
    (1, 'LocationChild', 'Child is a physical location under the parent'),
    (2, 'Child',         'General parent to child association'),
    (5, 'Self',          'Self reference; the party is its own root')
ON CONFLICT (code) DO UPDATE
    SET name = EXCLUDED.name, description = EXCLUDED.description;

INSERT INTO ref_stop_event_type (code, name) VALUES
    (1, 'Pickup'),
    (2, 'Delivery')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO ref_shape (code, name) VALUES
    (0, 'Unspecified'),
    (1, 'Rectangular'),
    (2, 'Cylindrical')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO ref_phone_type (code, name) VALUES
    (1, 'Home'),
    (2, 'Work'),
    (3, 'Mobile'),
    (4, 'Fax')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;

-- --- Helper: decode an entity_type bitmask into role names ----------------
-- Used by tms_views.v_business_entity so a Palantir-style object type can
-- expose "is_carrier / is_location / ..." booleans instead of a raw integer.
CREATE OR REPLACE FUNCTION tms_raw.decode_entity_type(mask INTEGER)
RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$
    SELECT COALESCE(array_agg(t.name ORDER BY t.code), '{}'::text[])
    FROM tms_raw.ref_entity_type t
    WHERE t.code > 0 AND (COALESCE(mask, 0) & t.code) = t.code;
$$;

-- --- Helper: normalise a mass measurement to kilograms --------------------
-- Payload weights arrive as {"Unit":"MassUnit.Pound","Value":110}; the unit
-- token is landed verbatim and converted here so every KPI sums one unit.
CREATE OR REPLACE FUNCTION tms_raw.to_kilograms(value DOUBLE PRECISION, unit TEXT)
RETURNS DOUBLE PRECISION
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN value IS NULL THEN NULL
        WHEN unit IS NULL THEN value
        WHEN unit ILIKE '%Kilogram%' THEN value
        WHEN unit ILIKE '%Gram%'     THEN value / 1000.0
        WHEN unit ILIKE '%Tonne%'    THEN value * 1000.0
        WHEN unit ILIKE '%Pound%'    THEN value * 0.45359237
        WHEN unit ILIKE '%Ounce%'    THEN value * 0.028349523125
        WHEN unit ILIKE '%ShortTon%' THEN value * 907.18474
        WHEN unit ILIKE '%LongTon%'  THEN value * 1016.0469088
        ELSE value
    END;
$$;

-- --- Helper: normalise a length measurement to centimetres ---------------
CREATE OR REPLACE FUNCTION tms_raw.to_centimetres(value DOUBLE PRECISION, unit TEXT)
RETURNS DOUBLE PRECISION
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN value IS NULL THEN NULL
        WHEN unit IS NULL THEN value
        WHEN unit ILIKE '%Centimeter%' OR unit ILIKE '%Centimetre%' THEN value
        WHEN unit ILIKE '%Millimeter%' OR unit ILIKE '%Millimetre%' THEN value / 10.0
        WHEN unit ILIKE '%Meter%'      OR unit ILIKE '%Metre%'      THEN value * 100.0
        WHEN unit ILIKE '%Kilometer%'  OR unit ILIKE '%Kilometre%'  THEN value * 100000.0
        WHEN unit ILIKE '%Inch%'  THEN value * 2.54
        WHEN unit ILIKE '%Foot%'  OR unit ILIKE '%Feet%' THEN value * 30.48
        WHEN unit ILIKE '%Yard%'  THEN value * 91.44
        WHEN unit ILIKE '%Mile%'  THEN value * 160934.4
        ELSE value
    END;
$$;

-- --- Helper: normalise a length measurement to kilometres ----------------
-- Leg distances arrive as LengthUnit.Meter; lane KPIs report kilometres.
CREATE OR REPLACE FUNCTION tms_raw.to_kilometres(value DOUBLE PRECISION, unit TEXT)
RETURNS DOUBLE PRECISION
LANGUAGE sql IMMUTABLE AS $$
    SELECT tms_raw.to_centimetres(value, unit) / 100000.0;
$$;
