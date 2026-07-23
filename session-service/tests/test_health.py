"""Tests for /healthz and /readyz (spec: liveness vs readiness)."""

import pytest


@pytest.mark.asyncio
async def test_healthz_200(client):
    resp = await client.get("/healthz")
    assert resp.status_code == 200
    data = resp.json()
    assert "db" in data
    assert "redis" in data


@pytest.mark.asyncio
async def test_readyz_200_when_healthy(client):
    resp = await client.get("/readyz")
    assert resp.status_code == 200
    data = resp.json()
    assert "live_sessions" in data
    assert "capacity" in data


@pytest.mark.asyncio
async def test_metrics_exposed(client):
    resp = await client.get("/metrics")
    assert resp.status_code == 200
    assert "oh_session" in resp.text


@pytest.mark.asyncio
async def test_readyz_503_when_redis_down(client, monkeypatch):
    """Spec scenario: readyz returns 503 when Redis is down (async, non-blocking)."""
    import fakeredis.aioredis
    from app.session import registry, logs
    from app.routers import health

    async def _broken_client():
        raise ConnectionError("redis down")

    # Break the registry/logs clients AND the health redis probe.
    monkeypatch.setattr(registry, "_client", _broken_client)
    monkeypatch.setattr(logs, "_client", _broken_client)

    orig_redis_ok = health._redis_ok

    async def _down():
        return False

    monkeypatch.setattr(health, "_redis_ok", _down)
    resp = await client.get("/readyz")
    assert resp.status_code == 503
    assert resp.json()["redis"] == "error"
