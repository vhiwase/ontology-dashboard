# TMS Ontology Workbench

A Palantir-Foundry-shaped ontology platform: connect a PostgreSQL database, get
an ontology of your own tables, and ask for the charts, KPIs, dashboards and
reports you need. An AI-FDE assistant builds and extends the ontology and checks
every request against the data first - ready, one approval away, or not possible.
Anyone can sign up and gets a private workspace. A captured 3PL transport
management snapshot ships as an optional demo source.

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

## Your data, your workspace

Every account has a **private workspace**: its own connections, model,
dashboards, reports, approvals and conversations. Nobody else can open it.
With `ALLOW_SELF_REGISTRATION=true` (the default) anyone who can reach the UI
can create an account from the sign-in page and is taken straight to theirs.

### From a table to a dashboard

1. **Connect** a PostgreSQL database (Home -> *Connect your database*). The
   connection is tested before it is saved; the password goes to the
   workspace's encrypted vault (AES-256-GCM, key in `./secrets/credential_key`)
   and the connection keeps only a reference to it. Read-only access is enough:
   nothing is ever written back.
2. **Choose tables.** Each is copied into the workspace (a snapshot you can
   refresh from *Data sources*, or on a schedule from *Refresh schedules*), and the source's primary, unique and foreign
   keys are read.
3. **A model, not a dump.** Each table becomes an object type whose columns are
   profiled into measures, dimensions, dates and identifiers; foreign keys (and
   columns named for another table's key, verified against the data) become
   links with their measured match ratio; every type gets its metrics - counts,
   sums and averages of its measures, distinct counts of its references, each
   sliceable by its dimensions and by day, week, month, quarter and year.
4. **Ask.** "Revenue by country per month", "build me a sales dashboard",
   "write a report on orders I can share", "what can I build?",
   "link employees to us states on region = state_abbr",
   "combine order details with their products and categories".

### Ready, one approval away, or not possible

Every request goes through a **feasibility check** against the workspace's
ontology first:

| Answer | What happens |
|---|---|
| **Ready** | An existing metric answers it. The chart, KPI, dashboard or report is built. |
| **Needs approval** | One more building block is needed - a **link** (found by column name or by values, or named by you), a **combined dataset** (rows of one type with fields from the types they point at, plus derived columns such as `revenue = unit_price * quantity * (1 - discount)`, `days_between(order_date, shipped_date)` or `(shipped_date <= required_date) * 100`), a **metric**, or an **action type**. It is drafted and measured - match ratio, preview value, sample rows - and waits in *Approvals*. Nothing changes until you approve. |
| **Not possible** | The data does not hold what is needed. You are told what is missing and offered the nearest questions it can answer. |

A dashboard asked for on data that cannot support a good one (no timeline,
little to slice, or not the figure asked for) becomes a proposal for one wide,
analysis-ready dataset - and the board is **built the moment you approve it**.

Being on time is a figure no column holds but two dates do. "On-time delivery
rate by month" or "how many orders shipped late" on rows with a promised date
and an actual one (`required_date` and `shipped_date`, say) proposes a
*Timing* dataset: each row flagged on time or late, with its days late and
days to complete, measured as **On-time rate** and **Late orders** and
sliceable by whatever the rows point at. Rows with no actual date yet count as
neither. Data without both dates is told so - it is never estimated.

### Dashboards and reports

- **Dashboards** are live grids: filters read from the data (with date presets
  measured from where the data ends), click a bar, slice or row to filter the
  whole board by it, download any widget (or the whole board) as CSV, see the
  SQL behind any tile. Stat tiles show the change over the last *complete*
  period; a period the data stops part-way through is drawn dashed and never
  compared.
- **Reports** are the same widgets laid out as a document - key figures,
  highlights written from the numbers on the page, captioned sections - with
  *Print / save PDF*.

### Settings

| Variable | Default | |
|---|---|---|
| `ALLOW_SELF_REGISTRATION` | `true` | `false` = accounts by administrators only |
| `REGISTRATION_DEFAULT_ROLE` | `analyst` | or `viewer` |
| `REGISTRATION_MAX_PER_HOUR` | `5` | sign-ups per address per hour |
| `BLOCK_PRIVATE_CONNECTION_HOSTS` | `false` | `true` = personal workspaces may connect to public addresses only (cloud deployments). Link-local metadata addresses and the platform's own database are always refused. |
| `SCHEDULE_TICK_SECONDS` | `20` | how often due sync schedules are fired; `0` disables them |

**Upgrading an existing install:** re-run `./scripts/init-secrets.sh` - it adds
`credential_key` without touching the existing secrets - then
`docker compose up -d --build`. If the script says it replaced a directory with
a file, use `docker compose up -d --build --force-recreate` instead (see
[Secrets](#secrets) for why a restart is not enough). The pipeline applies the
pending migrations at start (workspaces, proposals and per-workspace audit are
0032-0034, after the dataset-ontology migrations 0027-0031; the admin console
is 0035; 0036 lets a conversation be deleted without deleting what it cost).

A question that names a value - "revenue in Germany", "orders shipped via
Speedy Express", "customers in Mexico" - is answered for that value. The
value is found in the workspace's own category columns (never guessed) and
placed on the column that holds it as asked: "shipped to France" on the ship
country, "customers in Brazil" on the customer's country. When the figure's
own rows do not carry that column, the same figure on a combined dataset with
one row per record answers instead; when nothing carries it, you are told so
and offered the combination that would - never the unfiltered number.

**New and returning customers** are told apart by the order of each
customer's rows: "new vs returning customers per month" proposes an *Order
History* dataset that numbers every order within its customer
(`sequence_of(customer_id, order_date, order_id)`). A customer is new in the
period of their first order and returning in any period they order again.

### SQL functions in a personal workspace

Every workspace's synced tables share one schema, so a function written in a
personal workspace may read only that workspace's own synced tables - checked
by the planner, which reports a combined dataset as the tables under it - and
is checked again at every run. Functions that run SQL handed to them as text
(`ts_stat`, `*_to_xml`) and queries carried inside a string are refused
everywhere. The workspace's owner approves its functions.

---

## Getting started

### Requirements

- Docker with Compose v2 (tested on Docker Desktop 29.1.3 / Compose 2.40.3)
- ~2 GB free disk
- Optional: the sibling `../api_responses` directory, mounted read-only by the
  pipeline - the TMS demo snapshot. Without it the stack starts empty and every
  user works from the databases they connect.

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

Then open **https://127.0.0.1:3000** and either **create an account** (you land
in your own empty workspace: *Connect your database*) or sign in as `admin` with
that password.
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

One model backend: the **Azure OpenAI** deployment configured in `.env`
(`AZURE_OPENAI_ENDPOINT`, deployment name, and the key in
`./secrets/azure_openai_key`).

Until those are set, the **built-in planner** answers: it needs no model, runs
the same tools - the feasibility check, metrics, proposals, boards - and says on
every answer that no model wrote it, so a fresh install is usable at once.
`LLM_PROVIDER=builtin` selects it on purpose (tests, demos); any value other
than `azure_openai` or `builtin` fails loudly at startup. Each answer shows what
it cost; planner turns are free.

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
minutes* … *Every 8 days*, or *Custom schedule…*, which opens a window: repeat
every *n* minutes, hours, days or weeks (at least a minute, at most a year), and
the **first run** picked on a calendar with a time — or one interval from now.
The runs that follow are listed before anything is saved.

- **One cadence per sync**, enforced by a unique index: two schedules on one
  dataset would each rebuild it under the other.
- **A schedule keeps its rhythm.** Each run is due a whole number of intervals
  after the first, counted from when the last one was *due* rather than when the
  tick reached it — so "every day at 02:00" is still 02:00 a month on, and a run
  missed while the service was down is followed by the next one at its usual
  time. A first run already past starts at the next moment on the same rhythm.
- **A scheduled run is a normal run** — the same function as *Run now* — and lands
  in the same run history.
- **The claim is the fire.** `next_run_at` moves forward inside the same `UPDATE`
  that records the firing, so two ticks can never double-run a sync.
- **Failure keeps the cadence**, and failing syncs lead the page.

The loop ticks every `SCHEDULE_TICK_SECONDS` (default 20; `0` disables it).

```bash
# Every 2 hours; "manual" removes the schedule
curl -X POST -H "authorization: Bearer $TOKEN" -d '{"every":"2h"}' .../api/syncs/3/schedule
# Every 3 days, first at 02:00 on the 6th (a date and time with its zone)
curl -X POST -H "authorization: Bearer $TOKEN" \
     -d '{"every":"3d","startAt":"2026-10-06T02:00:00+05:30"}' .../api/syncs/3/schedule
```

### Datasets (`/browse/datasets`)

Each synced view, with where it came from, when it was last synced, what it is
modelled as, and its rows. **Add dataset** chooses a connection and one of its
views and syncs it — the same sync the connection's page sets up. A sync's first
run is what registers its dataset, and the list and the count in the navigation
are re-read whenever one runs, so a new dataset is there without reloading the
page. **Create object type** opens the profile as a form:
every column kept, each with its suggested role, the key chosen from the columns
that qualify — a person corrects rather than composes. **Ask the AI-FDE to model
it** hands the same request to the assistant.

### The workbench (`/`, `/ontology`, `/graph`, `/explorer`)

- **Overview** counts the five stages for the space you are in and names the next
  step (sync something, model what is synced, give a sync a cadence, …).
- **Object types** shows each type's properties with their semantic role and
  column, its links with their match ratios, its actions and metrics, and the
  change history — every creation, edit and deletion, with who made it and what
  it replaced, and an undo. A type's **title column** — the one an object is
  named by in lists and pickers — is chosen from its own columns and is the
  single record of that choice; a column the type does not have is refused.
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

**Actions** — pick one, fill the form, run it. An action runs **as whoever is
signed in**: the actor and the ontology role come from the token, never from the
request, so the page offers no role to "act as". The form knows the data: the
object the action acts on is chosen from its own records, searched by name
rather than typed as an id; a parameter that names a field is chosen from the
object type's fields, with the value it holds now beside it; the rest are typed
in a control that fits their declared type. The ontology role decides what is
permitted through ontograph's `AccessController` with **default-deny**. Every
action returns **`staged`** and writes an audit row with the exact payload that
would be sent. The Business Analyst role may run none.

### Dashboards (`/dashboards`)

A widget names a **metric** and how to slice it; it never carries SQL, so the
worst a bad generation can do is pick the wrong metric, not run the wrong query.
`/dashboards/history` shows where each board came from and lets you rename, back
up to a file and restore — a restore validates every widget against the
**current** metrics and skips one whose metric no longer exists. Restoring asks
first whether a board that already exists should be replaced or left as it is
(or neither: cancelling restores nothing), and deleting a board asks before it
goes. A board the assistant built links back to the conversation that built it.

### Deleting

Every list has a **Delete**: connections, datasets, schedules, object types,
links, actions, metrics, functions, dashboards and approvals - and, in a
personal workspace, the databases and tables under *Data sources*. It deletes
the thing, not its card: a deleted object type is not back after the next
change to the model, and a deleted dataset is not back after the next sync.

The window that asks first is read from the database at that moment and lists
three things - what is **deleted with it**, what is **built on it** and would
be deleted too, and what is **kept but affected**:

| Deleting | Goes with it | Built on it (deleted too, once confirmed) | Kept |
|---|---|---|---|
| a connection | its syncs, each with its schedule and the record of its runs; its stored password | | the datasets it landed, with the rows they have now; they can no longer be refreshed |
| a dataset | its copied table; its sync, with its schedule and the record of its runs | the object types built on it and the combined datasets that read it, each with its metrics, links and actions | the connection; a dashboard showing one of those metrics, with that widget in error; a function that reads the table, which fails until it is changed |
| a sync (on *Schedules*) | its schedule and the record of its runs | | its dataset, with the rows it has now |
| a schedule | | | the sync, which then runs only when someone starts it |
| an object type | its properties; a combined dataset's view | its metrics, its links (either end) and its actions | the dataset; a dashboard showing one of those metrics, with that widget in error |
| a metric | | | a dashboard showing it, with that widget in error |
| a link | | | the object types at both ends |
| an action | | | every run already in its audit trail |
| a function | its recorded runs | | |
| a dashboard or report | | | the metrics it showed |
| an approval | | | whatever an approved one added to the model |

Nothing with a name of its own is lost to a delete that did not mention it: a
request that leaves out what is built on something is refused with `409` and
the list, and goes through only with `cascade=true` - which is what the button
"Delete it and *n* things built on it" sends. Three things are refused
outright and say why: an object type the pipeline generates (its next run would
rebuild it), a proposal another proposal is still waiting on, and a table that
something outside this space's model reads.

A dataset's table is dropped only when it is provably that dataset's own: the
sync that lands it is in the same space, or the card is the one a sync run
registered. A dataset registered by hand over some other relation comes off
the list - with what was modelled on it, once confirmed - and the relation
itself is left alone.

```bash
# What deleting it would do - changes nothing
curl -H "authorization: Bearer $TOKEN" .../api/removal/objectType/Order
# Do it, with what is built on it
curl -X DELETE -H "authorization: Bearer $TOKEN" ".../api/removal/objectType/Order?cascade=true"
```

`kind` is one of `connection`, `dataset`, `sync`, `schedule`, `objectType`,
`linkType`, `actionType`, `metric`, `function`, `dashboard`, `proposal`; the
reference is an id, an api name or a dashboard's slug. `DELETE
/api/resources/:id` does the same for whatever a workspace card stands for.
Deleting needs the `admin` role in the space - an administrator in the shared
spaces, the owner in their own workspace - and everyone else is not shown the
button.

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

**A conversation outlives the page.** It is held above the pages, one per space,
so opening a dataset or a schedule and coming back finds it where it was, and a
question still being answered keeps running meanwhile. It is stored on the
server, so a reload reopens it, and only **New conversation** (or **New chat**
in the history) starts another.

**Every conversation is kept, and the history is beside it.** Each question,
each answer, what was attached to it and what it cost is a row in
`platform.chat_session` / `platform.chat_message`, under the account that
asked and the space it was asked in. The panel on the left of the page lists
that account's conversations in the space, newest first under *Today*,
*Yesterday*, *Previous 7 days*, … with the one on screen marked:

- **Open** one to continue it where it stopped.
- **Search** looks through the names and through everything asked and answered,
  and shows the passage that matched.
- **Rename** one; **pin** it to keep it at the top.
- **Delete** erases what was said - questions, answers, attachments - and takes
  it out of every list. What it cost stays on record, so deleting a
  conversation does not hand back any of the month's AI credit or take money
  out of the cost report. What it built (dashboards, metrics, proposals) stays.
- What the page itself adds to a conversation - "Approved and built: …" after
  approving a proposal from inside it - is stored with it, so it reads the same
  when it is opened again.

An administrator can switch the panel from *Mine* to *Everyone's* in a shared
space; nobody else can list, open, rename or delete another account's
conversation (the API answers `404`, not `403`, so ids cannot be probed). The
**History** button in the bar hides and shows the panel; on a narrow window it
slides over the conversation instead of sitting beside it.

```bash
# The caller's conversations in a space; q searches, limit/offset page
curl -H "authorization: Bearer $TOKEN" ".../api/assistant/sessions?space=sandbox&scope=mine&q=freight"
curl -H "authorization: Bearer $TOKEN" .../api/assistant/sessions/42            # every message of one
curl -X PATCH -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
     -d '{"title":"Freight by country","pinned":true}' .../api/assistant/sessions/42
curl -X DELETE -H "authorization: Bearer $TOKEN" .../api/assistant/sessions/42
```

**A question is answered by choosing.** When the assistant needs the person to
pick — which tables to sync, which datasets to model, whether to go ahead — the
choices open in a panel above the message box: one or several, an optional note,
and **Submit answer**. It asks through the `request_clarification` tool, which
carries whatever it had to say first (asking never replaces answering); a reply
that still closes with a question in prose has its choices read off it by one
small extra call, priced into the turn.

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
That connection is added when the project is first set up and not again: one
that was deleted stays deleted across restarts, and `POST
/api/spaces/sandbox/seed` puts it back when it is wanted.

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
| the admin console, `/api/admin/*` | the **platform** `admin` role |

Anything under `/api` added later needs at least `viewer`: the guard is mounted
once, ahead of the routes.

```bash
docker compose run --rm pipeline python -m pipeline.users list
docker compose run --rm pipeline python -m pipeline.users add jo analyst '<password>' --ontology-role tms:DispatcherRole
docker compose run --rm pipeline python -m pipeline.users revoke jo   # kills issued tokens
```

Passwords are scrypt, in a format both Python and Node derive from their
standard library.

### The admin console (`/admin`)

For platform administrators, with the same sign-in — there is no second
password. An analyst is the admin of their own workspace and is still refused
here: `/api/admin/*` is pinned to the platform role, whichever space a request
names.

- **Overview** — accounts, what the assistant has cost this month and today, who
  is spending it, and what needs attention (credit used up, no default set).
- **Users** — add an account (it gets its private workspace), change its role,
  business role and monthly AI credit, set a new password, sign it out
  everywhere, disable it, or delete it. Nobody can delete, disable or demote
  themselves, and the last active admin cannot be removed. Deleting removes the
  account and frees the username; the workspace, conversations and notes it owned
  are kept under a label nobody can sign in as, so the cost history stays whole.
  Kept is not kept running: that workspace's scheduled refreshes are switched
  off and the database passwords it stored are removed, so nothing goes on
  reading a deleted person's database.
- **Defaults** — the default model, the Azure prices per million tokens, the
  default monthly AI credit, whether anyone may register and with which role.
  Stored in `platform.app_setting` and applied within seconds, with no restart.
  A setting nobody has set falls back to its environment variable and then the
  built-in default, so `.env` works as before.
- **Activity** — every change made in the console, with who made it.

The CLI above and the console manage the same `app_user` rows.

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
| `credential_key` | the ontology service, to encrypt the connection passwords typed into the connect form |

Each must be a **file**. A stack started before a secret's file exists gets an
empty *directory* at that path from Docker, and the service cannot read its
key. The ontology service checks the credential key as it starts and logs
`[boot] credential vault ready` or `[boot] CREDENTIAL VAULT NOT USABLE` with the
reason; until it is fixed, saving a connection with a typed password answers
`503` and says so, rather than "Internal server error". The fix is to re-run
`./scripts/init-secrets.sh` - it replaces such an empty directory with the key
and leaves every existing secret alone - then **recreate** the containers:
`docker compose up -d --build --force-recreate`. Restarting is not enough, and
on Docker Desktop it is worse than that: a container that started with the
directory mounted cannot start again once the path is a file ("Are you trying
to mount a directory onto a file?"), and for as long as it keeps running,
Docker shows the directory to every new container as well.

A stored connection password lives exactly as long as what it is for. Deleting
a connection - by itself, with its folder or with its project - removes its
password from the vault, and deleting an account removes every password its
workspace stored.

### Cost controls

`/api/assistant/chat` has a per-user request rate (`CHAT_RATE_PER_MINUTE`,
`CHAT_RATE_BURST`) and a rolling 24-hour token budget (`CHAT_DAILY_TOKEN_BUDGET`),
both per process. Every turn's tokens and price are recorded — including a turn
the model stopped part way through — and shown on the turn and at
`/assistant/cost`.

A **monthly AI credit** per person is set in the admin console: the platform
default, an account's own limit, or none. Spend is what the person's turns cost
this calendar month, priced when they ran. A question is refused (`402`) only
*before* it starts, once the credit is used up; a turn already running is never
cut off. The message box shows what is left, and a refused question is put back
in it rather than lost. Deleting a conversation does not lower the spend: the
record of what each answer cost outlives what it said.

### Retention and logs

`CHAT_RETENTION_DAYS` purges conversations idle longer than the window on each
pipeline run (`0`, the default, disables it: a conversation is then kept until
its owner deletes it). A **pinned** conversation is never purged, and the
history panel says which of the two applies, so nobody is told a conversation
is kept that a clean-up will remove. Both services emit one JSON line per request
carrying a `requestId`, forwarded from the assistant to the ontology service, so
one chat turn and every query it caused share one value. A 5xx returns only the
request id; the detail stays in the log.

### Tests

```bash
cd services/ontology-service && npm test          # unit tests (vitest)
cd services/ui              && npm test          # the UI's own rules (vitest)
cd services/ai-fde          && pytest tests/ -q
cd services/pipeline        && pytest tests/ -q
cd e2e && npm test                                # browser journey, against a running stack
```

They cover the SQL builders (identifiers allowlisted, values bound, limits
clamped), the function guard, the interval parser, dataset profiling's role
suggestions, the definition builder (held to ontograph's own validator and
`AccessController`), link naming, the assistant's mode gating, tool schemas,
write-aware cache and failure summaries, and - for workspaces - role inference,
request parsing, feasibility decisions, derived expressions, proposals and
follow-ups, registration, space roles, connection address classes, the vault
and the built-in planner; who may delete and how a refused delete reads; and
the conversation history - searching it, the grouping by day, and a delete
that erases what was said and leaves what it cost. `e2e/` drives a browser through sign-up, connect,
import, ask, approve and the built board (see `e2e/README.md`). `.github/workflows/ci.yml` runs all of
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
                      removal (what a delete takes with it, for every kind)
                      functions + sqlGuard · objectSet · kpi · actions · dashboards
                      spaces · resourceData · documentation · registry · auth
services/ai-fde/app/  llm (Azure OpenAI) · modes · tools · capability_tools
                      agent · prompts · store (conversations, their history) · ontology_client
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
