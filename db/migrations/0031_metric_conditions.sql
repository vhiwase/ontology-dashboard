-- ============================================================================
--  0031: a metric can carry a condition.
--
--  "Unplanned orders" is a count of orders WHERE is_unplanned, not a count of
--  every order that can be grouped by the flag - whose headline figure would
--  be every order. Metrics authored over object types need that condition as
--  part of their definition, so it is applied to every computation of the
--  metric: the headline, every breakdown and every dashboard tile.
--
--  Equality only, column -> value (or -> list of values), matched on the
--  column's text form like a caller's filter. The columns are resolved against
--  the object type when the metric is created, so nothing here reaches SQL
--  that the registry did not vouch for.
-- ============================================================================

ALTER TABLE platform.kpi_definition
    ADD COLUMN IF NOT EXISTS conditions JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN platform.kpi_definition.conditions IS
    'Equality conditions always applied when the metric is computed: '
    '{"<sql_column>": value | [values]}.';
