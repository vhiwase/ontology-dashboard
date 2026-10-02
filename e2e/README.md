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
(`ALLOW_SELF_REGISTRATION=true`, the default).

Set `PW_CHROMIUM` to a Chromium binary to use one that is already installed.
