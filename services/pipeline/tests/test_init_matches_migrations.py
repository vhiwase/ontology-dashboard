"""Init scripts must agree with the migrations that run after them.

The failure this guards: db/init runs ONLY when the Postgres data directory is
empty, so init is always followed by every migration. A fresh volume ran
05_kpi_views.sql, which still defined v_kpi_account_scorecard - a view
migration 0018 had dropped and nothing rebuilt - and the init failed on the
withdrawn is_on_time column. The half-built schema then came up "healthy"
(with the trap 07_verify.sql documents) and the pipeline refused to start.

Parsing SQL with regex is not schema analysis, but the drift itself is
textual: a view defined in init and dropped-and-never-rebuilt by the
migrations is exactly the bug, and this catches it without a database.
"""

from __future__ import annotations

import re
from pathlib import Path

DB_DIR = Path(__file__).resolve().parents[3] / "db"

CREATE_VIEW = re.compile(r"CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+([\w.]+)", re.IGNORECASE)
DROP_VIEW = re.compile(r"DROP\s+VIEW\s+(?:IF\s+EXISTS\s+)?([\w.]+)", re.IGNORECASE)


def _bare(name: str) -> str:
    """tms_views.v_order and v_order are the same view; compare them so."""
    return name.strip().lower().split(".")[-1]


def _init_views() -> set[str]:
    views: set[str] = set()
    for path in sorted(DB_DIR.joinpath("init").glob("*.sql")):
        for match in CREATE_VIEW.finditer(path.read_text(encoding="utf-8")):
            views.add(_bare(match.group(1)))
    return views


def _views_dropped_by_migrations() -> set[str]:
    """Views removed by a migration and never recreated by a later one.

    Files run in filename order, so a DROP followed by a CREATE of the same
    view (0018 drops five core views and rebuilds them in the same file) is a
    replacement, not a removal.
    """
    dropped: set[str] = set()
    for path in sorted(DB_DIR.joinpath("migrations").glob("*.sql")):
        text = path.read_text(encoding="utf-8")
        for match in DROP_VIEW.finditer(text):
            dropped.add(_bare(match.group(1)))
        for match in CREATE_VIEW.finditer(text):
            dropped.discard(_bare(match.group(1)))
    return dropped


def _verify_script_views() -> set[str]:
    """The view names 07_verify.sql requires to exist."""
    text = (DB_DIR / "init" / "07_verify.sql").read_text(encoding="utf-8")
    block = re.search(r"expected_views TEXT\[\] := ARRAY\[(.*?)\];", text, re.S)
    assert block, "07_verify.sql no longer names its expected views"
    return {
        match.group(1).strip().lower()
        for match in re.finditer(r"'([\w]+)'", block.group(1))
    }


def test_no_init_view_is_dropped_and_never_rebuilt():
    init_views = _init_views()
    # Sanity: if the parser finds nothing, the checks below are vacuous.
    assert len(init_views) >= 20, f"Parsed {len(init_views)} views from init; the glob is wrong."
    stale = init_views & _views_dropped_by_migrations()
    assert not stale, (
        f"Init scripts define views the migrations withdraw and nothing rebuilds: "
        f"{sorted(stale)}. A fresh volume runs init and then every migration, so "
        "these either fail init (if their columns are gone) or resurrect withdrawn "
        "data. Remove them from init, or add a migration that rebuilds them."
    )


def test_withdrawn_scorecard_views_are_gone_from_init():
    for name in (
        "v_kpi_account_scorecard",
        "v_kpi_carrier_scorecard",
        "v_kpi_on_time_performance",
    ):
        assert name not in _init_views(), (
            f"{name} was withdrawn with the simulated execution data (0018) and "
            "must not come back through init."
        )


def test_verify_script_expects_only_views_that_exist():
    ghost = _verify_script_views() - _init_views()
    assert not ghost, (
        f"07_verify.sql demands views no init script creates: {sorted(ghost)}. "
        "It would fail every fresh volume."
    )


def test_verify_script_expects_every_view_init_creates():
    """The other direction: a view init creates but verify does not demand is
    one that could silently stop being created without anyone noticing."""
    missing = _init_views() - _verify_script_views()
    assert not missing, (
        f"Init scripts create views 07_verify.sql does not check for: "
        f"{sorted(missing)}. Add them to expected_views, or explain them with a "
        "comment beside the check."
    )
