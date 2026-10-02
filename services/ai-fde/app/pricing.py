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
import re
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
    # Prompt-cache reads and writes, where the provider prices them apart from
    # ordinary input. None means "same as input".
    cache_read_per_m: float | None = None
    cache_write_per_m: float | None = None

    @property
    def is_free(self) -> bool:
        return self.input_per_m == 0.0 and self.output_per_m == 0.0


# Claude list prices, USD per million tokens: input, output, cache read. A
# 5-minute cache write is 1.25x input. Check them against the pricing page and
# an invoice; COST_ANTHROPIC_* overrides every one of them.
CLAUDE_LIST_PRICES: dict[str, tuple[float, float, float]] = {
    "claude-opus-5-5": (4.00, 20.00, 0.20),
    "claude-sonnet-5-5": (2.00, 10.00, 0.20),
    "claude-fable-5-1": (10.00, 50.00, 0.25),
}


def claude_rate(model: str) -> Rate | None:
    base = re.sub(r"-\d{8}$", "", (model or "").strip().lower())
    if os.environ.get("COST_ANTHROPIC_INPUT_PER_M"):
        input_per_m = _rate("COST_ANTHROPIC_INPUT_PER_M", 0.0)
        return Rate(
            input_per_m=input_per_m,
            output_per_m=_rate("COST_ANTHROPIC_OUTPUT_PER_M", 0.0),
            source="configured",
            cache_read_per_m=_rate("COST_ANTHROPIC_CACHE_READ_PER_M", input_per_m * 0.1),
            cache_write_per_m=_rate("COST_ANTHROPIC_CACHE_WRITE_PER_M", input_per_m * 1.25),
        )
    listed = CLAUDE_LIST_PRICES.get(base)
    if listed is None:
        return None
    input_per_m, output_per_m, read_per_m = listed
    return Rate(
        input_per_m=input_per_m,
        output_per_m=output_per_m,
        source=f"list price for {base} (verify)",
        cache_read_per_m=read_per_m,
        cache_write_per_m=input_per_m * 1.25,
    )


def rate_for(provider: str, model: str) -> Rate | None:
    """The rate for the model that actually answered.

    Claude is priced by model rather than by provider: a refusal fallback can
    answer from a different model than the one configured.
    """
    if provider == "anthropic":
        return claude_rate(model)
    return rates().get(provider)


def rates() -> dict[str, Rate]:
    """Per-provider rates, read at call time so a restart picks up a change."""
    from .config import CONFIG

    table = {
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
        # Any OpenAI-compatible endpoint: priced only when configured, because
        # the same API fronts very different models and gateways.
        "openai": Rate(
            input_per_m=_rate("COST_OPENAI_INPUT_PER_M", 2.00),
            output_per_m=_rate("COST_OPENAI_OUTPUT_PER_M", 8.00),
            source="configured" if os.environ.get("COST_OPENAI_INPUT_PER_M") else "gpt-4.1 list price (verify)",
        ),
        # No model is called at all.
        "builtin": Rate(0.0, 0.0, "no model: the built-in planner"),
    }
    claude = claude_rate(CONFIG.anthropic_model)
    if claude is not None:
        table["anthropic"] = claude
    return table


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
    # Of the prompt tokens, those read from or written to the prompt cache,
    # which Claude prices apart from ordinary input.
    cache_read = min(count("cacheReadTokens"), prompt)
    cache_write = min(count("cacheWriteTokens"), prompt - cache_read)

    rate = rate_for(provider, model)
    if rate is None:
        return Cost(prompt, completion, total, 0.0, 0.0, 0.0, provider, model, priced=False)

    read_per_m = rate.input_per_m if rate.cache_read_per_m is None else rate.cache_read_per_m
    write_per_m = rate.input_per_m if rate.cache_write_per_m is None else rate.cache_write_per_m
    cost = (
        ((prompt - cache_read - cache_write) / 1_000_000) * rate.input_per_m
        + (cache_read / 1_000_000) * read_per_m
        + (cache_write / 1_000_000) * write_per_m
        + (completion / 1_000_000) * rate.output_per_m
    )

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
