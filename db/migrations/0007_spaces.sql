-- ============================================================================
--  0007: spaces, projects, folders and resources.
--
--  The platform had object types, links, actions, KPIs, dashboards and
--  pipelines, but nowhere to PUT them: no space, no project, no folder, and no
--  first-class dataset object. Everything lived in one flat global namespace,
--  which is workable for a demo and wrong for anything with more than one team
--  or more than one environment.
--
--  The hierarchy is
--
--      space  ->  project  ->  folder (nestable)  ->  resource
--
--  A SPACE is environment-scoped: sandbox, development, staging, production.
--  Separating them is the point - a pipeline promoted to production must not
--  share a namespace with the sandbox copy someone is experimenting on.
--
--  A RESOURCE is the addressable thing: a dataset, an object type, an action
--  type, a link type, a pipeline, a dashboard, a connection.
--
--  Resources reference ontology entities BY api_name, not by foreign key. The
--  ontology is regenerated wholesale by the pipeline and every row in
--  platform.object_type is replaced when it is; a real foreign key would
--  either block that or cascade the user's whole workspace away.
-- ============================================================================

CREATE TABLE IF NOT EXISTS platform.space (
    space_id     BIGSERIAL PRIMARY KEY,
    slug         TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    description  TEXT,
    environment  TEXT NOT NULL
                 CHECK (environment IN ('sandbox','development','staging','production')),
    -- One space per environment is created up front, and those cannot be
    -- deleted: the environment list is fixed, so a missing space would just be
    -- a hole someone has to recreate by hand.
    is_system    BOOLEAN NOT NULL DEFAULT false,
    created_by   TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform.project (
    project_id   BIGSERIAL PRIMARY KEY,
    space_id     BIGINT NOT NULL REFERENCES platform.space(space_id) ON DELETE CASCADE,
    slug         TEXT NOT NULL,
    name         TEXT NOT NULL,
    description  TEXT,
    created_by   TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Unique per space, not globally: two spaces may both hold "TMS Platform",
    -- which is exactly what promoting a project between environments means.
    UNIQUE (space_id, slug)
);

CREATE TABLE IF NOT EXISTS platform.folder (
    folder_id    BIGSERIAL PRIMARY KEY,
    project_id   BIGINT NOT NULL REFERENCES platform.project(project_id) ON DELETE CASCADE,
    parent_id    BIGINT REFERENCES platform.folder(folder_id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    -- Materialised "/Datasets/Raw" path. Denormalised on purpose: the tree is
    -- read far more often than it is reshaped, and walking parent_id per node
    -- to render a breadcrumb is a query per level.
    path         TEXT NOT NULL,
    created_by   TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, path)
);

CREATE INDEX IF NOT EXISTS ix_folder_project ON platform.folder (project_id, parent_id);

CREATE TABLE IF NOT EXISTS platform.resource (
    resource_id  BIGSERIAL PRIMARY KEY,
    project_id   BIGINT NOT NULL REFERENCES platform.project(project_id) ON DELETE CASCADE,
    folder_id    BIGINT REFERENCES platform.folder(folder_id) ON DELETE CASCADE,
    kind         TEXT NOT NULL CHECK (kind IN (
                     'dataset','objectType','actionType','linkType',
                     'pipeline','dashboard','connection','kpi'
                 )),
    name         TEXT NOT NULL,
    description  TEXT,
    -- What this resource points at in the rest of the platform: an object
    -- type's api_name, a pipeline's slug, a dashboard's slug. Nullable because
    -- a connection points at nothing but itself.
    target_ref   TEXT,
    -- Kind-specific payload: a dataset's schema snapshot and backing view, a
    -- connection's DSN without its password.
    properties   JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by   TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, folder_id, name)
);

CREATE INDEX IF NOT EXISTS ix_resource_project ON platform.resource (project_id, folder_id);
CREATE INDEX IF NOT EXISTS ix_resource_kind ON platform.resource (kind);
CREATE INDEX IF NOT EXISTS ix_resource_target ON platform.resource (kind, target_ref);

-- One space per environment, created up front so the workspace is never empty
-- and so promoting between environments has somewhere to land.
INSERT INTO platform.space (slug, name, description, environment, is_system, created_by)
VALUES
    ('sandbox', 'Sandbox',
     'Personal workspace. Safe to break: nothing here is served to anyone else.',
     'sandbox', true, 'system'),
    ('development', 'Development',
     'Shared development environment.',
     'development', true, 'system'),
    ('staging', 'Staging',
     'Pre-production verification.',
     'staging', true, 'system'),
    ('production', 'Production',
     'Live environment. Simulated figures are refused here when ALLOW_SIMULATED_DATA=false.',
     'production', true, 'system')
ON CONFLICT (slug) DO NOTHING;
