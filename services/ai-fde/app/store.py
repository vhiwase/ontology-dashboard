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


# ── agent state: mode, capabilities, plan, todos ────────────────────────────
# Migration 0027 put these on the session row, because a conversation that
# switched into governance mode must still be in it after a restart. The
# columns hold the whole state in one place the agent loop reads at the start
# of every turn and writes back at the end.


def get_session_state(session_id: int) -> dict[str, Any]:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT agent_mode, capabilities, plan, todos
              FROM platform.chat_session
             WHERE chat_session_id = %s
            """,
            (session_id,),
        )
        row = cur.fetchone()
    if row is None:
        return {"agent_mode": "exploration", "capabilities": [], "plan": None, "todos": []}
    return {
        "agent_mode": row["agent_mode"] or "exploration",
        "capabilities": row["capabilities"] or [],
        "plan": row["plan"],
        "todos": row["todos"] or [],
    }


def set_session_state(
    session_id: int,
    agent_mode: str,
    capabilities: list[str],
    plan: dict[str, Any] | None,
    todos: list[dict[str, Any]],
) -> None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE platform.chat_session
               SET agent_mode = %s, capabilities = %s, plan = %s, todos = %s
             WHERE chat_session_id = %s
            """,
            (
                agent_mode,
                json.dumps(sorted(capabilities)),
                json.dumps(plan) if plan is not None else None,
                json.dumps(todos),
                session_id,
            ),
        )


# ── notepad ─────────────────────────────────────────────────────────────────
# Notes belong to a user in a space, like every other artefact here: a finding
# written down while working the sandbox must not resurface as apparent
# context in production. Created by migration 0027.


class NotepadExists(RuntimeError):
    """A note with this title already exists for the user in this space."""


class NotepadSpaceMissing(RuntimeError):
    """The space slug a note was addressed to does not exist."""


def _notepad_space_id(space_slug: str) -> int:
    """Resolve the space, so a note cannot be written into a space that does
    not exist by a slug that merely looks plausible."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT space_id FROM platform.space WHERE slug = %s", (space_slug,))
        row = cur.fetchone()
    if row is None:
        raise NotepadSpaceMissing(f"No space '{space_slug}'.")
    return int(row["space_id"])


def notepad_list(user: str, space_slug: str) -> list[dict[str, Any]]:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT n.notepad_document_id, n.title, n.content,
                   left(n.content, 120) AS preview,
                   n.created_at, n.updated_at
              FROM platform.notepad_document n
              JOIN platform.space s ON s.space_id = n.space_id
             WHERE n.user_id = %s AND s.slug = %s
             ORDER BY n.updated_at DESC
            """,
            (user, space_slug),
        )
        return list(cur.fetchall())


def notepad_read(user: str, space_slug: str, title: str) -> dict[str, Any] | None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT n.notepad_document_id, n.title, n.content, n.created_at, n.updated_at
              FROM platform.notepad_document n
              JOIN platform.space s ON s.space_id = n.space_id
             WHERE n.user_id = %s AND s.slug = %s AND n.title = %s
            """,
            (user, space_slug, title),
        )
        return cur.fetchone()


def notepad_create(user: str, space_slug: str, title: str, content: str) -> dict[str, Any]:
    space_id = _notepad_space_id(space_slug)
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO platform.notepad_document (user_id, space_id, title, content)
            VALUES (%s, %s, %s, %s)
            RETURNING notepad_document_id, title, content, created_at, updated_at
            """,
            (user, space_id, title, content),
        )
        return cur.fetchone()


def notepad_update(
    user: str, space_slug: str, title: str, content: str
) -> dict[str, Any] | None:
    space_id = _notepad_space_id(space_slug)
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE platform.notepad_document
               SET content = %s, updated_at = now()
             WHERE user_id = %s AND space_id = %s AND title = %s
            RETURNING notepad_document_id, title, content, created_at, updated_at
            """,
            (content, user, space_id, title),
        )
        return cur.fetchone()


def notepad_delete(user: str, space_slug: str, title: str) -> bool:
    space_id = _notepad_space_id(space_slug)
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            DELETE FROM platform.notepad_document
             WHERE user_id = %s AND space_id = %s AND title = %s
            RETURNING notepad_document_id
            """,
            (user, space_id, title),
        )
        return cur.fetchone() is not None


# ── assistant eval suites ───────────────────────────────────────────────────
# The assistant owns the 'assistant' target kind of platform.eval_suite; the
# ontology-service owns the 'function' kind. Same tables, shared shape, one
# owner each - so neither service invents a second schema for a suite.


def eval_suite_list(space_slug: str) -> list[dict[str, Any]]:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT es.eval_suite_id, es.name, es.target_kind, es.target_ref,
                   es.description, es.created_by, es.created_at,
                   (SELECT count(*) FROM platform.eval_case c
                     WHERE c.suite_id = es.eval_suite_id)::int AS case_count,
                   (SELECT count(*) FROM platform.eval_run r
                     WHERE r.suite_id = es.eval_suite_id)::int AS run_count
              FROM platform.eval_suite es
              JOIN platform.space sp ON sp.space_id = es.space_id
             WHERE es.target_kind = 'assistant' AND sp.slug = %s
             ORDER BY es.name
            """,
            (space_slug,),
        )
        return list(cur.fetchall())


def eval_suite_create(
    space_slug: str,
    name: str,
    description: str,
    cases: list[dict[str, Any]],
    user: str,
) -> int:
    space_id = _notepad_space_id(space_slug)
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO platform.eval_suite
                (space_id, name, target_kind, target_ref, description, created_by)
            VALUES (%s, %s, 'assistant', 'assistant', %s, %s)
            RETURNING eval_suite_id
            """,
            (space_id, name, description or None, user),
        )
        suite_id = int(cur.fetchone()["eval_suite_id"])
        for ordinal, case in enumerate(cases, start=1):
            cur.execute(
                """
                INSERT INTO platform.eval_case (suite_id, name, spec, ordinal)
                VALUES (%s, %s, %s, %s)
                """,
                (suite_id, case["name"], json.dumps(case["spec"]), ordinal),
            )
    return suite_id


def eval_suite_get(suite_id: int, space_slug: str) -> dict[str, Any] | None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT es.eval_suite_id, es.name, es.target_kind, es.target_ref,
                   es.description, es.created_by, es.created_at
              FROM platform.eval_suite es
              JOIN platform.space sp ON sp.space_id = es.space_id
             WHERE es.eval_suite_id = %s AND es.target_kind = 'assistant'
               AND sp.slug = %s
            """,
            (suite_id, space_slug),
        )
        suite = cur.fetchone()
        if suite is None:
            return None
        cur.execute(
            """
            SELECT eval_case_id, name, spec, ordinal
              FROM platform.eval_case
             WHERE suite_id = %s ORDER BY ordinal, eval_case_id
            """,
            (suite_id,),
        )
        suite["cases"] = list(cur.fetchall())
    return suite


def eval_suite_delete(suite_id: int, space_slug: str) -> bool:
    space_id = _notepad_space_id(space_slug)
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            DELETE FROM platform.eval_suite
             WHERE eval_suite_id = %s AND space_id = %s AND target_kind = 'assistant'
            RETURNING eval_suite_id
            """,
            (suite_id, space_id),
        )
        return cur.fetchone() is not None


def eval_run_record(
    suite_id: int,
    started_by: str,
    outcome: dict[str, Any],
    duration_seconds: float,
    cost: Any | None = None,
) -> int:
    """Persist a finished suite run. Counters are columns so a run list can be
    read without opening every detail blob."""
    tokens = outcome.get("tokens") or {}
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO platform.eval_run
                (suite_id, started_by, status, passed, failed, total, detail,
                 prompt_tokens, completion_tokens, total_tokens, cost_usd,
                 started_at, finished_at)
            VALUES (%s, %s, 'succeeded', %s, %s, %s, %s, %s, %s, %s, %s,
                    now() - make_interval(secs => %s), now())
            RETURNING eval_run_id
            """,
            (
                suite_id,
                started_by,
                outcome["passed"],
                outcome["failed"],
                outcome["total"],
                json.dumps(outcome["outcomes"]),
                tokens.get("promptTokens"),
                tokens.get("completionTokens"),
                tokens.get("totalTokens"),
                getattr(cost, "cost_usd", None) if getattr(cost, "priced", False) else None,
                # The row spans the whole suite; reconstruct started_at from
                # the measured duration rather than fabricating a timestamp.
                max(0, int(duration_seconds)),
            ),
        )
        return int(cur.fetchone()["eval_run_id"])


def eval_runs_list(suite_id: int, limit: int = 10) -> list[dict[str, Any]]:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT eval_run_id, started_by, status, passed, failed, total, detail,
                   prompt_tokens, completion_tokens, total_tokens, cost_usd,
                   started_at, finished_at
              FROM platform.eval_run
             WHERE suite_id = %s
             ORDER BY started_at DESC LIMIT %s
            """,
            (suite_id, max(1, min(limit, 50))),
        )
        return list(cur.fetchall())


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
