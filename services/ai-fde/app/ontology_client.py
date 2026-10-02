"""The HTTP client every tool reaches the ontology service through.

Split out of tools.py so the capability tools (modes, plans, notepad,
permissions) can share one client without a circular import: tools.py
aggregates both tool sets and must stay the single registry.

The rules that shaped it live unchanged from tools.py:

  * EVERY CALL CARRIES THE CALLER'S TOKEN. The assistant has no service
    identity of its own; a call without a token is answered 401, which is the
    correct outcome.
  * THE SPACE TRAVELS WITH THE CALL. The ontology is per-space, and a tool
    that does not name one would read the sandbox's while the user is
    elsewhere.
  * THE CORRELATION ID TRAVELS TOO, so one chat turn and the queries it caused
    share one grep-able id.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from .config import CONFIG
from .context import current_request_id, current_space, current_token

log = logging.getLogger("ai_fde.tools")


class OntologyClient:
    def __init__(self, base_url: str | None = None) -> None:
        self.base_url = (base_url or CONFIG.ontology_service_url).rstrip("/")

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        url = f"{self.base_url}{path}"

        # Forward the caller's bearer token. Without one the ontology service
        # answers 401, which is the correct outcome: there is no ambient
        # service identity here that could read the ontology on nobody's
        # behalf.
        headers = dict(kwargs.pop("headers", None) or {})
        token = current_token.get()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        # Carry the correlation id downstream so the ontology service logs the
        # same id against the queries this turn caused.
        request_id = current_request_id.get()
        if request_id:
            headers["X-Request-ID"] = request_id
        if headers:
            kwargs["headers"] = headers

        # Every call is made in the conversation's space, so the assistant
        # reads the ontology of the environment the user is actually in. A
        # tool that set its own space explicitly keeps it.
        params = dict(kwargs.pop("params", None) or {})
        params.setdefault("space", current_space.get())
        kwargs["params"] = params

        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.request(method, url, **kwargs)
        if response.status_code >= 400:
            # Pass the service's own message through: it usually names the valid
            # options, which is exactly what the model needs to recover.
            try:
                detail = response.json().get("error") or response.text
            except Exception:
                detail = response.text
            if response.status_code == 409:
                # The space has no published ontology. A distinct type because
                # the answer is "nothing has been published here yet", which is
                # worth saying plainly rather than reporting as a failed call.
                raise NoOntologyInSpace(detail)
            raise ToolError(f"{method} {path} failed ({response.status_code}): {detail}")
        if response.status_code == 204:
            return None
        return response.json()

    async def get(self, path: str, **kwargs: Any) -> Any:
        return await self._request("GET", path, **kwargs)

    async def post(self, path: str, json_body: Any = None) -> Any:
        return await self._request("POST", path, json=json_body or {})

    async def delete(self, path: str) -> Any:
        return await self._request("DELETE", path)


class ToolError(RuntimeError):
    pass


class NoOntologyInSpace(ToolError):
    """Raised where the conversation's space has no published ontology."""


client = OntologyClient()
