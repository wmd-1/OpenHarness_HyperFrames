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
