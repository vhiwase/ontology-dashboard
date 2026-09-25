-- ============================================================================
--  0026: Python transform repositories, and connectors that are not PostgreSQL.
--
--  Two gaps, both of them "the platform describes a capability it does not
--  have".
--
--  -- 1. a repository could hold SQL, and that was all ------------------------
--  0025 gave transforms repositories one language: a `.sql` file with an
--  @output header. That covers a projection and an aggregate and nothing else.
--  Per-row logic - scoring an order against a list of rules, reshaping a
--  nested payload, anything with a branch in it - is what people actually
--  reach for a repository to write, and it is exactly what SQL is worst at.
--
--  A `python` repository holds Foundry-shaped transforms:
--
--      @transform(
--          output=Output("repo_out.order_exception_scores"),
--          orders=Input("tms_views.v_order"),
--      )
--      def compute(orders, output):
--          output.write([...])
--
--  and the build RUNS them. The rule that makes the kind coherent: a transform
--  that does not declare an Output, or declares one and never writes to it,
--  FAILS the build and says which. A repository whose build goes green without
--  producing a dataset is the failure this rule exists to prevent.
--
--  -- 2. every connection was a PostgreSQL connection --------------------------
--  `engine` was declared as the single value 'postgresql'. The captured TMS
--  payloads this whole platform is built on came from a REST API, so the one
--  source that demonstrably matters could not be registered. A connection now
--  carries a connector kind, and a REST source is a first-class one: a base
--  URL, a credential reference, and syncs that name a path rather than a table.
-- ============================================================================

-- -- python repositories ------------------------------------------------------

ALTER TABLE platform.code_repo DROP CONSTRAINT IF EXISTS code_repo_kind_check;
ALTER TABLE platform.code_repo ADD CONSTRAINT code_repo_kind_check
    CHECK (kind IN ('transforms','python','functions'));

-- -- connectors ---------------------------------------------------------------
--  Held on the resource's properties JSON rather than in a column, like every
--  other connection field: a connection is a platform.resource row and its
--  shape differs per connector. What is recorded here is the CHECK that the
--  sync tables need.

ALTER TABLE platform.connection_sync
    -- A REST sync names a path on the source, not a schema and a table. The
    -- existing columns are reused rather than duplicated - source_schema holds
    -- the connector kind's second axis - so a sync stays one row whatever it
    -- pulls from. For REST: source_schema = 'rest', source_table = the slug the
    -- landing table is named for, and the path lives here.
    ADD COLUMN IF NOT EXISTS source_path TEXT,
    -- Where the records live inside the response: "data.items", or empty when
    -- the body is already an array. A REST payload is rarely a bare list, and
    -- guessing which key holds the rows is how a sync silently lands one row
    -- containing the whole document.
    ADD COLUMN IF NOT EXISTS records_path TEXT;

COMMENT ON COLUMN platform.connection_sync.source_path IS
    'REST connectors only: the path appended to the connection base URL.';
COMMENT ON COLUMN platform.connection_sync.records_path IS
    'REST connectors only: dotted path to the array of records in the response.';

-- The identifier check has to relax for REST, where there is no schema on the
-- far side to validate against. The service still derives the landing table
-- name itself, so nothing the caller writes becomes an identifier.
ALTER TABLE platform.connection_sync DROP CONSTRAINT IF EXISTS connection_sync_rest_path;
ALTER TABLE platform.connection_sync ADD CONSTRAINT connection_sync_rest_path
    CHECK (source_schema <> 'rest' OR source_path IS NOT NULL);

-- -- a python repository to look at --------------------------------------------
--  Seeded like 0025's two, and for the same reason: an empty repository
--  demonstrates nothing, and this one has a rule about failing builds that is
--  only believable if you can watch it.

INSERT INTO platform.code_repo (space_id, slug, name, description, kind, created_by)
SELECT s.space_id,
       'tms-python-transforms',
       'TMS Python Transforms',
       'Per-row logic that SQL reads badly: scoring, reshaping, branching. '
       || 'Every transform must write a dataset, or the build fails and says so.',
       'python',
       'system'
  FROM platform.space s
 WHERE s.slug = 'sandbox'
ON CONFLICT (space_id, slug) DO NOTHING;

INSERT INTO platform.code_file (repo_id, path, content, language, updated_by)
SELECT r.repo_id, 'README.md', $file$# TMS Python Transforms

One transform per file under `transforms/`. The build runs each one and writes
what it returns into a dataset.

```python
from transforms.api import transform, Input, Output

@transform(
    output=Output("repo_out.my_table"),
    orders=Input("tms_views.v_order"),
)
def compute(orders, output):
    output.write([{"lane": o["lane"]} for o in orders])
```

| | |
|---|---|
| `Input("schema.table")` | arrives as a list of dicts, one per row |
| `Output("repo_out.table")` | `.write(rows)` — a list of dicts |

Numbers arrive as numbers. `bigint` and `numeric` cross the driver as strings,
which would make `row["accessorial_count"] > 2` a TypeError; they are converted
back using the column's real type, so a text column that happens to hold digits
is left alone. A bigint too large for a float stays a string rather than
silently changing value. Timestamps arrive as ISO-8601 strings.

**A transform must write a dataset.** Declaring no `Output`, or declaring one
and never calling `.write()`, fails the build and names the file. A build that
goes green without producing anything is the failure this rule exists to stop.

### What you may read

`tms_views.*` (views the published ontology exposes), and `connection_raw.*`,
`repo_out.*` and `pipeline_out.*` — the schemas this platform writes itself.
Anything else is refused by name.

### What runs, and where

Your code runs in a Python subprocess inside the ontology service: no database
handle, no credentials in its environment, a time limit, and a cap on how many
rows it may return. It gets the rows it declared and hands rows back. That is
the whole of its access.
$file$, 'markdown', 'system'
  FROM platform.code_repo r
  JOIN platform.space s ON s.space_id = r.space_id
 WHERE s.slug = 'sandbox' AND r.slug = 'tms-python-transforms'
ON CONFLICT (repo_id, path) DO NOTHING;

INSERT INTO platform.code_file (repo_id, path, content, language, updated_by)
SELECT r.repo_id, 'transforms/order_exception_scores.py', $file$"""Score every order against the exceptions the snapshot can actually see.

Written in Python rather than SQL because it is a list of rules with a branch
in each one, and because the reasons have to be collected as they are found.
Every field it reads is measured: no carrier, cost or arrival appears here,
because the captured payload carries none of them.
"""

from transforms.api import transform, Input, Output


@transform(
    output=Output("repo_out.order_exception_scores"),
    orders=Input("tms_views.v_order"),
)
def compute(orders, output):
    scored = []

    for order in orders:
        reasons = []
        severity = 0

        if order["is_unplanned"]:
            reasons.append("no route planned")
            severity += 3
        if order["has_implausible_weight"]:
            reasons.append("implausible weight")
            severity += 4
        if order["has_hazmat"]:
            reasons.append("hazmat")
            severity += 2
        if order["is_temperature_controlled"]:
            reasons.append("temperature controlled")
            severity += 1
        if order["has_non_stackable"]:
            reasons.append("non-stackable")
            severity += 1
        if (order["accessorial_count"] or 0) > 2:
            reasons.append(f"{order['accessorial_count']} accessorials")
            severity += 1

        # An order with nothing against it is still a row. Dropping the clean
        # ones would make "how many orders are clean" unanswerable from the
        # dataset, which is half of what anyone asks it.
        scored.append(
            {
                "order_key": order["order_key"],
                "order_number": order["order_number"],
                "lane": order["lane"],
                "account_name": order["account_name"],
                "gross_weight_kg": order["gross_weight_kg"],
                "severity": severity,
                "band": "high" if severity >= 5 else "medium" if severity >= 2 else "clean" if severity == 0 else "low",
                "reason_count": len(reasons),
                "reasons": "; ".join(reasons) if reasons else None,
            }
        )

    scored.sort(key=lambda row: (-row["severity"], row["order_number"] or ""))
    output.write(scored)
$file$, 'python', 'system'
  FROM platform.code_repo r
  JOIN platform.space s ON s.space_id = r.space_id
 WHERE s.slug = 'sandbox' AND r.slug = 'tms-python-transforms'
ON CONFLICT (repo_id, path) DO NOTHING;

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
   AND r.slug = 'tms-python-transforms'
   AND EXISTS (SELECT 1 FROM platform.code_file f WHERE f.repo_id = r.repo_id)
ON CONFLICT (repo_id, sequence) DO NOTHING;

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
   AND r.slug = 'tms-python-transforms'
   AND NOT EXISTS (
         SELECT 1 FROM platform.resource x
          WHERE x.project_id = p.project_id
            AND x.kind = 'codeRepo'
            AND x.target_ref = r.slug);
