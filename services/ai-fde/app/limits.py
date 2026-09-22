"""Rate limiting and LLM spend control for the chat route.

/api/assistant/chat fans out to a paid model for up to AI_FDE_MAX_TOOL_ROUNDS
tool rounds, so one caller in a loop is a cost amplifier rather than just a
noisy neighbour. Two independent limits apply, per user:

  * a token bucket on request rate, which bounds bursts;
  * a rolling 24 h budget on LLM tokens actually consumed, which bounds spend
    even when the request rate is perfectly polite.

Both are in-process, which is the same scaling constraint the ontology
registry already has: correct for the single-replica deployment this compose
file describes, and needing a shared store (Redis, or a Postgres table) before
a second replica makes either limit meaningful. REPLICA_WARNING below is
logged at startup so that constraint is not discovered in production.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass, field

log = logging.getLogger("ai-fde.limits")

# Requests: a steady rate plus a burst allowance.
RATE_PER_MINUTE = float(os.environ.get("CHAT_RATE_PER_MINUTE", "10"))
RATE_BURST = float(os.environ.get("CHAT_RATE_BURST", "5"))

# Spend: total LLM tokens one user may consume in a rolling 24 hours.
# 0 disables the budget, and 0 is the default: turns are not refused for
# volume. Spend is still recorded per turn and reported on the Cost analysis
# page, so removing the cap removes a refusal, not the measurement.
DAILY_TOKEN_BUDGET = int(os.environ.get("CHAT_DAILY_TOKEN_BUDGET", "0"))
BUDGET_WINDOW_SECONDS = 24 * 60 * 60

REPLICA_WARNING = (
    "Chat rate limiting and the token budget are per-process. Running more "
    "than one ai-fde replica multiplies both limits by the replica count; "
    "move them to a shared store before scaling out."
)


class RateLimited(Exception):
    """Raised when a caller must wait. `retry_after` is in seconds."""

    def __init__(self, message: str, retry_after: int) -> None:
        super().__init__(message)
        self.retry_after = retry_after


@dataclass
class _Bucket:
    tokens: float
    updated: float


@dataclass
class _Spend:
    # (timestamp, tokens) samples inside the rolling window.
    samples: list[tuple[float, int]] = field(default_factory=list)


class ChatLimiter:
    def __init__(
        self,
        rate_per_minute: float = RATE_PER_MINUTE,
        burst: float = RATE_BURST,
        daily_token_budget: int = DAILY_TOKEN_BUDGET,
    ) -> None:
        self.rate_per_second = rate_per_minute / 60.0
        self.burst = burst
        self.daily_token_budget = daily_token_budget
        self._buckets: dict[str, _Bucket] = {}
        self._spend: dict[str, _Spend] = {}
        # Uvicorn runs this on one event loop, but the lock keeps the state
        # correct if the service is ever run with more than one worker thread.
        self._lock = threading.Lock()

    # ── request rate ────────────────────────────────────────────────────────

    def check_rate(self, key: str) -> None:
        """Consume one request token, or raise RateLimited."""
        now = time.monotonic()
        with self._lock:
            bucket = self._buckets.get(key)
            if bucket is None:
                self._buckets[key] = _Bucket(tokens=self.burst - 1, updated=now)
                return

            elapsed = now - bucket.updated
            bucket.tokens = min(
                self.burst, bucket.tokens + elapsed * self.rate_per_second
            )
            bucket.updated = now

            if bucket.tokens < 1:
                # How long until one whole token is available again.
                deficit = 1 - bucket.tokens
                retry_after = max(1, int(deficit / self.rate_per_second) + 1)
                raise RateLimited(
                    f"Too many requests. Try again in {retry_after}s.", retry_after
                )
            bucket.tokens -= 1

    # ── spend ───────────────────────────────────────────────────────────────

    def check_budget(self, key: str) -> None:
        """Refuse a new turn when the rolling token budget is already spent."""
        if self.daily_token_budget <= 0:
            return
        used = self.tokens_used(key)
        if used >= self.daily_token_budget:
            raise RateLimited(
                f"Daily token budget of {self.daily_token_budget:,} is used up "
                f"({used:,} consumed). It refills on a rolling 24-hour window.",
                retry_after=3600,
            )

    def record_usage(self, key: str, tokens: int) -> None:
        """Record what a completed turn actually cost."""
        if self.daily_token_budget <= 0 or tokens <= 0:
            return
        now = time.time()
        with self._lock:
            spend = self._spend.setdefault(key, _Spend())
            spend.samples.append((now, tokens))
            self._prune(spend, now)

    def tokens_used(self, key: str) -> int:
        now = time.time()
        with self._lock:
            spend = self._spend.get(key)
            if spend is None:
                return 0
            self._prune(spend, now)
            return sum(count for _, count in spend.samples)

    @staticmethod
    def _prune(spend: _Spend, now: float) -> None:
        cutoff = now - BUDGET_WINDOW_SECONDS
        spend.samples = [s for s in spend.samples if s[0] >= cutoff]

    # ── introspection, for /health ──────────────────────────────────────────

    def snapshot(self, key: str) -> dict[str, object]:
        return {
            "ratePerMinute": self.rate_per_second * 60,
            "burst": self.burst,
            "dailyTokenBudget": self.daily_token_budget,
            "tokensUsed24h": self.tokens_used(key),
        }


limiter = ChatLimiter()
