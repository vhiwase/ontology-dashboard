#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  Rebuild the semantic view layer in place, without touching the landed data.
#
#  Needed because CREATE OR REPLACE VIEW cannot rename or reorder columns - it
#  fails with "cannot change name of view column". Dropping the schema and
#  replaying 04/05 is the only way to pick up a column rename, and it is cheap
#  because tms_views holds no data of its own.
#
#  tms_views is the SOURCE the platform's own connection syncs from. Nothing
#  on the platform side depends on it directly: a sync names a view as text and
#  re-reads it on its next run, so re-running the syncs picks up the new shape.
#
#  Usage:  ./scripts/reload-views.sh            (via the compose postgres service)
# ---------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "$0")/.."

PSQL=(docker compose exec -T postgres psql -U "${POSTGRES_USER:-ontology}" \
      -d "${POSTGRES_DB:-tms_ontology}" -q -v ON_ERROR_STOP=1)

echo "Dropping and recreating schema tms_views ..."
"${PSQL[@]}" -c "DROP SCHEMA IF EXISTS tms_views CASCADE; CREATE SCHEMA tms_views;"

for file in db/init/04_views.sql db/init/05_kpi_views.sql; do
    echo "Replaying $file ..."
    "${PSQL[@]}" < "$file"
done

echo "Verifying ..."
"${PSQL[@]}" < db/init/07_verify.sql

count=$("${PSQL[@]}" -tAc \
    "SELECT count(*) FROM information_schema.views WHERE table_schema='tms_views'")
echo "Done: ${count// /} views in tms_views."
echo "Run the syncs of any view that changed (Schedules page, Run now) so their"
echo "datasets pick up the new shape."
