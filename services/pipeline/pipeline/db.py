"""Postgres helpers.

Thin wrappers over psycopg 3 so the rest of the pipeline reads as data flow
rather than cursor bookkeeping.
"""

from __future__ import annotations

import logging
import time
from contextlib import contextmanager
from typing import Any, Iterable, Iterator, Sequence

import psycopg
from psycopg import sql
from psycopg.rows import dict_row

from .config import CONFIG

log = logging.getLogger("pipeline.db")


def connect(autocommit: bool = False) -> psycopg.Connection:
    """Open a connection, waiting for Postgres to accept us.

    The pipeline starts as soon as the healthcheck passes, which can still be a
    beat before the init scripts have finished replaying, so a short retry loop
    here saves a spurious failed run.
    """
    last_error: Exception | None = None
    for attempt in range(1, 31):
        try:
            conn = psycopg.connect(CONFIG.database_url, row_factory=dict_row)
            conn.autocommit = autocommit
            return conn
        except psycopg.OperationalError as exc:  # not up yet
            last_error = exc
            if attempt == 1:
                log.info("Waiting for Postgres at %s ...", _safe_dsn())
            time.sleep(2)
    raise RuntimeError(f"Postgres never became reachable: {last_error}")


def _safe_dsn() -> str:
    """The DSN with the password removed, for logging."""
    dsn = CONFIG.database_url
    if "@" not in dsn:
        return dsn
    head, tail = dsn.split("@", 1)
    if ":" in head:
        scheme_user = head.rsplit(":", 1)[0]
        return f"{scheme_user}:***@{tail}"
    return dsn


@contextmanager
def cursor(conn: psycopg.Connection) -> Iterator[psycopg.Cursor]:
    cur = conn.cursor()
    try:
        yield cur
    finally:
        cur.close()


def query(conn: psycopg.Connection, statement: str, params: Sequence[Any] | None = None) -> list[dict]:
    with cursor(conn) as cur:
        cur.execute(statement, params)
        return list(cur.fetchall())


def query_one(conn: psycopg.Connection, statement: str, params: Sequence[Any] | None = None) -> dict | None:
    rows = query(conn, statement, params)
    return rows[0] if rows else None


def scalar(conn: psycopg.Connection, statement: str, params: Sequence[Any] | None = None) -> Any:
    row = query_one(conn, statement, params)
    if row is None:
        return None
    return next(iter(row.values()))


def execute(conn: psycopg.Connection, statement: str, params: Sequence[Any] | None = None) -> int:
    with cursor(conn) as cur:
        cur.execute(statement, params)
        return cur.rowcount


def upsert_many(
    conn: psycopg.Connection,
    table: str,
    columns: Sequence[str],
    rows: Iterable[Sequence[Any]],
    conflict_columns: Sequence[str] | None = None,
    update_columns: Sequence[str] | None = None,
    chunk_size: int = 500,
) -> int:
    """Bulk INSERT ... ON CONFLICT, batched into multi-row VALUES statements.

    Deliberately not executemany: psycopg sends one round trip per row, and when
    the pipeline runs against a port forwarded off a Docker Desktop VM each of
    those costs a few hundred milliseconds. Landing the snapshot that way took
    over two minutes; folding the rows into chunked multi-row INSERTs brings the
    same work down to a couple of seconds by cutting ~360 round trips to ~15.
    """
    rows = list(rows)
    if not rows:
        return 0

    schema, _, name = table.partition(".")
    target = sql.Identifier(schema, name) if name else sql.Identifier(schema)
    col_idents = sql.SQL(", ").join(sql.Identifier(c) for c in columns)
    width = len(columns)

    conflict_clause = sql.SQL("")
    if conflict_columns:
        conflict = sql.SQL(", ").join(sql.Identifier(c) for c in conflict_columns)
        resolved = update_columns
        if resolved is None:
            resolved = [c for c in columns if c not in conflict_columns]
        if resolved:
            assignments = sql.SQL(", ").join(
                sql.SQL("{col} = EXCLUDED.{col}").format(col=sql.Identifier(c))
                for c in resolved
            )
            conflict_clause = sql.SQL(
                " ON CONFLICT ({conflict}) DO UPDATE SET {assignments}"
            ).format(conflict=conflict, assignments=assignments)
        else:
            conflict_clause = sql.SQL(" ON CONFLICT ({conflict}) DO NOTHING").format(
                conflict=conflict
            )

    row_template = sql.SQL("({})").format(sql.SQL(", ").join(sql.Placeholder() * width))

    landed = 0
    with cursor(conn) as cur:
        for start in range(0, len(rows), chunk_size):
            chunk = rows[start : start + chunk_size]
            statement = (
                sql.SQL("INSERT INTO {target} ({cols}) VALUES ").format(
                    target=target, cols=col_idents
                )
                + sql.SQL(", ").join([row_template] * len(chunk))
                + conflict_clause
            )
            flat: list[Any] = []
            for row in chunk:
                if len(row) != width:
                    raise ValueError(
                        f"{table}: row has {len(row)} values but {width} columns were named"
                    )
                flat.extend(row)
            cur.execute(statement, flat)
            landed += len(chunk)
    return landed


def truncate(conn: psycopg.Connection, tables: Sequence[str]) -> None:
    """Empty the given tables, honouring FK order via CASCADE."""
    if not tables:
        return
    idents = sql.SQL(", ").join(
        sql.Identifier(*t.split(".")) if "." in t else sql.Identifier(t) for t in tables
    )
    with cursor(conn) as cur:
        cur.execute(sql.SQL("TRUNCATE {tables} CASCADE").format(tables=idents))


def table_exists(conn: psycopg.Connection, schema: str, name: str) -> bool:
    return bool(
        scalar(
            conn,
            """
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = %s AND table_name = %s
            """,
            (schema, name),
        )
    )


def count_rows(conn: psycopg.Connection, qualified: str) -> int:
    schema, _, name = qualified.partition(".")
    statement = sql.SQL("SELECT count(*) AS n FROM {}").format(sql.Identifier(schema, name))
    with cursor(conn) as cur:
        cur.execute(statement)
        row = cur.fetchone()
    return int(row["n"]) if row else 0
