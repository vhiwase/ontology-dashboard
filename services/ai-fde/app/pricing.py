"""What a turn costs.

Tokens were already metered for the rate limiter, but never priced, so "what
is this assistant costing us" had no answer. Tokens alone do not answer it
either: input and output are priced differently, the rate differs per model,
and a turn can fail over from a free local model to a paid hosted one.

RATES ARE CONFIGURATION, NOT CONSTANTS. The defaults below are list prices and
are the thing most likely to be out of date in this file: Azure pricing varies
by region, by commitment and over time, and an enterprise agreement usually
does not pay list. An administrator can set the real ones in the admin
console; .env is the fallback, then the list price. Check them against an
actual invoice before anyone makes a decision on these numbers.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from . import settings


def _rate(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class Rate:
    """USD per million tokens."""

    input_per_m: float
    output_per_m: float
    source: str

    @property
    def is_free(self) -> bool:
        return self.input_per_m == 0.0 and self.output_per_m == 0.0


def rates() -> dict[str, Rate]:
    """Per-provider rates, read at call time so a change applies to the next turn.

    The admin console's price wins over .env, which wins over the list price.
    Each half of the Azure rate falls back on its own, so setting only the
    output price leaves the input price where it was.
    """
    admin_input = settings.number("pricing.azureInputPerMillion")
    admin_output = settings.number("pricing.azureOutputPerMillion")
    if admin_input is not None or admin_output is not None:
        source = "set by an administrator"
    elif os.environ.get("COST_AZURE_INPUT_PER_M"):
        source = "configured"
    else:
        source = "list price (verify)"
    return {
        # Azure OpenAI list price for gpt-4.1 at the time of writing.
        "azure_openai": Rate(
            input_per_m=admin_input if admin_input is not None else _rate("COST_AZURE_INPUT_PER_M", 2.00),
            output_per_m=admin_output if admin_output is not None else _rate("COST_AZURE_OUTPUT_PER_M", 8.00),
            source=source,
        ),
        # The built-in planner calls no model, so a turn it answers costs nothing.
        "builtin": Rate(input_per_m=0.0, output_per_m=0.0, source="no model"),
    }


@dataclass(frozen=True)
class Cost:
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    cost_usd: float
    rate_input_per_m: float
    rate_output_per_m: float
    provider: str
    model: str
    # A turn whose provider has no rate entry is priced at zero AND flagged, so
    # an unpriced model shows up as a gap rather than as "free".
    priced: bool


def price_turn(
    provider: str,
    model: str,
    usage: dict[str, object] | None,
) -> Cost:
    """Price one assistant turn from the usage the provider reported."""
    usage = usage or {}

    def count(key: str) -> int:
        value = usage.get(key)
        return int(value) if isinstance(value, (int, float)) else 0

    prompt = count("promptTokens")
    completion = count("completionTokens")
    total = count("totalTokens") or (prompt + completion)

    table = rates()
    rate = table.get(provider)
    if rate is None:
        return Cost(prompt, completion, total, 0.0, 0.0, 0.0, provider, model, priced=False)

    cost = (prompt / 1_000_000) * rate.input_per_m + (
        completion / 1_000_000
    ) * rate.output_per_m

    return Cost(
        prompt_tokens=prompt,
        completion_tokens=completion,
        total_tokens=total,
        # Rounded to the micro-dollar: a single turn can cost less than a cent
        # and rounding to cents would report every one of them as zero.
        cost_usd=round(cost, 6),
        rate_input_per_m=rate.input_per_m,
        rate_output_per_m=rate.output_per_m,
        provider=provider,
        model=model,
        priced=True,
    )
