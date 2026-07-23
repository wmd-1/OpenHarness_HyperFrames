"""Shared test fixtures for the session-service test suite.

Sets up a fully offline environment:
- aiosqlite DB (tables created via Base.metadata.create_all)
- fakeredis for the rate-limiter / routing table / log stream
- the ``oh_backend_stub.py`` as the ``oh`` binary (no LLM API key needed)
- temp workspace + video dirs
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

# Make the session-service package importable as ``app``.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

STUB = ROOT / "scripts" / "oh_backend_stub.py"


@pytest.fixture(scope="session", autouse=True)
def _configure_settings(tmp_path_factory):
    """Override settings BEFORE any app module imports its singleton."""
    from app import config as config_module

    tmp = tmp_path_factory.mktemp("oh-session")
    workspace = tmp / "workspaces"
    workspace.mkdir()
    videos = tmp / "videos"
    videos.mkdir()

    # Make the stub executable so create_subprocess_exec can run it via shebang.
    STUB.chmod(0o755)

    cfg = config_module.settings
    cfg.db_url = f"sqlite+aiosqlite:///{tmp / 'test.db'}"
    cfg.db_migration_url = cfg.db_url
    cfg.broker_url = "redis://localhost:6379/15"
    cfg.workspace_root = workspace
    cfg.video_dir = videos
    cfg.storage_kind = "local"
    cfg.oh_bin = str(STUB)
    cfg.oh_api_key = None
    cfg.max_live_sessions = 4
    cfg.idle_grace_seconds = 2
    cfg.turn_timeout_seconds = 60
    cfg.max_turns_per_session = 50
    cfg.permission_policy = "full_auto"
    cfg.node_id = "test-node"
    cfg.route_ttl_seconds = 30
    cfg.require_auth = False
    cfg.api_key = None
    yield
    # reset the supervisor between sessions is handled per-test.


@pytest_asyncio.fixture
async def db_engine(tmp_path):
    """Create a fresh file-based sqlite DB with all tables per test.

    A *file* DB (not in-memory) is required because the sync ``TestClient`` runs
    the ASGI app in a portal thread with its own event loop; a file-backed sqlite
    shares data across loops/threads (with ``check_same_thread=False``).
    """
    from app.models import Base
    from app import db as db_module
    from sqlalchemy.pool import StaticPool

    db_file = tmp_path / "test.db"
    engine = create_async_engine(
        f"sqlite+aiosqlite:///{db_file}",
        echo=False,
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    # Reconfigure the global engine/session factory so all app code (which
    # references ``db.engine`` / ``db.async_session`` through the module) uses
    # the test DB.
    db_module.reconfigure(engine, factory)
    try:
        yield factory
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest_asyncio.fixture
async def db_session(db_engine):
    async with db_engine() as session:
        yield session


@pytest.fixture(autouse=True)
def _fakeredis(monkeypatch):
    """Replace Redis clients with fakeredis (sync + async)."""
    import fakeredis
    import fakeredis.aioredis

    fake_sync = fakeredis.FakeRedis()
    fake_async = fakeredis.aioredis.FakeRedis()

    # Sync rate-limiter.
    from app import ratelimit

    monkeypatch.setattr(ratelimit, "_get_redis", lambda: fake_sync)

    # Async registry / logs.
    from app.session import registry, logs

    async def _async_client():
        return fake_async

    monkeypatch.setattr(registry, "_client", _async_client)
    monkeypatch.setattr(logs, "_client", _async_client)

    # The health router builds its own redis client in _redis_ok; point it at
    # fakeredis so /healthz and /readyz see a healthy redis by default. The
    # dedicated "redis down" test overrides this.
    from app.routers import health

    async def _healthy_redis():
        return True

    monkeypatch.setattr(health, "_redis_ok", _healthy_redis)
    yield
    fake_sync.flushall()


@pytest_asyncio.fixture(autouse=True)
async def _reset_supervisor():
    """Clear the supervisor registry between tests (async — can await teardown)."""
    from app.session.supervisor import get_supervisor

    sup = get_supervisor()
    sup._sessions.clear()
    yield
    try:
        await sup.shutdown_all()
    except Exception:
        sup._sessions.clear()


@pytest_asyncio.fixture
async def client(db_engine):
    """httpx AsyncClient bound to the FastAPI app."""
    from httpx import ASGITransport, AsyncClient
    from app.main import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.fixture
def sync_client(db_engine):
    """Synchronous Starlette TestClient (needed for websocket_connect)."""
    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as c:
        yield c
