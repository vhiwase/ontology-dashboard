"""Token verification for the assistant API.

The ontology service issues the tokens; this service only verifies them, using
the same AUTH_JWT_SECRET. There is no login endpoint here, so there is exactly
one place that can mint a credential.

Verification is stateless apart from a short-lived check of app_user, which is
what makes a revocation or a role change take effect before the token expires.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Any

import psycopg
from fastapi import Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from psycopg.rows import dict_row

from .config import CONFIG
from .config import _secret as config_secret
from .context import current_token

log = logging.getLogger("ai-fde.auth")

ROLE_RANK = {"viewer": 1, "analyst": 2, "admin": 3}


def _read_secret() -> str:
    """The shared signing secret, from a Docker secret file or the environment.

    A service that starts without one would accept unsigned traffic, so it
    refuses to start instead.
    """
    value = config_secret("AUTH_JWT_SECRET")
    if len(value) < 32:
        raise RuntimeError(
            "AUTH_JWT_SECRET must be set to at least 32 characters. "
            "Generate one with: openssl rand -base64 48"
        )
    return value


SECRET = _read_secret()
USER_CACHE_TTL = float(os.environ.get("AUTH_USER_CACHE_TTL_MS", "30000")) / 1000.0


@dataclass(frozen=True)
class Principal:
    """Who the caller is, as two separate role concepts.

    `role` is the platform access tier and decides which routes are reachable.
    `ontology_role` is the business hat declared in the generated ontology and
    decides which actions AccessController will permit. Both come from
    app_user; neither is derived from the other, because a dispatcher and a
    finance user share a platform tier but not a set of executable actions.
    """

    user_id: int
    username: str
    role: str
    ontology_role: str


def _b64url_decode(segment: str) -> bytes:
    # JWT strips base64 padding; put it back before decoding.
    return base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))


def verify_token(token: str) -> dict[str, Any] | None:
    """Check signature and expiry. Returns the claims, or None if unusable."""
    parts = token.split(".")
    if len(parts) != 3:
        return None
    body = f"{parts[0]}.{parts[1]}".encode("ascii")

    expected = (
        base64.urlsafe_b64encode(hmac.new(SECRET.encode(), body, hashlib.sha256).digest())
        .rstrip(b"=")
        .decode()
    )
    if not hmac.compare_digest(expected, parts[2]):
        return None

    try:
        claims = json.loads(_b64url_decode(parts[1]))
    except (ValueError, TypeError):
        return None

    if not isinstance(claims, dict):
        return None
    exp = claims.get("exp")
    if not isinstance(exp, (int, float)) or exp <= time.time():
        return None
    if claims.get("role") not in ROLE_RANK:
        return None
    return claims


# ── user state, cached briefly ──────────────────────────────────────────────

_user_cache: dict[int, tuple[float, dict[str, Any] | None]] = {}


def _current_user(uid: int) -> dict[str, Any] | None:
    cached = _user_cache.get(uid)
    if cached and time.monotonic() - cached[0] < USER_CACHE_TTL:
        return cached[1]

    row: dict[str, Any] | None = None
    try:
        # CONFIG.database_url, not os.environ: the DSN arrives as a Docker
        # secret file (DATABASE_URL_FILE), so the plain variable is not set.
        with psycopg.connect(
            CONFIG.database_url, row_factory=dict_row, connect_timeout=5
        ) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT role, ontology_role, token_version, is_active "
                    "FROM platform.app_user WHERE app_user_id = %s",
                    (uid,),
                )
                row = cur.fetchone()
    except psycopg.Error as exc:
        # Fail closed. If the user table cannot be read we cannot know whether
        # this token was revoked, and guessing in the permissive direction is
        # what turns an outage into an authorisation bypass.
        log.error("Could not verify user %s against the database: %s", uid, exc)
        raise HTTPException(status_code=503, detail="Authorisation store unavailable.")

    _user_cache[uid] = (time.monotonic(), row)
    return row


def clear_user_cache() -> None:
    _user_cache.clear()


# ── FastAPI dependency ──────────────────────────────────────────────────────


async def _principal_from(request: Request) -> Principal:
    """Resolve the caller, and publish their token for downstream calls.

    This is async on purpose. FastAPI runs a *sync* dependency in a worker
    thread via run_in_threadpool, and a ContextVar set inside that thread is
    set on a copy of the context: it is discarded when the thread returns, so
    the token never reached the ontology client and every tool call came back
    401. An async dependency runs in the request's own task, where the set
    sticks. The one blocking call here is pushed to a thread explicitly.
    """
    header = request.headers.get("authorization", "")
    token = header[7:].strip() if header.startswith("Bearer ") else ""
    if not token:
        raise HTTPException(status_code=401, detail="Authentication required.")

    claims = verify_token(token)
    if claims is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token.")

    user = await run_in_threadpool(_current_user, int(claims["uid"]))
    if (
        user is None
        or not user["is_active"]
        or user["token_version"] != claims.get("tv")
    ):
        raise HTTPException(status_code=401, detail="Invalid or expired token.")

    # The assistant queries the ontology as the caller, not as a service
    # account, so the caller's own permissions apply to whatever it reads.
    current_token.set(token)

    # The database wins on role, so a demotion lands within the cache TTL
    # rather than at token expiry.
    return Principal(
        user_id=int(claims["uid"]),
        username=str(claims["sub"]),
        role=user["role"],
        ontology_role=user["ontology_role"],
    )


def require_role(minimum: str):
    """Dependency factory: admits `minimum` and anything above it."""

    async def dependency(request: Request) -> Principal:
        principal = await _principal_from(request)
        if ROLE_RANK[principal.role] < ROLE_RANK[minimum]:
            raise HTTPException(status_code=403, detail=f"Requires the {minimum} role.")
        return principal

    return dependency


RequireViewer = Depends(require_role("viewer"))
RequireAnalyst = Depends(require_role("analyst"))
RequireAdmin = Depends(require_role("admin"))
