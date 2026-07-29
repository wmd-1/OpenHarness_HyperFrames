"""Tests for the /v1/sessions REST API."""

from __future__ import annotations

import pytest


@pytest.mark.asyncio
async def test_create_session_returns_201(client):
    resp = await client.post("/v1/sessions", json={"permission_policy": "full_auto"})
    assert resp.status_code == 201
    data = resp.json()
    assert data["status"] == "live"
    assert data["ws_url"].endswith("/ws")
    assert data["oh_session_id"]


@pytest.mark.asyncio
async def test_create_session_rejects_bad_extra_args(client):
    resp = await client.post(
        "/v1/sessions", json={"extra_oh_args": ["--permission-mode", "x"]}
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_get_session(client):
    create = await client.post("/v1/sessions", json={})
    sid = create.json()["session_id"]
    resp = await client.get(f"/v1/sessions/{sid}")
    assert resp.status_code == 200
    assert resp.json()["session_id"] == sid


@pytest.mark.asyncio
async def test_get_unknown_session_404(client):
    resp = await client.get("/v1/sessions/00000000-0000-0000-0000-000000000000")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_session(client):
    create = await client.post("/v1/sessions", json={})
    sid = create.json()["session_id"]
    resp = await client.delete(f"/v1/sessions/{sid}")
    assert resp.status_code == 200
    assert resp.json()["status"] == "closed"


@pytest.mark.asyncio
async def test_rest_turn_returns_409_when_not_live(client):
    """Non-WS turn on a non-live session returns 409 (spec scenario)."""
    create = await client.post("/v1/sessions", json={})
    sid = create.json()["session_id"]
    # The session IS live here (just created); this checks the 409 path requires
    # a live process. We delete first to make it non-live.
    await client.delete(f"/v1/sessions/{sid}")
    resp = await client.post(
        f"/v1/sessions/{sid}/turns", json={"text": "hello"}
    )
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_rest_turn_completes(client):
    create = await client.post("/v1/sessions", json={})
    sid = create.json()["session_id"]
    resp = await client.post(f"/v1/sessions/{sid}/turns", json={"text": "hello"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "completed"
    assert data["turn_index"] == 0


@pytest.mark.asyncio
async def test_create_session_503_when_capacity_full(client, monkeypatch):
    """Node capacity exhausted, nothing evictable, queue disabled -> 503 (openspec A)."""
    from app.config import settings

    # Zero capacity + no wait queue: pool admission degrades to the pre-pool
    # fail-fast CapacityFullError (WS-D queue_size=0 semantics).
    monkeypatch.setattr(settings, "max_live_sessions", 0)
    monkeypatch.setattr(settings, "pool_queue_size", 0)
    # Unique XFF isolates this test from the shared rate-limit bucket.
    resp = await client.post(
        "/v1/sessions", json={}, headers={"X-Forwarded-For": "203.0.113.1"}
    )
    assert resp.status_code == 503
    assert "capacity full" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_create_session_rate_limited_returns_429(client, monkeypatch):
    """POST /v1/sessions is rate-limited (shared token bucket) -> 429 (openspec B)."""
    from app.routers import sessions as sessions_module

    state = {"n": 0}

    async def _limited(client_ip):
        state["n"] += 1
        return state["n"] <= 1  # first allowed, subsequent denied

    monkeypatch.setattr(sessions_module, "check_rate_limit", _limited)
    r1 = await client.post("/v1/sessions", json={})
    assert r1.status_code == 201
    r2 = await client.post("/v1/sessions", json={})
    assert r2.status_code == 429


# --- Artifact download Range handling (Task 3.5) ------------------------------


async def _session_with_artifact(client) -> tuple[str, int]:
    """Create a session, run one turn, and return (sid, artifact size)."""
    create = await client.post("/v1/sessions", json={})
    sid = create.json()["session_id"]
    turn = await client.post(f"/v1/sessions/{sid}/turns", json={"text": "render"})
    assert turn.status_code == 200
    full = await client.get(f"/v1/sessions/{sid}/turns/0/artifact")
    assert full.status_code == 200
    return sid, int(full.headers["content-length"])


@pytest.mark.asyncio
async def test_artifact_range_parsed_to_206_partial_content(client):
    sid, size = await _session_with_artifact(client)
    if size < 8:
        pytest.skip("stub mp4 too small for range test")
    resp = await client.get(
        f"/v1/sessions/{sid}/turns/0/artifact", headers={"Range": "bytes=0-4"}
    )
    assert resp.status_code == 206
    assert resp.headers["content-range"] == f"bytes 0-4/{size}"
    assert resp.headers["content-length"] == "5"
    assert len(resp.content) == 5


@pytest.mark.asyncio
async def test_artifact_open_ended_range_returns_tail(client):
    sid, size = await _session_with_artifact(client)
    if size < 8:
        pytest.skip("stub mp4 too small for range test")
    resp = await client.get(
        f"/v1/sessions/{sid}/turns/0/artifact", headers={"Range": f"bytes={size - 4}-"}
    )
    assert resp.status_code == 206
    assert resp.headers["content-range"] == f"bytes {size - 4}-{size - 1}/{size}"
    assert int(resp.headers["content-length"]) == 4
    assert len(resp.content) == 4


@pytest.mark.asyncio
async def test_artifact_no_range_returns_200_full_body(client):
    sid, size = await _session_with_artifact(client)
    resp = await client.get(f"/v1/sessions/{sid}/turns/0/artifact")
    assert resp.status_code == 200
    assert resp.headers.get("accept-ranges") == "bytes"
    assert len(resp.content) == size
