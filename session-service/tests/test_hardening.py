"""Quality-gate tests for harden-session-service (SS-1 … SS-18).

One focused test per hardening guarantee that is not already covered by the
module test files: XFF trust (SS-5), Lua token-bucket atomicity (SS-9),
filename sanitize (SS-6), approval enum (SS-15), payload cap (SS-14),
ffprobe degradation (SS-16), api_key masking (SS-11), get_db close (SS-8),
quota atomicity + daily quota (SS-3/SS-18), COLD single-writer (SS-4).
"""

from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.config import settings


# --- SS-5: X-Forwarded-For only honored behind a trusted proxy ---------------


def _fake_request(peer: str, xff: str | None = None):
    headers = {}
    if xff is not None:
        headers["X-Forwarded-For"] = xff
    return SimpleNamespace(client=SimpleNamespace(host=peer), headers=headers)


def test_xff_ignored_from_untrusted_peer(monkeypatch):
    from app.ratelimit import _client_ip

    monkeypatch.setattr(settings, "trusted_proxy", "")
    req = _fake_request("198.51.100.7", xff="1.2.3.4")
    assert _client_ip(req) == "198.51.100.7"


def test_xff_honored_from_trusted_proxy(monkeypatch):
    from app.ratelimit import _client_ip

    monkeypatch.setattr(settings, "trusted_proxy", "10.0.0.1, 10.0.0.2")
    req = _fake_request("10.0.0.2", xff="1.2.3.4, 10.0.0.2")
    assert _client_ip(req) == "1.2.3.4"


def test_no_xff_uses_socket_peer(monkeypatch):
    from app.ratelimit import _client_ip

    monkeypatch.setattr(settings, "trusted_proxy", "10.0.0.1")
    assert _client_ip(_fake_request("10.0.0.1")) == "10.0.0.1"


# --- SS-9/SS-12: token bucket is atomic under concurrency --------------------


@pytest.mark.asyncio
async def test_token_bucket_atomic_under_concurrency(monkeypatch):
    from app.ratelimit import check_rate_limit

    monkeypatch.setattr(settings, "rate_limit_capacity", 3)
    monkeypatch.setattr(settings, "rate_limit_refill", 0.001)
    results = await asyncio.gather(
        *(check_rate_limit("ip-atomic-test") for _ in range(10))
    )
    # Exactly capacity requests pass — no read-modify-write race oversell.
    assert sum(results) == 3


# --- SS-6: Content-Disposition filename sanitize ------------------------------


def test_sanitize_filename_strips_header_injection():
    from app.routers.sessions import _sanitize_filename

    assert (
        _sanitize_filename('evil";\r\nX-Injected: 1.mp4') == "evil____X-Injected__1.mp4"
    )
    assert _sanitize_filename("normal_video-1.mp4") == "normal_video-1.mp4"
    assert _sanitize_filename("dir/../x.mp4") == "dir_.._x.mp4"  # no path separators


# --- SS-15: ApprovalRequest.reply enum ----------------------------------------


def test_approval_reply_enum_validation():
    from app.schemas import ApprovalRequest

    for ok in ("once", "always", "reject", None):
        ApprovalRequest(request_id="r1", reply=ok)
    with pytest.raises(ValidationError):
        ApprovalRequest(request_id="r1", reply="rm -rf /")


# --- SS-14: oversized backend event payload rejected --------------------------


@pytest.mark.asyncio
async def test_adapter_rejects_oversized_payload(monkeypatch):
    from app.session.adapter import ProtocolAdapter

    monkeypatch.setattr(settings, "backend_event_max_bytes", 128)
    adapter = ProtocolAdapter(SimpleNamespace())  # process unused by _handle_line
    big = json.dumps({"type": "assistant_delta", "text": "x" * 4096})
    await adapter._handle_line("OHJSON:" + big)
    assert adapter.events.empty()  # never parsed into an event
    logged = adapter.logs.get_nowait()
    assert logged.startswith("[oversized event rejected:")

    # A normal-size event still parses.
    small = json.dumps({"type": "assistant_delta", "text": "hi"})
    await adapter._handle_line("OHJSON:" + small)
    event = adapter.events.get_nowait()
    assert event.type == "assistant_delta"


@pytest.mark.asyncio
async def test_adapter_truncates_long_log_lines():
    from app.session.adapter import _LOG_LINE_MAX, ProtocolAdapter

    adapter = ProtocolAdapter(SimpleNamespace())
    await adapter._handle_line("y" * (_LOG_LINE_MAX * 2))
    assert len(adapter.logs.get_nowait()) == _LOG_LINE_MAX


# --- SS-16: ffprobe malformed numerics degrade gracefully ---------------------


def test_probe_mp4_degrades_on_malformed_frame_rate(monkeypatch, tmp_path):
    from app.session import artifacts

    payload = {
        "format": {"duration": "2.5"},
        "streams": [
            {
                "codec_type": "video",
                "width": 640,
                "height": 480,
                "r_frame_rate": "30/abc",  # int("abc") -> ValueError
            }
        ],
    }

    def _fake_run(*_a, **_k):
        return SimpleNamespace(returncode=0, stdout=json.dumps(payload))

    monkeypatch.setattr(artifacts, "run", _fake_run)
    video = tmp_path / "v.mp4"
    video.write_bytes(b"0" * 32)
    meta = artifacts.probe_mp4(video)
    # Whatever parsed before the bad field is kept; fps degrades to None.
    assert meta.duration_seconds == 2.5
    assert meta.resolution == "640x480"
    assert meta.fps is None
    assert meta.file_size_bytes == 32


@pytest.mark.asyncio
async def test_probe_mp4_async_offloads(monkeypatch, tmp_path):
    from app.session import artifacts

    def _fake_run(*_a, **_k):
        return SimpleNamespace(returncode=1, stdout="")

    monkeypatch.setattr(artifacts, "run", _fake_run)
    video = tmp_path / "v.mp4"
    video.write_bytes(b"0" * 16)
    meta = await artifacts.probe_mp4_async(video)
    assert meta.file_size_bytes == 16


# --- SS-11: api_key masking in logs -------------------------------------------


def test_mask_api_key_variants():
    from app.observability.logging import mask_api_key

    assert mask_api_key("ws://h/ws?api_key=sk-secret123&x=1") == (
        "ws://h/ws?api_key=***&x=1"
    )
    assert mask_api_key('{"api_key": "sk-abc"}') == '{"api_key": "***"}'
    assert mask_api_key("Api-Key: tok-1") == "Api-Key: ***"
    assert mask_api_key("no secrets here") == "no secrets here"


def test_mask_processor_scrubs_event_dict():
    from app.observability.logging import _mask_secrets_processor

    out = _mask_secrets_processor(None, "info", {"url": "/ws?api_key=sk-x", "n": 3})
    assert out["url"] == "/ws?api_key=***"
    assert out["n"] == 3


# --- SS-8: get_db closes the session even on error ----------------------------


@pytest.mark.asyncio
async def test_get_db_closes_session_on_error(monkeypatch):
    from app import deps

    class _FakeSession:
        def __init__(self) -> None:
            self.closed = False

        async def close(self) -> None:
            self.closed = True

    fake = _FakeSession()

    class _Ctx:
        async def __aenter__(self):
            return fake

        async def __aexit__(self, *args):
            return False

    monkeypatch.setattr(deps.db, "async_session", lambda: _Ctx())
    gen = deps.get_db()
    session = await gen.__anext__()
    assert session is fake
    with pytest.raises(RuntimeError):
        await gen.athrow(RuntimeError("handler blew up"))
    assert fake.closed is True


# --- SS-18: per-tenant daily creation quota -> 403 -----------------------------


@pytest.mark.asyncio
async def test_daily_quota_exceeded_returns_403(client, monkeypatch):
    monkeypatch.setattr(settings, "tenant_max_daily", 1)
    r1 = await client.post("/v1/sessions", json={})
    assert r1.status_code == 201
    r2 = await client.post("/v1/sessions", json={})
    assert r2.status_code == 403
    detail = r2.json()["detail"]
    # Structured code (harden-session-frontend E1): quota vs access 403.
    assert detail["code"] == "daily_quota_exceeded"
    assert "daily" in detail["message"].lower()


# --- SS-3: concurrent creates cannot oversell the concurrent quota -------------


@pytest.mark.asyncio
async def test_concurrent_creates_do_not_oversell_quota(client, monkeypatch):
    monkeypatch.setattr(settings, "tenant_max_concurrent", 1)
    r1, r2 = await asyncio.gather(
        client.post("/v1/sessions", json={}),
        client.post("/v1/sessions", json={}),
    )
    assert sorted([r1.status_code, r2.status_code]) == [201, 429]


# --- F4: multi-worker startup is refused (in-process singleton state) ---------


def test_assert_single_worker_rejects_multi_worker(monkeypatch):
    from app.main import _assert_single_worker

    monkeypatch.setattr(settings, "api_workers", 2)
    with pytest.raises(RuntimeError, match="single worker"):
        _assert_single_worker()


def test_assert_single_worker_accepts_one_worker(monkeypatch):
    from app.main import _assert_single_worker

    monkeypatch.setattr(settings, "api_workers", 1)
    _assert_single_worker()  # must not raise


# --- SS-4: concurrent COLD reconnects trigger exactly one rehydrate ------------


@pytest.mark.asyncio
async def test_concurrent_cold_register_single_rehydrate():
    from app.session.lifecycle import SessionState
    from app.session.supervisor import LiveSession, SessionSupervisor

    sup = SessionSupervisor()
    sid = uuid.uuid4()

    def _cold_session() -> LiveSession:
        live = LiveSession(
            sid=sid,
            tenant_id="default",
            cwd=Path("/tmp"),
            oh_session_id="oh-1",
            permission_policy="full_auto",
            extra_args=[],
            epoch=1,
        )
        live.state = SessionState.COLD
        return live

    calls = {"n": 0}

    async def _fake_rehydrate(live, *, db):
        calls["n"] += 1
        await asyncio.sleep(0.01)  # widen the race window
        live.process = SimpleNamespace()
        live.state = SessionState.LIVE

    sup.rehydrate = _fake_rehydrate  # type: ignore[method-assign]
    a, b = _cold_session(), _cold_session()
    ra, rb = await asyncio.gather(
        sup.register_live_session(a, db=None),
        sup.register_live_session(b, db=None),
    )
    assert calls["n"] == 1  # single writer
    assert ra is rb  # the loser reuses the winner's live session
    sup.remove_live_session(sid)
