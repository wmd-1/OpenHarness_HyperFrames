"""F1: query-param auth allowlist matrix (change fix-session-review-2026-07).

Only GET download endpoints (turn artifact + workspace file) may authenticate
via ``?api_key=``; every other path/method stays header-only. Before F1 the
workspace-file download was missing from the allowlist, so enabling auth broke
the frontend's direct download links with a 401.
"""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest
import pytest_asyncio

from app.config import settings

HEADERS = {"X-API-Key": "sk-test"}


@pytest_asyncio.fixture
async def auth_client(db_engine):
    """Client against an app rebuilt with header/query auth enabled.

    Mirrors tests/test_harden_frontend.py: the middleware reads settings at
    ``app.main`` import time, so reload with the key configured, restore after.
    """
    import importlib

    from httpx import ASGITransport, AsyncClient
    from pydantic import SecretStr

    import app.main as main_module

    old_key, old_require = settings.api_key, settings.require_auth
    settings.api_key = SecretStr("sk-test")
    settings.require_auth = True
    importlib.reload(main_module)
    try:
        transport = ASGITransport(app=main_module.app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c
    finally:
        settings.api_key = old_key
        settings.require_auth = old_require
        importlib.reload(main_module)


async def _session_with_workspace_file(auth_client, db_engine) -> str:
    """Create a session and drop a real file into its workspace dir."""
    create = await auth_client.post("/v1/sessions", json={}, headers=HEADERS)
    assert create.status_code == 201
    sid = create.json()["session_id"]

    from app.models import Conversation

    async with db_engine() as session:
        conv = await session.get(Conversation, uuid.UUID(sid))
    ws_dir = Path(conv.workspace_path or (Path(settings.workspace_root) / sid))
    ws_dir.mkdir(parents=True, exist_ok=True)
    (ws_dir / "hello.txt").write_text("hi", encoding="utf-8")
    return sid


# --- workspace file download joins the ?api_key= allowlist (F1) ----------------


@pytest.mark.asyncio
async def test_workspace_file_get_accepts_valid_query_api_key(auth_client, db_engine):
    sid = await _session_with_workspace_file(auth_client, db_engine)
    resp = await auth_client.get(
        f"/v1/sessions/{sid}/workspace/files/hello.txt", params={"api_key": "sk-test"}
    )
    assert resp.status_code == 200
    assert resp.content == b"hi"


@pytest.mark.asyncio
async def test_workspace_file_get_rejects_invalid_query_api_key(auth_client, db_engine):
    sid = await _session_with_workspace_file(auth_client, db_engine)
    resp = await auth_client.get(
        f"/v1/sessions/{sid}/workspace/files/hello.txt", params={"api_key": "sk-wrong"}
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_workspace_file_get_header_auth_still_works(auth_client, db_engine):
    sid = await _session_with_workspace_file(auth_client, db_engine)
    resp = await auth_client.get(
        f"/v1/sessions/{sid}/workspace/files/hello.txt", headers=HEADERS
    )
    assert resp.status_code == 200


# --- everything else stays header-only ------------------------------------------


@pytest.mark.asyncio
async def test_workspace_file_list_rejects_query_api_key(auth_client, db_engine):
    """The listing endpoint is NOT a download path — header-only."""
    sid = await _session_with_workspace_file(auth_client, db_engine)
    resp = await auth_client.get(
        f"/v1/sessions/{sid}/workspace/files", params={"api_key": "sk-test"}
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_non_download_get_rejects_query_api_key(auth_client, db_engine):
    sid = await _session_with_workspace_file(auth_client, db_engine)
    resp = await auth_client.get(f"/v1/sessions/{sid}", params={"api_key": "sk-test"})
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_post_rejects_query_api_key(auth_client):
    """POST never authenticates via query param, even with a valid key."""
    resp = await auth_client.post(
        "/v1/sessions", json={}, params={"api_key": "sk-test"}
    )
    assert resp.status_code == 401
