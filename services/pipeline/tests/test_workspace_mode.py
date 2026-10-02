"""Starting without the TMS snapshot, and replaying db/init on a fresh volume.

Two regressions are pinned here, both of which stopped a clean clone of this
repository from coming up at all:

  * the pipeline raised when PIPELINE_SOURCE_DIR was missing, so the ontology
    service never saw a published ontology and nothing downstream started;
  * db/init/05_kpi_views.sql selected columns 04_views.sql had already dropped
    (is_on_time, total_cost), so a fresh Postgres volume failed initialisation.

The first set runs anywhere. The second needs a database: set
TEST_DATABASE_URL to a role that may CREATE DATABASE (the tests create and drop
their own scratch databases and never touch the one named in the URL).
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path

import pytest

os.environ.setdefault("DATABASE_URL", "postgresql://unused:unused@127.0.0.1:1/unused")

from pipeline import run as run_module  # noqa: E402
from pipeline.workspace import WORKSPACE_ONTOLOGY_ID, empty_definition  # noqa: E402

REPO = Path(__file__).resolve().parents[3]
INIT_DIR = REPO / "db" / "init"
MIGRATIONS_DIR = REPO / "db" / "migrations"
TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL", "").strip()

needs_database = pytest.mark.skipif(
    not TEST_DATABASE_URL, reason="TEST_DATABASE_URL is not set"
)


# ── no database needed ──────────────────────────────────────────────────────


def test_empty_definition_is_a_complete_ontology_document() -> None:
    doc = empty_definition("Workspace", "Nothing yet.")
    assert doc["@type"] == "Ontology"
    assert doc["@id"] == WORKSPACE_ONTOLOGY_ID
    # Every collection the ontology service and the exporters iterate over is
    # present and empty, rather than missing.
    for key in ("entityTypes", "eventTypes", "relationTypes", "attributes", "constraints",
                "actionTypes", "interfaces", "valueTypes"):
        assert doc[key] == [], key
    # Roles are kept: a user's ontology_role has to resolve in every space.
    assert {role["@id"] for role in doc["roles"]} >= {"tms:AdminRole", "tms:AnalystRole"}


def test_empty_definition_generates_nothing() -> None:
    """The fallback publishes structure only, never rows or metrics."""
    doc = empty_definition("Workspace", "Nothing yet.")
    assert "kpis" not in doc
    assert all(not doc[key] for key in ("entityTypes", "relationTypes", "attributes"))


class _FakeConn:
    def close(self) -> None:
        self.closed = True


def _patch_startup(monkeypatch: pytest.MonkeyPatch, source_dir: str, require: bool) -> list[str]:
    calls: list[str] = []
    config = run_module.CONFIG
    monkeypatch.setattr(run_module, "CONFIG", type(config)(
        **{**config.__dict__, "source_dir": source_dir, "require_snapshot": require}
    ))
    monkeypatch.setattr(run_module, "connect", lambda: _FakeConn())
    monkeypatch.setattr(run_module, "_assert_schema_ready", lambda conn: None)

    def fake_workspace(conn, dry_run):
        calls.append(f"workspace dry_run={dry_run}")
        return 0

    monkeypatch.setattr(run_module, "run_workspace_mode", fake_workspace)

    def refuse(*_args, **_kwargs):  # the TMS path must not be reached
        raise AssertionError("the TMS pipeline ran without a snapshot")

    monkeypatch.setattr(run_module, "query_one", refuse)
    return calls


def test_missing_snapshot_starts_an_empty_workspace(monkeypatch, tmp_path) -> None:
    calls = _patch_startup(monkeypatch, str(tmp_path / "absent"), require=False)
    assert run_module.main([]) == 0
    assert calls == ["workspace dry_run=False"]


def test_missing_snapshot_honours_dry_run(monkeypatch, tmp_path) -> None:
    calls = _patch_startup(monkeypatch, str(tmp_path / "absent"), require=False)
    assert run_module.main(["--dry-run"]) == 0
    assert calls == ["workspace dry_run=True"]


def test_missing_snapshot_is_an_error_when_required(monkeypatch, tmp_path) -> None:
    calls = _patch_startup(monkeypatch, str(tmp_path / "absent"), require=True)
    assert run_module.main([]) == 1
    assert calls == []


def test_present_snapshot_takes_the_tms_path(monkeypatch, tmp_path) -> None:
    calls = _patch_startup(monkeypatch, str(tmp_path), require=False)
    with pytest.raises(AssertionError, match="TMS pipeline ran"):
        run_module.main([])
    assert calls == []


def test_snapshot_available_checks_for_a_directory(tmp_path) -> None:
    assert run_module.snapshot_available(str(tmp_path))
    assert not run_module.snapshot_available(str(tmp_path / "nope"))
    (tmp_path / "file.json").write_text("{}")
    assert not run_module.snapshot_available(str(tmp_path / "file.json"))


# ── against a real database ─────────────────────────────────────────────────


@pytest.fixture()
def scratch_database():
    """A brand-new database, dropped afterwards."""
    import psycopg
    from psycopg.conninfo import conninfo_to_dict, make_conninfo

    name = f"pipeline_test_{uuid.uuid4().hex[:10]}"
    admin = psycopg.connect(TEST_DATABASE_URL, autocommit=True)
    try:
        admin.execute(f'CREATE DATABASE "{name}" TEMPLATE template0 ENCODING \'UTF8\'')
        params = conninfo_to_dict(TEST_DATABASE_URL)
        params["dbname"] = name
        yield make_conninfo(**params)
    finally:
        admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        admin.close()


def _apply_init(url: str) -> None:
    import psycopg

    with psycopg.connect(url, autocommit=True) as conn:
        for path in sorted(INIT_DIR.glob("*.sql")):
            try:
                conn.execute(path.read_text(encoding="utf-8"))
            except psycopg.Error as exc:  # pragma: no cover - the failure is the point
                pytest.fail(f"{path.name} failed on a fresh database: {exc}")


@needs_database
def test_init_scripts_replay_on_a_fresh_volume(scratch_database) -> None:
    """Every db/init script applies in order, as the postgres entrypoint runs them."""
    _apply_init(scratch_database)


@needs_database
def test_migrations_apply_after_a_fresh_init(scratch_database, monkeypatch) -> None:
    _apply_init(scratch_database)
    monkeypatch.setenv("DATABASE_URL", scratch_database)
    import importlib

    from pipeline import config, db, migrate

    importlib.reload(config)
    importlib.reload(db)
    importlib.reload(migrate)
    monkeypatch.setattr(migrate, "MIGRATIONS_DIR", MIGRATIONS_DIR)
    assert migrate.apply_pending() == len(list(MIGRATIONS_DIR.glob("*.sql")))
    applied, pending = migrate.status()
    assert pending == [] and len(applied) > 0


@needs_database
def test_workspace_ontology_is_published_once_and_never_replaced(scratch_database) -> None:
    import psycopg
    from psycopg.rows import dict_row

    from pipeline.workspace import ensure_workspace_ontology

    _apply_init(scratch_database)
    with psycopg.connect(scratch_database, row_factory=dict_row) as conn:
        # 06_platform.sql predates spaces; the migrations add them. Only the
        # columns this module needs are created here, so the test does not
        # depend on the whole migration chain.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS platform.space (
                space_id BIGSERIAL PRIMARY KEY, slug TEXT UNIQUE NOT NULL);
            INSERT INTO platform.space (slug) VALUES ('sandbox') ON CONFLICT DO NOTHING;
            ALTER TABLE platform.ontology_version ADD COLUMN IF NOT EXISTS space_id BIGINT;
            DROP INDEX IF EXISTS platform.ux_ontology_single_active;
            """
        )
        first = ensure_workspace_ontology(conn, "sandbox")
        second = ensure_workspace_ontology(conn, "sandbox")
        assert first["published"] is True
        assert second["published"] is False
        assert second["ontologyVersionId"] == first["ontologyVersionId"]
        count = conn.execute(
            "SELECT count(*) AS n FROM platform.ontology_version WHERE is_active"
        ).fetchone()
        assert count["n"] == 1
        definition = conn.execute(
            "SELECT definition FROM platform.ontology_version WHERE ontology_version_id = %s",
            (first["ontologyVersionId"],),
        ).fetchone()["definition"]
        assert definition["entityTypes"] == []
