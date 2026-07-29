"""Tests for tenant-prefixed object storage (video-tenant-storage WS-C).

Covers: key generation + whitelist (R1/R2), the ``save(key, src)`` signature
with nested/legacy-flat keys (R3), worker/delete backend resolution (R4),
ensure_bucket idempotency + readyz S3 probe (R5), and public-endpoint
presigned URLs with streaming fallback (R6).
"""

import inspect
import tempfile
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import Session

from app.models import Base, TaskStatus, VideoTask
from app.storage.keys import video_object_key
from app.storage.local import LocalVideoStorage
from app.storage.s3 import S3VideoStorage
from app.workers import tasks as worker_tasks


# ---- R1/R2: key generation + whitelist ----


class TestVideoObjectKey:
    def test_canonical_layout(self):
        """Key MUST be tenants/{tid}/videos/{task_id}.mp4 (R1)."""
        assert (
            video_object_key("alice", "t1") == "tenants/alice/videos/t1.mp4"
        )

    def test_valid_special_chars_pass(self):
        """Dots, dashes and underscores are whitelisted (R2 scenario)."""
        key = video_object_key("user-01.test_A", "t9")
        assert key == "tenants/user-01.test_A/videos/t9.mp4"

    @pytest.mark.parametrize(
        "bad", ["../etc", "a/b", "", "a" * 129, "te nant", "tid\x00", "a\\b"]
    )
    def test_malicious_tenant_rejected(self, bad):
        """Traversal / separator / oversize tenant ids MUST raise (R2)."""
        with pytest.raises(ValueError):
            video_object_key(bad, "t1")


# ---- R3: save(key, src) semantics ----


class TestLocalStorageKeys:
    def test_save_nested_key_creates_parents(self, tmp_path):
        """LocalVideoStorage MUST write the key as a relative path (R3)."""
        storage = LocalVideoStorage(root=tmp_path)
        src = tmp_path / "src.mp4"
        src.write_bytes(b"\x00" * 128)

        key = storage.save("tenants/alice/videos/t1.mp4", src)

        assert key == "tenants/alice/videos/t1.mp4"
        assert (tmp_path / "tenants/alice/videos/t1.mp4").read_bytes() == b"\x00" * 128

    def test_legacy_flat_key_still_resolves(self, tmp_path):
        """Flat legacy keys keep working for open/exists/delete (R3)."""
        storage = LocalVideoStorage(root=tmp_path)
        (tmp_path / "old-task.mp4").write_bytes(b"legacy")

        assert storage.exists("old-task.mp4")
        fh, size = storage.open("old-task.mp4")
        assert (fh.read(), size) == (b"legacy", 6)
        fh.close()
        storage.delete("old-task.mp4")
        assert not storage.exists("old-task.mp4")


class TestS3StorageKeys:
    def test_save_uses_key_verbatim(self):
        """S3VideoStorage MUST upload under the caller-provided key (R3)."""
        fake = MagicMock()
        storage = S3VideoStorage(client=fake, bucket="oh-tenants")

        with tempfile.NamedTemporaryFile(suffix=".mp4") as f:
            f.write(b"data")
            f.flush()
            key = storage.save("tenants/bob/videos/t2.mp4", Path(f.name))

        assert key == "tenants/bob/videos/t2.mp4"
        args = fake.upload_fileobj.call_args.args
        assert args[1:] == ("oh-tenants", "tenants/bob/videos/t2.mp4")


# ---- R4: worker saves by config, deletes by task row ----


class TestBackendResolution:
    def test_worker_storage_for_kind(self):
        """Module-local resolver maps s3 -> S3, everything else -> Local."""
        assert isinstance(worker_tasks._storage_for_kind("local"), LocalVideoStorage)
        assert isinstance(worker_tasks._storage_for_kind(None), LocalVideoStorage)
        with patch.object(worker_tasks, "S3VideoStorage") as m_s3:
            worker_tasks._storage_for_kind("s3")
            m_s3.assert_called_once_with()

    def test_generate_task_saves_via_configured_backend(self):
        """generate_video_task MUST select by settings.storage_kind and build
        the key via video_object_key (R1/R4 — no hardcoded LocalVideoStorage)."""
        source = inspect.getsource(worker_tasks.generate_video_task.run)
        assert "settings.storage_kind" in source
        assert "_storage_for_kind(storage_kind)" in source
        assert "video_object_key(tenant_id, str(task_id))" in source
        assert "storage = LocalVideoStorage()" not in source

    def test_cleanup_deletes_by_task_row(self):
        """cleanup_expired_tasks MUST resolve the backend per task row (R4)."""
        source = inspect.getsource(worker_tasks.cleanup_expired_tasks.run)
        assert "_storage_for_kind(task.storage_kind)" in source
        assert "storage = LocalVideoStorage()" not in source

    def test_delete_endpoint_resolves_by_task_row(self):
        """DELETE /v1/videos/{id} MUST use storage_for_kind(task.storage_kind)."""
        from app.routers import videos

        source = inspect.getsource(videos.delete_video)
        assert "storage_for_kind(task.storage_kind)" in source

    def test_mark_succeeded_records_storage_kind(self):
        """_mark_succeeded MUST persist the backend actually used (R4)."""
        eng = create_engine("sqlite://")
        Base.metadata.create_all(eng)
        worker_tasks._sync_engine = eng
        try:
            with Session(eng) as s:
                t = VideoTask(prompt="p", status=TaskStatus.RUNNING)
                s.add(t)
                s.commit()
                tid = str(t.id)

            meta = type("M", (), dict(
                file_size_bytes=1, duration_seconds=1.0, resolution="2x2", fps=1
            ))
            result = type("R", (), dict(exit_code=0))
            assert worker_tasks._mark_succeeded(
                tid, "tenants/alice/videos/x.mp4", meta, result, storage_kind="s3"
            )

            with Session(eng) as s:
                got = s.get(VideoTask, uuid.UUID(tid))
                assert got.storage_kind == "s3"
                assert got.output_path == "tenants/alice/videos/x.mp4"
        finally:
            worker_tasks._sync_engine = None
            eng.dispose()


# ---- R6: presigned URLs only via the public endpoint ----


class TestPresignedPublicEndpoint:
    def test_no_public_endpoint_returns_none(self, monkeypatch):
        """Without OH_S3_PUBLIC_ENDPOINT presigned_url MUST be None (R6)."""
        from app.storage import s3 as s3_mod

        monkeypatch.setattr(s3_mod.settings, "s3_public_endpoint", None)
        internal = MagicMock()
        storage = S3VideoStorage(client=internal, bucket="b")

        assert storage.presigned_url("k.mp4") is None
        internal.generate_presigned_url.assert_not_called()

    def test_public_endpoint_signs_via_public_client(self, monkeypatch):
        """With a public endpoint the URL comes from the public client (R6)."""
        from app.storage import s3 as s3_mod

        monkeypatch.setattr(
            s3_mod.settings, "s3_public_endpoint", "https://minio.example.com"
        )
        internal = MagicMock()
        public = MagicMock()
        public.generate_presigned_url.return_value = (
            "https://minio.example.com/oh-tenants/k.mp4?sig=x"
        )
        storage = S3VideoStorage(client=internal, bucket="b", public_client=public)

        url = storage.presigned_url("k.mp4")
        assert url.startswith("https://minio.example.com")
        internal.generate_presigned_url.assert_not_called()


# ---- R5: ensure_bucket idempotency + readyz probe ----


class TestEnsureBucket:
    def test_bucket_exists_is_noop(self):
        client = MagicMock()
        storage = S3VideoStorage(client=client, bucket="oh-tenants")
        assert storage.ensure_bucket() is True
        client.head_bucket.assert_called_once_with(Bucket="oh-tenants")
        client.create_bucket.assert_not_called()

    def test_missing_bucket_created(self):
        client = MagicMock()
        client.head_bucket.side_effect = Exception("404")
        storage = S3VideoStorage(client=client, bucket="oh-tenants")
        assert storage.ensure_bucket() is True
        client.create_bucket.assert_called_once_with(Bucket="oh-tenants")

    def test_unreachable_returns_false_never_raises(self):
        client = MagicMock()
        client.head_bucket.side_effect = Exception("down")
        client.create_bucket.side_effect = Exception("down")
        storage = S3VideoStorage(client=client, bucket="oh-tenants")
        assert storage.ensure_bucket() is False


# ---- readyz reflects S3 degradation (R5) ----

_engine = create_async_engine("sqlite+aiosqlite://", echo=False)
_TestSession = async_sessionmaker(_engine, class_=AsyncSession, expire_on_commit=False)


@pytest.fixture
async def client():
    from app.deps import get_db
    from app.main import app

    async with _engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async def _override_db():
        async with _TestSession() as session:
            yield session

    app.dependency_overrides[get_db] = _override_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.clear()
    async with _engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


async def test_readyz_503_when_s3_down(client):
    """storage_kind=s3 + MinIO down => readyz MUST go 503/degraded (R5)."""
    with patch("app.routers.health._db_ok", new=AsyncMock(return_value=True)), patch(
        "app.routers.health._redis_ok", new=AsyncMock(return_value=True)
    ), patch("app.routers.health._s3_ok", new=AsyncMock(return_value=False)):
        resp = await client.get("/readyz")
    assert resp.status_code == 503
    assert resp.json()["status"] == "degraded"


async def test_readyz_ok_when_s3_not_configured(client):
    """local topology (_s3_ok -> None) MUST stay ready (R5)."""
    with patch("app.routers.health._db_ok", new=AsyncMock(return_value=True)), patch(
        "app.routers.health._redis_ok", new=AsyncMock(return_value=True)
    ), patch("app.routers.health._s3_ok", new=AsyncMock(return_value=None)):
        resp = await client.get("/readyz")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"
