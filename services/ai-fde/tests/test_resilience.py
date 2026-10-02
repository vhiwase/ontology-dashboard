"""What a long turn does when the model stops answering part way.

A build turn runs a dozen rounds and can cross the deployment's token rate
limit. The two properties pinned here: a 429 is waited out for as long as
Azure asks (within a bound), and when the model does fail, the reply still
says what was built before it did.
"""

from __future__ import annotations

import os

os.environ.setdefault("AUTH_JWT_SECRET", "test-secret-at-least-thirty-two-characters-long")
os.environ.setdefault("DATABASE_URL", "postgresql://unused:unused@127.0.0.1:1/unused")

import httpx  # noqa: E402

from app.agent import _summarise_changes  # noqa: E402
from app.llm import MAX_RETRY_WAIT_SECONDS, _retry_after_seconds  # noqa: E402


def _response(headers: dict[str, str]) -> httpx.Response:
    return httpx.Response(429, headers=headers)


def test_retry_waits_as_long_as_azure_asks():
    assert _retry_after_seconds(_response({"retry-after": "7"})) == 7
    assert _retry_after_seconds(_response({"retry-after-ms": "1500"})) == 1.5


def test_retry_wait_is_bounded_and_has_a_default():
    assert _retry_after_seconds(_response({"retry-after": "600"})) == MAX_RETRY_WAIT_SECONDS
    assert _retry_after_seconds(_response({})) == 5.0
    assert _retry_after_seconds(_response({"retry-after": "soon"})) == 5.0


def test_summary_lists_what_was_built():
    artifacts = [
        {"kind": "modeChange", "mode": "ontologyEditing"},
        {"kind": "ontologyChange", "change": "objectType", "apiName": "Transport", "detail": "61 objects"},
        {"kind": "ontologyChange", "change": "linkType", "apiName": "transportOrder", "detail": "61/61 resolve (100%)"},
        {"kind": "functionProposal", "function": {"apiName": "avgStopsPerTransport"}},
    ]
    summary = _summarise_changes(artifacts)
    assert "Created object type `Transport` (61 objects)" in summary
    assert "Linked `transportOrder`" in summary
    assert "`avgStopsPerTransport`, awaiting approval" in summary
    assert "modeChange" not in summary


def test_summary_is_empty_when_nothing_changed():
    assert _summarise_changes([{"kind": "chart", "series": []}]) == ""
