"""Conversation persistence.

Chat history lives in Postgres rather than in memory so a conversation survives a
container restart, and so the tool calls behind every answer stay auditable: the
platform.chat_message rows record which ontology query produced the number the
assistant quoted.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import psycopg
from psycopg.rows import dict_row

from .config import CONFIG

log = logging.getLogger("ai_fde.store")

# How many prior turns are replayed to the model. Six user/assistant pairs is
# enough for "and now break that down by carrier" to work, without spending the
# context a local model needs for tool results.
HISTORY_TURNS = 12


def connect() -> psycopg.Connection:
    return psycopg.connect(CONFIG.database_url, row_factory=dict_row, autocommit=True)


def create_session(
    title: str | None,
    user_id: str,
    user_role: str,
    provider: str,
    model: str,
    space_slug: str = "sandbox",
) -> int:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO platform.chat_session
                (title, user_id, user_role, llm_provider, llm_model, space_id)
            VALUES (%s, %s, %s, %s, %s,
                    (SELECT space_id FROM platform.space WHERE slug = %s))
            RETURNING chat_session_id
            """,
            (title, user_id, user_role, provider, model, space_slug),
        )
        row = cur.fetchone()
    return int(row["chat_session_id"])


def list_sessions(
    owner: str | None, limit: int = 50, space_slug: str | None = None
) -> list[dict[str, Any]]:
    """Sessions belonging to `owner`, or every session when owner is None.

    A conversation can quote whatever the ontology holds, so one user's history
    is not another user's to read. Only an admin passes None.
    """
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT cs.chat_session_id, cs.title, cs.user_id, cs.user_role,
                   cs.llm_provider, cs.llm_model,
                   cs.message_count, cs.created_at, cs.updated_at
              FROM platform.chat_session cs
              JOIN platform.space sp ON sp.space_id = cs.space_id
             WHERE (%s::text IS NULL OR cs.user_id = %s)
               AND (%s::text IS NULL OR sp.slug = %s)
             ORDER BY cs.updated_at DESC LIMIT %s
            """,
            (owner, owner, space_slug, space_slug, limit),
        )
        return list(cur.fetchall())


def get_messages(session_id: int) -> list[dict[str, Any]]:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT chat_message_id, seq, role, content, tool_calls, tool_name,
                   tool_result, artifacts, latency_ms, token_usage, created_at
              FROM platform.chat_message
             WHERE chat_session_id = %s ORDER BY seq
            """,
            (session_id,),
        )
        return list(cur.fetchall())


def session_exists(session_id: int, owner: str | None = None) -> bool:
    """Whether the session exists and, when `owner` is given, belongs to them.

    Callers answer 404 rather than 403 on a miss, so this does not double as a
    probe for which session ids other users hold.
    """
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT 1 FROM platform.chat_session
                WHERE chat_session_id = %s
                  AND (%s::text IS NULL OR user_id = %s)""",
            (session_id, owner, owner),
        )
        return cur.fetchone() is not None


def session_space(session_id: int) -> str | None:
    """Which space a conversation belongs to.

    The session's own record is authoritative, not what the client sends with
    the turn: a conversation started in the sandbox keeps reading the sandbox's
    ontology, so its later turns cannot be made to answer about production by
    a request that simply says so.
    """
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT s.slug
                 FROM platform.chat_session c
                 JOIN platform.space s ON s.space_id = c.space_id
                WHERE c.chat_session_id = %s""",
            (session_id,),
        )
        row = cur.fetchone()
        # Rows here are dicts: connect() sets row_factory=dict_row. Indexing by
        # position raises KeyError, and only on an EXISTING session — so this
        # broke every second message in a conversation while the first worked.
        return row["slug"] if row else None


def history_for_model(session_id: int) -> list[dict[str, Any]]:
    """Prior turns as plain user/assistant text.

    Tool messages are excluded on purpose: replaying a previous turn's tool
    transcript would dominate the context window, and the model re-queries far
    more cheaply than it carries stale results forward.
    """
    messages = get_messages(session_id)
    conversational = [
        {"role": m["role"], "content": m["content"] or ""}
        for m in messages
        if m["role"] in ("user", "assistant") and (m["content"] or "").strip()
    ]
    return conversational[-HISTORY_TURNS:]


def append_message(
    session_id: int,
    role: str,
    content: str | None,
    tool_calls: list[dict[str, Any]] | None = None,
    tool_name: str | None = None,
    tool_result: dict[str, Any] | None = None,
    artifacts: list[dict[str, Any]] | None = None,
    latency_ms: int | None = None,
    token_usage: dict[str, Any] | None = None,
    cost: Any | None = None,
) -> int:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT COALESCE(max(seq), 0) + 1 AS next FROM platform.chat_message WHERE chat_session_id = %s",
            (session_id,),
        )
        row = cur.fetchone()
        seq = int(row["next"])

        cur.execute(
            """
            INSERT INTO platform.chat_message
                (chat_session_id, seq, role, content, tool_calls, tool_name, tool_result,
                 artifacts, latency_ms, token_usage,
                 provider, model, prompt_tokens, completion_tokens, total_tokens,
                 cost_usd, rate_input_per_m, rate_output_per_m)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            RETURNING chat_message_id
            """,
            (
                session_id,
                seq,
                role,
                content,
                json.dumps(tool_calls or []),
                tool_name,
                json.dumps(tool_result) if tool_result is not None else None,
                json.dumps(artifacts or []),
                latency_ms,
                json.dumps(token_usage) if token_usage is not None else None,
                # Priced at write time with the rate then in force, so a later
                # price change does not silently rewrite historical spend.
                getattr(cost, "provider", None),
                getattr(cost, "model", None),
                getattr(cost, "prompt_tokens", None),
                getattr(cost, "completion_tokens", None),
                getattr(cost, "total_tokens", None),
                getattr(cost, "cost_usd", None) if getattr(cost, "priced", False) else None,
                getattr(cost, "rate_input_per_m", None) if getattr(cost, "priced", False) else None,
                getattr(cost, "rate_output_per_m", None) if getattr(cost, "priced", False) else None,
            ),
        )
        message_id = int(cur.fetchone()["chat_message_id"])

        cur.execute(
            """
            UPDATE platform.chat_session
               SET message_count = (
                     SELECT count(*) FROM platform.chat_message WHERE chat_session_id = %s
                   ),
                   updated_at = now(),
                   -- The first user message becomes the session title, so the list
                   -- reads as questions rather than "Session 7".
                   title = COALESCE(title, left(%s, 80))
             WHERE chat_session_id = %s
            """,
            (session_id, content if role == "user" else None, session_id),
        )
    return message_id


def delete_session(session_id: int, owner: str | None = None) -> bool:
    """Delete a session the caller owns. Admins pass owner=None to delete any."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """DELETE FROM platform.chat_session
                WHERE chat_session_id = %s
                  AND (%s::text IS NULL OR user_id = %s)
            RETURNING chat_session_id""",
            (session_id, owner, owner),
        )
        return cur.fetchone() is not None


def cost_summary(
    owner: str | None, days: int = 30, space_slug: str | None = None
) -> dict[str, Any]:
    """Spend and token use, aggregated for the cost tab.

    `owner` is None for an admin, who sees the whole platform; everyone else
    sees only their own, because a spend report is also a record of what people
    have been asking.

    Rows with cost_usd IS NULL are turns made before pricing existed, or by a
    provider with no rate configured. They are counted separately rather than
    folded in as zero, so an unpriced gap is visible instead of flattering the
    total.
    """
    window = max(1, min(int(days), 365))
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT
              COALESCE(sum(m.cost_usd), 0)::float8            AS total_cost,
              COALESCE(sum(m.total_tokens), 0)::bigint         AS total_tokens,
              COALESCE(sum(m.prompt_tokens), 0)::bigint        AS prompt_tokens,
              COALESCE(sum(m.completion_tokens), 0)::bigint    AS completion_tokens,
              count(*) FILTER (WHERE m.total_tokens IS NOT NULL)::int  AS turns,
              count(*) FILTER (WHERE m.total_tokens IS NOT NULL
                                 AND m.cost_usd IS NULL)::int          AS unpriced_turns
              FROM platform.chat_message m
              JOIN platform.chat_session s ON s.chat_session_id = m.chat_session_id
             WHERE m.role = 'assistant'
               AND m.created_at > now() - make_interval(days => %s)
               AND (%s::text IS NULL OR s.user_id = %s)
               AND (%s::text IS NULL OR EXISTS (
                     SELECT 1 FROM platform.space sp
                      WHERE sp.space_id = s.space_id AND sp.slug = %s))
            """,
            (window, owner, owner, space_slug, space_slug),
        )
        totals = cur.fetchone() or {}

        cur.execute(
            """
            SELECT COALESCE(m.model, 'unknown') AS model,
                   COALESCE(m.provider, 'unknown') AS provider,
                   count(*)::int                        AS turns,
                   COALESCE(sum(m.total_tokens), 0)::bigint AS tokens,
                   COALESCE(sum(m.cost_usd), 0)::float8     AS cost
              FROM platform.chat_message m
              JOIN platform.chat_session s ON s.chat_session_id = m.chat_session_id
             WHERE m.role = 'assistant'
               AND m.created_at > now() - make_interval(days => %s)
               AND (%s::text IS NULL OR s.user_id = %s)
               AND (%s::text IS NULL OR EXISTS (
                     SELECT 1 FROM platform.space sp
                      WHERE sp.space_id = s.space_id AND sp.slug = %s))
             GROUP BY 1, 2 ORDER BY cost DESC, turns DESC
            """,
            (window, owner, owner, space_slug, space_slug),
        )
        by_model = list(cur.fetchall())

        cur.execute(
            """
            SELECT date_trunc('day', m.created_at)::date::text AS day,
                   count(*)::int                        AS turns,
                   COALESCE(sum(m.total_tokens), 0)::bigint AS tokens,
                   COALESCE(sum(m.cost_usd), 0)::float8     AS cost
              FROM platform.chat_message m
              JOIN platform.chat_session s ON s.chat_session_id = m.chat_session_id
             WHERE m.role = 'assistant'
               AND m.created_at > now() - make_interval(days => %s)
               AND (%s::text IS NULL OR s.user_id = %s)
               AND (%s::text IS NULL OR EXISTS (
                     SELECT 1 FROM platform.space sp
                      WHERE sp.space_id = s.space_id AND sp.slug = %s))
             GROUP BY 1 ORDER BY 1
            """,
            (window, owner, owner, space_slug, space_slug),
        )
        by_day = list(cur.fetchall())

        # Per-user only makes sense for whoever can see everyone.
        by_user: list[dict[str, Any]] = []
        if owner is None:
            cur.execute(
                """
                SELECT s.user_id                          AS username,
                       count(*)::int                      AS turns,
                       COALESCE(sum(m.total_tokens), 0)::bigint AS tokens,
                       COALESCE(sum(m.cost_usd), 0)::float8     AS cost
                  FROM platform.chat_message m
                  JOIN platform.chat_session s ON s.chat_session_id = m.chat_session_id
                 WHERE m.role = 'assistant'
                   AND m.created_at > now() - make_interval(days => %s)
                   AND (%s::text IS NULL OR EXISTS (
                         SELECT 1 FROM platform.space sp
                          WHERE sp.space_id = s.space_id AND sp.slug = %s))
                 GROUP BY 1 ORDER BY cost DESC
                """,
                (window, space_slug, space_slug),
            )
            by_user = list(cur.fetchall())

    return {
        "windowDays": window,
        "scope": "everyone" if owner is None else owner,
        "space": space_slug,
        "totals": totals,
        "byModel": by_model,
        "byDay": by_day,
        "byUser": by_user,
    }
