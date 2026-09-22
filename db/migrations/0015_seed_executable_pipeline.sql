-- ============================================================================
--  0015: a starter pipeline that actually runs.
--
--  The platform shipped with a demo pipeline whose data source named no view,
--  because until 0014 a "run" only estimated row counts and never needed one.
--  Now that nodes compile to SQL, that pipeline fails on its first node — the
--  worst possible first-run experience, since the failure is in the seed
--  rather than in anything the user did.
--
--  This seeds the pipeline the acceptance test describes:
--
--     TMS Transports -> Filter Valid Moves -> Calculate Cost/KM
--                    -> Group By Carrier -> Rank By Cost -> Carrier Analytics
--
--  Every node is executable, and running it answers "which carriers have the
--  highest cost per kilometre?" from the real warehouse data.
--
--  Seeded into the SANDBOX only. An ontology and the pipelines over it belong
--  to the space that published them (0012), and unreviewed starter content
--  belongs in the sandbox rather than in staging or production.
--
--  A note on the calculated column: it is named computed_cost_per_km, not
--  cost_per_km, because v_transport already publishes cost_per_km and the
--  compiler refuses to shadow an existing column rather than emit ambiguous
--  SQL. Naming it distinctly is what makes the demo run.
-- ============================================================================

INSERT INTO platform.pipeline
    (space_id, slug, name, description, environment, graph, validation, version,
     created_by, updated_by)
SELECT
    s.space_id,
    'carrier-cost-analytics',
    'Carrier Cost Analytics',
    'Transports, filtered to rated moves, cost per kilometre calculated, then '
    || 'aggregated and ranked by carrier. Every node compiles to SQL and is '
    || 'materialised into the pipeline_out schema.',
    'sandbox',
    $json${
      "nodes": [
        { "id": "src", "kind": "dataSource", "name": "TMS Transports",
          "position": {"x": 40, "y": 160},
          "config": { "sourceView": "tms_views.v_transport", "connection": "TMS Postgres" },
          "description": "Every transport leg the published ontology exposes." },

        { "id": "valid", "kind": "filter", "name": "Filter Valid Moves",
          "position": {"x": 300, "y": 160},
          "config": { "mode": "filter", "combine": "and", "conditions": [
            { "field": "total_cost", "operator": "gt", "value": 0 },
            { "field": "total_distance_km", "operator": "gt", "value": 0 }
          ]},
          "description": "A cost per kilometre is meaningless where either side is zero or missing." },

        { "id": "costkm", "kind": "filter", "name": "Calculate Cost / KM",
          "position": {"x": 560, "y": 160},
          "config": { "mode": "calculate", "alias": "computed_cost_per_km",
                      "left": "total_cost", "right": "total_distance_km",
                      "operator": "divide" },
          "description": "total_cost / total_distance_km, guarded against a zero denominator." },

        { "id": "bycarrier", "kind": "aggregate", "name": "Group By Carrier",
          "position": {"x": 830, "y": 160},
          "config": { "groupBy": ["carrier_name"], "measures": [
            { "aggregation": "count", "alias": "transports" },
            { "aggregation": "avg", "field": "computed_cost_per_km", "alias": "avg_cost_per_km" },
            { "aggregation": "sum", "field": "total_cost", "alias": "total_spend" },
            { "aggregation": "sum", "field": "total_distance_km", "alias": "total_km" }
          ]},
          "description": "One row per carrier." },

        { "id": "ranked", "kind": "filter", "name": "Rank By Cost",
          "position": {"x": 1100, "y": 160},
          "config": { "mode": "sort",
                      "sortBy": [{ "field": "avg_cost_per_km", "direction": "desc" }] },
          "description": "Most expensive carrier per kilometre first." },

        { "id": "out", "kind": "output", "name": "Carrier Analytics",
          "position": {"x": 1360, "y": 160},
          "config": {},
          "description": "Materialised to pipeline_out for dashboards and the assistant." }
      ],
      "edges": [
        { "id": "e1", "source": "src",       "target": "valid" },
        { "id": "e2", "source": "valid",     "target": "costkm" },
        { "id": "e3", "source": "costkm",    "target": "bycarrier" },
        { "id": "e4", "source": "bycarrier", "target": "ranked" },
        { "id": "e5", "source": "ranked",    "target": "out" }
      ]
    }$json$::jsonb,
    '{}'::jsonb,
    1,
    'platform',
    'platform'
  FROM platform.space s
 WHERE s.slug = 'sandbox'
-- Idempotent, and it never overwrites: someone who edited the starter
-- pipeline keeps their edits when this migration is replayed on a database
-- that already has it.
ON CONFLICT (space_id, slug) DO NOTHING;
