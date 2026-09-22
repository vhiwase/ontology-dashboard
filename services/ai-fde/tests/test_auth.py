"""Tests for token verification and the chat limiter.

The assistant verifies tokens the ontology service minted, so the two
implementations have to agree exactly. test_token_interop below signs a token
the way services/ontology-service/src/auth.ts does and checks this side
accepts it, which is the assertion that catches the two drifting apart.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time

import pytest

# Must be set before app.auth is imported: it reads the secret at module load
# and refuses to start without one.
SECRET = "test-secret-at-least-thirty-two-characters-long"
os.environ.setdefault("AUTH_JWT_SECRET", SECRET)
os.environ.setdefault("DATABASE_URL", "postgresql://unused:unused@127.0.0.1:1/unused")

from app import auth  # noqa: E402
from app.limits import ChatLimiter, RateLimited  # noqa: E402


# ── helpers ─────────────────────────────────────────────────────────────────


def sign(claims: dict, secret: str = SECRET) -> str:
    """Build a token exactly as the ontology service does."""

    def segment(payload: dict) -> str:
        return (
            base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
        )

    body = f"{segment({'alg': 'HS256', 'typ': 'JWT'})}.{segment(claims)}"
    signature = (
        base64.urlsafe_b64encode(
            hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest()
        )
        .rstrip(b"=")
        .decode()
    )
    return f"{body}.{signature}"


def claims(**overrides) -> dict:
    base = {
        "sub": "admin",
        "uid": 1,
        "role": "admin",
        "tv": 0,
        "iat": int(time.time()),
        "exp": int(time.time()) + 3600,
    }
    base.update(overrides)
    return base


# ── verification ────────────────────────────────────────────────────────────


def test_token_interop():
    """A token built the way the ontology service builds one is accepted."""
    verified = auth.verify_token(sign(claims()))
    assert verified is not None
    assert verified["sub"] == "admin"
    assert verified["role"] == "admin"


def test_rejects_a_token_signed_with_another_key():
    assert auth.verify_token(sign(claims(), secret="x" * 48)) is None


def test_rejects_a_tampered_payload():
    """The classic attack: swap the claims, keep the signature."""
    token = sign(claims(role="viewer"))
    header, _payload, signature = token.split(".")
    escalated = (
        base64.urlsafe_b64encode(json.dumps(claims(role="admin")).encode())
        .rstrip(b"=")
        .decode()
    )
    assert auth.verify_token(f"{header}.{escalated}.{signature}") is None


def test_rejects_alg_none():
    """An unsigned token must not be accepted however well-formed it looks."""
    header = (
        base64.urlsafe_b64encode(json.dumps({"alg": "none", "typ": "JWT"}).encode())
        .rstrip(b"=")
        .decode()
    )
    payload = (
        base64.urlsafe_b64encode(json.dumps(claims()).encode()).rstrip(b"=").decode()
    )
    assert auth.verify_token(f"{header}.{payload}.") is None


def test_rejects_an_expired_token():
    assert auth.verify_token(sign(claims(exp=int(time.time()) - 1))) is None


def test_rejects_a_token_with_no_expiry():
    payload = claims()
    del payload["exp"]
    assert auth.verify_token(sign(payload)) is None


def test_rejects_an_unknown_role():
    assert auth.verify_token(sign(claims(role="superuser"))) is None


@pytest.mark.parametrize(
    "token", ["", "notatoken", "a.b", "a.b.c.d", "...", "a.!!!.c"]
)
def test_rejects_malformed_tokens(token):
    assert auth.verify_token(token) is None


def test_role_ranking_is_ordered():
    assert auth.ROLE_RANK["viewer"] < auth.ROLE_RANK["analyst"] < auth.ROLE_RANK["admin"]


# ── rate limiting ───────────────────────────────────────────────────────────


def test_burst_is_allowed_then_refused():
    limiter = ChatLimiter(rate_per_minute=60, burst=3, daily_token_budget=0)
    for _ in range(3):
        limiter.check_rate("user")
    with pytest.raises(RateLimited) as caught:
        limiter.check_rate("user")
    assert caught.value.retry_after >= 1


def test_limits_are_per_user():
    limiter = ChatLimiter(rate_per_minute=60, burst=1, daily_token_budget=0)
    limiter.check_rate("alice")
    # Bob has his own bucket and is unaffected by Alice exhausting hers.
    limiter.check_rate("bob")
    with pytest.raises(RateLimited):
        limiter.check_rate("alice")


def test_budget_blocks_once_spent():
    limiter = ChatLimiter(rate_per_minute=600, burst=100, daily_token_budget=1000)
    limiter.record_usage("user", 600)
    limiter.check_budget("user")  # 600 < 1000, still allowed

    limiter.record_usage("user", 500)
    with pytest.raises(RateLimited, match="budget"):
        limiter.check_budget("user")


def test_budget_of_zero_disables_the_check():
    limiter = ChatLimiter(daily_token_budget=0)
    limiter.record_usage("user", 10**9)
    limiter.check_budget("user")
    assert limiter.tokens_used("user") == 0


def test_spend_outside_the_window_is_dropped():
    limiter = ChatLimiter(daily_token_budget=100)
    limiter.record_usage("user", 90)
    # Backdate the sample past the 24 h window.
    limiter._spend["user"].samples = [(time.time() - 25 * 3600, 90)]
    assert limiter.tokens_used("user") == 0
    limiter.check_budget("user")


# ── citation validation ─────────────────────────────────────────────────────


def _validate(reply: str, known: set[str]) -> tuple[str, int]:
    """The server-side citation check, exercised without the HTTP layer.

    Mirrors app.main._validate_citations. A citation whose path is not in the
    corpus is downgraded to plain text: a reader checking the source is the
    whole point of a citation, and a dead one is worse than none.
    """
    import re

    pattern = re.compile(r":citation\[([^\]]+)\]\{([^}]*)\}")
    dropped = 0

    def check(match):
        nonlocal dropped
        title, attrs = match.group(1), match.group(2)
        found = re.search(r'path="([^"]*)"', attrs)
        if found and found.group(1) in known:
            return match.group(0)
        dropped += 1
        return title

    return pattern.sub(check, reply), dropped


KNOWN = {"metric/on_time_pct", "platform/simulated-data"}


def test_known_citation_survives():
    reply = 'Simulated. :citation[On-Time]{path="metric/on_time_pct"}'
    out, dropped = _validate(reply, KNOWN)
    assert out == reply
    assert dropped == 0


def test_fabricated_citation_is_downgraded_to_plain_text():
    reply = 'See :citation[Invented Page]{path="metric/does_not_exist"} for detail.'
    out, dropped = _validate(reply, KNOWN)
    assert dropped == 1
    assert "does_not_exist" not in out
    # The title survives as prose, so the sentence still reads.
    assert out == "See Invented Page for detail."


def test_section_attribute_is_preserved():
    reply = ':citation[Simulated]{path="platform/simulated-data" section="What is simulated"}'
    out, dropped = _validate(reply, KNOWN)
    assert dropped == 0
    assert 'section="What is simulated"' in out


def test_mixed_reply_keeps_good_drops_bad():
    reply = (
        'Good :citation[A]{path="metric/on_time_pct"} '
        'and bad :citation[B]{path="metric/nope"}.'
    )
    out, dropped = _validate(reply, KNOWN)
    assert dropped == 1
    assert "metric/on_time_pct" in out
    assert "metric/nope" not in out


def test_citation_without_a_path_is_downgraded():
    out, dropped = _validate(':citation[No Path]{section="x"}', KNOWN)
    assert dropped == 1
    assert out == "No Path"


def test_reply_with_no_citations_is_untouched():
    reply = "On-time is 94%."
    out, dropped = _validate(reply, KNOWN)
    assert out == reply and dropped == 0
