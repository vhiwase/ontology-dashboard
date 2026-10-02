"""Request-scoped context shared between the auth layer and the tool layer.

The assistant queries the ontology service on the caller's behalf, so those
calls have to carry the caller's own token rather than a service account's.
There are around twenty tool functions and they all reach the ontology through
one module-level client, so threading a token through every signature would
touch all of them.

A ContextVar instead holds the token for the duration of one request. Each
asyncio task gets its own copy, so concurrent chats cannot see each other's
credential, and a tool that runs without one simply has no token to send.
"""

from __future__ import annotations

from contextvars import ContextVar
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .modes import SessionAgentState

# The raw bearer token of the request being served, or None outside a request.
current_token: ContextVar[str | None] = ContextVar("current_token", default=None)

# The correlation id for the request being served. It arrives as X-Request-ID
# from nginx or from the caller, is echoed back on the response, and is
# forwarded on every downstream call, so one user action can be followed from
# the browser through this service into the ontology service by grepping a
# single id.
current_request_id: ContextVar[str | None] = ContextVar("current_request_id", default=None)

# The space the conversation belongs to. The ontology is per-space — object
# types, links, actions and metrics are built from that space's datasets — so
# a tool call that does not name one reads the sandbox's
# and answers a question about the wrong environment. Held here for the same
# reason as the token: every tool reaches the ontology through one client, and
# this is the one place that has to know.
current_space: ContextVar[str] = ContextVar("current_space", default="sandbox")

# The conversation's agent state - active mode, enabled capabilities, plan and
# todos. The stateful tools (change_mode, generate_plan, notepad, ...) read and
# mutate it through here rather than taking it as an argument, for the same
# reason the token travels this way: every tool would otherwise carry it, and
# each asyncio task gets its own copy so concurrent chats cannot bleed state.
current_session_state: ContextVar["SessionAgentState | None"] = ContextVar(
    "current_session_state", default=None
)

# The signed-in username the conversation runs as. Tools that write something
# the user owns - notepad documents especially - need the principal without
# every implementation threading it through.
current_user: ContextVar[str | None] = ContextVar("current_user", default=None)
