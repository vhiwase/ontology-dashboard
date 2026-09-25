# TMS Ontology Workbench

A Palantir-Foundry-shaped ontology platform over a real 3PL transport management
system, with an AI-FDE assistant that answers business questions and builds
dashboards from it.

Built on [`openshuyi/ontograph-core`](https://github.com/openshuyi/ontograph-core)
(vendored in `vendor/`, compiled from source), Postgres, and an LLM that is either
a local open-source model via Ollama or the Azure AI Foundry deployment already in
use elsewhere in this repo.

```
docker compose up -d --build        # or ./scripts/bootstrap.sh
open http://127.0.0.1:3000
```

---

## What this is

The captured REST payloads in `../api_responses` describe a working TMS: orders,
shipments, transports, stops, a party master, and the configuration behind them.
This project turns that into an **ontology** — named object types with typed
properties, discovered links between them, a verb layer of actions, and a metric
catalogue — and then puts three things on top:

| | |
|---|---|
| **Ontology workbench** | Browse object types, properties classified by semantic role, link types with their real match ratios, and export the model as OWL, SHACL, Mermaid, DOT, ER or JSON Schema. |
| **Object explorer** | Query any object type with filters built from its own properties, open one object, and walk its links. Shows the SQL it ran. |
| **AI-FDE assistant** | Ask a question in freight language; get an answer, a chart, or a saved dashboard. Every answer shows which ontology queries produced it. |

Plus a six-layer **lineage graph** that traces any figure back to the HTTP
endpoint it came from, and an **action layer** with role-based permissions and an
audit trail.

### The honest part

The captured snapshot is a **planning** snapshot. Verified against
`api_responses/orders_viewType1.json`, it contains:

- 0 of 61 transports with an `actualStart` or `actualEnd`
- 0 of 122 stops that have been arrived at (`isArrived` is false everywhere)
- 0 of 61 legs with a non-zero distance
- 0 of 90 orders with a `carrierId`
- 14 of 61 shipments with a charge

So on-time performance, transit time, dwell, distance, cost per kilometre,
carrier scorecards and margin **cannot be computed from it**.

They were, once. The pipeline generated execution actuals into a separate
`tms_sim` schema so the KPI catalogue had something to display, and 17 of 31
KPIs -- every cost-per-kilometre and on-time figure on the dashboards -- rested
on invented numbers while looking authoritative. That is gone. Migration 0018
dropped the generated columns, the three KPI views composed wholly of them and
the `tms_sim` schema itself, and the pipeline's second stage now **reports the
coverage gaps instead of filling them**:

```
Coverage of the captured snapshot:
    Carrier assignment   0 of 61  from source   no carrierId anywhere in the payload
    Execution actuals    0 of 61  from source   no actualStart / actualEnd
    Leg distance         0 of 61  from source   every captured leg reports 0 m
```

Columns that could become real are kept and read NULL -- `actual_start_at`,
`total_distance_km` and `charge_per_kg` fill themselves the day the TMS starts
sending actuals. Columns that could only ever have been invented are gone.
`PIPELINE_SIMULATE_EXECUTION=true` now **refuses loudly** rather than
regenerating: the schema has to be restored and the views re-pointed on
purpose, which is the point of dropping it.

Measured, with no caveat needed: order volume and weight, the party and location
master, planning rate, the shipment status funnel, accessorial counts, and every
exception count.

---

## Getting started

### Requirements

- Docker with Compose v2 (tested on Docker Desktop 29.1.3 / Compose 2.40.3)
- ~8 GB free disk (4.7 GB of that is the Ollama model, only if you use it)
- The sibling `../api_responses` directory, mounted read-only by the pipeline

### The quick path

```bash
cp .env.example .env
./scripts/init-secrets.sh                      # generates ./secrets/*, once

# Set a bootstrap admin password of at least 12 characters, or the stack comes
# up with no users and every API route answers 401.
echo "BOOTSTRAP_ADMIN_PASSWORD=$(openssl rand -base64 18)" >> .env

docker compose up -d --build
docker compose logs -f pipeline      # migrations -> ingest -> ontology -> users
```

Then open **https://127.0.0.1:3000** and sign in as `admin` with that password.

The certificate is self-signed on first run, so the browser will warn once.
Mount a real one over `/etc/nginx/certs` for anything public.

### The path that picks the right LLM for your hardware

```bash
./scripts/bootstrap.sh
```

It runs `nvidia-smi`, writes the LLM configuration into `.env` accordingly, and
brings the stack up with the GPU overlay if there is a GPU. See
[Choosing the LLM](#choosing-the-llm).

### Ports

All bound to `127.0.0.1` only. That binding is a development control, not a
security boundary: it disappears the moment this runs on a host that publishes
the port, which is why the services authenticate rather than relying on it.

| Service | URL | Notes |
|---|---|---|
| UI | https://127.0.0.1:3000 | nginx, terminates TLS and proxies both APIs |
| UI (plain HTTP) | http://127.0.0.1:3080 | redirect and `/health` only |
| Ontology service | http://127.0.0.1:4000/api/stats | needs a bearer token |
| AI-FDE | http://127.0.0.1:4100/health | liveness only; detail needs a token |
| Postgres | `127.0.0.1:55432` | password in `secrets/postgres_password` |
| Ollama | `127.0.0.1:11435` | moved off 11434; see below |

> The HTTPS redirect on port 3080 targets the standard 443, which is right
> wherever the stack is published on 443 and wrong locally, where compose maps
> container 443 to host 3000 and nginx cannot learn that external port. In
> development, go to `https://127.0.0.1:3000` directly.

> **Use `127.0.0.1`, not `localhost`, from the host.** On Windows `localhost`
> resolves to `::1` first, and Docker Desktop's IPv6 proxy accepts the connection
> and then hangs until libpq times out. Measured on this project: **130.6 s with
> `localhost` versus 6.9 s with `127.0.0.1`** for an identical pipeline run.

> **Ollama is on 11435** because a native Ollama install on the host already
> listens on 11434, and Docker cannot bind a port twice. Services inside the
> compose network always reach it as `ollama:11434`, so this only affects access
> from the host. Change it with `OLLAMA_PORT`.

---

## Choosing the LLM

Two backends, one interface. `LLM_PROVIDER=auto` (the default) decides from the
hardware:

| Hardware | Primary | Fallback | Why |
|---|---|---|---|
| NVIDIA GPU present | `ollama` | `azure_openai` | Local, no keys, nothing leaves the machine |
| CPU only | `azure_openai` | `ollama` | A 7B model with a 15-tool schema takes minutes per call on CPU, and the agent makes several calls per question |

**This is not a preference, it is a measured constraint.** On the CPU-only machine
this was built on, `qwen2.5:7b-instruct` did not return within 300 s for a single
tool-calling round. The same question answered in **7.2 s** against `gpt-4.1`.

### Automatic failover

`LLM_FALLBACK_PROVIDER` enables failover, with a **circuit breaker**: after the
primary fails it is skipped for `LLM_FALLBACK_COOLDOWN` seconds rather than
retried on every tool round. Without the breaker one question would pay the
primary's timeout up to eight times.

Measured with Ollama primary and a 45 s timeout:

```
first question  : 52.4 s   (45 s Ollama timeout, then Azure answered)
second question :  7.4 s   (breaker open, straight to Azure)
```

The UI shows a note when it is running on the fallback, and each answer's footer
says which model produced it.

### Running on a GPU

The official `ollama/ollama` image ships **CUDA and ROCm backends only**. Apply
the overlay to pass an NVIDIA device through:

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d
```

Confirm offload actually happened — a GPU that exists on the host but was not
passed through looks identical until you check:

```bash
curl -s http://127.0.0.1:11435/api/ps    # size_vram > 0 means layers are on the GPU
```

Intel Iris Xe / Arc and Apple Silicon are **not** covered by that image and will
run on CPU. That is the case `auto` detects and routes around.

### Fully offline

```bash
# .env
LLM_PROVIDER=ollama
LLM_FALLBACK_PROVIDER=
AZURE_OPENAI_KEY=
```

Expect slow answers without a GPU. Everything except the assistant works with no
model at all.

---

## Architecture

```
  api_responses/*.json                 19 captured TMS REST endpoints
          │
          ▼  services/pipeline  (Python)
  tms_raw.*                            landing tables, faithful to the payload
          │
          │  services/ontology-service  (on demand, not on a schedule)
  connection_raw.*                     tables pulled through a registered source
  repo_out.*                           tables a code repository built
          │
          ▼  db/init/04,05_*.sql
  tms_views.v_*                        20 semantic object views + 11 metric views
          │                            ← THE CONTRACT: the ontology is generated
          │                              from this schema
          ▼  services/pipeline
  platform.ontology_version            the OntologyDefinition document
  platform.object_type / _property     shredded for querying
  platform.link_type                   discovered joins, with match ratios
  platform.kpi_definition              curated metric catalogue
  platform.lineage_node / _edge        six-layer provenance graph
          │
          ├─▶ services/ontology-service  (Node + @ontograph/core)
          │     object sets · KPIs · actions · lineage · exports
          │
          ├─▶ services/ai-fde            (Python + FastAPI)
          │     15 tools over the ontology · Ollama or Azure OpenAI
          │
          └─▶ services/ui                (React + Vite, nginx)
                workbench · explorer · graph · lineage · dashboards · chat
```

### How the ontology is generated

`tms_views` is the contract. The pipeline introspects it and derives everything:

1. **One object type per `v_*` view.** `v_order` → `tms:Order`. Views prefixed
   `v_kpi_` are registered as metric views instead.
2. **One property per column, classified by semantic role** — identity, title,
   measure, dimension, temporal, geo, flag, or provenance. This is the important
   step: a column's SQL type says it is numeric, not whether summing it means
   anything. `gross_weight_kg` sums; `latitude` does not; `status_code` is an
   identifier that happens to be an integer. The ontology service **refuses** to
   sum a non-measure, with an error naming the columns you can sum.
3. **Link types from three signals**, combined in order:
   - *naming convention* — a column ending `_key` that is not the view's own key
     points at the view whose key it matches by suffix
   - *party fallback* — the TMS keeps one party master projected into role views,
     so a reference named for one role is also probed against the master
   - *value overlap* — every candidate is probed against the real data and kept
     with its **match ratio**, because a 90 % join is a real modelling fact and
     hiding it behind a clean arrow is how a lossy join gets mistaken for a
     complete one
4. **Attributes are shared when they agree.** 462 properties collapse to 238
   attribute definitions; a name is type-qualified only where two views genuinely
   disagree on its datatype.
5. **Actions, roles, constraints and KPIs are authored**, not derived — a business
   rule is not discoverable from a schema.

Current output: **20 object types, 462 properties, 40 link types, 80 relation
types** (each link plus its inverse), 238 attributes, 9 value types, 8
constraints, 3 interfaces, 3 logic rules, 9 actions, 5 roles, 14 KPIs, and a
140-node lineage graph. It validates against ontograph's own `OntologyValidator`
with **0 errors and 0 warnings**, and generates 37 SHACL shapes.

The KPI count was 31 and the action count 12 before migration 0018: 17 metrics
and 3 read-only actions rested on generated execution data and were withdrawn
with it.

Five references are honestly reported as **unresolved** rather than dropped:
`service_level_key`, `shipment_type_key`, `payment_term_key` and `nmfc_key` point
at configuration objects the snapshot never fetched, and `v_order.carrier_key` is
null in all 90 orders.

---

## Using it

### Ontology workbench (`/ontology`)

Object types grouped by domain. For each: properties with their semantic role and
SQL column, links with match ratio and how they were discovered, and the actions
declared against it.

### Object explorer (`/explorer`)

Filter operators are narrowed by datatype, so you cannot compose a filter the
service rejects. Click a row to open the object; click a link to walk it. A link
below 100 % shows a banner saying how much it misses. **Show SQL** reveals the
query — an ontology layer should make the query derivable, not hide it.

### Graph (`/graph`) and lineage (`/lineage`)

The ontology graph is a force layout; dashed edges are partial joins. The lineage
graph is laid out in pipeline columns because it *is* a pipeline. Pick any object
type or KPI to trace it upstream to the source endpoints and the exact base
columns it reads — read from `pg_depend`, so it is the catalogue's own record of
the dependency rather than a guess from parsing SQL.

### Dashboards (`/dashboards`)

Five seeded boards plus anything the assistant builds. A widget names a **KPI from
the catalogue** and how to slice it; it never carries SQL. That is what makes a
generated dashboard reviewable — the worst a bad generation can do is pick the
wrong metric, not run the wrong query.

### Actions (`/actions`)

Pick a role, fill the form, run it. The role decides what is permitted, through
ontograph's `AccessController` with **default-deny** (its own default is allow,
which for an action layer is the wrong reading of "no rule").

All nine actions return **`staged`**: validated, permission-checked, recorded in
the audit trail with the exact payload that would be sent to the TMS, but **not
sent**, because this platform reads the TMS through a captured snapshot and has
no write-back endpoint. A dashboard that says a shipment was held when nothing
was held is worse than one that says the request was staged.

There were three **read-only** actions that genuinely executed and returned a
number — a rate what-if, an on-time projection and a cost recalculation. Every
figure all three produced came from the generated execution data in `tms_sim`:
a cost the snapshot does not carry, a carrier it does not name, a distance
recorded as 0 m on every leg. Migration 0018 dropped that schema, so they could
only answer 409, and they have been withdrawn rather than left as three menu
entries that can only fail. The machinery for a read-only action is intact —
declare one, register its implementation, and it executes — which is what
should happen the day the TMS starts sending actuals.

This is also why the Business Analyst role, which the assistant runs as, now
carries **no action permission at all**: everything left in the catalogue
mutates, and the assistant may not run any of it.

### The AI-FDE assistant (`/assistant`)

Named after Palantir's forward deployed engineer: the person who sits with a
business user and turns "am I losing money on the Chicago lane" into a working
artefact.

It has **15 tools and no database connection**. It cannot write SQL — it can only
ask questions the ontology already knows how to answer, so a wrong answer is a
wrong choice of metric, not a wrong query.

Try:

- *"Which carriers have the worst on-time performance, and how much do we spend
  with them?"*
- *"Build a freight finance dashboard showing revenue, cost, margin and anything
  still unbilled."*
- *"Which parts of this snapshot are measured, and what is missing at source?"*
- *"What happens to cost and margin if we cut rates on the BMW account by 8 %?"*
- *"Trace where the shipped weight figure comes from, back to the source API."*

Every answer shows the tool calls behind it, expandable to their arguments and
results. When it runs a KPI you get the chart; when it builds a dashboard you get
a link to it.

---

## Operating it

```bash
# Re-run the pipeline (idempotent)
docker compose run --rm pipeline python -m pipeline.run

# Re-land the snapshot from scratch
docker compose run --rm pipeline python -m pipeline.run --force

# Regenerate only the ontology layers, leaving tms_raw alone
docker compose run --rm pipeline python -m pipeline.run --skip-ingest

# Regenerate the ontology without re-landing the snapshot
docker compose run --rm pipeline python -m pipeline.run --skip-ingest

# See what would happen, write nothing
docker compose run --rm pipeline python -m pipeline.run --dry-run

# Rebuild the view layer after editing 04/05_*.sql, then regenerate
./scripts/reload-views.sh
docker compose run --rm pipeline python -m pipeline.run --skip-ingest
docker compose restart ontology-service
```

`CREATE OR REPLACE VIEW` cannot rename or reorder a column, which is why
`reload-views.sh` drops and replays the schema rather than replacing views in
place.

### Schema changes

`db/init/*.sql` runs **only when the Postgres data directory is empty**, so it
is the bootstrap for a fresh database and nothing else. Anything that has to
change a database which already holds data goes in `db/migrations/` as
`NNNN_name.sql`, and is applied by `pipeline.migrate` on every pipeline run:

```bash
# Apply anything pending (the pipeline does this automatically at startup)
docker compose run --rm pipeline python -m pipeline.migrate

# Show applied and pending without changing anything
docker compose run --rm pipeline python -m pipeline.migrate --status
```

Each migration runs in its own transaction and is recorded in
`platform.schema_migration` with a checksum, so editing one after it has been
applied is reported rather than silently skipped. Migrations are immutable once
applied: add a new one instead.

`docker compose down -v` still rebuilds from `db/init` — but it **destroys the
volume**, including every AI-built dashboard and chat conversation. Take a
backup first:

```bash
./scripts/backup.sh dump              # everything
./scripts/backup.sh dump --user-only  # just the work people did
./scripts/backup.sh restore backups/user-<timestamp>.sql.gz
```

`07_verify.sql` runs last and fails loudly if any expected object is missing. This
matters because of a trap worth knowing: if an init script errors, the container
exits, the restart policy brings it straight back, it finds a populated `PGDATA`,
prints *"Skipping initialization"* and comes up reporting **healthy** — with half
a schema. The pipeline also checks for a complete schema before doing anything and
tells you to run `down -v`.

### Troubleshooting

| Symptom | Cause |
|---|---|
| Pipeline: "database schema is incomplete" | An init script failed on first boot. `docker compose down -v && docker compose up -d`. |
| Ontology service waits forever at boot | No published ontology. Run the pipeline. |
| Assistant: "language model is not ready" | Check `/health`. With Ollama, the model may not be pulled: `docker compose exec ollama ollama pull qwen2.5:7b-instruct`. |
| Assistant is very slow, then answers | Ollama primary on CPU, timing out and failing over. Set `LLM_PROVIDER=azure_openai`, or use a GPU. |
| "ports are not available … 11434" | A native Ollama on the host. Change `OLLAMA_PORT`. |
| Anything from the host takes ~130 s | `localhost` resolving to `::1`. Use `127.0.0.1`. |

---

## Spaces, projects and resources

`/spaces` is the workspace: where things live and how they are found.

```
space  ->  project  ->  folder (nestable)  ->  resource
```

A **space** is environment-scoped, and one exists for each environment from the
start — **Sandbox, Development, Staging, Production** — because the environment
list is fixed and a missing space is just a hole someone has to fill by hand.
Separating them is the point: a pipeline promoted to production must not share
a namespace with the sandbox copy someone is experimenting on. Each space card
carries an environment tone, so acting on the wrong one is harder to do by
accident.

A **resource** is the addressable unit. Nine kinds:

| Kind | Points at | Preview shows |
|---|---|---|
| Connection | a PostgreSQL host or a REST API | what the source reports about itself, and its syncs |
| Repository | a code repository | kind, branch, files, commits, last build |
| Dataset | a view, or a table a sync or a build wrote | schema, live sample rows, row count, lineage |
| Object Type | an ontology type | properties, links, actions, row count |
| Link Type | a discovered link | cardinality, key mapping, match ratio |
| Action Type | an ontology action | parameters, permissions, targets |
| Metric | a KPI in the catalogue | category, unit, the view it reads |
| Pipeline | a pipeline slug | version, node/edge count, validation status |
| Dashboard | a dashboard slug | widget count, provenance |

Opening one shows a **preview window** with the same anatomy every time —
header, tabs, body — so the shape of the answer does not change with the kind
of thing being asked about. Only tabs with content appear: a link type has no
rows to preview, and an empty tab is worse than no tab.

### Filling the sandbox

```bash
# Idempotent: does nothing once the sandbox has a project
curl -X POST -H "authorization: Bearer $TOKEN" .../api/spaces/sandbox/seed
```

or press **Fill from the ontology** in the UI. It creates a *TMS Platform*
project with `/Connections`, `/Code`, `/Datasets`, `/Ontology/{Object types,
Links,Action Types,Metrics}` and `/Outputs`, then registers a resource for the
live connection, one for each code repository, one dataset per source view, and
every object type, link, action, metric, dashboard and pipeline — about 100
resources, all pointing at something real.

The connection it registers is a usable one: it carries the host, port,
database and user parsed from the DSN the service is already running against,
plus the *path* of the Docker secret holding the password. It can be tested and
synced through, rather than being a card describing a database it has no way to
reach.

### Datasets

A dataset is the artefact the platform was missing: a pipeline could describe
how data becomes an ontology, but produced nothing anyone could open, share or
build on.

Register one from the explorer (**Register dataset**) or straight from the
canvas — select an Object Type node in the pipeline builder and press **Create
dataset from this node**. Either way the backing view is checked against the
published ontology first, so a dataset always points at something real; a view
the ontology does not expose is refused with the reason.

### Connections, and getting data through one

A connection used to be a business card. You could register a PostgreSQL
source, press **Test connection**, be told it answered — and that was the whole
of it. Nothing could come through it, and the panel that claimed to list "every
table this connection can read" was querying the *platform's own* `pg_class`
over three hardcoded schemas, so a source on another host was described with
this platform's tables. Both are fixed.

The model is Foundry's:

```
connection resource  ──▶  sync  ──▶  connection_raw.<table>  ──▶  dataset
        (host, credential      (one table,        (landed here)     (a card you
         REFERENCE)             re-runnable)                         can open)
```

**Two connectors.** Create one from **Connections** in the nav, or from inside a
project in `/spaces` — both open the same dialog.

| Connector | A sync names | Notes |
|---|---|---|
| **PostgreSQL** | a schema and a table | the source's catalogue is listed for you, so a sync cannot name a table its user cannot read |
| **REST API** | a path, and where the records sit in the response | every payload this platform was built from came from one of these |

A REST source has no catalogue to list — there is no standard way to ask an
HTTP API what it exposes — so the path is typed and checked by fetching it
before the sync is stored. Its **records path** matters more than it looks:

```
POST a sync on /api/tags with no records path
→ The response is an object, not a list of records. Its records look like
  they are at 'models' — set the records path to one of those. Without it
  this would land the whole document as a single row.
```

Guessing which key holds the rows is how a sync lands one row containing the
whole document and reports a clean run, so it refuses and says where the
records appear to be. JSON keys are normalised to column names (`orderNumber`
→ `order_number`) and every rename is reported; two keys that normalise the
same way both survive, suffixed, because dropping one silently is worse.

A **sync** is a named pull from one table on the source. Two modes:

| Mode | What it does | When it is wrong |
|---|---|---|
| `snapshot` | drops the landing table and rebuilds it | never, but it re-reads everything each run |
| `incremental` | appends rows past the last cursor value | if the source edits rows in place without moving the cursor |

An incremental sync without a cursor column is refused — by the service *and*
by a `CHECK` constraint — because without one every run would re-read the whole
table and append it, silently doubling the dataset.

Declare one from the connection's preview window, or commit a `*.sync.json`
file to a transforms repository. Either way the source table is checked against
the far side's catalogue first, so a sync cannot name a table the connection's
user cannot read.

**What a run reports.** Rows read, rows before, rows after, the cursor it moved
to, and `truncated` when it stopped at the row limit — because a partial table
reported as complete is the failure mode worth designing against. Columns whose
remote type has no local equivalent (an enum, a domain, PostGIS geometry) land
as `text` and are listed by name, so a number arriving as text is explained
rather than discovered.

**What is never stored.** The password. A connection records the *name* of an
environment variable or the *path* of a Docker secret, resolved at the moment of
use. A credential in `platform.resource` would be readable by anyone who can
read the workspace and would land in every backup.

**On the reader being bounded.** A run reads up to `rowLimit` rows into memory
and then writes them, in batches sized from the column count so a statement
never exceeds PostgreSQL's parameter limit. That bound is why the limit exists
and why reaching it is reported rather than hidden.

### Stale references

Resources point at the rest of the platform **by api_name or slug, not by
foreign key**, because the pipeline replaces every row in the ontology tables
on each run. A real foreign key would either block regeneration or cascade a
user's whole workspace away with it.

The cost is that a reference can go stale, so a resource whose target no longer
exists is marked `unresolved` and says why, rather than rendering an empty
window as though nothing were wrong.

### Row counts

The connection preview reports **planner estimates**, not exact counts: an
exact count over every table would be a table scan per table on every panel
open. Tables Postgres has never analysed are shown as `+N?` rather than folded
into the total — `reltuples` is `-1` for those, and summing them produced
negative row counts.

## Code repositories

`/repos`. Before this there was nowhere to keep work: a pipeline was a canvas, a
function was one definition pasted into a dialog, and neither had a file, a
history, or a way to publish several related changes as one reviewed act.

Three kinds, because the three jobs produce different things:

| Kind | Files it acts on | Building produces |
|---|---|---|
| **python** | `transforms/*.py` | runs them; each must write a dataset in `repo_out` |
| **transforms** | `*.sync.json`, `transforms/*.sql` | syncs that run, and tables in `repo_out` |
| **functions** | `functions/*.sql`, `.py`, `.ts` | entries in the function catalogue, as **proposed** |

Three are seeded in the sandbox, and all three build:

```
TMS Python Transforms  transforms/order_exception_scores.py  90 rows in repo_out
TMS Data Ingestion     syncs/orders.sync.json                90 rows through the connection
                       transforms/order_volume_by_lane.sql   67 lanes in repo_out
TMS Functions          functions/avg_weight_per_piece.sql    averageWeightPerPiece
                       functions/orders_by_mode.sql          ordersByTransportationMode
```

### Python transforms

Foundry's shape, and they really run:

```python
from transforms.api import transform, Input, Output


@transform(
    output=Output("repo_out.order_exception_scores"),
    orders=Input("tms_views.v_order"),
)
def compute(orders, output):
    scored = []
    for order in orders:
        reasons = []
        if order["is_unplanned"]:
            reasons.append("no route planned")
        if order["has_implausible_weight"]:
            reasons.append("implausible weight")
        scored.append({"order_number": order["order_number"],
                       "reasons": "; ".join(reasons) or None})
    output.write(scored)
```

`Input` arrives as a list of dicts; `output.write(rows)` takes a list of dicts
back. Column types are inferred from the values — a column is only given a
narrow type when every non-null value in it fits, so one string among the
numbers makes the whole column `text` rather than failing. Numbers arrive as
numbers: `bigint` and `numeric` cross the driver as strings, and they are
converted back **using the column's real type**, so a text column that happens
to hold digits is not silently turned into one.

**A transform must produce a dataset.** This is the rule that makes the kind
coherent, and it is enforced two ways:

```
transforms/no_output_at_all.py -> failed
  declares no Output, so it can produce no dataset.
  Add one: @transform(output=Output("repo_out.<table>"), ...).

transforms/forgot_to_write.py -> failed
  compute() never wrote to its Output. Call output.write(rows) with a list
  of dicts, or return the rows from the function.
```

The build is marked **failed** and names both files — while the working
transform in the same build still produced its 90 rows, because a broken file
should not hide three working ones.

**Where the code runs.** A `python3` subprocess inside the ontology service,
with an empty environment, a 60-second limit, row caps in and out, and **no
database handle**: the relations it declared are read by the service, against
the same allow-list a dataset is checked against, and handed over as data. A
transform may read `tms_views.*` and the schemas the platform writes itself,
and may write only into `repo_out` — the view layer is the contract the
ontology is generated from and is not a build's to overwrite.

It is **not** a sandbox against a determined adversary. It shares a container
with the service, so anyone who can commit and press Build can run code there.
That is the same trust as writing a SQL node and it is gated at the same role,
but it is a larger surface, and pretending otherwise would be the dishonest
half of the feature.

### What a SQL or function file declares

A header of `key: value` comment lines, in whichever comment syntax the
language uses. A decorator would be closer to Foundry, but a decorator is code,
and nothing here executes code.

```sql
-- @output repo_out.order_volume_by_lane
SELECT lane, count(*) AS orders FROM connection_raw.… GROUP BY lane
```

```sql
-- name: Average Weight Per Piece
-- businessQuestion: How heavy is an average piece of freight we move?
-- returns: scalar
-- unit: kg
SELECT round(avg(gross_weight_kg / nullif(piece_count, 0))::numeric, 2) …
```

### What a build will not do

- **SQL never becomes arbitrary code.** A SQL transform goes through the same
  compiler a pipeline node does — one statement, `SELECT` or `WITH` only — and
  is materialised by `CREATE TABLE … AS SELECT * FROM (<sql>)`. Wrapping it in a
  subquery is what makes "read-only" structural rather than merely checked: a
  non-SELECT is a syntax error in that position, and PostgreSQL rejects a
  data-modifying CTE anywhere but the top level. (A **python** repository is the
  deliberate exception, described above.)
- **It will not write outside `repo_out`.** The view layer is the contract the
  ontology is generated from; a build that could replace a view could silently
  change every object type built on it.
- **It will not approve a function.** Publishing puts a definition in the
  catalogue as `proposed`, which computes nothing and which no dashboard may
  use. Approving is a separate admin act on `/functions` — the whole point of
  the proposed/active split is that the two are not the same click.
- **It will not replace an active definition.** That file is reported as
  `skipped`, with what to do instead. An active function is what a dashboard
  already renders, and a build is not a review.
- **A Python or TypeScript file under `functions/` is published, not run.**
  A function is something a dashboard calls, which is a different contract from
  a transform that runs once at build time: the catalogue executes SQL, and the
  other two languages are stored, reviewable, and reported as not executable.

### Editing

`/repos/<slug>` is a file tree, an editor and a toolbar. **New file** starts
from a template for the repository's kind rather than an empty buffer, Tab
indents, Ctrl+S saves, and **Commit** snapshots the tree with a message.
Deleting a file removes it from the working tree; the last commit still has it.

### Builds build a commit

Not the editor. A build of uncommitted edits would produce a number nobody
could reproduce, and reproducing a number is most of what a repository is for.
One artifact is recorded per file, so a build that half worked says exactly
which half: a failing transform does not hide three working ones, and the run
is marked failed with every file named.

## Pipeline builder

`/pipeline` is a canvas where a pipeline is drawn — sources, transforms, the
object types they produce, the links and actions on those, and the dashboards
at the end.

It is not a drawing tool that resembles a data platform. Every node is
validated against the **published ontology**: an Object Type node naming a type
the registry does not have is an error, and a Link node whose cardinality
contradicts the one the pipeline discovered in the data is an error too. The
palette is the real ontology — 20 object types, 40 links, 9 actions, 14 KPIs —
so a node is configured by choosing something that exists rather than by typing
a name.

| Node group | Kinds |
|---|---|
| Data | Data Source, Dataset |
| Transform | Filter, Join, Aggregate, SQL, Python |
| Ontology | Object Type, Link Type, Action Type |
| AI | LLM |
| Output | Output, Dashboard, Validation |

Which groups may feed which kinds is part of the model, so an illegal
connection is refused with a reason rather than drawn.

**Validation** runs server-side as the graph is edited. Errors block a run;
warnings do not — "this object type does not exist" makes the pipeline
meaningless, "this node has no description" only makes it rude. Every issue
carries the node it belongs to, so clicking one in the bottom panel focuses
that card.

**Runs** really run (migration 0014). Each node compiles to one SELECT and is
materialised as a table in `pipeline_out`, so every row count, duration and
error the panel shows comes from the database having done the work rather than
from a ratio. Before that a run estimated — a filter was assumed to keep 60 %,
an aggregate to collapse 50:1 — and every run was stored with
`is_simulated = true`; runs now record `is_simulated = false` and name the
table each node wrote.

**Versions** are kept on every save (`platform.pipeline_version`), and
restoring an old one creates a new version rather than rewriting history.

Keyboard: `N` add node · `Ctrl/Cmd+S` save · `Ctrl/Cmd+Z` undo ·
`Ctrl/Cmd+Shift+Z` redo · `Delete` remove the selected node · `F` fit.

```bash
# The palette the builder offers, straight from the published ontology
curl -H "authorization: Bearer $TOKEN" .../api/pipelines/palette

# Validate a graph without saving it
curl -X POST -H "authorization: Bearer $TOKEN" -d '{"graph":{…}}' .../api/pipelines/validate
```

Editing a pipeline needs the `analyst` role; deleting one needs `admin`.
Reading, validating and the palette are `viewer`.

## Choosing the model per conversation

The assistant's composer has a model picker. **Ollama is the default** where it
is usable; the option falls back to whatever is actually available, because a
default that cannot answer is not a default.

An explicit choice is honoured exactly, with **no failover**: someone who
picked the local model should be told it is unreachable rather than have the
hosted one answer — and be billed for it — without saying so. `Automatic`
keeps the server's configured chain and its failover.

The picker reports live availability, and flags Ollama as **slow (CPU)** when
no GPU offload is detected. That is not cosmetic: a 7B model with this
fifteen-tool schema needs minutes per round on CPU, and on hardware without a
GPU it will usually exhaust `OLLAMA_TIMEOUT` (default 300s) before answering.
With a GPU it is the better choice; without one, Azure answers in seconds.

## Dashboard history and backup

`/dashboards/history` shows every dashboard with where it came from: the
conversation that built it, the prompt it was built from, and every rename it
has been through.

- **Search** matches the name, description, prompt, creator and *previous*
  names — people look for a board by what they asked for, or by what it used to
  be called.
- **Rename** gives a generated board a name of your own. The slug follows the
  title (so the URL stays readable), the old name and slug are recorded, and a
  clash with an existing name is refused rather than silently resolved.
- **Back up to file** downloads every dashboard as JSON to your machine, which
  is the copy that survives `docker compose down -v`. **Restore** reads one back.

A restore validates each dashboard against the **current** ontology before
writing it: a backup taken before the KPI catalogue changed can name metrics
that no longer exist, and importing those would put a permanently broken widget
on someone's screen. Such a dashboard is skipped with its reason and the rest
still land.

A dashboard outlives the chat that made it — retention purges conversations and
the foreign key is `ON DELETE SET NULL` — so the history says *purged* rather
than implying the board never had a conversation.

## Security and operations

### Authentication

Every API route requires a bearer token except `/health`, which the compose
healthcheck probes and which carries no detail. The ontology service is the
only thing that issues a token; the assistant verifies the same token with the
shared `AUTH_JWT_SECRET`, so one sign-in works across both APIs.

Two role concepts, deliberately separate:

| | What it decides | Values |
|---|---|---|
| `role` | which API routes are reachable | `viewer`, `analyst`, `admin` |
| `ontology_role` | which **actions** may be executed | the roles declared in the ontology |

A dispatcher and a finance user are both `analyst` on the platform but may run
different actions, which one column could not express.

| Route | Needs |
|---|---|
| reads: object types, objects, KPIs, lineage, dashboards | `viewer` |
| dashboard create / validate, action validate / apply | `analyst` |
| audit trail, registry reload, dashboard delete | `admin` |

Anything under `/api` added later is authenticated by default and needs at
least `viewer`: the guard is mounted once, ahead of the routes, so forgetting
about a new route makes it *demand a login* rather than leaving it anonymous.

```bash
docker compose run --rm pipeline python -m pipeline.users list
docker compose run --rm pipeline python -m pipeline.users add jo analyst '<password>'     --ontology-role tms:DispatcherRole
docker compose run --rm pipeline python -m pipeline.users passwd jo '<password>'
docker compose run --rm pipeline python -m pipeline.users revoke jo   # kills issued tokens
```

Passwords are scrypt, in a format both Python and Node derive from their
standard library, so neither service carries a hashing dependency.

The assistant calls the ontology service **as the signed-in user**, forwarding
their token, so its queries are bound by their permissions and the audit trail
names a person rather than the assistant.

### Secrets

`./scripts/init-secrets.sh` writes `./secrets/*`, which compose mounts at
`/run/secrets` and each service reads through a `*_FILE` variable. They are not
plain `environment:` values, which `docker inspect` prints to anyone who can
run it. `./secrets` is gitignored.

| File | Used by |
|---|---|
| `jwt_secret` | both APIs, to sign and verify tokens |
| `postgres_password` | Postgres |
| `database_url` | all three services |
| `azure_openai_key` | the assistant |

### Cost controls

`/api/assistant/chat` reaches a paid model for up to `AI_FDE_MAX_TOOL_ROUNDS`
rounds, so two limits apply per user: a request rate
(`CHAT_RATE_PER_MINUTE`, `CHAT_RATE_BURST`) and a rolling 24-hour token budget
(`CHAT_DAILY_TOKEN_BUDGET`). Both are **per process** — running more than one
`ai-fde` replica multiplies them, and the service logs that warning at startup.

### Simulated data

There is none. The `tms_sim` schema and every metric that rested on it were
removed in migration 0018, and `PIPELINE_SIMULATE_EXECUTION=true` refuses
rather than regenerating. 14 KPIs remain, each computable from the captured
payload.

`ALLOW_SIMULATED_DATA=false` stays in the compose file as a second lock: it
refuses any KPI, widget or action still flagged `depends_on_simulation` with a
**409** and an explanation. Nothing carries that flag today, so it currently
gates nothing — which is the state it is meant to be in.

### Retention

`CHAT_RETENTION_DAYS` purges conversations idle longer than the window on each
pipeline run; `0` disables it. Set a real window if answers can quote customer
data. A session can be exempted with `platform.chat_session.is_retained`, and
each purge is recorded in `platform.retention_run`.

### Logs

Both services emit one JSON line per request carrying a `requestId`, and the
assistant forwards that id to the ontology service, so a single chat turn and
every query it caused share one value:

```bash
docker compose logs ai-fde ontology-service | grep '<request-id>'
```

A 5xx returns only `{"error": "Internal server error.", "requestId": "..."}`;
the message, type and stack stay in the log under that id.

### Tests

```bash
cd services/ontology-service && npm test          # 47 tests
cd services/ai-fde          && pytest tests/ -q   # 19 tests
cd services/pipeline        && pytest tests/ -q   # 19 tests
```

The TypeScript tests cover the dynamic SQL builders in `objectSet.ts` and
`kpi.ts` — identifiers allowlisted, every value bound, limits clamped and
coerced. `.github/workflows/ci.yml` runs all of it plus a typecheck, an
`nginx -t` and a full image build.

### Known limits

- Rate limiting, the token budget and the ontology registry are all in-process,
  so horizontal scaling needs a shared store and a cache-invalidation story.
- The pipeline reads a relative host path (`../api_responses`) and runs once.
  There is no schedule, no incremental ingest and no late-data handling;
  production needs the real TMS API or object storage behind it.
- No metrics or tracing, only structured logs.

## Layout

```
db/init/              01 raw schema · 02 reference data · 03 simulation schema
                      04 semantic views · 05 KPI views · 06 platform · 07 verify
                      (03 replays on a fresh volume and is dropped again by
                       migration 0018; nothing reads the schema it creates)
db/migrations/        NNNN_name.sql, applied once each by pipeline.migrate
services/pipeline/    ingest · simulate (coverage report only) · introspect
                      relationships · ontology_gen · kpi_catalog · actions
                      lineage_gen · dashboards
services/ontology-service/  registry · objectSet · kpi · actions · lineage · dashboards
                      connections (sources, syncs) · repos (files, commits, builds)
services/ai-fde/      llm (providers + failover) · tools · agent · prompts · store
services/ui/          pages: Overview, OntologyManager, ObjectExplorer, GraphView,
                      LineagePage, Dashboards, Actions, Assistant
vendor/ontograph-core/      the vendored library — see below
scripts/              bootstrap.sh · reload-views.sh
docker-compose.gpu.yml      NVIDIA overlay
```

### Changes to the vendored library

`vendor/ontograph-core` is a clone of
[`openshuyi/ontograph-core`](https://github.com/openshuyi/ontograph-core) with two
minimal, documented changes, both needed to consume it from Node rather than Bun:

1. **`tsconfig.build.json` added.** The upstream build emits ESM with
   extensionless relative imports (`./action-auditor`), which Bun resolves and
   Node does not, and with `composite: true` the output lands at `dist/src/` while
   `package.json` points at `dist/index.js`. The added config emits CommonJS with
   `rootDir: "src"`, so the declared entry point is the real one.
2. **Two root re-exports added to `src/index.ts`.** `OWLExporter` and
   `SHACLExporter` exist in `src/exporters/` but are not re-exported from the root
   index, making them unreachable under CommonJS resolution.

No behaviour was changed. The library's own `OntologyValidator`,
`ActionValidator`, `AccessController`, `SHACLShapeGenerator` and exporters do the
real work in the ontology service.

### Charts

Hand-built SVG, not a chart library, so the mark specs are enforceable: 2 px
surface gaps between fills, 4 px rounded data-ends anchored to the baseline, 2 px
lines, direct value labels rather than a value axis, recessive grid, crosshair and
tooltip by default.

The categorical palette is the eight-hue validated order, with separately stepped
light and dark values — validated against these exact surfaces (`#141416` dark,
`#fbfbfa` light) rather than one mode being an inversion of the other. Donuts cap
at three hues plus a neutral "Other", because the all-pairs colour-vision gate
only clears for the first three slots; a six-slice donut would put
indistinguishable hues side by side.

---

## Data notes

Things found in the captured data that shape the model:

- **20 orders carry an implausible handling-unit weight.** One is 530 units ×
  77,936 lb = 18,736 t in a single handling unit, roughly 500× a legal truckload.
  The figures are computed faithfully; the platform flags them as a
  high-severity exception and exposes `has_implausible_weight` as a property so an
  analysis can exclude them rather than be silently skewed.
- **The demo coordinates are not geographically coherent.** Great-circle distance
  between origin and destination has a median of 5,594 km and a maximum of
  18,948 km, against planned transit windows of 0.06 to 3.4 days; only 28 of 61
  transports fall in a plausible road range. Road distance was once derived from
  the planned transit window to work around this; that derivation went with
  `tms_sim` in migration 0018, and `total_distance_km` now reads NULL — which is
  what the snapshot actually supports.
- **Shipment status reaches 11 and transport status reaches 8**, beyond the enums
  documented in `../scripts/tms_models.py`. Labels for the undocumented codes are
  inferred from conventional TMS lifecycle naming and carry `is_inferred = true`
  all the way into the ontology.
- **`users_permissions.json` is not ingested.** Despite the name it is the
  front-end module and route registry — micro-frontend paths and ports — not TMS
  business data.
- **`businessentities_entityType_0_None.json` is not ingested** because the API
  returns HTTP 400 for `entityType=0`.
- **Every party is nearly a location**: 738 of 743 parties hold `LocationRole`,
  which is why the party-fallback link probe finds the role projections already
  resolve every reference and prunes itself.
