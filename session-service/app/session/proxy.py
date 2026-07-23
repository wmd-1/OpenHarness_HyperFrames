"""Transparent reverse-proxy forwarding for multi-node affinity (spec D4).

When a WS connects to a gateway that does NOT own the session's live process,
the gateway transparently proxies the connection (including WS) to the owning
node — it MUST NOT 307-redirect the client. Clients always connect to a uniform
``/v1/sessions/**`` and never learn the owner node.

Each node publishes a reachable base URL (``OH_NODE_BASE_URL``) alongside its
``node_id`` in the routing table so a peer can build the proxy target. In a
compose deployment ``node_id`` is typically the service hostname and
``node_base_url`` is ``http://<hostname>:<port>``.

Bidirectional WS piping uses the ``websockets`` library (a hard dependency).
"""

from __future__ import annotations

import asyncio
import logging
from urllib.parse import urlparse

import websockets
from fastapi import WebSocket

from app.config import settings
from app.session.registry import RouteEntry, get_route

log = logging.getLogger(__name__)


def _node_base_url(node_id: str) -> str | None:
    """Resolve the HTTP base URL for a node_id.

    In the common compose case ``OH_NODE_BASE_URL`` is unset and node_id is the
    service hostname; we fall back to ``http://<node_id>:<api_port>``.
    """
    explicit = settings.node_base_url
    if explicit:
        return explicit.rstrip("/")
    return f"http://{node_id}:{settings.api_port}"


def _ws_target_url(node_id: str, path: str, query: str) -> str | None:
    base = _node_base_url(node_id)
    if base is None:
        return None
    parsed = urlparse(base)
    host = parsed.hostname
    port = parsed.port or settings.api_port
    qs = f"?{query}" if query else ""
    return f"ws://{host}:{port}{path}{qs}"


async def proxy_ws(websocket: WebSocket, sid: str, path: str, query: str) -> bool:
    """Transparently proxy an inbound WS to the owning node.

    Returns True if proxied (the caller must not handle the connection further),
    False if the session is owned locally (caller proceeds normally).
    """
    route = await get_route(sid)
    if route is None:
        return False  # no route -> serve locally (single-node / first connect)
    if route.node_id == (settings.node_id or "local"):
        return False  # we own it

    # Another node owns it — proxy.
    target = _ws_target_url(route.node_id, path, query)
    if target is None:
        log.warning("cannot resolve owner URL for node=%s; serving locally", route.node_id)
        return False

    await websocket.accept()
    try:
        # Forward the API key so the owner can authenticate the proxied client.
        headers = {}
        if settings.api_key is not None:
            headers["X-API-Key"] = settings.api_key.get_secret_value()
        async with websockets.connect(target, additional_headers=headers) as upstream:
            async def _client_to_upstream():
                try:
                    while True:
                        msg = await websocket.receive_text()
                        await upstream.send(msg)
                except Exception:
                    pass

            async def _upstream_to_client():
                try:
                    async for msg in upstream:
                        await websocket.send_text(msg if isinstance(msg, str) else msg.decode())
                except Exception:
                    pass

            await asyncio.gather(_client_to_upstream(), _upstream_to_client())
    except Exception as exc:
        log.warning("ws proxy to %s failed: %s", route.node_id, exc)
        try:
            await websocket.close(code=4502, reason="proxy failed")
        except Exception:
            pass
    return True
