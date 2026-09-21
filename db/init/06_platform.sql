-- ============================================================================
--  TMS Ontology Platform - Layer 4: PLATFORM SCHEMA
--  ---------------------------------------------------------------------------
--  Everything that is *about* the ontology rather than part of the TMS data:
--  the generated ontology registry, the lineage graph, the KPI catalogue, saved
--  dashboards, assistant conversations and the action audit trail.
--
--  The registry is deliberately stored twice:
--    * ontology_version.definition holds the single canonical OntologyDefinition
--      JSON document that @ontograph/core consumes and validates.
--    * object_type / object_property / link_type / action_type hold the same
--      content shredded into rows, because the UI and the assistant need to
--      filter and join it, and neither should be parsing a 300 KB JSON blob per
--      request.
--  services/pipeline writes both in one transaction, so they cannot drift.
-- ============================================================================

SET search_path = platform, public;

-- ---------------------------------------------------------------------------
--  Ontology versions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ontology_version (
    ontology_version_id BIGSERIAL PRIMARY KEY,
    version             TEXT NOT NULL,
    ontology_id         TEXT NOT NULL,
    label               TEXT,
    description         TEXT,
    definition          JSONB NOT NULL,
    validation          JSONB NOT NULL DEFAULT '{}'::jsonb,
    object_type_count   INTEGER NOT NULL DEFAULT 0,
    link_type_count     INTEGER NOT NULL DEFAULT 0,
    action_type_count   INTEGER NOT NULL DEFAULT 0,
    generated_from_run  BIGINT,
    is_active           BOOLEAN NOT NULL DEFAULT false,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by          TEXT NOT NULL DEFAULT 'pipeline'
);

-- Only one ontology version may be active at a time; the UI and the assistant
-- both resolve "the ontology" through this flag.
CREATE UNIQUE INDEX IF NOT EXISTS ux_ontology_single_active
    ON ontology_version (is_active) WHERE is_active;

-- ---------------------------------------------------------------------------
--  Object types and properties
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS object_type (
    object_type_rid     TEXT PRIMARY KEY,          -- e.g. tms:Order
    ontology_version_id BIGINT NOT NULL REFERENCES ontology_version(ontology_version_id) ON DELETE CASCADE,
    api_name            TEXT NOT NULL,             -- Order
    label               TEXT NOT NULL,             -- Customer Order
    plural_label        TEXT,
    description         TEXT,
    kind                TEXT NOT NULL DEFAULT 'entity'
                        CHECK (kind IN ('entity','event','role','value')),
    source_view         TEXT NOT NULL,             -- tms_views.v_order
    primary_key_column  TEXT NOT NULL,
    title_column        TEXT,
    icon                TEXT,
    color               TEXT,
    group_name          TEXT,
    row_count           BIGINT NOT NULL DEFAULT 0,
    display_order       INTEGER NOT NULL DEFAULT 100,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_object_type_version ON object_type (ontology_version_id);

CREATE TABLE IF NOT EXISTS object_property (
    object_property_rid TEXT PRIMARY KEY,          -- tms:Order.orderNumber
    object_type_rid     TEXT NOT NULL REFERENCES object_type(object_type_rid) ON DELETE CASCADE,
    api_name            TEXT NOT NULL,             -- orderNumber
    label               TEXT NOT NULL,             -- Order Number
    description         TEXT,
    datatype            TEXT NOT NULL,             -- ontograph DataType
    sql_column          TEXT NOT NULL,
    sql_type            TEXT,
    is_identity         BOOLEAN NOT NULL DEFAULT false,
    is_title            BOOLEAN NOT NULL DEFAULT false,
    is_nullable         BOOLEAN NOT NULL DEFAULT true,
    is_foreign_key      BOOLEAN NOT NULL DEFAULT false,
    -- The measure/dimension split is what lets the assistant build a chart
    -- without guessing which columns can be summed.
    semantic_role       TEXT NOT NULL DEFAULT 'attribute'
                        CHECK (semantic_role IN ('identity','title','measure','dimension',
                                                 'temporal','geo','flag','attribute','provenance')),
    default_aggregation TEXT,                       -- sum | avg | count | min | max
    unit                TEXT,
    display_order       INTEGER NOT NULL DEFAULT 100,
    UNIQUE (object_type_rid, api_name)
);

CREATE INDEX IF NOT EXISTS ix_object_property_type ON object_property (object_type_rid);
CREATE INDEX IF NOT EXISTS ix_object_property_role ON object_property (semantic_role);

-- ---------------------------------------------------------------------------
--  Link types
-- ---------------------------------------------------------------------------
--  discovery_method records HOW the link was found, which matters because the
--  pipeline mixes three signals: naming convention on the views, the declared
--  party hierarchy, and value-overlap probing between candidate columns.
CREATE TABLE IF NOT EXISTS link_type (
    link_type_rid       TEXT PRIMARY KEY,          -- tms:orderPlacedByAccount
    ontology_version_id BIGINT NOT NULL REFERENCES ontology_version(ontology_version_id) ON DELETE CASCADE,
    api_name            TEXT NOT NULL,
    label               TEXT NOT NULL,
    description         TEXT,
    source_object_type  TEXT NOT NULL,
    target_object_type  TEXT NOT NULL,
    source_column       TEXT NOT NULL,
    target_column       TEXT NOT NULL,
    cardinality         TEXT NOT NULL DEFAULT 'MANY_TO_ONE'
                        CHECK (cardinality IN ('ONE_TO_ONE','ONE_TO_MANY','MANY_TO_ONE','MANY_TO_MANY')),
    inverse_api_name    TEXT,
    inverse_label       TEXT,
    discovery_method    TEXT NOT NULL
                        CHECK (discovery_method IN ('naming_convention','declared_hierarchy',
                                                    'value_overlap','manual')),
    -- Share of non-null source values that resolve to a target row. A link at
    -- 0.72 is real but partial (origin ids split across Location and BillTo);
    -- surfacing it stops the UI from presenting a lossy join as complete.
    match_ratio         NUMERIC(5,4),
    matched_rows        BIGINT,
    candidate_rows      BIGINT,
    is_verified         BOOLEAN NOT NULL DEFAULT false,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_link_type_version ON link_type (ontology_version_id);
CREATE INDEX IF NOT EXISTS ix_link_type_source  ON link_type (source_object_type);
CREATE INDEX IF NOT EXISTS ix_link_type_target  ON link_type (target_object_type);

-- ---------------------------------------------------------------------------
--  Action types  (the ontology's verb layer)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS action_type (
    action_type_rid     TEXT PRIMARY KEY,
    ontology_version_id BIGINT NOT NULL REFERENCES ontology_version(ontology_version_id) ON DELETE CASCADE,
    api_name            TEXT NOT NULL,
    label               TEXT NOT NULL,
    description         TEXT,
    target_object_types TEXT[] NOT NULL DEFAULT '{}',
    parameters          JSONB NOT NULL DEFAULT '[]'::jsonb,
    requires_approval   BOOLEAN NOT NULL DEFAULT false,
    approver_roles      TEXT[] NOT NULL DEFAULT '{}',
    allowed_roles       TEXT[] NOT NULL DEFAULT '{}',
    audit_level         TEXT NOT NULL DEFAULT 'full' CHECK (audit_level IN ('minimal','full')),
    -- Actions that only read (a what-if or a report) are safe for the assistant
    -- to invoke unattended; mutating ones always go through confirmation.
    is_read_only        BOOLEAN NOT NULL DEFAULT false,
    tags                TEXT[] NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS action_audit (
    action_audit_id  BIGSERIAL PRIMARY KEY,
    action_type_rid  TEXT,
    api_name         TEXT NOT NULL,
    object_type_rid  TEXT,
    object_key       TEXT,
    parameters       JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- 'staged' is the honest outcome for a mutating action here: parameters and
    -- permissions were checked and the request was recorded, but this platform
    -- reads the TMS through a captured snapshot and has no write-back endpoint,
    -- so nothing was sent. 'succeeded' is reserved for read-only actions, which
    -- really do run and return a computed result.
    status           TEXT NOT NULL CHECK (status IN ('succeeded','staged','failed','rejected','pending_approval')),
    validation       JSONB NOT NULL DEFAULT '{}'::jsonb,
    result           JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_message    TEXT,
    actor            TEXT NOT NULL DEFAULT 'anonymous',
    actor_role       TEXT,
    -- Set when the assistant, not a human, triggered the action.
    initiated_by_ai  BOOLEAN NOT NULL DEFAULT false,
    chat_session_id  BIGINT,
    duration_ms      INTEGER,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_action_audit_created ON action_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS ix_action_audit_action  ON action_audit (api_name);

-- ---------------------------------------------------------------------------
--  Lineage graph
-- ---------------------------------------------------------------------------
--  Shape follows the LineageNode / LineageEdge interfaces in
--  @ontograph/core (src/lineage.ts) so rows can be handed to the library
--  without translation.
CREATE TABLE IF NOT EXISTS lineage_node (
    lineage_node_rid TEXT PRIMARY KEY,
    node_type        TEXT NOT NULL CHECK (node_type IN ('dataSource','transformation','object','usage')),
    label            TEXT NOT NULL,
    description      TEXT,
    object_id        TEXT,          -- set when node_type = 'object'
    payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
    node_version     INTEGER NOT NULL DEFAULT 1,
    layer            TEXT,          -- source | raw | view | ontology | metric | consumer
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by       TEXT NOT NULL DEFAULT 'pipeline',
    tags             TEXT[] NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS ix_lineage_node_type  ON lineage_node (node_type);
CREATE INDEX IF NOT EXISTS ix_lineage_node_layer ON lineage_node (layer);

CREATE TABLE IF NOT EXISTS lineage_edge (
    lineage_edge_rid TEXT PRIMARY KEY,
    source_node_rid  TEXT NOT NULL REFERENCES lineage_node(lineage_node_rid) ON DELETE CASCADE,
    target_node_rid  TEXT NOT NULL REFERENCES lineage_node(lineage_node_rid) ON DELETE CASCADE,
    relation_type    TEXT NOT NULL CHECK (relation_type IN ('flowsTo','derivedFrom','usedBy')),
    -- Carries flow volume on a flowsTo edge (rows moved) and match ratio on a
    -- derivedFrom edge, which is what ontograph's impact analysis weights by.
    -- Wide enough for a real row count: a 6,3 numeric overflowed on 2,269 rows.
    weight           NUMERIC(16,4),
    payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_lineage_edge_source ON lineage_edge (source_node_rid);
CREATE INDEX IF NOT EXISTS ix_lineage_edge_target ON lineage_edge (target_node_rid);

-- Column-level lineage: which view column came from which raw column. This is
-- what lets the UI answer "where does gross_weight_kg come from" precisely.
CREATE TABLE IF NOT EXISTS lineage_column (
    lineage_column_id BIGSERIAL PRIMARY KEY,
    target_view       TEXT NOT NULL,
    target_column     TEXT NOT NULL,
    source_table      TEXT NOT NULL,
    source_column     TEXT,
    transform_note    TEXT,
    UNIQUE (target_view, target_column, source_table, source_column)
);

-- ---------------------------------------------------------------------------
--  KPI catalogue
-- ---------------------------------------------------------------------------
--  A KPI is a named, reviewable semantic object: which view, which column, how
--  to aggregate it, which dimensions it may be sliced by, and how to format it.
--  The assistant composes dashboards by selecting from this catalogue, so a
--  chart can always be traced to a definition a human approved.
CREATE TABLE IF NOT EXISTS kpi_definition (
    kpi_rid            TEXT PRIMARY KEY,           -- kpi:on_time_delivery_pct
    api_name           TEXT NOT NULL UNIQUE,
    label              TEXT NOT NULL,
    description        TEXT,
    business_question  TEXT,
    category           TEXT NOT NULL DEFAULT 'operations',
    source_view        TEXT NOT NULL,
    measure_column     TEXT,
    aggregation        TEXT NOT NULL DEFAULT 'sum'
                       CHECK (aggregation IN ('sum','avg','count','count_distinct','min','max','ratio','passthrough')),
    numerator_column   TEXT,                       -- for aggregation = 'ratio'
    denominator_column TEXT,
    dimensions         TEXT[] NOT NULL DEFAULT '{}',
    default_dimension  TEXT,
    time_column        TEXT,
    unit               TEXT,
    value_format       TEXT NOT NULL DEFAULT 'number'
                       CHECK (value_format IN ('number','integer','currency','percent','duration_hours','duration_days','weight_kg','distance_km')),
    higher_is_better   BOOLEAN,
    target_value       NUMERIC(18,4),
    warning_threshold  NUMERIC(18,4),
    critical_threshold NUMERIC(18,4),
    related_object_types TEXT[] NOT NULL DEFAULT '{}',
    -- Set where the metric leans on simulated execution data, so every chart
    -- built from it can be labelled honestly.
    depends_on_simulation BOOLEAN NOT NULL DEFAULT false,
    coverage_note      TEXT,
    display_order       INTEGER NOT NULL DEFAULT 100,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_kpi_category ON kpi_definition (category);

-- ---------------------------------------------------------------------------
--  Dashboards
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dashboard (
    dashboard_id   BIGSERIAL PRIMARY KEY,
    slug           TEXT NOT NULL UNIQUE,
    title          TEXT NOT NULL,
    description    TEXT,
    -- layout is an array of widget descriptors: {type, kpi, dimension, filters,
    -- chart, width, title}. Rendering is entirely data-driven from this.
    layout         JSONB NOT NULL DEFAULT '[]'::jsonb,
    filters        JSONB NOT NULL DEFAULT '{}'::jsonb,
    audience       TEXT,
    is_ai_generated BOOLEAN NOT NULL DEFAULT false,
    source_prompt  TEXT,
    created_by     TEXT NOT NULL DEFAULT 'system',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    is_pinned      BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS ix_dashboard_updated ON dashboard (updated_at DESC);

-- ---------------------------------------------------------------------------
--  Assistant conversations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_session (
    chat_session_id BIGSERIAL PRIMARY KEY,
    title           TEXT,
    user_id         TEXT NOT NULL DEFAULT 'demo-user',
    user_role       TEXT NOT NULL DEFAULT 'tms:AnalystRole',
    llm_provider    TEXT,
    llm_model       TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    message_count   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS chat_message (
    chat_message_id BIGSERIAL PRIMARY KEY,
    chat_session_id BIGINT NOT NULL REFERENCES chat_session(chat_session_id) ON DELETE CASCADE,
    seq             INTEGER NOT NULL,
    role            TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
    content         TEXT,
    -- Tool calls are persisted so a conversation can be audited: which
    -- ontology query produced the number the assistant quoted.
    tool_calls      JSONB NOT NULL DEFAULT '[]'::jsonb,
    tool_name       TEXT,
    tool_result     JSONB,
    artifacts       JSONB NOT NULL DEFAULT '[]'::jsonb,
    latency_ms      INTEGER,
    token_usage     JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (chat_session_id, seq)
);

CREATE INDEX IF NOT EXISTS ix_chat_message_session ON chat_message (chat_session_id, seq);

-- ---------------------------------------------------------------------------
--  Generation runs (pipeline -> ontology)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS generation_run (
    generation_run_id BIGSERIAL PRIMARY KEY,
    started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at       TIMESTAMPTZ,
    status            TEXT NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running','success','failed')),
    stage_log         JSONB NOT NULL DEFAULT '[]'::jsonb,
    views_scanned     INTEGER NOT NULL DEFAULT 0,
    object_types      INTEGER NOT NULL DEFAULT 0,
    link_types        INTEGER NOT NULL DEFAULT 0,
    kpis              INTEGER NOT NULL DEFAULT 0,
    lineage_nodes     INTEGER NOT NULL DEFAULT 0,
    error_message     TEXT
);
