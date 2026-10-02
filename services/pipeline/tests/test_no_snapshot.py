"""Starting without the TMS snapshot.

A clean clone of this repository has no captured payloads. The pipeline must
not fail on that - the bootstrap would stop before seeding users and nothing
downstream would start - unless the deployment says the snapshot is required.
"""

from __future__ import annotations

import dataclasses
import os

os.environ.setdefault("DATABASE_URL", "postgresql://unused:unused@127.0.0.1:1/unused")

from pipeline import run as run_module  # noqa: E402


def _with_config(monkeypatch, **changes):
    monkeypatch.setattr(run_module, "CONFIG", dataclasses.replace(run_module.CONFIG, **changes))


def _no_database(*_args, **_kwargs):
    raise AssertionError("no database work should happen without a snapshot")


def test_missing_snapshot_is_not_a_failure(monkeypatch, tmp_path):
    _with_config(monkeypatch, source_dir=str(tmp_path / "absent"), require_snapshot=False)
    monkeypatch.setattr(run_module, "connect", _no_database)
    assert run_module.main([]) == 0


def test_missing_snapshot_fails_when_required(monkeypatch, tmp_path):
    _with_config(monkeypatch, source_dir=str(tmp_path / "absent"), require_snapshot=True)
    monkeypatch.setattr(run_module, "connect", _no_database)
    assert run_module.main([]) == 1


def test_snapshot_detection(tmp_path):
    assert run_module.snapshot_available(str(tmp_path))
    assert not run_module.snapshot_available(str(tmp_path / "absent"))
