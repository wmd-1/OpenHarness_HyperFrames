"""Tests for multi-key tenant authentication (WS-A, R15).

Covers: open mode, legacy single-key compatibility, multi-key → per-tenant
resolution, 401 rejection (missing/unknown/deactivated keys), the ``?api_key=``
query-param fallback on /file and /events, and the TTL lookup cache.
"""

from __future__ import annotations

import hashlib
import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.models import ApiKey, Base

# ---- Fixtures ----

# StaticPool: a single shared in-memory sqlite connection, so the sessions the
# resolver opens via the (monkeypatched) app.db.async_session see the same DB
# as the sessions used by the tests.
engine = create_async_engine(
    "sqlite+aiosqlite://", echo=False, poolclass=StaticPool
)
TestAsyncSession = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


@pytest.fixture(autouse=True)
async def setup_db(monkeypatch):
    """Create tables, point app.db.async_session at sqlite, reset the cache."""
    import app.db as db_mod
    from app.security import reset_apikey_cache

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    monkeypatch.setattr(db_mod, "async_session", TestAsyncSession)
    reset_apikey_cache()
    yield
    reset_apikey_cache()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


@pytest.fixture
async def db_session():
    async with TestAsyncSession() as session:
        yield session


@pytest.fixture
async def client(db_session):
    """Test client with the real auth middleware and a sqlite DB override."""
    from app.deps import get_db
    from app.main import app

    async def _override_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.clear()


def _hash(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


async def _add_key(raw: str, tenant_id: str, *, active: bool = True) -> str:
    """Insert an api_keys row; returns the row id (str)."""
    row = ApiKey(id=uuid.uuid4(), key_hash=_hash(raw), tenant_id=tenant_id, active=active)
    async with TestAsyncSession() as session:
        session.add(row)
        await session.commit()
    return str(row.id)


@pytest.fixture
def single_key():
    """Configure a legacy single OH_API_KEY for the test duration.

    ``settings`` is resolved at fixture runtime (not module import time):
    other test modules reload ``app.config``, and ``resolve_tenant`` always
    reads the current ``app.config.settings`` object.
    """
    from app.config import settings

    old = settings.api_key
    settings.api_key = SecretStr("sk-legacy")
    yield "sk-legacy"
    settings.api_key = old


# ---- resolve_tenant unit behavior ----


async def test_resolve_open_mode_defaults():
    """No configured key + empty api_keys table -> tenant 'default'."""
    from app.security import resolve_tenant

    assert await resolve_tenant(None) == ("default", None)


async def test_resolve_legacy_single_key(single_key):
    """A configured OH_API_KEY resolves to 'default'; wrong/missing -> None."""
    from app.security import resolve_tenant

    assert await resolve_tenant("sk-legacy") == ("default", None)
    assert await resolve_tenant("sk-wrong") is None
    assert await resolve_tenant(None) is None


async def test_resolve_multikey_maps_to_tenant():
    from app.security import resolve_tenant

    kid_a = await _add_key("sk-tenant-a", "tenant-a")
    await _add_key("sk-tenant-b", "tenant-b")
    assert await resolve_tenant("sk-tenant-a") == ("tenant-a", kid_a)
    tenant_b, _ = await resolve_tenant("sk-tenant-b")
    assert tenant_b == "tenant-b"


async def test_resolve_rejects_unknown_and_missing_once_keys_exist():
    from app.security import resolve_tenant

    await _add_key("sk-tenant-a", "tenant-a")
    assert await resolve_tenant("sk-nope") is None
    # Open mode requires an EMPTY table, so a missing key is rejected too.
    assert await resolve_tenant(None) is None


async def test_resolve_rejects_inactive_key():
    from app.security import resolve_tenant

    await _add_key("sk-dead", "tenant-x", active=False)
    assert await resolve_tenant("sk-dead") is None


async def test_resolve_single_key_coexists_with_table(single_key):
    """Single-key deployments keep working after api_keys rows appear."""
    from app.security import resolve_tenant

    await _add_key("sk-tenant-a", "tenant-a")
    assert await resolve_tenant("sk-legacy") == ("default", None)
    tenant, _ = await resolve_tenant("sk-tenant-a")
    assert tenant == "tenant-a"


async def test_ttl_cache_serves_stale_until_expiry():
    """Deactivation honors the documented TTL lag; expiry -> rejected."""
    from app.security import _key_cache, resolve_tenant

    kid = await _add_key("sk-revoke-me", "tenant-r")
    assert await resolve_tenant("sk-revoke-me") == ("tenant-r", kid)
    # Deactivate in the DB — inside the TTL, the cache still resolves.
    async with TestAsyncSession() as session:
        await session.execute(
            update(ApiKey).where(ApiKey.key_hash == _hash("sk-revoke-me")).values(active=False)
        )
        await session.commit()
    assert await resolve_tenant("sk-revoke-me") == ("tenant-r", kid)
    # Simulate TTL expiry by aging the cache entry.
    digest = _hash("sk-revoke-me")
    _, value = _key_cache[digest]
    _key_cache[digest] = (0.0, value)
    assert await resolve_tenant("sk-revoke-me") is None


# ---- HTTP middleware integration ----


async def test_http_open_mode_no_auth_needed(client):
    """Open mode: requests pass without a key (existing behavior)."""
    r = await client.get(f"/v1/videos/{uuid.uuid4()}")
    assert r.status_code == 404  # authenticated as 'default', task not found


async def test_http_multikey_401_and_pass(client):
    await _add_key("sk-tenant-a", "tenant-a")
    tid = uuid.uuid4()
    ok = await client.get(f"/v1/videos/{tid}", headers={"X-API-Key": "sk-tenant-a"})
    assert ok.status_code == 404  # auth ok, task missing
    anon = await client.get(f"/v1/videos/{tid}")
    assert anon.status_code == 401
    bad = await client.get(f"/v1/videos/{tid}", headers={"X-API-Key": "sk-nope"})
    assert bad.status_code == 401


async def test_http_healthz_exempt(client):
    await _add_key("sk-tenant-a", "tenant-a")
    r = await client.get("/healthz")
    assert r.status_code != 401


async def test_query_param_fallback_on_file_and_events(client):
    """/file and /events accept ?api_key= (same three-step resolution)."""
    await _add_key("sk-tenant-a", "tenant-a")
    tid = uuid.uuid4()
    # Valid key via query param -> passes auth (404: task does not exist).
    r = await client.get(f"/v1/videos/{tid}/file?api_key=sk-tenant-a")
    assert r.status_code == 404
    r = await client.get(f"/v1/videos/{tid}/events?api_key=sk-tenant-a")
    assert r.status_code == 404
    # Invalid key via query param -> 401.
    r = await client.get(f"/v1/videos/{tid}/file?api_key=sk-nope")
    assert r.status_code == 401


async def test_query_param_not_accepted_on_other_endpoints(client):
    """All other endpoints remain header-only (R15)."""
    await _add_key("sk-tenant-a", "tenant-a")
    tid = uuid.uuid4()
    r = await client.get(f"/v1/videos/{tid}?api_key=sk-tenant-a")
    assert r.status_code == 401
