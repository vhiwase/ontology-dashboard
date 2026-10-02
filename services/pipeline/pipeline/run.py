"""Land the captured TMS snapshot.

    python -m pipeline.run                 land the payloads (skipped if already landed)
    python -m pipeline.run --force         re-land the snapshot from scratch
    python -m pipeline.run --dry-run       report what would happen, write nothing

This is the whole of the pipeline's data work now. The captured REST payloads
become tms_raw, and db/init/04_views.sql presents them as the tms_views views.
That database is the SOURCE a PostgreSQL connection reads from: a sync copies a
view into connection_raw as it is, and object types are created from those
datasets in the ontology service. Nothing here generates an ontology any more.
"""

from __future__ import annotations

import argparse
import logging
import sys

from .config import CONFIG
from .db import connect, query_one
from .ingest import run_ingest

log = logging.getLogger("pipeline")


def _configure_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s  %(levelname)-7s %(name)-24s %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stdout,
    )
    logging.getLogger("psycopg").setLevel(logging.WARNING)


def _assert_schema_ready(conn) -> None:
    """Fail loudly if the init scripts did not fully replay.

    The postgres entrypoint only runs /docker-entrypoint-initdb.d when PGDATA is
    empty. If one of those scripts errors, the container exits, the restart policy
    brings it back, it finds a populated PGDATA, skips init and reports healthy -
    with half a schema. Checking here turns that into one clear message instead of
    a confusing failure later.
    """
    missing: list[str] = []
    for schema, name in [
        ("tms_raw", "tms_order"),
        ("tms_views", "v_order"),
        ("platform", "space"),
        ("platform", "connection_sync"),
    ]:
        found = query_one(
            conn,
            """
            SELECT 1 AS ok FROM information_schema.tables
            WHERE table_schema = %s AND table_name = %s
            """,
            (schema, name),
        )
        if not found:
            missing.append(f"{schema}.{name}")

    if missing:
        raise RuntimeError(
            "The database schema is incomplete - missing: "
            + ", ".join(missing)
            + ".\nThis usually means a db/init script failed on first boot and the "
            "container then skipped initialisation on restart. Rebuild with:\n"
            "    docker compose down -v && docker compose up -d"
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pipeline.run", description=__doc__)
    parser.add_argument("--force", action="store_true",
                        help="Re-land the snapshot even if the raw tables already hold it.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Report what would be landed and roll the transaction back.")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    _configure_logging(args.verbose)
    log.info("Landing the captured TMS snapshot from %s.", CONFIG.source_dir)

    conn = connect()
    try:
        _assert_schema_ready(conn)
        result = run_ingest(conn, force=args.force or CONFIG.force_reingest)
        if args.dry_run:
            conn.rollback()
            log.warning("--dry-run: everything above was rolled back.")
        else:
            conn.commit()
        if result.get("skipped"):
            log.info("Nothing to land: %s orders already present.", result.get("orders"))
        return 0
    except Exception as exc:
        conn.rollback()
        log.error("Ingest failed: %s", exc)
        if args.verbose:
            log.exception("Traceback:")
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
