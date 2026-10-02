#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  Back up and restore the Postgres volume.
#
#      ./scripts/backup.sh dump                 write ./backups/<timestamp>.sql.gz
#      ./scripts/backup.sh dump --user-only     what people made (see below)
#      ./scripts/backup.sh restore <file>       load a dump back in
#      ./scripts/backup.sh list                 show what is in ./backups
#      ./scripts/backup.sh prune [keep]         delete all but the newest N
#
#  There was previously no backup at all, and `docker compose down -v` is a
#  documented step here, so the only copy of a dashboard someone built lived in
#  a volume that a routine command destroys.
#
#  What can be rebuilt is left out of --user-only: the captured TMS snapshot
#  (the pipeline re-lands it) and the synced datasets (their syncs re-run).
#  What cannot be rebuilt is kept: the connections, syncs and schedules, the
#  ontology built from the datasets (object types, links, actions, metrics and
#  their change history), functions, dashboards, notes, chats, the action
#  audit trail and users. It is small enough to keep often.
#
#  Restore a --user-only dump into a freshly MIGRATED database, before the
#  ontology service first starts - it creates an empty ontology per space at
#  boot, which a restored one would collide with:
#      docker compose down -v && docker compose up -d postgres
#      docker compose run --rm pipeline python -m pipeline.migrate
#      ./scripts/backup.sh restore backups/user-<timestamp>.sql.gz
#      docker compose up -d        # then re-run each sync to refill its dataset
# ---------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "$0")/.."
BACKUP_DIR=backups
SERVICE=postgres
PG_USER=${POSTGRES_USER:-ontology}
PG_DB=${POSTGRES_DB:-tms_ontology}

mkdir -p "$BACKUP_DIR"

compose() { docker compose "$@"; }

running() {
    [ -n "$(compose ps -q "$SERVICE" 2>/dev/null)" ] || {
        echo "Postgres is not running. Start it with: docker compose up -d $SERVICE" >&2
        exit 1
    }
}

# The tables holding work nothing can reproduce. Parents before children, so a
# data-only restore satisfies each foreign key as it goes.
USER_TABLES=(
    platform.app_user
    platform.project
    platform.folder
    platform.resource
    platform.connection_sync
    platform.connection_sync_run
    platform.schedule
    platform.schedule_run
    platform.ontology_version
    platform.object_type
    platform.object_property
    platform.link_type
    platform.action_type
    platform.kpi_definition
    platform.ontology_edit
    platform.function
    platform.function_run
    platform.dashboard
    platform.dashboard_rename
    platform.notepad_document
    platform.chat_session
    platform.chat_message
    platform.action_audit
)

cmd_dump() {
    running
    local stamp user_only=0 args=() target
    stamp=$(date +%Y%m%d-%H%M%S)
    [ "${1:-}" = "--user-only" ] && user_only=1

    if [ "$user_only" -eq 1 ]; then
        target="$BACKUP_DIR/user-$stamp.sql.gz"
        args=(--data-only --column-inserts)
        for table in "${USER_TABLES[@]}"; do args+=(-t "$table"); done
        echo "Dumping user-created content only."
    else
        target="$BACKUP_DIR/full-$stamp.sql.gz"
        echo "Dumping the whole database."
    fi

    # -T: no TTY, or the gzip stream gets CRLF-mangled on Windows.
    compose exec -T "$SERVICE" pg_dump -U "$PG_USER" -d "$PG_DB" "${args[@]}" \
        | gzip > "$target"

    echo "Wrote $target ($(du -h "$target" | cut -f1))"
}

cmd_restore() {
    local file=${1:-}
    [ -n "$file" ] || { echo "Usage: $0 restore <file>" >&2; exit 1; }
    [ -f "$file" ] || { echo "No such file: $file" >&2; exit 1; }
    running

    echo "About to load $file into $PG_DB."
    echo "This does not drop anything first: a full dump restored over a live"
    echo "database will collide on rows that already exist."
    printf 'Type the database name to continue: '
    read -r confirm
    [ "$confirm" = "$PG_DB" ] || { echo "Aborted."; exit 1; }

    if [ "${file##*.}" = "gz" ]; then
        gunzip -c "$file" | compose exec -T "$SERVICE" psql -U "$PG_USER" -d "$PG_DB"
    else
        compose exec -T "$SERVICE" psql -U "$PG_USER" -d "$PG_DB" < "$file"
    fi
    echo "Restored. Start (or restart) the services so the ontology is re-read,"
    echo "then run each sync once to refill the datasets it lands:"
    echo "  docker compose up -d && docker compose restart ontology-service"
}

cmd_list() {
    if [ -z "$(ls -A "$BACKUP_DIR" 2>/dev/null)" ]; then
        echo "No backups in ./$BACKUP_DIR"
        return
    fi
    ls -lh "$BACKUP_DIR" | tail -n +2 | awk '{printf "%-34s %8s  %s %s %s\n", $9, $5, $6, $7, $8}'
}

cmd_prune() {
    local keep=${1:-10} count removed=0
    count=$(ls -1 "$BACKUP_DIR"/*.sql.gz 2>/dev/null | wc -l)
    if [ "$count" -le "$keep" ]; then
        echo "$count backup(s), keeping $keep - nothing to prune."
        return
    fi
    # Newest first, skip the ones being kept, delete the rest.
    for file in $(ls -1t "$BACKUP_DIR"/*.sql.gz | tail -n +$((keep + 1))); do
        rm -f "$file"
        echo "  - removed $(basename "$file")"
        removed=$((removed + 1))
    done
    echo "Pruned $removed, kept $keep."
}

case "${1:-}" in
    dump)    shift; cmd_dump "$@" ;;
    restore) shift; cmd_restore "$@" ;;
    list)    cmd_list ;;
    prune)   shift; cmd_prune "$@" ;;
    *)
        sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
        exit 1
        ;;
esac
