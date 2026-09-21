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
carrier scorecards and margin **cannot be computed from it**. Rather than ship a
platform where half the KPI catalogue reads zero, the pipeline generates execution
actuals deterministically into a **separate `tms_sim` schema**, and:

- every view that surfaces them reports `data_origin = 'simulated'`
- every KPI built on them carries `depends_on_simulation` and a coverage note
- the assistant is required by its system prompt to say so when it quotes one
- a **Data Trust** dashboard breaks the split down metric by metric

Measured, with no caveat needed: order volume and weight, the party and location
master, planning rate, the shipment status funnel, accessorial counts, and every
exception count.

Turn the simulation off with `PIPELINE_SIMULATE_EXECUTION=false`; the execution
KPIs then honestly read as no data.

---

## Getting started

### Requirements

- Docker with Compose v2 (tested on Docker Desktop 29.1.3 / Compose 2.40.3)
- ~8 GB free disk (4.7 GB of that is the Ollama model, only if you use it)
- The sibling `../api_responses` directory, mounted read-only by the pipeline

### The quick path

```bash
cp .env.example .env
docker compose up -d --build
docker compose logs -f pipeline      # watch ingest -> ontology -> lineage
```

Then open **http://127.0.0.1:3000**.

### The path that picks the right LLM for your hardware

```bash
./scripts/bootstrap.sh
```

It runs `nvidia-smi`, writes the LLM configuration into `.env` accordingly, and
brings the stack up with the GPU overlay if there is a GPU. See
[Choosing the LLM](#choosing-the-llm).

### Ports

All bound to `127.0.0.1` only.

| Service | URL | Notes |
|---|---|---|
| UI | http://127.0.0.1:3000 | nginx, also proxies both APIs |
| Ontology service | http://127.0.0.1:4000/api/stats | |
| AI-FDE | http://127.0.0.1:4100/health | reports which model is live |
| Postgres | `127.0.0.1:55432` | user/password/db all `ontology` |
| Ollama | `127.0.0.1:11435` | moved off 11434; see below |

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
  tms_sim.*                            generated execution actuals, flagged
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
4. **Attributes are shared when they agree.** 482 properties collapse to 252
   attribute definitions; a name is type-qualified only where two views genuinely
   disagree on its datatype.
5. **Actions, roles, constraints and KPIs are authored**, not derived — a business
   rule is not discoverable from a schema.

Current output: **20 object types, 482 properties, 41 link types, 82 relation
types** (each link plus its inverse), 252 attributes, 9 value types, 8
constraints, 3 interfaces, 3 logic rules, 12 actions, 5 roles, 31 KPIs, and a
168-node lineage graph. It validates against ontograph's own `OntologyValidator`
with **0 errors and 0 warnings**, and generates 23 SHACL shapes.

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

Read-only actions — rate what-ifs, on-time projections, cost recalculation —
genuinely execute and return computed results. Mutating actions return
**`staged`**: validated, permission-checked, recorded in the audit trail with the
exact payload that would be sent to the TMS, but **not sent**, because this
platform reads the TMS through a captured snapshot and has no write-back endpoint.
A dashboard that says a shipment was held when nothing was held is worse than one
that says the request was staged.

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
- *"Which of these metrics are measured and which are simulated?"*
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

# Measured data only: no simulated execution
docker compose run --rm pipeline python -m pipeline.run --no-simulate

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

`db/init/*.sql` runs **only when the Postgres data directory is empty**. To pick
up a schema change:

```bash
docker compose down -v && docker compose up -d
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

## Layout

```
db/init/              01 raw schema · 02 reference data · 03 simulation schema
                      04 semantic views · 05 KPI views · 06 platform · 07 verify
services/pipeline/    ingest · simulate · introspect · relationships
                      ontology_gen · kpi_catalog · actions · lineage_gen · dashboards
services/ontology-service/  registry · objectSet · kpi · actions · lineage · dashboards
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
  transports fall in a plausible road range. Simulated road distance is therefore
  derived from the planned transit window — which *is* real data — and the
  great-circle figure is still stored in `tms_sim.leg_distance.haversine_km` so
  the discrepancy stays visible.
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
