"""Versioned SQL migrations.

db/init/*.sql only replays into an empty data directory, so any schema change
after first boot previously meant `docker compose down -v` and losing the data.
Files in db/migrations are applied in filename order, once each, inside a
transaction, and recorded in platform.schema_migration with a checksum so an
edited file is reported rather than silently skipped.

    python -m pipeline.migrate            apply everything pending
    python -m pipeline.migrate --status   show applied / pending, apply nothing
"""

from __future__ import annotations

import argparse
import hashlib
import logging
import os
import sys
from pathlib import Path

from .db import connect

log = logging.getLogger("pipeline.migrate")

MIGRATIONS_DIR = Path(os.environ.get("PIPELINE_MIGRATIONS_DIR", "/db/migrations"))

_TRACKING_TABLE = """
CREATE SCHEMA IF NOT EXISTS platform;
CREATE TABLE IF NOT EXISTS platform.schema_migration (
    version     TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    checksum    TEXT NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    duration_ms INTEGER
)
"""


def _checksum(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _discover() -> list[tuple[str, str, Path]]:
    """Every migration on disk as (version, name, path), in filename order.

    A file is named NNNN_some_name.sql; the numeric prefix is the version and
    orders the set, so a migration added later never sorts ahead of one that
    has already been applied somewhere.
    """
    if not MIGRATIONS_DIR.is_dir():
        log.warning("No migrations directory at %s - nothing to apply.", MIGRATIONS_DIR)
        return []

    found: list[tuple[str, str, Path]] = []
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        stem = path.stem
        version, _, name = stem.partition("_")
        if not version.isdigit():
            raise RuntimeError(
                f"Migration {path.name} does not start with a numeric version "
                f"(expected NNNN_name.sql)."
            )
        found.append((version, name or stem, path))

    versions = [v for v, _, _ in found]
    duplicates = {v for v in versions if versions.count(v) > 1}
    if duplicates:
        raise RuntimeError(f"Duplicate migration version(s): {sorted(duplicates)}")
    return found


def status() -> tuple[list[str], list[str]]:
    """(applied, pending) version lists, and a hard error on any drift."""
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(_TRACKING_TABLE)
            conn.commit()
            cur.execute("SELECT version, checksum FROM platform.schema_migration")
            recorded = {row["version"]: row["checksum"] for row in cur.fetchall()}

    applied: list[str] = []
    pending: list[str] = []
    for version, _name, path in _discover():
        if version in recorded:
            on_disk = _checksum(path.read_text(encoding="utf-8"))
            if on_disk != recorded[version]:
                raise RuntimeError(
                    f"Migration {path.name} has changed since it was applied "
                    f"(recorded {recorded[version][:12]}, on disk {on_disk[:12]}). "
                    f"Migrations are immutable once applied - add a new one instead."
                )
            applied.append(version)
        else:
            pending.append(version)
    return applied, pending


def apply_pending() -> int:
    """Apply every pending migration. Returns how many ran."""
    applied, pending = status()
    log.info("Migrations: %d applied, %d pending.", len(applied), len(pending))
    if not pending:
        return 0

    by_version = {v: (n, p) for v, n, p in _discover()}
    ran = 0
    for version in pending:
        name, path = by_version[version]
        body = path.read_text(encoding="utf-8")
        log.info("Applying %s (%s) ...", version, name)
        # One transaction per migration: a failure leaves the database on the
        # last good version rather than half-way through this one.
        with connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT clock_timestamp() AS t")
                started = cur.fetchone()["t"]
                cur.execute(body)
                cur.execute("SELECT clock_timestamp() AS t")
                duration_ms = int(
                    (cur.fetchone()["t"] - started).total_seconds() * 1000
                )
                cur.execute(
                    """INSERT INTO platform.schema_migration
                           (version, name, checksum, duration_ms)
                       VALUES (%s, %s, %s, %s)""",
                    (version, name, _checksum(body), duration_ms),
                )
            conn.commit()
        log.info("Applied %s in %d ms.", version, duration_ms)
        ran += 1
    return ran


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
    )
    parser = argparse.ArgumentParser(description="Apply versioned SQL migrations.")
    parser.add_argument(
        "--status", action="store_true", help="Report state and apply nothing."
    )
    args = parser.parse_args(argv)

    try:
        if args.status:
            applied, pending = status()
            print(f"applied: {', '.join(applied) or '(none)'}")
            print(f"pending: {', '.join(pending) or '(none)'}")
            return 0
        apply_pending()
        return 0
    except Exception as exc:  # noqa: BLE001 - top level, report and fail
        log.error("Migration failed: %s", exc)
        return 1


if __name__ == "__main__":
    sys.exit(main())
