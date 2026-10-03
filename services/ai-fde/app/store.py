"""Conversation persistence.

Chat history lives in Postgres rather than in memory so a conversation survives a
container restart, and so the tool calls behind every answer stay auditable: the
platform.chat_message rows record which ontology query produced the number the
assistant quoted.

Every conversation is kept, per person and per space, until that person deletes
it. It can be found again (list_sessions searches titles and what was said),
renamed and pinned. Deleting one erases what was said and keeps what it cost -
see delete_session - because a person's monthly credit and the spend report
are both sums over these rows, and neither may shrink because a conversation
was tidied away.
"""

from __future__ import annotations

import json
import logging
import re
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


# How much of a matching message is shown under a search result.
SNIPPET_BEFORE = 40
SNIPPET_AFTER = 110


def like_pattern(search: str) -> str:
    """A search phrase as an ILIKE pattern that matches it literally.

    `%` and `_` are wildcards to LIKE; someone searching for "100%" or
    "order_date" means those characters.
    """
    escaped = search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


_DIRECTIVE = re.compile(r":(resource|citation)\[([^\]]*)\](\{[^}]*\})?")
_FENCE = re.compile(r"```([A-Za-z0-9_+-]*)[ \t]*\n?(.*?)```", re.DOTALL)
# Marks that sit inside the words (bold, italics, inline code) and marks that
# sit between them (a heading's #, a table's |).
_EMPHASIS = re.compile(r"[*`]+")
_STRUCTURE = re.compile(r"[#|]+")

# A message as it was read, for matching in SQL: `:resource[objectType:Order]`
# is read as "Order", a citation as its own text, and "**on-time** rate" as
# "on-time rate". Matched as stored, a search for "resource" or "objectType"
# found every answer that names a thing, with nothing in it a person had read -
# and a phrase with a bold word in the middle of it was not found at all.
_READ_SQL = (
    r"translate(regexp_replace(regexp_replace(m.content, "
    r"':resource\[[^]:]*:([^]]*)\](\{[^}]*\})?', '\1', 'g'), "
    r"':citation\[([^]]*)\](\{[^}]*\})?', '\1', 'g'), '*`', '')"
)


def _prose(text: str) -> str:
    def named(match: re.Match[str]) -> str:
        inner = match.group(2)
        # A resource marker names its thing after the colon; a citation is its own text.
        return inner.split(":", 1)[1] if match.group(1) == "resource" and ":" in inner else inner

    return _STRUCTURE.sub(" ", _EMPHASIS.sub("", _DIRECTIVE.sub(named, text)))


def plain_text(content: str) -> str:
    """A message as the words a person read, without what the page turns into
    chips, headings and diagrams.

    An answer is stored as written: `:resource[objectType:Order]`, `###`,
    fenced Mermaid. Shown as it is under a search result it reads as noise.
    Code in a fence is kept as it stands - it was read, and `*` in it is not
    emphasis; a diagram's source is dropped, since the page draws it instead.
    """
    parts: list[str] = []
    at = 0
    for fence in _FENCE.finditer(content):
        parts.append(_prose(content[at : fence.start()]))
        if fence.group(1).lower() != "mermaid":
            parts.append(fence.group(2))
        at = fence.end()
    parts.append(_prose(content[at:]))
    return " ".join(" ".join(parts).split())


def snippet_around(content: str | None, search: str) -> str | None:
    """The part of a message a search matched, with a little either side.

    Taken from the message as words (plain_text). A phrase that matched only
    inside a marker is not among those words; the message's opening is shown
    then, so the result still says which message it was.
    """
    if not content or not search:
        return None
    text = plain_text(content)
    if not text:
        return None
    # As typed first (code keeps its marks), then without the marks that were
    # ignored when it was matched.
    lowered = text.lower()
    for phrase in (search, _EMPHASIS.sub("", search)):
        at = lowered.find(phrase.lower()) if phrase else -1
        if at >= 0:
            start = max(0, at - SNIPPET_BEFORE)
            end = min(len(text), at + len(phrase) + SNIPPET_AFTER)
            return ("…" if start > 0 else "") + text[start:end] + ("…" if end < len(text) else "")
    end = min(len(text), SNIPPET_BEFORE + SNIPPET_AFTER)
    return text[:end] + ("…" if end < len(text) else "")


def list_sessions(
    owner: str | None,
    limit: int = 50,
    space_slug: str | None = None,
    search: str | None = None,
    offset: int = 0,
) -> list[dict[str, Any]]:
    """Sessions belonging to `owner`, or every session when owner is None.

    A conversation can quote whatever the ontology holds, so one user's history
    is not another user's to read. Only an admin passes None.

    Pinned ones first, then the most recently used. `search` keeps those whose
    title or any question, answer or note from the page contains the phrase -
    in what was read, not in the markers it is stored with - and returns the
    matching passage as `snippet`. Each row carries `total`, the number that
    matched before `limit` and `offset` were applied.
    """
    phrase = (search or "").strip() or None
    # Emphasis marks are taken out of a message before it is matched
    # (_READ_SQL), so they are taken out of the phrase too.
    needle = _EMPHASIS.sub("", phrase).strip() if phrase else ""
    pattern = like_pattern(needle) if needle else None
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT cs.chat_session_id, cs.title, cs.user_id, cs.user_role,
                   cs.llm_provider, cs.llm_model,
                   cs.message_count, cs.created_at, cs.updated_at,
                   cs.is_retained AS pinned, sp.slug AS space,
                   hit.content AS matched,
                   count(*) OVER () AS total
              FROM platform.chat_session cs
              JOIN platform.space sp ON sp.space_id = cs.space_id
              LEFT JOIN LATERAL (
                    SELECT m.content
                      FROM platform.chat_message m
                     WHERE %(pattern)s::text IS NOT NULL
                       AND m.chat_session_id = cs.chat_session_id
                       AND (m.role IN ('user', 'assistant')
                            OR (m.role = %(note_role)s AND m.tool_name = %(note_tool)s))
                       AND """
            + _READ_SQL
            + """ ILIKE %(pattern)s
                     ORDER BY m.seq
                     LIMIT 1
                   ) hit ON true
             WHERE cs.deleted_at IS NULL
               AND (%(owner)s::text IS NULL OR cs.user_id = %(owner)s)
               AND (%(space)s::text IS NULL OR sp.slug = %(space)s)
               AND (%(pattern)s::text IS NULL
                    OR cs.title ILIKE %(pattern)s
                    OR hit.content IS NOT NULL)
             ORDER BY cs.is_retained DESC, cs.updated_at DESC
             LIMIT %(limit)s OFFSET %(offset)s
            """,
            {
                "owner": owner,
                "space": space_slug,
                "pattern": pattern,
                "note_role": NOTE_ROLE,
                "note_tool": NOTE_TOOL,
                "limit": max(1, min(int(limit), 200)),
                "offset": max(0, int(offset)),
            },
        )
        rows = list(cur.fetchall())
    for row in rows:
        matched = row.pop("matched", None)
        row["snippet"] = snippet_around(matched, phrase) if phrase else None
    return rows


def get_messages(session_id: int) -> list[dict[str, Any]]:
    # Provider, model, tokens and cost come back with each message so a
    # conversation reopened later shows what every answer cost, as it did live.
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT chat_message_id, seq, role, content, tool_calls, tool_name,
                   tool_result, artifacts, latency_ms, token_usage, created_at,
                   provider, model, total_tokens, cost_usd
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
        # A deleted conversation is not there, to anyone: it cannot be opened,
        # continued or deleted again.
        cur.execute(
            """SELECT 1 FROM platform.chat_session
                WHERE chat_session_id = %s
                  AND deleted_at IS NULL
                  AND (%s::text IS NULL OR user_id = %s)""",
            (session_id, owner, owner),
        )
        return cur.fetchone() is not None


def session_info(session_id: int) -> dict[str, Any] | None:
    """A conversation's own details: its name, its owner and whether it is pinned."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT title, user_id, is_retained AS pinned, created_at, updated_at
                 FROM platform.chat_session
                WHERE chat_session_id = %s AND deleted_at IS NULL""",
            (session_id,),
        )
        return cur.fetchone()


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


TITLE_LIMIT = 120


def update_session(
    session_id: int,
    owner: str | None = None,
    title: str | None = None,
    pinned: bool | None = None,
) -> dict[str, Any] | None:
    """Rename or pin a conversation. Returns its row, or None if it is not there.

    Pinning sets is_retained: the flag that keeps a session out of the
    retention purge is the one that keeps it at the top of the list.
    """
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE platform.chat_session
               SET title = COALESCE(%s, title),
                   is_retained = COALESCE(%s, is_retained)
             WHERE chat_session_id = %s
               AND deleted_at IS NULL
               AND (%s::text IS NULL OR user_id = %s)
            RETURNING chat_session_id, title, user_id, message_count,
                      created_at, updated_at, is_retained AS pinned
            """,
            (title[:TITLE_LIMIT] if title is not None else None, pinned, session_id, owner, owner),
        )
        return cur.fetchone()


def delete_session(
    session_id: int, owner: str | None = None, deleted_by: str | None = None
) -> bool:
    """Delete a session the caller owns. Admins pass owner=None to delete any.

    What was said is erased; what it cost is kept. The row stays as a
    tombstone - out of every list, not openable - and each answer keeps only
    its usage (tokens, model, price). A person's monthly credit and the spend
    report are sums over those answers, so deleting the rows outright handed
    the credit back and took money out of the report.
    """
    with connect() as conn, conn.transaction(), conn.cursor() as cur:
        cur.execute(
            """UPDATE platform.chat_session
                  SET deleted_at = now(), deleted_by = %s, title = NULL,
                      plan = NULL, todos = NULL, is_retained = false
                WHERE chat_session_id = %s
                  AND deleted_at IS NULL
                  AND (%s::text IS NULL OR user_id = %s)
                RETURNING chat_session_id""",
            (deleted_by or owner, session_id, owner, owner),
        )
        if cur.fetchone() is None:
            return False
        # Questions, notes and tool transcripts carry no cost: they go.
        cur.execute(
            "DELETE FROM platform.chat_message WHERE chat_session_id = %s AND role <> 'assistant'",
            (session_id,),
        )
        # Answers stay as rows for what they cost, with nothing of what they said.
        cur.execute(
            """UPDATE platform.chat_message
                  SET content = NULL, tool_calls = '[]'::jsonb, tool_name = NULL,
                      tool_result = NULL, artifacts = '[]'::jsonb
                WHERE chat_session_id = %s""",
            (session_id,),
        )
    return True


# What the page itself adds to a conversation - "Approved and built: ..." after
# an approval made from inside it. Stored so the conversation reads the same
# when it is reopened, under a role no spend or turn count looks at.
NOTE_ROLE = "system"
NOTE_TOOL = "page-note"
NOTE_ARTIFACT_KINDS = {"dashboard", "clarification"}


def append_note(session_id: int, content: str, artifacts: list[dict[str, Any]] | None = None) -> int:
    """Record something the page said in a conversation, as part of its history."""
    kept = [
        artifact
        for artifact in (artifacts or [])
        if isinstance(artifact, dict) and artifact.get("kind") in NOTE_ARTIFACT_KINDS
    ][:4]
    with connect() as conn, conn.transaction(), conn.cursor() as cur:
        cur.execute(
            "SELECT COALESCE(max(seq), 0) + 1 AS next FROM platform.chat_message WHERE chat_session_id = %s",
            (session_id,),
        )
        seq = int(cur.fetchone()["next"])
        cur.execute(
            """
            INSERT INTO platform.chat_message
                (chat_session_id, seq, role, content, tool_calls, tool_name, artifacts)
            VALUES (%s, %s, %s, %s, '[]'::jsonb, %s, %s)
            RETURNING chat_message_id
            """,
            (session_id, seq, NOTE_ROLE, content[:4000], NOTE_TOOL, json.dumps(kept)),
        )
        message_id = int(cur.fetchone()["chat_message_id"])
        cur.execute(
            """UPDATE platform.chat_session
                  SET message_count = (
                        SELECT count(*) FROM platform.chat_message WHERE chat_session_id = %s
                      ),
                      updated_at = now()
                WHERE chat_session_id = %s""",
            (session_id, session_id),
        )
    return message_id


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
