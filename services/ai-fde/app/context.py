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

# The raw bearer token of the request being served, or None outside a request.
current_token: ContextVar[str | None] = ContextVar("current_token", default=None)

# The correlation id for the request being served. It arrives as X-Request-ID
# from nginx or from the caller, is echoed back on the response, and is
# forwarded on every downstream call, so one user action can be followed from
# the browser through this service into the ontology service by grepping a
# single id.
current_request_id: ContextVar[str | None] = ContextVar("current_request_id", default=None)
