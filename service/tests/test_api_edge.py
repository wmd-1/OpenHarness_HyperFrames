"""Edge-case API tests: CORS policy (#7) and idempotency race (#9)."""

import importlib
import os
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.exc import IntegrityError

from app.models import TaskStatus, VideoTask
from app.schemas import VideoCreateRequest


# ---------------------------------------------------------------------------
# #9 Idempotency race: a concurrent duplicate insert must not 500.
# ---------------------------------------------------------------------------


async def test_create_video_integrity_error_falls_back_to_existing():
    """When the SELECT-then-INSERT loses a race (IntegrityError on commit), the
    route must roll back and return the existing task instead of 500-ing."""
    from app.routers import videos as videos_router
    import uuid

    existing = VideoTask(
        id=uuid.uuid4(),
        prompt="race",
        status=TaskStatus.QUEUED,
        idempotency_key="dup-key",
    )
    body = VideoCreateRequest(prompt="x", idempotency_key="dup-key")

    db = AsyncMock()
    # add/refresh are synchronous in SQLAlchemy; make them plain mocks so no
    # coroutine-is-never-awaited warning is emitted.
    db.add = MagicMock()
    db.refresh = MagicMock()
    # First SELECT finds nothing; the re-SELECT (after rollback) finds `existing`.
    sel = MagicMock()
    sel.scalar_one_or_none.side_effect = [None, existing]
    db.execute.return_value = sel
    # First commit raises IntegrityError (the race); second is the no-op path.
    db.commit.side_effect = [IntegrityError("duplicate key", None, None), None]

    # Build a minimal mock Request so the rate-limiter's _client_ip can extract
    # an IP. The limiter itself fails open when Redis is unreachable.
    request = MagicMock()
    request.headers = {}
    request.client = MagicMock()
    request.client.host = "127.0.0.1"

    resp = await videos_router.create_video(body, request, db)

    assert resp.task_id == existing.id
    assert resp.status == TaskStatus.QUEUED
    # No exception escaped; the error branch returned before enqueueing.
    db.rollback.assert_awaited()


# ---------------------------------------------------------------------------
# #7 CORS: explicit origins are reflected (with credentials); arbitrary
#     origins are NOT reflected. The old code used allow_origins=["*"] +
#     allow_credentials=True which reflected any Origin with credentials.
# ---------------------------------------------------------------------------


async def test_cors_default_does_not_reflect_arbitrary_origin():
    """With default (empty) cors_origins, an arbitrary Origin must not be
    echoed back and credentials must not be granted."""
    transport = ASGITransport(app=__import__("app.main", fromlist=["app"]).app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.options(
            "/healthz",
            headers={
                "Origin": "https://evil.example.com",
                "Access-Control-Request-Method": "GET",
            },
        )
    assert resp.headers.get("access-control-allow-origin") != "https://evil.example.com"
    assert resp.headers.get("access-control-allow-credentials") != "true"


@pytest.fixture
def explicit_cors_app():
    """Reload app.main with an explicit, allowed origin so the positive CORS
    path can be exercised in isolation."""
    os.environ["OH_CORS_ORIGINS"] = "https://app.example.com"
    import app.config as config_mod
    import app.main as main_mod

    importlib.reload(config_mod)
    importlib.reload(main_mod)
    yield main_mod.app
    # Restore default so other modules see the unchanged app.
    os.environ.pop("OH_CORS_ORIGINS", None)
    importlib.reload(config_mod)
    importlib.reload(main_mod)


async def test_cors_explicit_origin_reflected_with_credentials(explicit_cors_app):
    transport = ASGITransport(app=explicit_cors_app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.options(
            "/healthz",
            headers={
                "Origin": "https://app.example.com",
                "Access-Control-Request-Method": "GET",
            },
        )
    assert resp.headers.get("access-control-allow-origin") == "https://app.example.com"
    assert resp.headers.get("access-control-allow-credentials") == "true"


async def test_cors_explicit_app_rejects_other_origin(explicit_cors_app):
    transport = ASGITransport(app=explicit_cors_app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.options(
            "/healthz",
            headers={
                "Origin": "https://other.example.com",
                "Access-Control-Request-Method": "GET",
            },
        )
    assert resp.headers.get("access-control-allow-origin") != "https://other.example.com"


# ---------------------------------------------------------------------------
# S1/S2: require_auth + constant-time compare_digest
# ---------------------------------------------------------------------------


@pytest.fixture
def auth_app():
    """Reload app.main with require_auth=True and an api_key set."""
    os.environ["OH_REQUIRE_AUTH"] = "true"
    os.environ["OH_API_KEY"] = "test-secret-key"
    import app.config as config_mod
    import app.main as main_mod

    importlib.reload(config_mod)
    importlib.reload(main_mod)
    yield main_mod.app
    os.environ.pop("OH_REQUIRE_AUTH", None)
    os.environ.pop("OH_API_KEY", None)
    importlib.reload(config_mod)
    importlib.reload(main_mod)


async def test_auth_rejects_missing_api_key(auth_app):
    transport = ASGITransport(app=auth_app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get("/v1/videos")
    assert resp.status_code == 401


async def test_auth_accepts_correct_api_key(auth_app):
    transport = ASGITransport(app=auth_app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get("/healthz", headers={"X-API-Key": "test-secret-key"})
    # /healthz is always accessible even with auth (no key needed)
    assert resp.status_code != 401


async def test_auth_rejects_wrong_api_key(auth_app):
    transport = ASGITransport(app=auth_app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get("/v1/videos", headers={"X-API-Key": "wrong-key"})
    assert resp.status_code == 401


async def test_auth_healthz_accessible_without_key(auth_app):
    transport = ASGITransport(app=auth_app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get("/healthz")
    assert resp.status_code != 401


# ---------------------------------------------------------------------------
# N10/N11: SecretStr — api_key MUST be masked in repr/traceback
# ---------------------------------------------------------------------------


def test_api_key_is_secretstr_and_not_leaked_in_repr():
    """Settings.api_key MUST be a SecretStr so its plaintext value is masked
    in repr() and log output (N10/N11)."""
    from pydantic import SecretStr

    import app.config as config_mod

    os.environ["OH_API_KEY"] = "super-secret-value-123"
    importlib.reload(config_mod)
    try:
        s = config_mod.settings
        assert isinstance(s.api_key, SecretStr), "api_key must be SecretStr"
        # repr must NOT contain the plaintext key
        assert "super-secret-value-123" not in repr(s)
        # get_secret_value() DOES return the plaintext
        assert s.api_key.get_secret_value() == "super-secret-value-123"
    finally:
        os.environ.pop("OH_API_KEY", None)
        importlib.reload(config_mod)
