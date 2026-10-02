# TMS Ontology Workbench

A Palantir-Foundry-shaped ontology platform over a real 3PL transport management
system, with an AI-FDE assistant that builds the ontology from your data and then
answers business questions from it.

Built on [`openshuyi/ontograph-core`](https://github.com/openshuyi/ontograph-core)
(vendored in `vendor/`, compiled from source), Postgres, and the Azure AI Foundry
deployment already in use elsewhere in this repo.

```
docker compose up -d --build        # or ./scripts/bootstrap.sh
open https://127.0.0.1:3000
```

---

## What this is

One path, from a database to answers:

```
PostgreSQL connection ──sync──▶ dataset ──▶ object type ──▶ links, actions, metrics, functions
                         ▲       (as it is)                          │
                     schedule                                        ▼
            every 20 min, 2 h, 1 day, 8 days …           explorer · graph · dashboards · AI-FDE
```

| Step | What it is | Where |
|---|---|---|
| **Connection** | a PostgreSQL host, database, user and the *name* of the secret holding the password | Connections |
| **Sync** | a copy of one view (or table) from the connection into a dataset, **exactly as it is** | a connection's page |
| **Schedule** | how often a sync runs: manual, 20m, 1h, 2h, 6h, 12h, 1d, 8d, or any `<n><m\|h\|d\|w>` | Schedules, or beside the sync |
| **Dataset** | the landed copy, `connection_raw.<table>`, rebuilt on every run | Datasets |
| **Object type** | created *from* a dataset, one property per column, with a primary key checked against the data | a dataset's page, or the AI-FDE |
| **Links, actions, metrics, functions** | defined on object types, each checked against the data before it is stored | the AI-FDE, the workbench |

The sandbox comes with one connection already registered: the platform's own
database, whose `tms_views` schema presents the captured TMS data as views
(`v_order`, `v_shipment`, `v_transport`, …). Syncing those is the first step.

The **AI-FDE** does the modelling when asked — *"create object types from my
datasets, link them, and add the metrics and actions dispatchers need"* — through
the same checked routes a person's form uses.

### The honest part

The TMS data behind the connection is a **planning** snapshot. Verified against
`api_responses/orders_viewType1.json`, it contains:

- 0 of 61 transports with an `actualStart` or `actualEnd`
- 0 of 122 stops that have been arrived at (`isArrived` is false everywhere)
- 0 of 61 legs with a non-zero distance
- 0 of 90 orders with a `carrierId`
- 14 of 61 shipments with a charge

So on-time performance, transit time, dwell, distance, cost per kilometre,
carrier scorecards and margin **cannot be computed from it**. Profiling a dataset
flags those columns as *empty in every row*, and the assistant is instructed to
say a figure is not measured rather than estimate it.

Nothing on this platform is simulated. An earlier version generated execution
data into a `tms_sim` schema so a metric catalogue had something to show; migration
0018 removed it, and `ALLOW_SIMULATED_DATA=false` remains as a lock that refuses
anything flagged as resting on generated data.

---

## Getting started

### Requirements

- Docker with Compose v2 (tested on Docker Desktop 29.1.3 / Compose 2.40.3)
- ~2 GB free disk
- The sibling `../api_responses` directory, mounted read-only by the pipeline

### The quick path

```bash
cp .env.example .env
./scripts/init-secrets.sh                      # generates ./secrets/*, once

# Set a bootstrap admin password of at least 12 characters, or the stack comes
# up with no users and every API route answers 401.
echo "BOOTSTRAP_ADMIN_PASSWORD=$(openssl rand -base64 18)" >> .env

docker compose up -d --build
docker compose logs -f pipeline      # migrations -> land the TMS snapshot -> users
```

Then open **https://127.0.0.1:3000** and sign in as `admin` with that password.
The certificate is self-signed on first run, so the browser will warn once.
Mount a real one over `/etc/nginx/certs` for anything public.

Then, in order:

1. **Connections** → `tms_ontology` → **Sync a view** → pick `tms_views.v_order`,
   choose *Every 20 minutes*, keep *Copy it now*.
2. **Datasets** → `v_order` → **Create object type** (or *Ask the AI-FDE to model it*).
3. Repeat for the views you need, or ask the AI-FDE to do all of it.

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

> **Use `127.0.0.1`, not `localhost`, from the host.** On Windows `localhost`
> resolves to `::1` first, and Docker Desktop's IPv6 proxy accepts the connection
> and then hangs until libpq times out. Measured on this project: **130.6 s with
> `localhost` versus 6.9 s with `127.0.0.1`**.

---

## The language model

One backend: the **Azure OpenAI** deployment configured in `.env`
(`AZURE_OPENAI_ENDPOINT`, deployment name, and the key in
`./secrets/azure_openai_key`). `LLM_PROVIDER=azure_openai` is the only value; the
variable exists so a misconfigured one fails loudly rather than being ignored.
Everything except the assistant works with no model at all.

A turn may take up to `AI_FDE_MAX_TOOL_ROUNDS` rounds (default **16**: building
an ontology from several datasets takes around ten). A rate-limited call (HTTP
429) is retried after the delay Azure asks for, at most three times; if the model
still stops answering part way, the reply lists what was already built.

---

## Architecture

```
  api_responses/*.json                 the captured TMS REST payloads
          │  services/pipeline (Python): migrate → land → users → retention
          ▼
  tms_raw.*  ──(db/init/04,05)──▶  tms_views.v_*      THE SOURCE: views over the snapshot
          │
          │  PostgreSQL connection (any host; the sandbox's points at this database)
          ▼  sync, on a schedule — services/ontology-service
  connection_raw.<table>                              datasets, copied as they are
          │
          ▼  created from datasets — by a person or the AI-FDE
  platform.object_type / object_property              one living ontology per space
  platform.link_type · action_type · kpi_definition   checked against the data
  platform.function                                   proposed → approved by an admin
  platform.ontology_edit                              every change, with what it replaced
          │
          ├─▶ services/ontology-service  (Node + @ontograph/core)
          │     connections · syncs · scheduler · authoring · object sets · metrics · actions
          ├─▶ services/ai-fde            (Python + FastAPI, Azure OpenAI)
          │     modes and tools over the service's API, as the signed-in user
          └─▶ services/ui                (React + Vite, nginx)
```

### How the ontology is built

There is no generator. Every space starts with an **empty** ontology, and each
piece is authored against a dataset:

1. **Profile the dataset.** Real distinct and null counts per column, sample
   values, the columns that could be a primary key (unique and never null in the
   data as it stands), and a suggested role per column. A column's SQL type says
   it is numeric, not whether adding it up means anything: `gross_weight_kg` is a
   measure, `origin_latitude` is geo, `status_code` and `order_key` are
   dimensions, `max_unit_weight_kg` aggregates with `max`, `planned_transit_days`
   with `avg`. Columns empty in every row are flagged.
2. **Create the object type.** One property per column, typed from the dataset's
   catalogue. Refused, with the counts, when the chosen key is not unique and
   non-null; a measure must be numeric.
3. **Link object types.** Suggestions are columns named for another type's key
   (`origin_location_key` → `Location.location_key`), each **measured**: the
   match ratio is the share of values that really resolve, stored on the link. A
   link where nothing resolves is refused. Inverse names follow the link's role
   (`Location → originOrders`, `destinationOrders`).
4. **Metrics.** An aggregation over one object type — count, count_distinct, sum,
   avg, min, max, or ratio (sum over sum, never an average of per-row ratios) —
   with the dimensions it can be sliced by and, optionally, a fixed condition:
   `unplanned_orders` counts orders **where** `is_unplanned`. A new metric is
   computed once before it is kept.
5. **Actions.** A verb on an object type with typed parameters and the roles that
   may run it; the object's key is always the first parameter. Every action is
   **staged**: validated, permission-checked and recorded, never written back,
   because a dataset is a copy of its source.
6. **Functions.** One SELECT over datasets for what a metric cannot express. See
   *Functions* below.

After every change the ontograph `OntologyDefinition` document is rebuilt from
the tables, validated with ontograph's own `OntologyValidator`, and the registry
reloaded — so exports (OWL, SHACL, Mermaid, DOT, ER, JSON Schema), validation and
action role checks always describe what is actually there. Ontology roles
(`AdminRole`, `OperationsManagerRole`, `DispatcherRole`, `FinanceRole`,
`AnalystRole`) are fixed; which actions each may run comes from each action.

---

## Using it

### Connections and syncs (`/browse/connections`)

A **connection** records the host, port, database, user and the **name** of an
environment variable or the **path** of a Docker secret holding the password —
never the password. It is tested before it is stored.

A connection's page lists what it can read (views first) and its **syncs**. A sync
copies one view into `connection_raw.<connection>__<schema>__<view>`:

- **As it is.** Same columns, same rows. Remote types map through a fixed table;
  a type with no local equivalent (an enum, a domain, PostGIS geometry) lands as
  `text` and is named in the run's report.
- **A snapshot every time.** The table is rebuilt from the source on every run,
  inside one transaction, so a failure leaves the previous copy in place and the
  dataset never keeps rows the source has deleted.
- **Bounded.** A run reads at most its row limit (50,000 by default, 1,000,000
  max) and says `truncated` when it stopped there.
- **It refreshes what is built on it.** The object types on the dataset get their
  new counts, and a property whose column the source dropped is named in the run.

On the platform's own database the `platform` and `connection_raw` schemas are
hidden and refused as a sync source: they hold users' password hashes and the
platform's bookkeeping, not source data.

### Schedules (`/schedules`)

One row per sync, with its cadence beside it. Choose *Manual only*, *Every 20
minutes* … *Every 8 days*, or *Custom…* for anything like `45m`, `3d`, `2w`
(at least a minute, at most a year).

- **One cadence per sync**, enforced by a unique index: two schedules on one
  dataset would each rebuild it under the other.
- **A scheduled run is a normal run** — the same function as *Run now* — and lands
  in the same run history.
- **The claim is the fire.** `next_run_at` moves forward inside the same `UPDATE`
  that records the firing, so two ticks can never double-run a sync.
- **Failure keeps the cadence**, and failing syncs lead the page.

The loop ticks every `SCHEDULE_TICK_SECONDS` (default 20; `0` disables it).

```bash
# Every 2 hours; "manual" removes the schedule
curl -X POST -H "authorization: Bearer $TOKEN" -d '{"every":"2h"}' .../api/syncs/3/schedule
```

### Datasets (`/browse/datasets`)

Each synced view, with where it came from, when it was last synced, what it is
modelled as, and its rows. **Create object type** opens the profile as a form:
every column kept, each with its suggested role, the key chosen from the columns
that qualify — a person corrects rather than composes. **Ask the AI-FDE to model
it** hands the same request to the assistant.

### The workbench (`/`, `/ontology`, `/graph`, `/explorer`)

- **Overview** counts the five stages for the space you are in and names the next
  step (sync something, model what is synced, give a sync a cadence, …).
- **Object types** shows each type's properties with their semantic role and
  column, its links with their match ratios, its actions and metrics, and the
  change history — every creation, edit and deletion, with who made it and what
  it replaced, and an undo.
- **Graph** is a force layout of the types and links; dashed edges are partial
  joins. Export the ontology as OWL, SHACL, Mermaid, DOT, ER or JSON Schema.
- **Object explorer** queries any type with filters built from its properties,
  opens one object and walks its links, and shows the SQL it ran.

### Metrics (`/browse/metrics`), functions (`/functions`), actions (`/actions`)

A **metric**'s page shows its definition and the rows it is computed from.

A **function** is drafted — by a person or the assistant — and lands as
`proposed`: it computes nothing and nothing may use it until an **admin**
approves it. Its SQL is restricted in three layers:

1. one `SELECT`/`WITH`, comments stripped first so `-- x` cannot hide a second
   statement, and no server function that reaches outside the data
   (`pg_read_file`, `dblink`, `set_config`, …);
2. every relation it reads is resolved **by the planner** (`EXPLAIN`) and must be
   a synced dataset in `connection_raw` — a read of `platform.app_user`, even one
   hidden behind an `information_schema` view, is refused by name;
3. it runs as a subquery inside a `READ ONLY` transaction with a 30-second limit.

**Actions** — pick one, fill the form, run it. The ontology role decides what is
permitted through ontograph's `AccessController` with **default-deny**. Every
action returns **`staged`** and writes an audit row with the exact payload that
would be sent. The Business Analyst role may run none.

### Dashboards (`/dashboards`)

A widget names a **metric** and how to slice it; it never carries SQL, so the
worst a bad generation can do is pick the wrong metric, not run the wrong query.
`/dashboards/history` shows where each board came from and lets you rename, back
up to a file and restore — a restore validates every widget against the
**current** metrics and skips one whose metric no longer exists.

### The AI-FDE assistant (`/assistant`)

Named after Palantir's forward deployed engineer. It has **no database
connection** and calls the ontology service **as the signed-in user**, so it can
create exactly what that user may create (analyst and above) and delete only if
they are an admin.

**Modes** decide which tools it sees, per the Palantir AI-FDE prompt
(`secrets/prompt`), following the platform's path:

| Mode | For | Tools include |
|---|---|---|
| `dataConnection` | bringing data in | list connections and their views, create a sync with a cadence, run, schedule |
| `ontologyEditing` | building | list and profile datasets, create object types, suggest and create links, create metrics and actions, propose functions |
| `functionsEditing` | functions | profile datasets, draft functions, create metrics |
| `exploration` (default) | answering | describe, search, aggregate, traverse links, compute metrics |
| `applicationBuilding` | dashboards | compute metrics, create metrics and dashboards |
| `governance`, `platformQna` | permissions, the platform itself | roles, audit, documentation |

Capabilities (`notepad`, plans, todos, `viewPermissions`, `filesystem`) survive a
mode switch. Gating is enforced twice: the schemas a turn receives are filtered
by mode, and `run_tool` checks the same set, answering a stray call with the mode
to switch to.

For a build it writes a **plan** first (a live checklist in the chat), profiles
each dataset, creates the types, draws the links the data supports (at least
50 % resolving), defines metrics and actions, and ends with what it built — a
**Built in this turn** card, the metric values, and a Mermaid diagram. A read
made before a write in the same turn is never served from its duplicate-call
cache, so it sees what it just created.

Try:

- *"Create object types from every synced dataset, link them, and add the metrics
  and actions that are useful for running freight operations."*
- *"Sync tms_views.v_transport from the TMS database and refresh it every 20 minutes."*
- *"Profile the order dataset and tell me which columns the source does not carry."*
- *"How many orders have no route yet, for which accounts?"*
- *"Build a dashboard for a transport operations manager."*

---

## Operating it

```bash
# Re-land the captured snapshot from scratch (tms_raw; the views follow it)
docker compose run --rm pipeline python -m pipeline.run --force

# Rebuild the source views after editing db/init/04,05_*.sql, then re-run the
# syncs of the views that changed
./scripts/reload-views.sh
```

### Schema changes

`db/init/*.sql` runs **only when the Postgres data directory is empty**. Anything
that changes a database which already holds data goes in `db/migrations/` as
`NNNN_name.sql`, applied by `pipeline.migrate` on every pipeline run, each in its
own transaction and recorded with a checksum. Migrations are immutable once
applied: add a new one instead.

```bash
docker compose run --rm pipeline python -m pipeline.migrate            # apply pending
docker compose run --rm pipeline python -m pipeline.migrate --status   # show only
```

**Init is the post-migration truth, not a historical snapshot**:
`services/pipeline/tests/test_init_matches_migrations.py` fails if an init script
defines a view the migrations drop without rebuilding. `07_verify.sql` fails
loudly if an expected object is missing, because a failed init otherwise comes
back "healthy" with half a schema.

### Backups

```bash
./scripts/backup.sh dump              # everything
./scripts/backup.sh dump --user-only  # what people made (below)
./scripts/backup.sh restore backups/user-<timestamp>.sql.gz
```

`--user-only` keeps what nothing can rebuild: connections, syncs and schedules,
the ontology (types, links, actions, metrics and their change history),
functions, dashboards, notes, chats, the audit trail and users. It leaves out
what can: the TMS snapshot (the pipeline re-lands it) and the datasets (their
syncs re-run). Restore one into a freshly **migrated** database before the
ontology service first starts — the script's header gives the four commands.

### Troubleshooting

| Symptom | Cause |
|---|---|
| Pipeline: "database schema is incomplete" | An init script failed on first boot. `docker compose down -v && docker compose up -d`. |
| Ontology service waits at boot | Migrations not applied. Check `docker compose logs pipeline`. |
| A sync fails with "not readable" | The view was renamed or the connection's user lost `SELECT` on it. |
| An object type's queries fail after a sync | The source dropped a column; the sync's run names the property. |
| Assistant: "language model is not ready" | Check `/health`; usually the Azure endpoint or key. Everything else works without it. |
| Anything from the host takes ~130 s | `localhost` resolving to `::1`. Use `127.0.0.1`. |

---

## Spaces, projects and resources

`/spaces` is the workspace: `space → project → folder → resource`. **Sandbox,
Development, Staging and Production** exist from the start, each with its own
connections, syncs, datasets, ontology, functions, dashboards and conversations.
The sandbox is set up at boot with a *TMS Platform* project (`/Connections`,
`/Datasets`, `/Ontology`, `/Outputs`) and the platform-database connection.

A **resource** is the addressable card. Seven kinds: connection, dataset, object
type, link type, action type, metric and dashboard. Datasets are filed by their
sync; ontology cards are kept in step with the ontology after every change. Cards
point at what they describe by api name or relation, not by foreign key, so a
card whose target was deleted is marked `unresolved` rather than rendering empty.

---

## Security and operations

### Authentication

Every API route requires a bearer token except `/health`. The ontology service
issues tokens; the assistant verifies them with the shared `AUTH_JWT_SECRET`, so
one sign-in works across both APIs.

| | Decides | Values |
|---|---|---|
| `role` | which API routes are reachable | `viewer`, `analyst`, `admin` |
| `ontology_role` | which **actions** may be executed | the five ontology roles |

| Route | Needs |
|---|---|
| reads: object types, objects, metrics, datasets, profiles, dashboards | `viewer` |
| connections, syncs, schedules; object types, links, actions, metrics; function proposals; dashboards | `analyst` |
| deleting anything, approving functions, the audit trail, registry reload | `admin` |

Anything under `/api` added later needs at least `viewer`: the guard is mounted
once, ahead of the routes.

```bash
docker compose run --rm pipeline python -m pipeline.users list
docker compose run --rm pipeline python -m pipeline.users add jo analyst '<password>' --ontology-role tms:DispatcherRole
docker compose run --rm pipeline python -m pipeline.users revoke jo   # kills issued tokens
```

Passwords are scrypt, in a format both Python and Node derive from their
standard library.

### Secrets

`./scripts/init-secrets.sh` writes `./secrets/*`, which compose mounts at
`/run/secrets`; each service reads them through a `*_FILE` variable, not plain
`environment:` values that `docker inspect` would print. `./secrets` is
gitignored.

| File | Used by |
|---|---|
| `jwt_secret` | both APIs, to sign and verify tokens |
| `postgres_password` | Postgres, and the sandbox connection's credential reference |
| `database_url` | all three services |
| `azure_openai_key` | the assistant |

### Cost controls

`/api/assistant/chat` has a per-user request rate (`CHAT_RATE_PER_MINUTE`,
`CHAT_RATE_BURST`) and a rolling 24-hour token budget (`CHAT_DAILY_TOKEN_BUDGET`),
both per process. Every turn's tokens and price are recorded — including a turn
the model stopped part way through — and shown on the turn and at
`/assistant/cost`.

### Retention and logs

`CHAT_RETENTION_DAYS` purges conversations idle longer than the window on each
pipeline run (`0` disables it). Both services emit one JSON line per request
carrying a `requestId`, forwarded from the assistant to the ontology service, so
one chat turn and every query it caused share one value. A 5xx returns only the
request id; the detail stays in the log.

### Tests

```bash
cd services/ontology-service && npm test          # 120 tests
cd services/ai-fde          && pytest tests/ -q   # 58 tests
cd services/pipeline        && pytest tests/ -q   # 23 tests
```

They cover the SQL builders (identifiers allowlisted, values bound, limits
clamped), the function guard, the interval parser, dataset profiling's role
suggestions, the definition builder (held to ontograph's own validator and
`AccessController`), link naming, and the assistant's mode gating, tool schemas,
write-aware cache and failure summaries. `.github/workflows/ci.yml` runs all of
it plus typechecks, an `nginx -t` and a full image build.

### Known limits

- Rate limiting, the token budget, the registry and the scheduler are
  in-process; horizontal scaling needs a shared store (the scheduler's claim
  `UPDATE` already prevents double-firing).
- A sync reads its rows into memory, bounded by its row limit; there is no
  streaming or incremental mode.
- Actions are staged; there is no write-back to a source.
- No metrics or tracing, only structured logs.

## Layout

```
db/init/              01 raw schema · 02 reference data · 03 (dropped by 0018)
                      04 source views · 05 source KPI views · 06 platform · 07 verify
db/migrations/        NNNN_name.sql, applied once each by pipeline.migrate
services/pipeline/    migrate · ingest (the TMS snapshot) · users · retention
services/ontology-service/src/
                      connections (sources, syncs) · schedules (the loop)
                      authoring (profile, object types, suggestions, actions, metrics)
                      builder (edits, links, deletes, history) · definition (document, cards)
                      functions + sqlGuard · objectSet · kpi · actions · dashboards
                      spaces · resourceData · documentation · registry · auth
services/ai-fde/app/  llm (Azure OpenAI) · modes · tools · capability_tools
                      agent · prompts · store · ontology_client
services/ui/src/      pages: Overview, OntologyManager, ObjectExplorer, GraphView,
                      ResourceBrowser (connections, datasets, metrics), Schedules,
                      Functions, Actions, Dashboards, Assistant, Spaces
vendor/ontograph-core/      the vendored library — see below
scripts/              bootstrap · init-secrets · backup · reload-views
```

### Changes to the vendored library

`vendor/ontograph-core` is a clone of
[`openshuyi/ontograph-core`](https://github.com/openshuyi/ontograph-core) with two
minimal changes, both needed to consume it from Node rather than Bun:

1. **`tsconfig.build.json` added**, emitting CommonJS with `rootDir: "src"` so the
   declared entry point `dist/index.js` is the real one.
2. **Two root re-exports added to `src/index.ts`** for `OWLExporter` and
   `SHACLExporter`, which were unreachable under CommonJS resolution.

No behaviour was changed.

### Charts

Hand-built SVG, not a chart library, so the mark specs are enforceable: 2 px
surface gaps between fills, rounded data-ends anchored to the baseline, direct
value labels, recessive grid. The categorical palette is validated separately
against the dark (`#141416`) and light (`#fbfbfa`) surfaces, and donuts cap at
three hues plus "Other".

---

## Data notes

Things found in the captured TMS data that a model built on it should know:

- **20 orders carry an implausible handling-unit weight** — one is 530 units ×
  77,936 lb = 18,736 t in a single handling unit. The source view flags them as
  `has_implausible_weight`, so a metric can exclude them with a condition.
- **The demo coordinates are not geographically coherent.** Great-circle distance
  between origin and destination has a median of 5,594 km against planned transit
  windows of 0.06 to 3.4 days. `total_distance_km` reads NULL, which is what the
  snapshot supports.
- **Shipment status reaches 11 and transport status reaches 8**, beyond the
  documented enums; the inferred labels carry `status_label_is_inferred = true`.
- **`users_permissions.json` is not ingested** (it is the front-end route
  registry), and **`businessentities_entityType_0_None.json` is not ingested**
  (the API returns HTTP 400 for `entityType=0`).
- **Every party is nearly a location**: 738 of 743 parties hold `LocationRole`,
  which is why `v_location` has 738 rows.
