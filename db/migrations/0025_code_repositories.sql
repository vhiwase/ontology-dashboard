-- ============================================================================
--  0025: code repositories - where ingestion and functions are written down.
--
--  The platform had two ways to make something: draw a pipeline on a canvas,
--  or paste one SQL definition into the function dialog. Neither is a place to
--  KEEP work. There was no file, no history of who changed a definition and
--  why, and no way to publish several things as one reviewed change.
--
--  This adds the Foundry shape: a repository holds files, a commit records a
--  change to them, and a build turns the committed files into things the rest
--  of the platform can use. Two kinds, because the two jobs have genuinely
--  different outputs:
--
--    transforms  files that INGEST and RESHAPE data.
--                *.sync.json declares a pull through a connection (0024);
--                transforms/*.sql declares a table built from what landed.
--                Building produces datasets.
--
--    functions   files that define a named computation.
--                Building publishes each one into platform.function (0016).
--
--  -- on what a build may do ---------------------------------------------------
--  A build never executes arbitrary code. A transform's SQL goes through the
--  same compiler a pipeline node does - one SELECT, no stacked statements, no
--  writes - and is materialised by the same engine. A Python or TypeScript
--  function file is stored and published as a definition and reported as not
--  executable here, exactly as 0016 already does: this deployment has no
--  sandbox to run one in, and pretending otherwise would be the dishonest
--  half of a feature.
--
--  -- on publishing versus approving -------------------------------------------
--  A functions build publishes as `proposed`. Approval stays what 0016 made
--  it: a separate, admin-level, human act. A repository is a place to write a
--  definition down, not a way around the review that makes it produce numbers
--  on someone else's dashboard.
-- ============================================================================

-- Built transform outputs, kept apart from pipeline_out for the same reason
-- pipeline_out is kept apart from tms_views: a reader should be able to tell
-- what wrote a table from where it lives.
CREATE SCHEMA IF NOT EXISTS repo_out;

COMMENT ON SCHEMA repo_out IS
    'Tables materialised by a code repository build. Rebuilt on every build '
    'and safe to drop.';

-- -- the repository -----------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform.code_repo (
    repo_id         BIGSERIAL PRIMARY KEY,
    space_id        BIGINT NOT NULL
        REFERENCES platform.space(space_id) ON DELETE CASCADE,

    slug            TEXT NOT NULL,
    name            TEXT NOT NULL,
    description     TEXT,

    kind            TEXT NOT NULL
                    CHECK (kind IN ('transforms','functions')),

    -- Named rather than implied. There is one branch here and a build always
    -- builds it; recording its name keeps the door open for more without
    -- pretending today's single branch is something it is not.
    default_branch  TEXT NOT NULL DEFAULT 'master',

    created_by      TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (space_id, slug)
);

-- -- the working tree ---------------------------------------------------------
--  The files as they are now. A commit snapshots them; this is what an editor
--  reads and writes.

CREATE TABLE IF NOT EXISTS platform.code_file (
    file_id         BIGSERIAL PRIMARY KEY,
    repo_id         BIGINT NOT NULL
        REFERENCES platform.code_repo(repo_id) ON DELETE CASCADE,

    -- Relative, with '/' separators and no leading slash. Validated by the
    -- service: a path is shown to people and used to decide what a file means
    -- ('functions/x.sql' is published, 'README.md' is not).
    path            TEXT NOT NULL,
    content         TEXT NOT NULL,
    language        TEXT NOT NULL DEFAULT 'sql'
                    CHECK (language IN ('sql','python','typescript','json','markdown')),

    updated_by      TEXT NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (repo_id, path)
);

CREATE INDEX IF NOT EXISTS ix_code_file_repo ON platform.code_file (repo_id, path);

-- -- history ------------------------------------------------------------------
--  A commit is the whole tree, not a diff. The tree here is a handful of small
--  text files, and storing the snapshot means a build can be reproduced from
--  the commit alone rather than by replaying every change before it.

CREATE TABLE IF NOT EXISTS platform.code_commit (
    commit_id       BIGSERIAL PRIMARY KEY,
    repo_id         BIGINT NOT NULL
        REFERENCES platform.code_repo(repo_id) ON DELETE CASCADE,

    -- 1, 2, 3 ... per repository, so a person can say "commit 4" and be
    -- understood. The primary key is global and says nothing useful.
    sequence        INTEGER NOT NULL,
    message         TEXT NOT NULL,
    author          TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- { "path": "content", ... } as the tree stood at this commit.
    files           JSONB NOT NULL DEFAULT '{}'::jsonb,
    file_count      INTEGER NOT NULL DEFAULT 0,

    UNIQUE (repo_id, sequence)
);

CREATE INDEX IF NOT EXISTS ix_code_commit_repo
    ON platform.code_commit (repo_id, sequence DESC);

-- -- builds -------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform.code_build (
    build_id        BIGSERIAL PRIMARY KEY,
    repo_id         BIGINT NOT NULL
        REFERENCES platform.code_repo(repo_id) ON DELETE CASCADE,
    -- Which commit was built. A build of uncommitted work would be a number
    -- nobody could reproduce.
    commit_id       BIGINT
        REFERENCES platform.code_commit(commit_id) ON DELETE SET NULL,

    status          TEXT NOT NULL
                    CHECK (status IN ('running','success','failed')),
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    duration_ms     INTEGER,

    -- One entry per file the build acted on: what it was, what it produced,
    -- and the error if it failed. This is what the build log shows.
    artifacts       JSONB NOT NULL DEFAULT '[]'::jsonb,
    error_message   TEXT,
    triggered_by    TEXT NOT NULL DEFAULT 'user'
);

CREATE INDEX IF NOT EXISTS ix_code_build_repo
    ON platform.code_build (repo_id, started_at DESC);

-- -- a repository is a resource ------------------------------------------------
--  So it appears in the workspace tree and the resource browser beside the
--  datasets it produces, rather than in a page of its own that nothing links
--  to.

ALTER TABLE platform.resource DROP CONSTRAINT IF EXISTS resource_kind_check;
ALTER TABLE platform.resource ADD CONSTRAINT resource_kind_check CHECK (kind IN (
    'dataset','objectType','actionType','linkType',
    'pipeline','dashboard','connection','kpi','codeRepo'
));

-- -- the seeded connection can now actually be synced through -------------------
--  It was registered with an engine and a display DSN and nothing else, which
--  made it untestable and unsyncable: there was no host to reach and no
--  credential to resolve. These are the same values the New Connection dialog
--  asks for, filled in from the database this migration is running against.
--
--  'postgres' is the compose service name, which is how every service on this
--  network reaches the database. The credential is the REFERENCE to the Docker
--  secret, never the password: docker-compose.yml already mounts
--  postgres_password into the ontology service for exactly this.
UPDATE platform.resource
   SET properties = properties
       || jsonb_build_object(
            'host',      'postgres',
            'port',      5432,
            'database',  current_database(),
            'username',  current_user,
            'secretRef', '/run/secrets/postgres_password',
            'sslMode',   'prefer'
          ),
       updated_at = now()
 WHERE kind = 'connection'
   AND properties->>'host' IS NULL;

-- -- starter repositories -------------------------------------------------------
--  Two working repositories in the sandbox, following 0020's precedent of
--  seeding something real rather than an empty shell. Every file here builds:
--  the sync reads a view that exists, and the functions read columns that
--  exist. Nothing is generated - the sync copies measured rows from the
--  captured snapshot through the connection, which is the point of the
--  demonstration.

INSERT INTO platform.code_repo (space_id, slug, name, description, kind, created_by)
SELECT s.space_id,
       'tms-data-ingestion',
       'TMS Data Ingestion',
       'Pulls TMS tables in through the connection and reshapes what lands. '
       || 'Build it to run every sync it declares and materialise every transform.',
       'transforms',
       'system'
  FROM platform.space s
 WHERE s.slug = 'sandbox'
ON CONFLICT (space_id, slug) DO NOTHING;

INSERT INTO platform.code_repo (space_id, slug, name, description, kind, created_by)
SELECT s.space_id,
       'tms-functions',
       'TMS Functions',
       'Named computations over the published ontology. Building publishes each '
       || 'file as a proposed function; approving one stays a separate act.',
       'functions',
       'system'
  FROM platform.space s
 WHERE s.slug = 'sandbox'
ON CONFLICT (space_id, slug) DO NOTHING;

-- -- ingestion repo files --------------------------------------------------------

INSERT INTO platform.code_file (repo_id, path, content, language, updated_by)
SELECT r.repo_id, 'README.md', $file$# TMS Data Ingestion

Two kinds of file build here.

### `*.sync.json` - pull through a connection

Declares a sync on a registered connection. Building the repository creates or
updates the sync and runs it, landing the rows in `connection_raw` and
registering the dataset that wraps them.

| Field | Meaning |
|---|---|
| `connection` | the name of a connection resource in this space |
| `name` | the sync's name, unique per connection |
| `source` | `{ "schema": "...", "table": "..." }` on the far side |
| `mode` | `snapshot` rebuilds the table; `incremental` appends past a cursor |
| `cursorColumn` | required for `incremental` |
| `rowLimit` | how many rows one run may read; the run says so if it hits it |

### `transforms/*.sql` - build a table from what landed

One `SELECT`, with the table it writes declared in a header comment:

```sql
-- @output repo_out.my_table
SELECT ...
```

It is compiled by the same compiler a pipeline node uses, so it is read-only by
construction, and materialised into `repo_out`. A transform that reads a synced
table will fail with a clear message until that sync has run at least once -
build the repository and the syncs run first.
$file$, 'markdown', 'system'
  FROM platform.code_repo r
  JOIN platform.space s ON s.space_id = r.space_id
 WHERE s.slug = 'sandbox' AND r.slug = 'tms-data-ingestion'
ON CONFLICT (repo_id, path) DO NOTHING;

INSERT INTO platform.code_file (repo_id, path, content, language, updated_by)
SELECT r.repo_id, 'syncs/orders.sync.json', $file${
  "connection": "tms_ontology",
  "name": "orders",
  "description": "Every order in the captured snapshot, pulled through the connection rather than read in place.",
  "source": { "schema": "tms_views", "table": "v_order" },
  "mode": "snapshot",
  "rowLimit": 50000
}
$file$, 'json', 'system'
  FROM platform.code_repo r
  JOIN platform.space s ON s.space_id = r.space_id
 WHERE s.slug = 'sandbox' AND r.slug = 'tms-data-ingestion'
ON CONFLICT (repo_id, path) DO NOTHING;

INSERT INTO platform.code_file (repo_id, path, content, language, updated_by)
SELECT r.repo_id, 'transforms/order_volume_by_lane.sql', $file$-- @output repo_out.order_volume_by_lane
--
-- Orders grouped by lane, built from what the orders sync landed. Every column
-- is measured: v_order is 90 of 90 rows from the captured payload.
--
-- The input is the table the sync writes. Its name is derived from the
-- connection and the source table, so it changes only if the sync does.
SELECT lane,
       count(*)                                        AS orders,
       sum(gross_weight_kg)                            AS total_weight_kg,
       sum(piece_count)                                AS total_pieces,
       round(avg(gross_weight_kg)::numeric, 2)         AS avg_weight_kg
  FROM connection_raw.tms_ontology__tms_views__v_order
 WHERE lane IS NOT NULL
 GROUP BY lane
$file$, 'sql', 'system'
  FROM platform.code_repo r
  JOIN platform.space s ON s.space_id = r.space_id
 WHERE s.slug = 'sandbox' AND r.slug = 'tms-data-ingestion'
ON CONFLICT (repo_id, path) DO NOTHING;

-- -- functions repo files ---------------------------------------------------------

INSERT INTO platform.code_file (repo_id, path, content, language, updated_by)
SELECT r.repo_id, 'README.md', $file$# TMS Functions

One function per file under `functions/`. The header is a comment block of
`key: value` lines; everything after it is the definition.

```sql
-- name: Average Weight Per Piece
-- description: what it computes
-- businessQuestion: the question it answers
-- returns: scalar | table
-- unit: kg
SELECT ...
```

`name` is required and is what the function is called; its api name and rid are
derived from it once and then frozen, because dashboards reference them.

Building publishes each file into the function catalogue as **proposed**.
A proposed function computes nothing and no dashboard may use it. Approving one
is a separate admin act on the Functions page - that split is the whole point
of it, so a build cannot perform it.

SQL definitions execute. Python and TypeScript files are published as
definitions and reported as not executable: there is no sandboxed runtime here
to run them in.
$file$, 'markdown', 'system'
  FROM platform.code_repo r
  JOIN platform.space s ON s.space_id = r.space_id
 WHERE s.slug = 'sandbox' AND r.slug = 'tms-functions'
ON CONFLICT (repo_id, path) DO NOTHING;

INSERT INTO platform.code_file (repo_id, path, content, language, updated_by)
SELECT r.repo_id, 'functions/avg_weight_per_piece.sql', $file$-- name: Average Weight Per Piece
-- description: Mean gross weight of one piece of freight, across the orders that report both a weight and a piece count.
-- businessQuestion: How heavy is an average piece of freight we move?
-- returns: scalar
-- returnType: numeric
-- unit: kg
-- valueFormat: number
SELECT round(avg(gross_weight_kg / nullif(piece_count, 0))::numeric, 2)
         AS avg_weight_per_piece_kg
  FROM tms_views.v_order
 WHERE gross_weight_kg > 0
   AND piece_count > 0
$file$, 'sql', 'system'
  FROM platform.code_repo r
  JOIN platform.space s ON s.space_id = r.space_id
 WHERE s.slug = 'sandbox' AND r.slug = 'tms-functions'
ON CONFLICT (repo_id, path) DO NOTHING;

INSERT INTO platform.code_file (repo_id, path, content, language, updated_by)
SELECT r.repo_id, 'functions/orders_by_mode.sql', $file$-- name: Orders By Transportation Mode
-- description: How many orders, how much weight and how many pieces move on each transportation mode.
-- businessQuestion: What is the mode mix of our order book?
-- returns: table
-- valueFormat: number
SELECT coalesce(transportation_mode, 'Unspecified') AS transportation_mode,
       count(*)              AS orders,
       sum(gross_weight_kg)  AS total_weight_kg,
       sum(piece_count)      AS total_pieces
  FROM tms_views.v_order
 GROUP BY 1
 ORDER BY orders DESC
$file$, 'sql', 'system'
  FROM platform.code_repo r
  JOIN platform.space s ON s.space_id = r.space_id
 WHERE s.slug = 'sandbox' AND r.slug = 'tms-functions'
ON CONFLICT (repo_id, path) DO NOTHING;

-- -- an initial commit for each, so a build has something to build ---------------

INSERT INTO platform.code_commit (repo_id, sequence, message, author, files, file_count)
SELECT r.repo_id,
       1,
       'Initial commit',
       'system',
       (SELECT jsonb_object_agg(f.path, f.content)
          FROM platform.code_file f WHERE f.repo_id = r.repo_id),
       (SELECT count(*) FROM platform.code_file f WHERE f.repo_id = r.repo_id)
  FROM platform.code_repo r
  JOIN platform.space s ON s.space_id = r.space_id
 WHERE s.slug = 'sandbox'
   AND r.slug IN ('tms-data-ingestion','tms-functions')
   AND EXISTS (SELECT 1 FROM platform.code_file f WHERE f.repo_id = r.repo_id)
ON CONFLICT (repo_id, sequence) DO NOTHING;

-- -- and a resource for each, where the sandbox has already been filled ----------
--  On a fresh database the sandbox is seeded after migrations run, and
--  seedSandbox creates these instead. Guarded so it does neither twice.

INSERT INTO platform.folder (project_id, parent_id, name, path, created_by)
SELECT p.project_id, NULL, 'Code', '/Code', 'system'
  FROM platform.project p
  JOIN platform.space s ON s.space_id = p.space_id
 WHERE s.slug = 'sandbox' AND p.slug = 'tms-platform'
ON CONFLICT (project_id, path) DO NOTHING;

INSERT INTO platform.resource (project_id, folder_id, kind, name, description, target_ref, properties, created_by)
SELECT p.project_id,
       (SELECT f.folder_id FROM platform.folder f
         WHERE f.project_id = p.project_id AND f.path = '/Code'),
       'codeRepo',
       r.name,
       r.description,
       r.slug,
       jsonb_build_object('repoKind', r.kind, 'branch', r.default_branch),
       'system'
  FROM platform.code_repo r
  JOIN platform.space s ON s.space_id = r.space_id
  JOIN platform.project p ON p.space_id = s.space_id
 WHERE s.slug = 'sandbox'
   AND p.slug = 'tms-platform'
   AND NOT EXISTS (
         SELECT 1 FROM platform.resource x
          WHERE x.project_id = p.project_id
            AND x.kind = 'codeRepo'
            AND x.target_ref = r.slug);
