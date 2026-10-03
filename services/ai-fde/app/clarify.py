"""Questions asked in prose, made answerable with a click.

The model is told to ask through request_clarification, and the prompt says
so plainly. It does not always comply: a reply can still end "Would you like
to model all three, or focus on one first?", and the person reading it then
has nothing to select - only a text box and the job of retyping a choice the
reply already spelled out.

So when a reply closes by asking something and carries no clarification of
its own, one small extra call turns that question into the same structured
choices. It reads only the user's message and the reply - a few hundred
tokens, not the conversation - and it is forced to answer through the
request_clarification schema, so the result is the same shape the agent
produces when it does use the tool. Its tokens are added to the turn's usage,
so the extra call is priced and counted against the person's credit.

"Closes by asking" is read generously, from how replies actually end: the
question is often not the last character. It is followed by a citation marker
("...for reporting? :citation[...]{...}") or by one more sentence ("Would you
like me to proceed? If so, I will show you the plan first."). So the test is
whether the closing passage contains a question at all; whether that question
is really put to the reader, and what its choices are, is the extra call's to
judge - and it answers with no options when there is nothing to choose.

It never invents a choice: the options must come from the reply itself, and a
question with nothing concrete to choose from yields no clarification at all.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from .llm import LlmError, LlmProvider
from .ontology_client import ToolError
from .tools import request_clarification, schemas_for

log = logging.getLogger("ai_fde.clarify")

# What a reply can carry that is not prose: the markers the UI renders as a
# citation or a resource chip, fenced code and inline code. A "?" inside any of
# them (a URL's query string, a SQL placeholder) is not a question.
_DIRECTIVE = re.compile(r":[a-z]+\[[^\]]*\](\{[^}]*\})?")
_FENCED = re.compile(r"```.*?```", re.DOTALL)
_INLINE_CODE = re.compile(r"`[^`\n]*`")

# How much of the end of a reply counts as its close: the last two paragraphs,
# and no more than this many characters of them.
_CLOSING_PARAGRAPHS = 2
_CLOSING_CHARACTERS = 700

SYSTEM = (
    "You turn the question an assistant's reply puts to the person into choices they can "
    "click. Call request_clarification with:\n"
    "- question: the question the reply asks the person, as one short sentence in the "
    "reply's language;\n"
    "- options: 2 to 12 short, concrete answers taken from the reply itself - the tables, "
    "datasets, metrics or alternatives it names. For an offer such as 'Would you like me "
    "to...?' or 'Shall I...?', give the offered action as the person would say it "
    "('Yes, model ingest_run now') and a way to decline ('No, not now'); when the reply "
    "offers several next steps, give each as its own option;\n"
    "- multiple: true only when the question lets the person pick several at once, such as "
    "which tables to sync or which datasets to model;\n"
    "- allowFreeText: true;\n"
    "- message: leave it out - the reply is already on the person's screen.\n"
    "Never invent an option the reply does not offer. Call it with an empty options list "
    "when the reply asks the person nothing - a rhetorical question, or one it answers "
    "itself - or when the question is open-ended and the reply offers nothing concrete to "
    "choose."
)


def closing_passage(reply: str) -> str:
    """The prose a reply ends with, without markers and code."""
    prose = _INLINE_CODE.sub(" ", _FENCED.sub(" ", _DIRECTIVE.sub(" ", reply or "")))
    paragraphs = [block.strip() for block in re.split(r"\n\s*\n", prose) if block.strip()]
    return "\n".join(paragraphs[-_CLOSING_PARAGRAPHS:])[-_CLOSING_CHARACTERS:]


def asks_something(reply: str) -> bool:
    """Whether the reply closes with a question - one worth a look, not yet a verdict."""
    return "?" in closing_passage(reply)


def _add_usage(total: dict[str, Any], extra: dict[str, Any]) -> dict[str, Any]:
    merged = dict(total or {})
    for key in ("promptTokens", "completionTokens", "totalTokens"):
        value = (extra or {}).get(key)
        if isinstance(value, (int, float)):
            merged[key] = int(merged.get(key) or 0) + int(value)
    return merged


async def infer_clarification(
    provider: LlmProvider,
    user_message: str,
    reply: str,
    usage: dict[str, Any],
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    """The question a reply closes with, as a clarification artifact, if it has one.

    Returns the artifact (or None) and the turn's usage with this call's tokens
    added. Any failure is logged and ignored: the reply stands on its own, and
    an answer must never be lost over a convenience.
    """
    # Only a provider that calls tools can be forced to; the built-in planner
    # writes its own structured output and never needs this.
    if provider.name != "azure_openai" or not asks_something(reply):
        return None, usage
    messages = [
        {"role": "system", "content": SYSTEM},
        {
            "role": "user",
            "content": f"The person asked:\n{(user_message or '')[:2000]}\n\nThe assistant replied:\n{reply[-6000:]}",
        },
    ]
    try:
        answer = await provider.chat(
            messages,
            tools=schemas_for({"request_clarification"}),
            tool_choice={"type": "function", "function": {"name": "request_clarification"}},
        )
    except LlmError as exc:
        log.warning("Could not structure the closing question: %s", exc)
        return None, usage

    usage = _add_usage(usage, answer.usage)
    call = next((c for c in answer.tool_calls if c.name == "request_clarification"), None)
    if call is None:
        return None, usage
    try:
        payload = await request_clarification(call.arguments)
    except ToolError:
        return None, usage
    if len(payload["options"]) < 2:
        return None, usage
    return (
        {
            "kind": "clarification",
            "question": payload["question"],
            "options": payload["options"],
            "multiple": payload["multiple"],
            "allowFreeText": True,
            # Read off the reply rather than asked through the tool, so the UI
            # keeps the reply's own text above the choices.
            "inferred": True,
        },
        usage,
    )
