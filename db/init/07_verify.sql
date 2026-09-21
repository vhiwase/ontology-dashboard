-- ============================================================================
--  TMS Ontology Platform - init verification
--  ---------------------------------------------------------------------------
--  Runs last. Asserts that every object the later services depend on actually
--  got created.
--
--  Why this is worth a whole file: the postgres entrypoint only replays
--  /docker-entrypoint-initdb.d when PGDATA is empty. If an earlier script fails,
--  the container exits, the restart policy brings it straight back, it finds a
--  populated PGDATA, prints "Skipping initialization" and comes up reporting
--  healthy - with half a schema. Failing loudly here makes a partial init
--  obvious on the first boot instead of surfacing as a confusing 500 from the
--  ontology service later.
--
--  If this fires, the fix is always:  docker compose down -v && docker compose up
-- ============================================================================

DO $$
DECLARE
    expected_views TEXT[] := ARRAY[
        'v_business_entity', 'v_location', 'v_carrier', 'v_customer', 'v_supplier',
        'v_bill_to', 'v_broker', 'v_agent', 'v_tenant', 'v_account',
        'v_entity_relationship', 'v_transportation_mode', 'v_unit_of_measure',
        'v_order', 'v_shipment', 'v_transport', 'v_transport_leg',
        'v_transport_stop', 'v_stop_event', 'v_handling_unit',
        'v_kpi_order_volume_daily', 'v_kpi_account_scorecard',
        'v_kpi_lane_performance', 'v_kpi_carrier_scorecard',
        'v_kpi_shipment_status_funnel', 'v_kpi_on_time_performance',
        'v_kpi_freight_spend_monthly', 'v_kpi_facility_throughput',
        'v_kpi_mode_mix', 'v_kpi_exception_summary', 'v_kpi_data_coverage'
    ];
    expected_platform_tables TEXT[] := ARRAY[
        'ontology_version', 'object_type', 'object_property', 'link_type',
        'action_type', 'action_audit', 'lineage_node', 'lineage_edge',
        'lineage_column', 'kpi_definition', 'dashboard', 'chat_session',
        'chat_message', 'generation_run'
    ];
    missing TEXT[];
BEGIN
    SELECT array_agg(v ORDER BY v) INTO missing
    FROM unnest(expected_views) AS v
    WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.views
        WHERE table_schema = 'tms_views' AND table_name = v
    );
    IF missing IS NOT NULL THEN
        RAISE EXCEPTION
            'Schema init incomplete: tms_views is missing %. Run: docker compose down -v && docker compose up -d',
            array_to_string(missing, ', ');
    END IF;

    SELECT array_agg(t ORDER BY t) INTO missing
    FROM unnest(expected_platform_tables) AS t
    WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'platform' AND table_name = t
    );
    IF missing IS NOT NULL THEN
        RAISE EXCEPTION
            'Schema init incomplete: platform is missing %. Run: docker compose down -v && docker compose up -d',
            array_to_string(missing, ', ');
    END IF;

    -- Every object view must expose exactly one <name>_key column and a
    -- title_property, because the ontology generator keys off that convention.
    SELECT array_agg(v ORDER BY v) INTO missing
    FROM unnest(expected_views) AS v
    WHERE v NOT LIKE 'v_kpi_%'
      AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'tms_views' AND table_name = v
          AND column_name = 'title_property'
    );
    IF missing IS NOT NULL THEN
        RAISE EXCEPTION
            'These object views have no title_property column, which the ontology generator requires: %',
            array_to_string(missing, ', ');
    END IF;

    RAISE NOTICE 'Schema verification passed: % views, % platform tables.',
        array_length(expected_views, 1), array_length(expected_platform_tables, 1);
END $$;
