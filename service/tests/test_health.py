"""Tests for /healthz and /readyz endpoints (X8/O1)."""

import inspect
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.models import Base

SQLALCHEMY_DATABASE_URL = "sqlite+aiosqlite://"
engine = create_async_engine(SQLALCHEMY_DATABASE_URL, echo=False)
TestAsyncSession = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


@pytest.fixture(autouse=True)
async def setup_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


@pytest.fixture
async def client():
    from app.deps import get_db
    from app.main import app

    async def _override_db():
        async with TestAsyncSession() as session:
            yield session

    app.dependency_overrides[get_db] = _override_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.clear()


# --- X8: _redis_ok must use redis.asyncio ---


def test_redis_ok_uses_async_redis():
    """_redis_ok source MUST use redis.asyncio, not sync redis (X8)."""
    from app.routers import health

    source = inspect.getsource(health._redis_ok)
    assert "redis.asyncio" in source or "aioredis" in source, (
        "_redis_ok must use redis.asyncio for non-blocking ping"
    )
    assert "redis_lib" not in source, "must not use sync redis import"


# --- /healthz always returns 200 (liveness) ---


async def test_healthz_always_200_even_when_redis_down(client):
    """/healthz MUST stay 200 even when Redis is down (X8/O1 liveness)."""
    with patch("app.routers.health._redis_ok", new=AsyncMock(return_value=False)), patch(
        "app.routers.health._db_ok", new=AsyncMock(return_value=True)
    ), patch("app.routers.health._s3_ok", new=AsyncMock(return_value=None)):
        resp = await client.get("/healthz")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "degraded"
    assert data["redis"] == "error"


async def test_healthz_ok_when_all_healthy(client):
    """/healthz returns 200 with status=ok when all deps are healthy."""
    with patch("app.routers.health._redis_ok", new=AsyncMock(return_value=True)), patch(
        "app.routers.health._db_ok", new=AsyncMock(return_value=True)
    ), patch("app.routers.health._s3_ok", new=AsyncMock(return_value=None)):
        resp = await client.get("/healthz")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"


# --- /readyz returns 503 when degraded (O1) ---


async def test_readyz_returns_503_when_redis_down(client):
    """/readyz MUST return 503 when Redis is down (O1 readiness)."""
    with patch("app.routers.health._redis_ok", new=AsyncMock(return_value=False)), patch(
        "app.routers.health._db_ok", new=AsyncMock(return_value=True)
    ):
        resp = await client.get("/readyz")
    assert resp.status_code == 503
    data = resp.json()
    assert data["status"] == "degraded"


async def test_readyz_returns_503_when_db_down(client):
    """/readyz MUST return 503 when DB is down (O1 readiness)."""
    with patch("app.routers.health._redis_ok", new=AsyncMock(return_value=True)), patch(
        "app.routers.health._db_ok", new=AsyncMock(return_value=False)
    ):
        resp = await client.get("/readyz")
    assert resp.status_code == 503


async def test_readyz_returns_200_when_healthy(client):
    """/readyz returns 200 when all deps are healthy."""
    with patch("app.routers.health._redis_ok", new=AsyncMock(return_value=True)), patch(
        "app.routers.health._db_ok", new=AsyncMock(return_value=True)
    ):
        resp = await client.get("/readyz")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert "pending" in data
    assert "running" in data
