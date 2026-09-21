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
) -> int:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO platform.chat_session (title, user_id, user_role, llm_provider, llm_model)
            VALUES (%s, %s, %s, %s, %s) RETURNING chat_session_id
            """,
            (title, user_id, user_role, provider, model),
        )
        row = cur.fetchone()
    return int(row["chat_session_id"])


def list_sessions(owner: str | None, limit: int = 50) -> list[dict[str, Any]]:
    """Sessions belonging to `owner`, or every session when owner is None.

    A conversation can quote whatever the ontology holds, so one user's history
    is not another user's to read. Only an admin passes None.
    """
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT chat_session_id, title, user_id, user_role, llm_provider, llm_model,
                   message_count, created_at, updated_at
              FROM platform.chat_session
             WHERE (%s::text IS NULL OR user_id = %s)
             ORDER BY updated_at DESC LIMIT %s
            """,
            (owner, owner, limit),
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
                 artifacts, latency_ms, token_usage)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
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
