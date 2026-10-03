# End-to-end tests

Browser tests of the journey a new customer takes - register, connect a
database, import its tables, ask what can be built, ask for a dashboard,
approve what it needs, open and filter the board, read it as a report -
against a running stack.

```bash
cd e2e
npm install                       # playwright only
npx playwright install chromium   # unless a Chromium is already available

E2E_BASE_URL=https://127.0.0.1:3000 \
E2E_SOURCE_HOST=db.example.com E2E_SOURCE_PORT=5432 E2E_SOURCE_DB=sales \
E2E_SOURCE_USER=reporting E2E_SOURCE_PASSWORD='…' \
npm test
```

The source database is yours: any PostgreSQL database with a few related
tables (foreign keys declared) and a read-only user will do. Nothing is
written to it. Steps that need particular data - a revenue dashboard needs a
price and a quantity column - skip with the reason when the data does not have
them. Every run registers a fresh account (`e2e-<timestamp>`), so it can be
repeated against the same stack; self-registration must be enabled
(`ALLOW_SELF_REGISTRATION=true`, the default). A stack accepts five
registrations an hour from one address: a sixth run inside the hour fails at
its first step with `429` until `REGISTRATION_MAX_PER_HOUR` is raised for the
stack under test.

The stack's self-signed certificate is accepted, so the HTTPS address works as
it stands. The source is dialled by the ontology service, from inside its
container: a database on the same machine is `host.docker.internal`, not
`127.0.0.1`, and it cannot be the platform's own database server.

Set `PW_CHROMIUM` to a Chromium binary to use one that is already installed.

## Without writing into your own stack

Each run leaves an account, its workspace, the tables it imported and the
assistant turns it paid for. To keep those out of a stack you use, run the
journey against a second copy of it: the same compose file under another
project name, with its own empty database, on other ports.

```bash
# from the repository root
export POSTGRES_PORT=55442 ONTOLOGY_SERVICE_PORT=4010 AI_FDE_PORT=4110 UI_PORT=3010 UI_HTTP_PORT=3090
docker compose -p tms-e2e up -d --build

(cd e2e && E2E_BASE_URL=https://127.0.0.1:3010 E2E_SOURCE_HOST=… npm test)

docker compose -p tms-e2e down -v --rmi local   # that copy only: its containers, volumes and images
```

`-p` is what keeps the two apart - `down -v` without it would remove the
database of the stack you use.
