"""The conversation history: finding one again, and deleting one honestly.

The suite runs without a database, so the store is given a connection that
records what it is asked to run and answers from a script. That is enough to
pin what matters here: a deleted conversation's content goes and its cost
stays, and nothing that was deleted is listed, opened or continued.
"""

from __future__ import annotations

import os
from typing import Any

os.environ.setdefault("AUTH_JWT_SECRET", "test-secret-at-least-thirty-two-characters-long")
os.environ.setdefault("DATABASE_URL", "postgresql://unused:unused@127.0.0.1:1/unused")

from app import store  # noqa: E402


class _Scope:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _Cursor(_Scope):
    def __init__(self, log: list[tuple[str, Any]], answers: list[Any]) -> None:
        self.log = log
        self.answers = answers

    def execute(self, sql: str, params: Any = None) -> None:
        self.log.append((" ".join(sql.split()), params))

    def fetchone(self) -> Any:
        return self.answers.pop(0) if self.answers else None

    def fetchall(self) -> Any:
        return self.answers.pop(0) if self.answers else []


class _Connection(_Scope):
    def __init__(self, log: list[tuple[str, Any]], answers: list[Any]) -> None:
        self.log = log
        self.answers = answers
        self.transactions = 0

    def cursor(self) -> _Cursor:
        return _Cursor(self.log, self.answers)

    def transaction(self) -> _Scope:
        self.transactions += 1
        return _Scope()


def _scripted(monkeypatch, answers: list[Any]) -> tuple[list[tuple[str, Any]], _Connection]:
    log: list[tuple[str, Any]] = []
    connection = _Connection(log, list(answers))
    monkeypatch.setattr(store, "connect", lambda: connection)
    return log, connection


# ── searching ───────────────────────────────────────────────────────────────


def test_a_search_phrase_is_matched_literally():
    assert store.like_pattern("orders") == "%orders%"
    # % and _ mean themselves to someone typing them, not "anything".
    assert store.like_pattern("100% of order_date") == "%100\\% of order\\_date%"
    assert store.like_pattern("a\\b") == "%a\\\\b%"


def test_the_snippet_shows_where_it_matched():
    long = "x " * 60 + "the freight total for Germany was higher " + "y " * 90
    snippet = store.snippet_around(long, "freight total")
    assert snippet is not None
    assert "freight total" in snippet
    assert snippet.startswith("…") and snippet.endswith("…")
    assert len(snippet) < 200


def test_the_snippet_ignores_case_and_line_breaks():
    assert store.snippet_around("Revenue\nby   COUNTRY, per month", "by country") == "Revenue by COUNTRY, per month"


def test_no_snippet_when_only_the_title_matched():
    # No message matched, so there is no message to quote.
    assert store.snippet_around(None, "freight") is None
    assert store.snippet_around("", "freight") is None


def test_the_snippet_is_the_words_not_the_markers():
    answer = (
        "### Object types created\n"
        "- :resource[objectType:BusinessEntityContact] — a **contact** of a business entity\n"
        "See :citation[How data becomes an ontology]{path=\"platform/data-flow\"}.\n"
        "```mermaid\nflowchart LR\n  A --> B\n```\n"
        "Rows landed: `127`"
    )
    assert store.plain_text(answer) == (
        "Object types created - BusinessEntityContact — a contact of a business entity "
        "See How data becomes an ontology. Rows landed: 127"
    )
    snippet = store.snippet_around(answer, "contact of a business")
    assert snippet is not None and "contact of a business" in snippet
    assert ":resource[" not in snippet and "###" not in snippet and "mermaid" not in snippet


def test_a_match_inside_a_marker_shows_the_message_opening():
    # "objectType" is in the stored text only as part of a marker.
    answer = "Created :resource[objectType:Order] from the orders dataset, with twelve properties."
    assert store.snippet_around(answer, "objectType") == "Created Order from the orders dataset, with twelve properties."


def test_code_in_an_answer_is_kept_as_written_and_a_diagram_is_not():
    answer = (
        "Run **this**:\n```sql\nSELECT count(*) FROM orders\n```\n"
        "and it draws\n```mermaid\ngraph TD; Order-->Customer\n```"
    )
    # The * in the query is not emphasis, and is still there to be found.
    assert store.plain_text(answer) == "Run this: SELECT count(*) FROM orders and it draws"
    assert "count(*)" in (store.snippet_around(answer, "count(*)") or "")
    # The diagram is drawn by the page; its source is not shown as a passage.
    assert "graph TD" not in (store.snippet_around(answer, "Customer") or "")


def test_a_phrase_is_found_across_a_bold_word():
    answer = "The **On-time rate** by month fell in March."
    # Read as one phrase, so shown as one - however it was typed.
    assert store.snippet_around(answer, "on-time rate by month") == "The On-time rate by month fell in March."
    assert store.snippet_around(answer, "**on-time rate** by month") == "The On-time rate by month fell in March."


def test_a_search_matches_what_was_read_not_the_markers(monkeypatch):
    log, _ = _scripted(monkeypatch, [[]])
    store.list_sessions("maria", space_slug="u-maria", search="`order_date` is **late**")
    sql, params = log[0]
    # A marker is reduced to what it shows before anything is matched against
    # it, so its own words - resource, objectType, path - find nothing...
    assert "regexp_replace(regexp_replace(m.content," in sql
    assert "':resource\\[[^]:]*:([^]]*)\\](\\{[^}]*\\})?', '\\1', 'g'" in sql
    # ...and emphasis marks come out of the message and of the phrase alike.
    assert "'*`', '') ILIKE %(pattern)s" in sql
    assert "m.content ILIKE" not in sql
    assert params["pattern"] == "%order\\_date is late%"
    # A line the page added is searched like a question or an answer.
    assert params["note_role"] == store.NOTE_ROLE == "system"
    assert params["note_tool"] == store.NOTE_TOOL == "page-note"


def test_a_phrase_of_nothing_but_marks_is_no_search(monkeypatch):
    log, _ = _scripted(monkeypatch, [[]])
    store.list_sessions("maria", search="**")
    assert log[0][1]["pattern"] is None


def test_listing_leaves_out_what_was_deleted_and_reports_the_total(monkeypatch):
    rows = [
        {"chat_session_id": 7, "title": "Freight by country", "matched": "the freight total was 12", "total": 2, "pinned": True},
        {"chat_session_id": 3, "title": "freight", "matched": None, "total": 2, "pinned": False},
    ]
    log, _ = _scripted(monkeypatch, [rows])
    listed = store.list_sessions("maria", limit=40, space_slug="u-maria", search=" freight ", offset=0)

    sql, params = log[0]
    assert "cs.deleted_at IS NULL" in sql
    assert "ORDER BY cs.is_retained DESC, cs.updated_at DESC" in sql
    assert params["owner"] == "maria" and params["space"] == "u-maria"
    assert params["pattern"] == "%freight%" and params["limit"] == 40 and params["offset"] == 0
    # What matched in a message is shown; a match on the title alone has nothing to show.
    assert listed[0]["snippet"] == "the freight total was 12"
    assert listed[1]["snippet"] is None
    assert "matched" not in listed[0]


def test_listing_without_a_search_matches_nothing_in_particular(monkeypatch):
    log, _ = _scripted(monkeypatch, [[]])
    assert store.list_sessions(None, space_slug="sandbox", search="   ") == []
    assert log[0][1]["pattern"] is None and log[0][1]["owner"] is None


def test_the_page_size_is_bounded(monkeypatch):
    log, _ = _scripted(monkeypatch, [[]])
    store.list_sessions("maria", limit=5000, offset=-4)
    assert log[0][1]["limit"] == 200 and log[0][1]["offset"] == 0


# ── deleting ────────────────────────────────────────────────────────────────


def test_deleting_erases_what_was_said_and_keeps_what_it_cost(monkeypatch):
    log, connection = _scripted(monkeypatch, [{"chat_session_id": 7}])
    assert store.delete_session(7, "maria", "maria") is True

    statements = [sql for sql, _ in log]
    # The session becomes a tombstone rather than disappearing with its rows.
    assert statements[0].startswith("UPDATE platform.chat_session SET deleted_at = now()")
    assert "title = NULL" in statements[0] and "deleted_at IS NULL" in statements[0]
    assert log[0][1] == ("maria", 7, "maria", "maria")
    assert not any("DELETE FROM platform.chat_session" in sql for sql in statements)
    # Questions and notes carry no cost and are removed...
    assert statements[1] == "DELETE FROM platform.chat_message WHERE chat_session_id = %s AND role <> 'assistant'"
    # ...answers stay as rows, emptied of everything but their usage.
    assert statements[2].startswith("UPDATE platform.chat_message SET content = NULL")
    for kept in ("cost_usd", "total_tokens", "prompt_tokens", "completion_tokens", "model", "provider"):
        assert kept not in statements[2], kept
    # All of it or none of it.
    assert connection.transactions == 1


def test_deleting_what_is_not_yours_or_already_gone_changes_nothing(monkeypatch):
    log, _ = _scripted(monkeypatch, [None])
    assert store.delete_session(7, "someone-else") is False
    assert len(log) == 1


def test_a_deleted_conversation_cannot_be_opened_or_continued(monkeypatch):
    log, _ = _scripted(monkeypatch, [None])
    assert store.session_exists(7, "maria") is False
    assert "deleted_at IS NULL" in log[0][0]


# ── how long one is kept ────────────────────────────────────────────────────


def test_the_retention_window_is_read_and_is_never_negative(monkeypatch):
    from app.config import Config

    # Unset: nothing is removed for being old, and the history may say so.
    monkeypatch.delenv("CHAT_RETENTION_DAYS", raising=False)
    assert Config().chat_retention_days == 0
    monkeypatch.setenv("CHAT_RETENTION_DAYS", "30")
    assert Config().chat_retention_days == 30
    for odd in ("-4", "soon", ""):
        monkeypatch.setenv("CHAT_RETENTION_DAYS", odd)
        assert Config().chat_retention_days == 0, odd


# ── renaming, pinning, notes ────────────────────────────────────────────────


def test_renaming_and_pinning_touch_only_a_live_conversation_of_the_callers(monkeypatch):
    log, _ = _scripted(monkeypatch, [{"chat_session_id": 7, "title": "Freight", "pinned": True}])
    row = store.update_session(7, "maria", title="F" * 400, pinned=True)
    sql, params = log[0]
    assert "deleted_at IS NULL" in sql and "user_id = %s" in sql
    # A pin is the flag that keeps a session from the retention purge.
    assert "is_retained = COALESCE(%s, is_retained)" in sql
    assert len(params[0]) == store.TITLE_LIMIT and params[1] is True
    assert row["pinned"] is True


def test_a_note_from_the_page_is_kept_out_of_the_spend(monkeypatch):
    log, _ = _scripted(monkeypatch, [{"next": 5}, {"chat_message_id": 99}])
    message_id = store.append_note(
        7,
        "Approved and built: **Sales**",
        [
            {"kind": "dashboard", "slug": "sales", "title": "Sales"},
            # Not something the page adds: dropped rather than stored.
            {"kind": "chart", "series": [1, 2, 3]},
            "not an artifact",
        ],
    )
    assert message_id == 99
    insert_sql, insert_params = log[1]
    assert "INSERT INTO platform.chat_message" in insert_sql
    # Under a role no cost or turn count looks at, marked as the page's own.
    assert insert_params[2] == "system" and insert_params[4] == "page-note"
    assert insert_params[5] == '[{"kind": "dashboard", "slug": "sales", "title": "Sales"}]'
    assert "cost_usd" not in insert_sql and "total_tokens" not in insert_sql
