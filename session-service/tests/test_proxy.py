"""Tests for app.session.proxy — multi-node transparent WS proxy (Task 3.1).

Covers: owner base-URL resolution, WS target URL building, local/remote
routing decisions, and error handling when the owning node is unreachable
(accept + close 4502, never a client-facing redirect).
"""

from __future__ import annotations

import pytest

from app.config import settings
from app.session import proxy, registry
from app.session.registry import RouteEntry


class FakeWebSocket:
    """Records accept/close calls made by proxy_ws."""

    def __init__(self) -> None:
        self.accepted = False
        self.closed: tuple[int, str] | None = None
        self.sent: list[str] = []

    async def accept(self) -> None:
        self.accepted = True

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = (code, reason)

    async def receive_text(self) -> str:
        raise RuntimeError("client gone")

    async def send_text(self, msg: str) -> None:
        self.sent.append(msg)


# --- URL resolution ----------------------------------------------------------


def test_node_base_url_explicit_setting(monkeypatch):
    monkeypatch.setattr(settings, "node_base_url", "http://gateway-2:9000/")
    assert proxy._node_base_url("whatever") == "http://gateway-2:9000"


def test_node_base_url_falls_back_to_node_id_hostname(monkeypatch):
    monkeypatch.setattr(settings, "node_base_url", None)
    assert proxy._node_base_url("node-b") == f"http://node-b:{settings.api_port}"


def test_ws_target_url_builds_ws_scheme_with_query(monkeypatch):
    monkeypatch.setattr(settings, "node_base_url", "http://node-b:8001")
    url = proxy._ws_target_url("node-b", "/v1/sessions/abc/ws", "last_turn_index=2")
    assert url == "ws://node-b:8001/v1/sessions/abc/ws?last_turn_index=2"


def test_ws_target_url_without_query(monkeypatch):
    monkeypatch.setattr(settings, "node_base_url", None)
    url = proxy._ws_target_url("node-c", "/v1/sessions/x/ws", "")
    assert url == f"ws://node-c:{settings.api_port}/v1/sessions/x/ws"


# --- Routing decisions --------------------------------------------------------


@pytest.mark.asyncio
async def test_proxy_ws_no_route_serves_locally():
    ws = FakeWebSocket()
    proxied = await proxy.proxy_ws(ws, "sid-none", "/v1/sessions/sid-none/ws", "")
    assert proxied is False
    assert ws.accepted is False


@pytest.mark.asyncio
async def test_proxy_ws_local_owner_serves_locally():
    # register_route publishes under this node's node_id ("test-node").
    await registry.register_route("sid-local", pid=1, epoch=1)
    ws = FakeWebSocket()
    proxied = await proxy.proxy_ws(ws, "sid-local", "/v1/sessions/sid-local/ws", "")
    assert proxied is False
    assert ws.accepted is False


@pytest.mark.asyncio
async def test_proxy_ws_remote_owner_unreachable_closes_4502(monkeypatch):
    """Owner node down -> accept, close 4502, and report handled (True)."""
    r = await registry._client()
    entry = RouteEntry(node_id="other-node", pid=42, epoch=1)
    await r.set(registry._route_key("sid-remote"), entry.to_json())

    def _connect_fails(*_args, **_kwargs):
        raise ConnectionRefusedError("owner down")

    monkeypatch.setattr(proxy.websockets, "connect", _connect_fails)
    ws = FakeWebSocket()
    proxied = await proxy.proxy_ws(ws, "sid-remote", "/v1/sessions/sid-remote/ws", "")
    assert proxied is True
    assert ws.accepted is True
    assert ws.closed is not None
    assert ws.closed[0] == 4502


@pytest.mark.asyncio
async def test_proxy_ws_forwards_api_key_header(monkeypatch):
    """The gateway forwards X-API-Key so the owner can authenticate the client."""
    from pydantic import SecretStr

    r = await registry._client()
    entry = RouteEntry(node_id="other-node", pid=42, epoch=1)
    await r.set(registry._route_key("sid-auth"), entry.to_json())
    monkeypatch.setattr(settings, "api_key", SecretStr("sk-proxy-secret"))

    captured: dict = {}

    def _capture_connect(target, **kwargs):
        captured["target"] = target
        captured["headers"] = kwargs.get("additional_headers")
        raise ConnectionRefusedError("owner down")

    monkeypatch.setattr(proxy.websockets, "connect", _capture_connect)
    ws = FakeWebSocket()
    proxied = await proxy.proxy_ws(ws, "sid-auth", "/v1/sessions/sid-auth/ws", "q=1")
    assert proxied is True
    assert captured["target"].startswith("ws://other-node:")
    assert captured["target"].endswith("/v1/sessions/sid-auth/ws?q=1")
    assert captured["headers"] == {"X-API-Key": "sk-proxy-secret"}
