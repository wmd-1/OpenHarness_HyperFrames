"""F2: WS proxy credential forwarding (change fix-session-review-2026-07).

The gateway must forward the *connecting client's* own credential to the
owning node so the owner authenticates the client's tenant. Before F2 the
proxy injected this node's legacy single ``settings.api_key``, which both
impersonated the wrong tenant under multi-key auth and broke when nodes
migrate off the legacy key.
"""

from __future__ import annotations

import pytest
from pydantic import SecretStr

from app.config import settings
from app.session import proxy, registry
from app.session.registry import RouteEntry
from tests.test_proxy import FakeWebSocket


async def _remote_route(sid: str) -> None:
    r = await registry._client()
    entry = RouteEntry(node_id="other-node", pid=42, epoch=1)
    await r.set(registry._route_key(sid), entry.to_json())


def _capture(monkeypatch) -> dict:
    captured: dict = {}

    def _connect(target, **kwargs):
        captured["target"] = target
        captured["headers"] = kwargs.get("additional_headers")
        raise ConnectionRefusedError("owner down")

    monkeypatch.setattr(proxy.websockets, "connect", _connect)
    return captured


@pytest.mark.asyncio
async def test_client_key_forwarded_even_when_node_has_legacy_key(monkeypatch):
    """The client's key wins — the node's own legacy key is never injected."""
    await _remote_route("sid-cred-1")
    monkeypatch.setattr(settings, "api_key", SecretStr("sk-node-legacy"))
    captured = _capture(monkeypatch)

    ws = FakeWebSocket()
    proxied = await proxy.proxy_ws(
        ws,
        "sid-cred-1",
        "/v1/sessions/sid-cred-1/ws",
        "",
        client_api_key="sk-client",
    )
    assert proxied is True
    assert captured["headers"] == {"X-API-Key": "sk-client"}


@pytest.mark.asyncio
async def test_open_mode_forwards_no_auth_header(monkeypatch):
    """No client credential (open mode) -> no X-API-Key header, even if the
    node itself still carries a legacy key."""
    await _remote_route("sid-cred-2")
    monkeypatch.setattr(settings, "api_key", SecretStr("sk-node-legacy"))
    captured = _capture(monkeypatch)

    ws = FakeWebSocket()
    proxied = await proxy.proxy_ws(
        ws,
        "sid-cred-2",
        "/v1/sessions/sid-cred-2/ws",
        "",
        client_api_key=None,
    )
    assert proxied is True
    assert captured["headers"] == {}
