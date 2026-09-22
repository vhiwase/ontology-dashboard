-- ============================================================================
--  0020: the starter pipeline computes something the data can actually support.
--
--  0015 seeded "Carrier Cost Analytics": transports filtered to rated moves,
--  cost per kilometre calculated, aggregated by carrier. It ran, and every
--  number it produced was fabricated - both operands were generated, because
--  the snapshot carries no transport cost and no carrier assignment. Removing
--  those columns in 0018 broke it, which is the correct outcome: the pipeline
--  was demonstrating an answer the data cannot give.
--
--  It is replaced with one built entirely on measured columns. v_order is the
--  strongest source available: 90 of 90 rows come from the captured payload,
--  with real lane, mode, piece count and weight.
--
--     Orders  ->  Filter shipped weight  ->  Weight per piece
--             ->  Group by lane          ->  Rank by volume  ->  Output
--
--  Nothing here is estimated. Where a figure cannot be computed the pipeline
--  says so rather than filling it.
-- ============================================================================

UPDATE platform.pipeline
   SET slug        = 'lane-volume-analytics',
       name        = 'Lane Volume Analytics',
       description = 'Orders grouped by lane: how many moves, how much freight and '
                  || 'the average weight per piece. Every column is measured - '
                  || 'v_order is 90 of 90 rows from the captured snapshot.',
       version     = version + 1,
       updated_at  = now(),
       updated_by  = 'platform',
       graph = $json${
         "nodes": [
           { "id": "src", "kind": "dataSource", "name": "TMS Orders",
             "position": {"x": 40, "y": 160},
             "config": { "sourceView": "tms_views.v_order", "connection": "TMS Postgres" },
             "description": "Every order in the captured snapshot. 100% from source." },

           { "id": "weighed", "kind": "filter", "name": "Filter Weighed Orders",
             "position": {"x": 300, "y": 160},
             "config": { "mode": "filter", "combine": "and", "conditions": [
               { "field": "gross_weight_kg", "operator": "gt", "value": 0 },
               { "field": "piece_count", "operator": "gt", "value": 0 }
             ]},
             "description": "An average weight per piece needs both sides to be present." },

           { "id": "perpiece", "kind": "filter", "name": "Weight Per Piece",
             "position": {"x": 560, "y": 160},
             "config": { "mode": "calculate", "alias": "weight_per_piece_kg",
                         "left": "gross_weight_kg", "right": "piece_count",
                         "operator": "divide" },
             "description": "gross_weight_kg / piece_count, guarded against zero." },

           { "id": "bylane", "kind": "aggregate", "name": "Group By Lane",
             "position": {"x": 830, "y": 160},
             "config": { "groupBy": ["lane"], "measures": [
               { "aggregation": "count", "alias": "orders" },
               { "aggregation": "sum", "field": "gross_weight_kg", "alias": "total_weight_kg" },
               { "aggregation": "sum", "field": "piece_count", "alias": "total_pieces" },
               { "aggregation": "avg", "field": "weight_per_piece_kg", "alias": "avg_weight_per_piece_kg" }
             ]},
             "description": "One row per lane." },

           { "id": "ranked", "kind": "filter", "name": "Rank By Volume",
             "position": {"x": 1100, "y": 160},
             "config": { "mode": "sort",
                         "sortBy": [{ "field": "orders", "direction": "desc" }] },
             "description": "Busiest lane first." },

           { "id": "out", "kind": "output", "name": "Lane Analytics",
             "position": {"x": 1360, "y": 160},
             "config": {},
             "description": "Materialised to pipeline_out for dashboards and the assistant." }
         ],
         "edges": [
           { "id": "e1", "source": "src",      "target": "weighed" },
           { "id": "e2", "source": "weighed",  "target": "perpiece" },
           { "id": "e3", "source": "perpiece", "target": "bylane" },
           { "id": "e4", "source": "bylane",   "target": "ranked" },
           { "id": "e5", "source": "ranked",   "target": "out" }
         ]
       }$json$::jsonb
 WHERE slug = 'carrier-cost-analytics'
   AND space_id = (SELECT space_id FROM platform.space WHERE slug = 'sandbox');

-- The old pipeline's materialised tables describe carriers and costs that were
-- never measured. Left in place they would keep answering questions.
DROP TABLE IF EXISTS pipeline_out.carrier_cost_analytics__src;
DROP TABLE IF EXISTS pipeline_out.carrier_cost_analytics__valid;
DROP TABLE IF EXISTS pipeline_out.carrier_cost_analytics__costkm;
DROP TABLE IF EXISTS pipeline_out.carrier_cost_analytics__bycarrier;
DROP TABLE IF EXISTS pipeline_out.carrier_cost_analytics__ranked;
DROP TABLE IF EXISTS pipeline_out.carrier_cost_analytics__out;
