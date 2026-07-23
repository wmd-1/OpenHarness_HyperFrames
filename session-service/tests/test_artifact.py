"""Tests for per-turn artifact download with HTTP Range (spec: 3.6)."""

from __future__ import annotations

import pytest

from app.session.supervisor import get_supervisor


async def _create_session_with_turn(client):
    create = await client.post("/v1/sessions", json={})
    sid = create.json()["session_id"]
    resp = await client.post(f"/v1/sessions/{sid}/turns", json={"text": "render"})
    assert resp.status_code == 200
    return sid


@pytest.mark.asyncio
async def test_artifact_download_full(client):
    sid = await _create_session_with_turn(client)
    resp = await client.get(f"/v1/sessions/{sid}/turns/0/artifact")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "video/mp4"
    assert resp.headers.get("accept-ranges") == "bytes"


@pytest.mark.asyncio
async def test_artifact_download_range_end_honored(client):
    """Spec scenario: Range bytes=10-19 -> 206 with exactly 10 bytes."""
    sid = await _create_session_with_turn(client)
    # First get the full size.
    full = await client.get(f"/v1/sessions/{sid}/turns/0/artifact")
    size = int(full.headers["content-length"])
    if size < 20:
        pytest.skip("stub mp4 too small for range test")
    resp = await client.get(
        f"/v1/sessions/{sid}/turns/0/artifact",
        headers={"Range": "bytes=10-19"},
    )
    assert resp.status_code == 206
    assert resp.headers["content-range"] == f"bytes 10-19/{size}"
    assert resp.headers["content-length"] == "10"
    assert len(resp.content) == 10


@pytest.mark.asyncio
async def test_artifact_download_suffix_range(client):
    sid = await _create_session_with_turn(client)
    full = await client.get(f"/v1/sessions/{sid}/turns/0/artifact")
    size = int(full.headers["content-length"])
    if size < 20:
        pytest.skip("stub mp4 too small")
    resp = await client.get(
        f"/v1/sessions/{sid}/turns/0/artifact",
        headers={"Range": "bytes=-10"},
    )
    assert resp.status_code == 206
    assert len(resp.content) == 10


@pytest.mark.asyncio
async def test_artifact_not_found_404(client):
    create = await client.post("/v1/sessions", json={})
    sid = create.json()["session_id"]
    resp = await client.get(f"/v1/sessions/{sid}/turns/0/artifact")
    assert resp.status_code == 404
