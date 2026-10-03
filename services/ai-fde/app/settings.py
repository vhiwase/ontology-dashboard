"""Platform settings an administrator changed in the admin console.

The ontology service owns the admin console and writes platform.app_setting
(migration 0035); this service only reads it. A key with no row is "not set by
an administrator", and the caller falls back to its environment variable - so
.env keeps working exactly as before, and a database that predates the
migration simply reads as "nothing set".

Read through a short cache: the chat route consults the prices and the credit
default on every turn, and a setting changed in the console reaching this
service within a few seconds is good enough for both.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

import psycopg
from psycopg.rows import dict_row

from .config import CONFIG

log = logging.getLogger("ai_fde.settings")

TTL_SECONDS = 15.0

_lock = threading.Lock()
_cache: tuple[float, dict[str, Any]] | None = None


def _load() -> dict[str, Any]:
    try:
        with psycopg.connect(CONFIG.database_url, row_factory=dict_row, connect_timeout=5) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT key, value FROM platform.app_setting")
                return {row["key"]: row["value"] for row in cur.fetchall()}
    except psycopg.errors.UndefinedTable:
        return {}
    except psycopg.Error as exc:
        # Never fail a turn over settings: the environment is a complete
        # configuration on its own, which is what this falls back to.
        log.warning("Could not read platform settings; using the environment: %s", exc)
        return {}


def all_settings() -> dict[str, Any]:
    """Every setting an administrator has set, keyed by name."""
    global _cache
    with _lock:
        if _cache is not None and time.monotonic() - _cache[0] < TTL_SECONDS:
            return _cache[1]
    values = _load()
    with _lock:
        _cache = (time.monotonic(), values)
    return values


def get(key: str, default: Any = None) -> Any:
    return all_settings().get(key, default)


def number(key: str) -> float | None:
    """A numeric setting, or None when it is not set (or not a number)."""
    value = get(key)
    # bool is an int in Python; a stray true must not read as 1.
    if type(value) in (int, float):
        return float(value)
    return None


def prime(values: dict[str, Any]) -> None:
    """Hold these values as the settings, without reading the database.

    For tests, which have no database: they state the settings they need.
    """
    global _cache
    with _lock:
        _cache = (float("inf"), dict(values))


def clear_cache() -> None:
    global _cache
    with _lock:
        _cache = None
