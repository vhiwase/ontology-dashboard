"""Monthly AI credit, per person.

An administrator sets it in the admin console (migration 0035). An account's
credit_mode says where its limit comes from:

    default    the platform default - setting credit.defaultMonthlyUsd, where
               not set means no limit
    unlimited  no limit for this person, whatever the default is
    custom     credit_limit_usd, for this person only

Spend is what the person's turns cost this calendar month, read from
platform.chat_message.cost_usd - priced at write time with the rate then in
force - so the check is against what the turns actually cost. The month is the
database's, the same boundary the admin console reports against.

A turn is refused only BEFORE it starts, when the credit is already used up.
A turn already running is never cut off part-way: abandoning work that has
been paid for would cost the money and lose the answer.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import psycopg
from psycopg.rows import dict_row

from . import settings
from .config import CONFIG

log = logging.getLogger("ai_fde.credit")


def effective_limit(mode: str, custom_limit: float | None, default_limit: float | None) -> float | None:
    """The monthly limit that applies: None means no limit."""
    if mode == "unlimited":
        return None
    if mode == "custom":
        return custom_limit
    return default_limit


def _day_month(value: datetime) -> str:
    # Spelled out rather than strftime("%-d"), which Windows does not support.
    return f"{value.day} {value.strftime('%B')}"


@dataclass(frozen=True)
class CreditStatus:
    mode: str
    limit_usd: float | None
    spent_usd: float
    period_start: datetime | None
    resets_at: datetime | None

    @property
    def remaining_usd(self) -> float | None:
        if self.limit_usd is None:
            return None
        return max(0.0, round(self.limit_usd - self.spent_usd, 6))

    @property
    def exhausted(self) -> bool:
        return self.limit_usd is not None and self.spent_usd >= self.limit_usd

    def refusal(self) -> str:
        since = f" since {_day_month(self.period_start)}" if self.period_start else " this month"
        renews = f" It renews on {_day_month(self.resets_at)}." if self.resets_at else ""
        return (
            f"Your monthly AI credit of ${self.limit_usd:,.2f} is used up "
            f"(${self.spent_usd:,.2f} spent{since}).{renews} "
            "Ask an administrator to raise your limit."
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "limitUsd": self.limit_usd,
            "spentUsd": round(self.spent_usd, 6),
            "remainingUsd": self.remaining_usd,
            "exhausted": self.exhausted,
            "periodStart": self.period_start.isoformat() if self.period_start else None,
            "resetsAt": self.resets_at.isoformat() if self.resets_at else None,
        }


_STATUS_SQL = """
    SELECT u.credit_mode,
           u.credit_limit_usd,
           COALESCE((
               SELECT sum(m.cost_usd)
                 FROM platform.chat_message m
                 JOIN platform.chat_session s USING (chat_session_id)
                WHERE s.user_id = u.username
                  AND m.role = 'assistant'
                  AND m.created_at >= date_trunc('month', now())
           ), 0) AS spent,
           date_trunc('month', now()) AS period_start,
           date_trunc('month', now()) + interval '1 month' AS resets_at
      FROM platform.app_user u
     WHERE u.username = %s
"""


def credit_status(username: str) -> CreditStatus:
    """Where a person stands against their monthly credit right now."""
    default_limit = settings.number("credit.defaultMonthlyUsd")
    try:
        with psycopg.connect(CONFIG.database_url, row_factory=dict_row, connect_timeout=5) as conn:
            with conn.cursor() as cur:
                cur.execute(_STATUS_SQL, (username,))
                row = cur.fetchone()
    except psycopg.errors.UndefinedColumn:
        # Before migration 0035 there is no credit to enforce.
        return CreditStatus("default", None, 0.0, None, None)

    if row is None:
        return CreditStatus("default", default_limit, 0.0, None, None)
    custom = float(row["credit_limit_usd"]) if row["credit_limit_usd"] is not None else None
    return CreditStatus(
        mode=row["credit_mode"],
        limit_usd=effective_limit(row["credit_mode"], custom, default_limit),
        spent_usd=float(row["spent"] or 0),
        period_start=row["period_start"],
        resets_at=row["resets_at"],
    )
