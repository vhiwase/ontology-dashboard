"""Chat retention.

Conversations can quote customer data pulled from the ontology, so they cannot
sit indefinitely behind only a manual per-session delete. Sessions whose last
activity is older than CHAT_RETENTION_DAYS are removed unless flagged
is_retained; chat_message rows cascade. Each pass is recorded in
platform.retention_run so the deletion itself is auditable.

    python -m pipeline.retention            purge per policy
    python -m pipeline.retention --dry-run  report what would go
"""

from __future__ import annotations

import argparse
import logging
import os
import sys

from .db import connect

log = logging.getLogger("pipeline.retention")

# 0 disables the purge, which is the right default for a dev box; production
# sets a real window in .env.
RETENTION_DAYS = int(os.environ.get("CHAT_RETENTION_DAYS", "0"))


def purge(days: int, dry_run: bool = False) -> tuple[int, int]:
    """Delete sessions idle longer than `days`. Returns (sessions, messages)."""
    if days <= 0:
        log.info("CHAT_RETENTION_DAYS=%d - retention disabled, nothing purged.", days)
        return (0, 0)

    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT chat_session_id
                     FROM platform.chat_session
                    WHERE NOT is_retained
                      AND updated_at < now() - make_interval(days => %s)""",
                (days,),
            )
            ids = [row["chat_session_id"] for row in cur.fetchall()]
            if not ids:
                log.info("Nothing older than %d day(s).", days)
                return (0, 0)

            cur.execute(
                "SELECT count(*) AS n FROM platform.chat_message "
                "WHERE chat_session_id = ANY(%s)",
                (ids,),
            )
            message_count = cur.fetchone()["n"]

            if dry_run:
                log.info(
                    "Would delete %d session(s) and %d message(s).",
                    len(ids),
                    message_count,
                )
                return (len(ids), message_count)

            cur.execute(
                "DELETE FROM platform.chat_session WHERE chat_session_id = ANY(%s)",
                (ids,),
            )
            cur.execute(
                """INSERT INTO platform.retention_run
                       (policy_days, sessions_deleted, messages_deleted)
                   VALUES (%s, %s, %s)""",
                (days, len(ids), message_count),
            )
        conn.commit()

    log.info("Purged %d session(s), %d message(s).", len(ids), message_count)
    return (len(ids), message_count)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
    )
    parser = argparse.ArgumentParser(description="Purge chat history per policy.")
    parser.add_argument("--dry-run", action="store_true", help="Report, delete nothing.")
    parser.add_argument(
        "--days",
        type=int,
        default=RETENTION_DAYS,
        help="Override CHAT_RETENTION_DAYS for this run.",
    )
    args = parser.parse_args(argv)

    try:
        purge(args.days, dry_run=args.dry_run)
        return 0
    except Exception as exc:  # noqa: BLE001 - top level, report and fail
        log.error("Retention pass failed: %s", exc)
        return 1


if __name__ == "__main__":
    sys.exit(main())
