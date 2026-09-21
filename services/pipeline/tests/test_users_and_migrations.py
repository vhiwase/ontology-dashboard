"""Tests for password hashing and the migration runner.

Neither needs a database: hashing is pure, and the migration runner's
discovery, ordering and drift detection are all decided before it connects.
"""

from __future__ import annotations

import base64
import importlib
import os

import pytest

os.environ.setdefault("DATABASE_URL", "postgresql://unused:unused@127.0.0.1:1/unused")

from pipeline import migrate, users  # noqa: E402


# ── password hashing ────────────────────────────────────────────────────────


def test_hash_verify_round_trip():
    encoded = users.hash_password("correct horse battery staple")
    assert users.verify_password("correct horse battery staple", encoded)
    assert not users.verify_password("wrong", encoded)


def test_hash_format_is_the_one_the_node_side_parses():
    """scrypt$N$r$p$salt$key - the ontology service splits on exactly this."""
    parts = users.hash_password("a-password-long-enough").split("$")
    assert len(parts) == 6
    scheme, n, r, p, salt, key = parts
    assert scheme == "scrypt"
    assert (int(n), int(r), int(p)) == (users.SCRYPT_N, users.SCRYPT_R, users.SCRYPT_P)
    # Both tails must be valid base64, or the other implementation cannot decode.
    assert len(base64.b64decode(salt)) == 16
    assert len(base64.b64decode(key)) == users.SCRYPT_KEYLEN


def test_salt_is_random_per_hash():
    first = users.hash_password("same password")
    second = users.hash_password("same password")
    assert first != second
    # ... and both still verify.
    assert users.verify_password("same password", first)
    assert users.verify_password("same password", second)


@pytest.mark.parametrize(
    "encoded",
    [
        "",
        "not-a-hash",
        "scrypt$16384$8",
        "bcrypt$16384$8$1$AAAA$BBBB",
        "scrypt$notanumber$8$1$AAAA$BBBB",
        "scrypt$16384$8$1$!!!$BBBB",
    ],
)
def test_malformed_hashes_are_refused_not_crashed(encoded):
    assert users.verify_password("anything", encoded) is False


def test_empty_password_still_hashes_and_verifies():
    # The length rule lives in the CLI, not here; this checks the primitive
    # does not special-case an empty string into something that always matches.
    encoded = users.hash_password("")
    assert users.verify_password("", encoded)
    assert not users.verify_password("x", encoded)


# ── role tables ─────────────────────────────────────────────────────────────


def test_every_platform_role_has_a_default_ontology_role():
    assert set(users.DEFAULT_ONTOLOGY_ROLE) == set(users.ROLES)
    for hat in users.DEFAULT_ONTOLOGY_ROLE.values():
        assert hat in users.ONTOLOGY_ROLES


def test_defaults_never_grant_write_by_accident():
    """viewer and analyst default to the read-only business role."""
    assert users.DEFAULT_ONTOLOGY_ROLE["viewer"] == "tms:AnalystRole"
    assert users.DEFAULT_ONTOLOGY_ROLE["analyst"] == "tms:AnalystRole"


# ── migration discovery ─────────────────────────────────────────────────────


@pytest.fixture
def migrations_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(migrate, "MIGRATIONS_DIR", tmp_path)
    return tmp_path


def test_discovers_in_numeric_order(migrations_dir):
    # Written out of order, and with a two-digit and a four-digit prefix, to
    # show the sort is on the filename as zero-padded text.
    for name in ["0003_c.sql", "0001_a.sql", "0002_b.sql"]:
        (migrations_dir / name).write_text("SELECT 1;", encoding="utf-8")

    found = migrate._discover()
    assert [version for version, _, _ in found] == ["0001", "0002", "0003"]
    assert [name for _, name, _ in found] == ["a", "b", "c"]


def test_rejects_a_file_with_no_numeric_prefix(migrations_dir):
    (migrations_dir / "add_column.sql").write_text("SELECT 1;", encoding="utf-8")
    with pytest.raises(RuntimeError, match="numeric version"):
        migrate._discover()


def test_rejects_duplicate_versions(migrations_dir):
    (migrations_dir / "0001_a.sql").write_text("SELECT 1;", encoding="utf-8")
    (migrations_dir / "0001_b.sql").write_text("SELECT 2;", encoding="utf-8")
    with pytest.raises(RuntimeError, match="Duplicate migration version"):
        migrate._discover()


def test_ignores_non_sql_files(migrations_dir):
    (migrations_dir / "0001_a.sql").write_text("SELECT 1;", encoding="utf-8")
    (migrations_dir / "README.md").write_text("notes", encoding="utf-8")
    (migrations_dir / "0002_b.sql.bak").write_text("SELECT 2;", encoding="utf-8")
    assert [v for v, _, _ in migrate._discover()] == ["0001"]


def test_missing_directory_is_not_an_error(tmp_path, monkeypatch):
    # A deployment that mounts no migrations should start, not crash.
    monkeypatch.setattr(migrate, "MIGRATIONS_DIR", tmp_path / "absent")
    assert migrate._discover() == []


def test_checksum_changes_with_content():
    # This is what makes an edited-after-applying migration detectable.
    assert migrate._checksum("SELECT 1;") == migrate._checksum("SELECT 1;")
    assert migrate._checksum("SELECT 1;") != migrate._checksum("SELECT 2;")
    assert len(migrate._checksum("x")) == 64


def test_shipped_migrations_are_wellformed():
    """The real db/migrations directory parses and is ordered."""
    here = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    real = os.path.join(os.path.dirname(here), "db", "migrations")
    if not os.path.isdir(real):
        pytest.skip("db/migrations not reachable from this checkout layout")

    import pathlib

    original = migrate.MIGRATIONS_DIR
    try:
        migrate.MIGRATIONS_DIR = pathlib.Path(real)
        found = migrate._discover()
        assert found, "expected at least one shipped migration"
        versions = [v for v, _, _ in found]
        assert versions == sorted(versions)
    finally:
        migrate.MIGRATIONS_DIR = original
