"""Tests for tenant isolation on /v1/videos (WS-B: R14/R16/R17/R18).

Covers: cross-tenant 404 on all four task endpoints, tenant-scoped
idempotency keys, the per-tenant active-task quota (429 + release), and
per-tenant rate-limit buckets with the 'default' tenant falling back to
client-IP keys.
"""

from __future__ import annotations

import hashlib
import uuid
from unittest.mock import MagicMock, patch

import fakeredis
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.models import ApiKey, Base, TaskStatus, VideoTask

# ---- Fixtures ----

# StaticPool: a single shared in-memory sqlite connection, so the middleware's
# resolver sessions (via the monkeypatched app.db.async_session) and the
# endpoint sessions see the same DB.
engine = create_async_engine("sqlite+aiosqlite://", echo=False, poolclass=StaticPool)
TestAsyncSession = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

A_KEY, B_KEY = "sk-iso-tenant-a", "sk-iso-tenant-b"
A, B = {"X-API-Key": A_KEY}, {"X-API-Key": B_KEY}


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


@pytest.fixture(autouse=True)
def _reset_sse_state():
    """Reset sse_starlette's loop-bound module global between tests."""
    from sse_starlette.sse import AppStatus

    AppStatus.should_exit = False
    AppStatus.should_exit_event = None
    yield


@pytest.fixture(autouse=True)
async def two_tenants(setup_db):
    """Seed one api key per tenant so requests resolve to tenant-a/tenant-b."""
    async with TestAsyncSession() as session:
        for raw, tid in ((A_KEY, "tenant-a"), (B_KEY, "tenant-b")):
            session.add(
                ApiKey(
                    id=uuid.uuid4(),
                    key_hash=hashlib.sha256(raw.encode("utf-8")).hexdigest(),
                    tenant_id=tid,
                )
            )
        await session.commit()


@pytest.fixture
async def db_session():
    async with TestAsyncSession() as session:
        yield session


@pytest.fixture
async def client(db_session):
    from app.deps import get_db
    from app.main import app

    async def _override_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.clear()


async def _add_task(tenant_id: str, status: TaskStatus = TaskStatus.QUEUED) -> uuid.UUID:
    task = VideoTask(id=uuid.uuid4(), prompt="iso", tenant_id=tenant_id, status=status)
    async with TestAsyncSession() as session:
        session.add(task)
        await session.commit()
    return task.id


# ---- R14: cross-tenant access is an indistinguishable 404 ----


class TestCrossTenant404:
    async def test_get_detail(self, client):
        tid = await _add_task("tenant-a")
        assert (await client.get(f"/v1/videos/{tid}", headers=A)).status_code == 200
        assert (await client.get(f"/v1/videos/{tid}", headers=B)).status_code == 404

    async def test_file(self, client):
        tid = await _add_task("tenant-a")
        assert (await client.get(f"/v1/videos/{tid}/file", headers=B)).status_code == 404
        # Owner passes the ownership check (QUEUED -> 409 "not ready", not 404).
        assert (await client.get(f"/v1/videos/{tid}/file", headers=A)).status_code == 409

    async def test_events(self, client):
        tid = await _add_task("tenant-a")
        assert (await client.get(f"/v1/videos/{tid}/events", headers=B)).status_code == 404

    async def test_delete(self, client):
        tid = await _add_task("tenant-a")
        assert (await client.delete(f"/v1/videos/{tid}", headers=B)).status_code == 404
        with patch("app.routers.videos.celery_app") as mock_celery:
            mock_celery.control.revoke = MagicMock()
            owner = await client.delete(f"/v1/videos/{tid}", headers=A)
        assert owner.status_code == 200


# ---- R17: idempotency keys are unique per tenant ----


class TestTenantScopedIdempotency:
    @patch("app.routers.videos.get_scheduler")
    async def test_same_key_different_tenants_creates_two_tasks(self, mock_sched, client):
        mock_sched.return_value.enqueue = MagicMock(return_value="fake-id")
        ra = await client.post(
            "/v1/videos", json={"prompt": "x", "idempotency_key": "shared"}, headers=A
        )
        rb = await client.post(
            "/v1/videos", json={"prompt": "x", "idempotency_key": "shared"}, headers=B
        )
        assert ra.status_code == 201 and rb.status_code == 201
        assert ra.json()["task_id"] != rb.json()["task_id"]
        # Replay within the same tenant returns the existing task.
        ra2 = await client.post(
            "/v1/videos", json={"prompt": "x", "idempotency_key": "shared"}, headers=A
        )
        assert ra2.status_code == 201
        assert ra2.json()["task_id"] == ra.json()["task_id"]


# ---- R16: per-tenant active-task quota ----


class TestTenantQuota:
    @patch("app.routers.videos.get_scheduler")
    async def test_quota_429_isolated_and_released(self, mock_sched, client):
        # Use the settings object the router actually reads (other test
        # modules reload app.config, so app.routers.videos may hold an older
        # instance than a fresh import here).
        from app.routers import videos as videos_router

        limit = videos_router.settings.tenant_max_active
        mock_sched.return_value.enqueue = MagicMock(return_value="fake-id")

        ids = [await _add_task("tenant-a") for _ in range(limit)]
        over = await client.post("/v1/videos", json={"prompt": "over"}, headers=A)
        assert over.status_code == 429

        # Other tenants are unaffected by tenant-a's exhausted quota.
        other = await client.post("/v1/videos", json={"prompt": "ok"}, headers=B)
        assert other.status_code == 201

        # A terminal task releases quota: the next submission succeeds.
        async with TestAsyncSession() as session:
            task = await session.get(VideoTask, ids[0])
            task.status = TaskStatus.SUCCEEDED
            await session.commit()
        again = await client.post("/v1/videos", json={"prompt": "again"}, headers=A)
        assert again.status_code == 201


# ---- R18: rate-limit keys are per tenant, default falls back to IP ----


class TestTenantRateLimitKeys:
    @pytest.fixture(autouse=True)
    def _reset_pool(self):
        import app.ratelimit as rl

        rl._pool = None
        yield
        rl._pool = None

    def test_rate_limit_key_selection(self):
        from app.ratelimit import rate_limit_key

        request = MagicMock()
        request.headers = {}
        request.client = MagicMock()
        request.client.host = "9.9.9.9"
        assert rate_limit_key("tenant-a", request) == "tenant:tenant-a"
        # 'default' keeps the pre-tenant per-IP semantics.
        assert rate_limit_key("default", request) == "9.9.9.9"

    def test_tenant_buckets_are_independent(self):
        import app.ratelimit as rl

        fake = fakeredis.FakeStrictRedis()
        with patch("app.ratelimit._get_redis", return_value=fake):
            with patch.object(rl.settings, "rate_limit_capacity", 1):
                with patch.object(rl.settings, "rate_limit_refill", 0.001):
                    assert rl.check_rate_limit("tenant:a") is True
                    assert rl.check_rate_limit("tenant:a") is False  # a exhausted
                    assert rl.check_rate_limit("tenant:b") is True  # b unaffected

    def test_default_tenant_ip_buckets_are_independent(self):
        import app.ratelimit as rl

        fake = fakeredis.FakeStrictRedis()
        with patch("app.ratelimit._get_redis", return_value=fake):
            with patch.object(rl.settings, "rate_limit_capacity", 1):
                with patch.object(rl.settings, "rate_limit_refill", 0.001):
                    assert rl.check_rate_limit("1.1.1.1") is True
                    assert rl.check_rate_limit("1.1.1.1") is False
                    assert rl.check_rate_limit("2.2.2.2") is True
