"""Rows from the store are dicts, and must be read as dicts.

connect() sets row_factory=dict_row, so `row[0]` raises KeyError rather than
returning the first column. That failure mode is nastier than it sounds: it
only fires on a code path that actually finds a row, so session_space()
indexing positionally worked for every NEW conversation and broke every
SECOND message in an existing one — reported as "I am not able to run second
query", with a 500 and no clue in the UI.

A static check rather than a database test: the whole ai-fde suite runs
without a database, and the mistake is visible in the source.
"""

from __future__ import annotations

import ast
import os
from pathlib import Path

os.environ.setdefault("DATABASE_URL", "postgresql://unused:unused@127.0.0.1:1/unused")

STORE = Path(__file__).resolve().parents[1] / "app" / "store.py"


def _positional_row_reads() -> list[str]:
    """Find `<name>[0]` where <name> looks like a fetched row."""
    tree = ast.parse(STORE.read_text(encoding="utf-8"))

    # Names bound from a fetchone()/fetchall() call, which are the ones that
    # hold dict rows.
    row_names: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign) or not isinstance(node.value, ast.Call):
            continue
        called = getattr(node.value.func, "attr", "")
        if called not in {"fetchone", "fetchall"}:
            continue
        for target in node.targets:
            if isinstance(target, ast.Name):
                row_names.add(target.id)

    offenders = []
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Subscript)
            and isinstance(node.value, ast.Name)
            and node.value.id in row_names
            and isinstance(node.slice, ast.Constant)
            and isinstance(node.slice.value, int)
        ):
            offenders.append(f"{node.value.id}[{node.slice.value}] on line {node.lineno}")
    return offenders


def test_rows_are_never_indexed_by_position():
    offenders = _positional_row_reads()
    assert not offenders, (
        "store.py reads a fetched row by position, but connect() uses "
        "row_factory=dict_row, so this raises KeyError at runtime: "
        + "; ".join(offenders)
    )


def test_the_check_can_see_fetched_rows():
    """Guards the guard: if nothing is recognised, the test above proves nothing."""
    source = STORE.read_text(encoding="utf-8")
    assert "fetchone()" in source
    assert "row_factory=dict_row" in source
