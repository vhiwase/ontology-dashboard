"""The ontology a pipeline publishes must not overwrite another space's.

Every table the pipeline writes the ontology into is scoped — by space, or by
the ontology version which is itself scoped to a space. If an upsert conflicts
on the RID alone, Postgres finds the OTHER space's row and updates it, quietly
moving that row onto this run's version. That is not a hypothetical: publishing
into staging emptied the sandbox's Object Types page, because object_type was
keyed on `object_type_rid` alone and the upsert conflicted on it.

These read the pipeline's own source rather than a database, so they run in the
same suite as everything else and still fail the moment a conflict target
loses its scoping column.
"""

from __future__ import annotations

import ast
import os
from pathlib import Path

os.environ.setdefault("DATABASE_URL", "postgresql://unused:unused@127.0.0.1:1/unused")

PIPELINE = Path(__file__).resolve().parents[1] / "pipeline"

# table -> the column that must appear in its ON CONFLICT target.
SCOPED_TABLES = {
    "platform.object_type": "ontology_version_id",
    "platform.object_property": "ontology_version_id",
    "platform.link_type": "ontology_version_id",
    "platform.action_type": "ontology_version_id",
    "platform.kpi_definition": "space_id",
    "platform.lineage_node": "space_id",
    "platform.lineage_edge": "space_id",
    "platform.lineage_column": "space_id",
}


def _upserts() -> list[tuple[str, str, list[str]]]:
    """(module, table, conflict columns) for every upsert_many call."""
    found = []
    for path in sorted(PIPELINE.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            name = getattr(node.func, "id", None) or getattr(node.func, "attr", None)
            if name != "upsert_many" or len(node.args) < 4:
                continue
            table = node.args[1]
            conflict = node.args[4] if len(node.args) > 4 else None
            if not isinstance(table, ast.Constant):
                continue
            columns = (
                [c.value for c in conflict.elts if isinstance(c, ast.Constant)]
                if isinstance(conflict, (ast.List, ast.Tuple))
                else []
            )
            found.append((path.name, table.value, columns))
    return found


def test_every_scoped_table_is_written_somewhere():
    """Guards the test itself: a renamed table would silently check nothing."""
    written = {table for _, table, _ in _upserts()}
    missing = set(SCOPED_TABLES) - written
    assert not missing, f"no upsert found for {sorted(missing)} - has it been renamed?"


def test_conflict_targets_carry_their_scope():
    offenders = [
        (module, table, columns)
        for module, table, columns in _upserts()
        if table in SCOPED_TABLES and SCOPED_TABLES[table] not in columns
    ]
    assert not offenders, (
        "These upserts conflict on a key that is not scoped, so a publish into "
        "one space would update another space's rows: "
        + "; ".join(f"{m}: {t} ON CONFLICT {c}" for m, t, c in offenders)
    )


def test_lineage_is_not_truncated():
    """TRUNCATE on a lineage table wipes every space, not just this one."""
    source = (PIPELINE / "lineage_gen.py").read_text(encoding="utf-8")
    assert "truncate(" not in source, (
        "lineage_gen must delete per space (delete_for_space), not TRUNCATE: "
        "truncating removes every other space's graph."
    )
