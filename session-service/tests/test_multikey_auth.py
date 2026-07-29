"""Tests for multi-key tenant authentication (WS-A, spec: "Requests MUST be
authenticated and scoped to a tenant").

Covers: multi-key → per-tenant resolution, cross-tenant 404, revoke behavior
inside/outside the TTL cache window, legacy single-key compatibility, open
mode, and the WS handshake with multiple keys.
"""

from __future__ import annotations

import hashlib
import uuid

import pytest
import pytest_asyncio

from app.config import settings


def _hash(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


async def _add_key(db_engine, raw: str, tenant_id: str, *, active: bool = True) -> str:
    """Insert an api_keys row; returns the row id (str)."""
    from app.models import ApiKey

    row = ApiKey(id=uuid.uuid4(), key_hash=_hash(raw), tenant_id=tenant_id, active=active)
    async with db_engine() as session:
        session.add(row)
        await session.commit()
    return str(row.id)


@pytest_asyncio.fixture
async def two_tenant_keys(db_engine):
    """Two active keys mapping to two tenants."""
    kid_a = await _add_key(db_engine, "sk-tenant-a", "tenant-a")
    kid_b = await _add_key(db_engine, "sk-tenant-b", "tenant-b")
    return {"tenant-a": ("sk-tenant-a", kid_a), "tenant-b": ("sk-tenant-b", kid_b)}


# --- resolve_tenant unit behavior ---------------------------------------------


@pytest.mark.asyncio
async def test_resolve_multikey_maps_to_tenant(db_engine, two_tenant_keys):
    from app.security import resolve_tenant

    tenant, actor = await resolve_tenant("sk-tenant-a")
    assert tenant == "tenant-a"
    assert actor == two_tenant_keys["tenant-a"][1]


@pytest.mark.asyncio
async def test_resolve_unknown_key_rejected_when_keys_exist(db_engine, two_tenant_keys):
    from app.security import resolve_tenant

    assert await resolve_tenant("sk-nope") is None
    # Missing key is also rejected once rows exist (open mode requires an
    # empty table).
    assert await resolve_tenant(None) is None


@pytest.mark.asyncio
async def test_resolve_open_mode_unchanged(db_engine):
    """No configured key, require_auth off, empty table -> tenant default."""
    from app.security import resolve_tenant

    assert await resolve_tenant(None) == ("default", None)


@pytest.mark.asyncio
async def test_resolve_legacy_single_key_unchanged(db_engine):
    """A configured OH_API_KEY still resolves to tenant default (no DB rows)."""
    from pydantic import SecretStr

    from app.security import resolve_tenant

    old = settings.api_key
    settings.api_key = SecretStr("sk-legacy")
    try:
        assert await resolve_tenant("sk-legacy") == ("default", None)
        assert await resolve_tenant("sk-wrong") is None
        assert await resolve_tenant(None) is None
    finally:
        settings.api_key = old


@pytest.mark.asyncio
async def test_resolve_single_key_beats_table_and_coexists(db_engine, two_tenant_keys):
    """Single-key deployments keep working even after api_keys rows appear."""
    from pydantic import SecretStr

    from app.security import resolve_tenant

    old = settings.api_key
    settings.api_key = SecretStr("sk-legacy")
    try:
        assert await resolve_tenant("sk-legacy") == ("default", None)
        tenant, _ = await resolve_tenant("sk-tenant-b")
        assert tenant == "tenant-b"
    finally:
        settings.api_key = old


@pytest.mark.asyncio
async def test_revoked_key_honored_inside_ttl_then_rejected(db_engine):
    """Within the TTL the cached resolution stays valid; after expiry -> None."""
    from sqlalchemy import update

    from app.models import ApiKey
    from app.security import _key_cache, resolve_tenant

    kid = await _add_key(db_engine, "sk-revoke-me", "tenant-r")
    old_ttl = settings.apikey_cache_ttl
    settings.apikey_cache_ttl = 60.0
    try:
        assert await resolve_tenant("sk-revoke-me") == ("tenant-r", kid)
        # Revoke in the DB.
        async with db_engine() as session:
            await session.execute(
                update(ApiKey).where(ApiKey.key_hash == _hash("sk-revoke-me")).values(active=False)
            )
            await session.commit()
        # Inside the TTL: still served from cache (documented revocation lag).
        assert await resolve_tenant("sk-revoke-me") == ("tenant-r", kid)
        # Simulate TTL expiry by aging the cache entry.
        digest = _hash("sk-revoke-me")
        expiry, value = _key_cache[digest]
        _key_cache[digest] = (0.0, value)
        assert await resolve_tenant("sk-revoke-me") is None
    finally:
        settings.apikey_cache_ttl = old_ttl


# --- REST integration ----------------------------------------------------------


@pytest.mark.asyncio
async def test_rest_multikey_scopes_sessions_per_tenant(client, two_tenant_keys):
    ra = await client.post("/v1/sessions", json={}, headers={"X-API-Key": "sk-tenant-a"})
    assert ra.status_code == 201
    sid_a = ra.json()["session_id"]

    # Tenant A sees its own session; tenant B gets 404 (cross-tenant).
    ok = await client.get(f"/v1/sessions/{sid_a}", headers={"X-API-Key": "sk-tenant-a"})
    assert ok.status_code == 200
    cross = await client.get(f"/v1/sessions/{sid_a}", headers={"X-API-Key": "sk-tenant-b"})
    assert cross.status_code == 404

    # No/unknown key -> 401 once keys exist.
    anon = await client.get(f"/v1/sessions/{sid_a}")
    assert anon.status_code == 401
    bad = await client.get(f"/v1/sessions/{sid_a}", headers={"X-API-Key": "sk-nope"})
    assert bad.status_code == 401


@pytest.mark.asyncio
async def test_rest_actor_key_id_recorded(client, db_engine, two_tenant_keys):
    from app.models import Conversation

    r = await client.post("/v1/sessions", json={}, headers={"X-API-Key": "sk-tenant-a"})
    assert r.status_code == 201
    sid = uuid.UUID(r.json()["session_id"])
    async with db_engine() as session:
        conv = await session.get(Conversation, sid)
    assert conv.tenant_id == "tenant-a"
    assert conv.actor_key_id == two_tenant_keys["tenant-a"][1]


@pytest.mark.asyncio
async def test_rest_open_mode_unchanged(client):
    """Empty api_keys table + no configured key: everything works keyless."""
    r = await client.post("/v1/sessions", json={})
    assert r.status_code == 201
    sid = r.json()["session_id"]
    ok = await client.get(f"/v1/sessions/{sid}")
    assert ok.status_code == 200


@pytest.mark.asyncio
async def test_healthz_exempt_from_multikey_auth(client, two_tenant_keys):
    r = await client.get("/healthz")
    assert r.status_code == 200


# --- WS handshake ----------------------------------------------------------------


def test_ws_handshake_multikey(sync_client, db_engine):
    """WS accepts a valid multi-key for the owning tenant; rejects others."""
    import asyncio

    from starlette.websockets import WebSocketDisconnect

    # Seed keys from the test thread (file-backed sqlite is loop/thread safe,
    # see conftest.db_engine docstring).
    async def _seed():
        await _add_key(db_engine, "sk-ws-a", "ws-tenant-a")
        await _add_key(db_engine, "sk-ws-b", "ws-tenant-b")

    asyncio.run(_seed())

    create = sync_client.post(
        "/v1/sessions", json={}, headers={"X-API-Key": "sk-ws-a"}
    )
    assert create.status_code == 201
    sid = create.json()["session_id"]

    # Owner connects fine (query-param key — browsers cannot set WS headers).
    with sync_client.websocket_connect(f"/v1/sessions/{sid}/ws?api_key=sk-ws-a") as ws:
        assert ws.receive_json()["type"] == "session_ready"

    # Invalid key -> handshake rejected before accept (4401).
    with pytest.raises(WebSocketDisconnect) as exc:
        with sync_client.websocket_connect(f"/v1/sessions/{sid}/ws?api_key=sk-nope"):
            pass
    assert exc.value.code == 4401

    # Another tenant's valid key -> session invisible (4404).
    with pytest.raises(WebSocketDisconnect) as exc:
        with sync_client.websocket_connect(f"/v1/sessions/{sid}/ws?api_key=sk-ws-b"):
            pass
    assert exc.value.code == 4404
