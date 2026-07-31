"""WS-B tenant data isolation tests (openspec session-container-pool-multitenancy, task 2.6).

Two layers:

- Unit layer (always runs, no MinIO): tenant-id/path traversal guards, disabled
  store no-op semantics, rules snapshot copy, destroy local cleanup, router
  error mapping (503 fail-fast) and the per-tenant concurrent quota (429).
- Integration layer (requires a live MinIO — run via the compose ``minio``
  service with ``OH_TEST_MINIO_ENDPOINT`` set, see e2e harness): first-seen
  seeding, memory roundtrip, wiped-staging resume, cross-tenant invisibility,
  delete propagation, destroy purge, handover no-loss, unreachable -> error.
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from pathlib import Path

import pytest
from pydantic import SecretStr

from app.config import settings
from app.session import tenant_store
from app.session.tenant_store import TenantStoreError


def _tid() -> str:
    return f"t-{uuid.uuid4().hex[:10]}"


@pytest.fixture(autouse=True)
def _isolated_tenants_root(tmp_path, monkeypatch):
    """Point staging at a per-test dir and reset the per-tenant lock table."""
    monkeypatch.setattr(settings, "tenants_root", tmp_path / "tenants")
    tenant_store._tenant_locks.clear()
    yield
    tenant_store._tenant_locks.clear()


# --- unit layer -----------------------------------------------------------------


@pytest.mark.parametrize(
    "bad",
    ["", "a/b", "a\\b", "..", "a..b", ".hidden", "x" * 129],
)
def test_validate_tenant_id_rejects_unsafe(bad):
    with pytest.raises(ValueError):
        tenant_store.validate_tenant_id(bad)


def test_validate_tenant_id_accepts_plain():
    assert tenant_store.validate_tenant_id("tenant-1") == "tenant-1"


def test_safe_tenant_path_rejects_escape(tmp_path):
    tid = _tid()
    root = tenant_store.tenant_local_root(tid)
    root.mkdir(parents=True)
    # Inside the prefix: ok.
    inside = root / "openharness" / "settings.json"
    assert tenant_store.safe_tenant_path(tid, inside) == inside.resolve()
    # Traversal out of the prefix: rejected.
    with pytest.raises(ValueError):
        tenant_store.safe_tenant_path(tid, root / ".." / "other" / "x")
    with pytest.raises(ValueError):
        tenant_store.safe_tenant_path(tid, Path("/etc/passwd"))


@pytest.mark.asyncio
async def test_disabled_store_is_local_noop(monkeypatch):
    """Without OH_MINIO_ENDPOINT the store still builds the local skeleton."""
    monkeypatch.setattr(settings, "minio_endpoint", None)
    tid = _tid()
    await tenant_store.stage_in(tid)
    assert tenant_store.local_data_dir(tid).is_dir()
    assert tenant_store.local_rules_dir(tid).is_dir()
    assert await tenant_store.stage_out(tid) is True


@pytest.mark.asyncio
async def test_copy_rules_into_workspace(tmp_path, monkeypatch):
    """Staged rules/ land in {workspace}/.claude/rules (D2.3 snapshot)."""
    monkeypatch.setattr(settings, "minio_endpoint", None)
    tid = _tid()
    await tenant_store.stage_in(tid)
    (tenant_store.local_rules_dir(tid) / "style.md").write_text("# rule\n")
    ws = tmp_path / "ws"
    ws.mkdir()
    await tenant_store.copy_rules_into_workspace(tid, ws)
    assert (ws / ".claude" / "rules" / "style.md").read_text() == "# rule\n"


@pytest.mark.asyncio
async def test_copy_rules_noop_when_empty(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "minio_endpoint", None)
    tid = _tid()
    await tenant_store.stage_in(tid)
    ws = tmp_path / "ws2"
    ws.mkdir()
    await tenant_store.copy_rules_into_workspace(tid, ws)
    assert not (ws / ".claude").exists()


@pytest.mark.asyncio
async def test_destroy_session_data_local_cleanup(monkeypatch):
    """destroy removes only the session's memory/session traces (prefix-safe)."""
    monkeypatch.setattr(settings, "minio_endpoint", None)
    tid = _tid()
    ohsid = "ws-abc123"
    data = tenant_store.local_data_dir(tid)
    (data / "memory" / ohsid).mkdir(parents=True)
    (data / "memory" / ohsid / "m.json").write_text("{}")
    (data / "sessions").mkdir(parents=True)
    (data / "sessions" / f"{ohsid}.json").write_text("{}")
    (data / "memory" / "other-session").mkdir(parents=True)
    (data / "memory" / "other-session" / "keep.json").write_text("{}")

    await tenant_store.destroy_session_data(tid, ohsid)

    assert not (data / "memory" / ohsid).exists()
    assert not (data / "sessions" / f"{ohsid}.json").exists()
    # Unrelated session data survives.
    assert (data / "memory" / "other-session" / "keep.json").exists()


def test_settings_seed_is_credential_free():
    """With no global settings file the derived seed degrades to `{}`;
    the full derivation contract lives in test_credential_isolation.py."""
    assert json.loads(tenant_store.settings_seed()) == {}


@pytest.mark.asyncio
async def test_create_route_maps_tenant_store_error_to_503(client, monkeypatch):
    """MinIO unreachable at create -> 503, no session started (fail-fast)."""

    async def boom(tenant_id: str) -> None:
        raise TenantStoreError("minio unreachable")

    monkeypatch.setattr(tenant_store, "stage_in", boom)
    resp = await client.post("/v1/sessions", json={})
    assert resp.status_code == 503
    assert "tenant data store" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_second_concurrent_create_returns_429(client):
    """tenant_max_concurrent defaults to 1 (D8): second live create -> 429 when
    the first session cannot yield (busy). An *idle* unattached session would
    yield its slot instead (session-history-switch, covered in test_ws)."""
    from app.session.supervisor import get_supervisor

    first = await client.post("/v1/sessions", json={})
    assert first.status_code == 201
    # Mark the first session busy: it is then not an eviction candidate, so
    # the quota rejection path is preserved.
    sid = first.json()["session_id"]
    get_supervisor().get(sid)._busy = True
    second = await client.post("/v1/sessions", json={})
    assert second.status_code == 429


@pytest.mark.asyncio
async def test_second_create_with_idle_first_yields_the_slot(client):
    """session-history-switch: an idle unattached same-tenant session yields
    its slot to the new create instead of a 429."""
    first = await client.post("/v1/sessions", json={})
    assert first.status_code == 201
    first_sid = first.json()["session_id"]
    second = await client.post("/v1/sessions", json={})
    assert second.status_code == 201
    status = (await client.get(f"/v1/sessions/{first_sid}")).json()["status"]
    assert status == "cold"


@pytest.mark.asyncio
async def test_stage_out_retries_then_reports_failure(monkeypatch):
    """stage_out backs off, keeps staging, bumps the metric, returns False."""
    monkeypatch.setattr(settings, "minio_endpoint", "127.0.0.1:1")  # refused
    monkeypatch.setattr(tenant_store, "_STAGE_OUT_BACKOFF", (0.01, 0.01))
    calls = {"n": 0}
    real = tenant_store._stage_out_sync

    def counting(tid):
        calls["n"] += 1
        return real(tid)

    monkeypatch.setattr(tenant_store, "_stage_out_sync", counting)
    tid = _tid()
    marker = tenant_store.local_data_dir(tid)
    marker.mkdir(parents=True)
    (marker / "keep.json").write_text("{}")
    ok = await tenant_store.stage_out(tid)
    assert ok is False
    assert calls["n"] == 3  # initial + 2 retries
    assert (marker / "keep.json").exists()  # staging kept on failure


@pytest.mark.asyncio
async def test_unreachable_minio_stage_in_raises(monkeypatch):
    monkeypatch.setattr(settings, "minio_endpoint", "127.0.0.1:1")
    with pytest.raises(TenantStoreError):
        await tenant_store.stage_in(_tid())


# --- integration layer (real MinIO) ----------------------------------------------


@pytest.fixture
def minio_live(monkeypatch):
    """Wire settings at a real MinIO (compose ``minio`` service) or skip."""
    endpoint = os.environ.get("OH_TEST_MINIO_ENDPOINT")
    if not endpoint:
        pytest.skip("OH_TEST_MINIO_ENDPOINT not set — MinIO integration harness only")
    monkeypatch.setattr(settings, "minio_endpoint", endpoint)
    monkeypatch.setattr(
        settings,
        "minio_access_key",
        SecretStr(os.environ.get("OH_TEST_MINIO_ACCESS_KEY", "ohminio")),
    )
    monkeypatch.setattr(
        settings,
        "minio_secret_key",
        SecretStr(os.environ.get("OH_TEST_MINIO_SECRET_KEY", "ohminio-secret")),
    )
    monkeypatch.setattr(settings, "minio_bucket", "oh-tenants-test")
    monkeypatch.setattr(settings, "minio_secure", False)
    return endpoint


def _remote_names(tid: str) -> set[str]:
    client = tenant_store._client()
    return set(tenant_store._list_remote(client, tid))


@pytest.mark.asyncio
async def test_first_seen_tenant_is_seeded(minio_live):
    """Empty prefix -> idempotent credential-free settings.json seed."""
    tid = _tid()
    await tenant_store.stage_in(tid)
    local_settings = tenant_store.local_config_dir(tid) / "settings.json"
    assert json.loads(local_settings.read_text()) == {}
    assert "openharness/settings.json" in _remote_names(tid)
    # Idempotent: a second stage_in must not fail or duplicate.
    await tenant_store.stage_in(tid)
    assert json.loads(local_settings.read_text()) == {}


@pytest.mark.asyncio
async def test_memory_roundtrip_and_wiped_staging_resume(minio_live):
    """Memory written by session N survives a full staging wipe (stateless node)."""
    tid = _tid()
    await tenant_store.stage_in(tid)
    mem = tenant_store.local_data_dir(tid) / "memory" / "agent"
    mem.mkdir(parents=True)
    (mem / "notes.json").write_text('{"fact": "remembered"}')
    assert await tenant_store.stage_out(tid) is True

    # Simulate node loss: wipe the whole staging tree, then resume.
    import shutil

    shutil.rmtree(tenant_store.tenant_local_root(tid))
    await tenant_store.stage_in(tid)
    restored = tenant_store.local_data_dir(tid) / "memory" / "agent" / "notes.json"
    assert json.loads(restored.read_text()) == {"fact": "remembered"}


@pytest.mark.asyncio
async def test_cross_tenant_invisibility(minio_live):
    """Tenant A's staged/bucketed memory never appears in tenant B's staging."""
    tid_a, tid_b = _tid(), _tid()
    await tenant_store.stage_in(tid_a)
    secret = tenant_store.local_data_dir(tid_a) / "memory" / "secret.json"
    secret.parent.mkdir(parents=True, exist_ok=True)
    secret.write_text('{"private": true}')
    assert await tenant_store.stage_out(tid_a) is True

    await tenant_store.stage_in(tid_b)
    b_root = tenant_store.tenant_local_root(tid_b)
    leaked = [p for p in b_root.rglob("secret.json")]
    assert leaked == []
    assert "openharness/data/memory/secret.json" not in _remote_names(tid_b)


@pytest.mark.asyncio
async def test_delete_propagation_both_ways(minio_live):
    tid = _tid()
    await tenant_store.stage_in(tid)
    f = tenant_store.local_data_dir(tid) / "memory" / "gone.json"
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text("{}")
    await tenant_store.stage_out(tid)
    assert "openharness/data/memory/gone.json" in _remote_names(tid)

    # Local delete propagates to the bucket on stage_out.
    f.unlink()
    await tenant_store.stage_out(tid)
    assert "openharness/data/memory/gone.json" not in _remote_names(tid)

    # Remote delete propagates locally on stage_in.
    g = tenant_store.local_data_dir(tid) / "memory" / "stale.json"
    g.write_text("{}")  # local-only file, not in bucket
    await tenant_store.stage_in(tid)
    assert not g.exists()


@pytest.mark.asyncio
async def test_handover_close_then_create_no_loss(minio_live):
    """Old session's final stage-out is visible to the immediately-next create."""
    tid = _tid()
    await tenant_store.stage_in(tid)
    mem = tenant_store.local_data_dir(tid) / "memory" / "handover.json"
    mem.parent.mkdir(parents=True, exist_ok=True)
    mem.write_text('{"turn": 42}')
    # close-hook stage-out and next-create stage-in racing: the per-tenant
    # lock serializes them, so the read always sees the write.
    out, _ = await asyncio.gather(
        tenant_store.stage_out(tid), tenant_store.stage_in(tid)
    )
    assert out is True
    await tenant_store.stage_in(tid)
    assert json.loads(mem.read_text()) == {"turn": 42}


@pytest.mark.asyncio
async def test_destroy_purges_bucket_traces(minio_live):
    tid = _tid()
    ohsid = "ws-deadbeef"
    await tenant_store.stage_in(tid)
    data = tenant_store.local_data_dir(tid)
    (data / "memory" / ohsid).mkdir(parents=True)
    (data / "memory" / ohsid / "m.json").write_text("{}")
    (data / "sessions").mkdir(parents=True, exist_ok=True)
    (data / "sessions" / f"{ohsid}.json").write_text("{}")
    await tenant_store.stage_out(tid)
    names = _remote_names(tid)
    assert f"openharness/data/memory/{ohsid}/m.json" in names
    assert f"openharness/data/sessions/{ohsid}.json" in names

    await tenant_store.destroy_session_data(tid, ohsid)
    names = _remote_names(tid)
    assert not any(ohsid in n for n in names)
    assert not (data / "memory" / ohsid).exists()
    assert not (data / "sessions" / f"{ohsid}.json").exists()


@pytest.mark.asyncio
async def test_no_credentials_in_bucket_or_staging(minio_live):
    """Nothing under the tenant prefix ever contains the provider API key."""
    tid = _tid()
    await tenant_store.stage_in(tid)
    await tenant_store.stage_out(tid)
    client = tenant_store._client()
    prefix = tenant_store._remote_prefix(tid)
    for rel in tenant_store._list_remote(client, tid):
        body = client.get_object(settings.minio_bucket, prefix + rel).read()
        assert b"api_key" not in body.lower()
        assert b"secret" not in body.lower()
    for rel, path in tenant_store._list_local(tid).items():
        content = path.read_bytes().lower()
        assert b"api_key" not in content
