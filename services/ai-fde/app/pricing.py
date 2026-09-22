"""What a turn costs.

Tokens were already metered for the rate limiter, but never priced, so "what
is this assistant costing us" had no answer. Tokens alone do not answer it
either: input and output are priced differently, the rate differs per model,
and a turn can fail over from a free local model to a paid hosted one.

RATES ARE CONFIGURATION, NOT CONSTANTS. The defaults below are list prices and
are the thing most likely to be out of date in this file: Azure pricing varies
by region, by commitment and over time, and an enterprise agreement usually
does not pay list. Set the real ones in .env and check them against an actual
invoice before anyone makes a decision on these numbers.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


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
    """Per-provider rates, read at call time so a restart picks up a change."""
    return {
        # Azure OpenAI list price for gpt-4.1 at the time of writing.
        "azure_openai": Rate(
            input_per_m=_rate("COST_AZURE_INPUT_PER_M", 2.00),
            output_per_m=_rate("COST_AZURE_OUTPUT_PER_M", 8.00),
            source="configured" if os.environ.get("COST_AZURE_INPUT_PER_M") else "list price (verify)",
        ),
        # Self-hosted: no per-token charge. Not free in reality - it burns
        # electricity and hardware - but there is no per-call price to attribute,
        # and inventing one would make the comparison with Azure dishonest.
        "ollama": Rate(0.0, 0.0, "self-hosted, no per-token charge"),
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
