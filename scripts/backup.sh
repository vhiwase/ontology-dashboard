#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  Back up and restore the Postgres volume.
#
#      ./scripts/backup.sh dump                 write ./backups/<timestamp>.sql.gz
#      ./scripts/backup.sh dump --user-only     dashboards, chats and audit only
#      ./scripts/backup.sh restore <file>       load a dump back in
#      ./scripts/backup.sh list                 show what is in ./backups
#      ./scripts/backup.sh prune [keep]         delete all but the newest N
#
#  There was previously no backup at all, and `docker compose down -v` is a
#  documented step here, so the only copy of a dashboard someone built lived in
#  a volume that a routine command destroys.
#
#  The pipeline can regenerate everything it derives from the source payloads.
#  What it cannot regenerate is what people made: AI-built dashboards, chat
#  history and the action audit trail. --user-only captures exactly that, and
#  is small enough to keep often.
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

# The tables holding work that no pipeline run can reproduce.
USER_TABLES=(
    platform.dashboard
    platform.chat_session
    platform.chat_message
    platform.action_audit
    platform.app_user
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
    echo "Restored. Reload the ontology service so it re-reads the registry:"
    echo "  docker compose restart ontology-service"
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
        sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
        exit 1
        ;;
esac
