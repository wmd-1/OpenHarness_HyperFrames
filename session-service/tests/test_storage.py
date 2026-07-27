"""Tests for artifact storage backends (Task 3.4).

Covers: LocalArtifactStorage CRUD, the per-kind instance cache (SS-13),
cache reset, and the settings-driven ``get_storage`` selection.
"""

from __future__ import annotations

import pytest

from app.config import settings
from app.storage.local import LocalArtifactStorage
from app.storage.s3 import (
    S3ArtifactStorage,
    get_storage,
    reset_storage_cache,
    storage_for_kind,
)


@pytest.fixture
def local_storage(tmp_path):
    return LocalArtifactStorage(root=tmp_path / "artifacts")


def _make_src(tmp_path, content: bytes = b"hello mp4 bytes"):
    src = tmp_path / "src.mp4"
    src.write_bytes(content)
    return src


def test_local_save_open_roundtrip(tmp_path, local_storage):
    src = _make_src(tmp_path)
    key = local_storage.save("sid/0/video.mp4", src)
    assert key == "sid/0/video.mp4"
    assert local_storage.exists(key)
    fh, size = local_storage.open(key)
    try:
        assert size == len(b"hello mp4 bytes")
        assert fh.read() == b"hello mp4 bytes"
    finally:
        fh.close()


def test_local_open_missing_raises(local_storage):
    with pytest.raises(FileNotFoundError):
        local_storage.open("nope/0/missing.mp4")


def test_local_delete(tmp_path, local_storage):
    src = _make_src(tmp_path)
    key = local_storage.save("sid/1/video.mp4", src)
    local_storage.delete(key)
    assert not local_storage.exists(key)
    # Deleting a missing key is a no-op.
    local_storage.delete(key)


def test_local_presigned_url_is_none(local_storage):
    assert local_storage.presigned_url("any/key") is None


def test_storage_for_kind_caches_local_instance():
    """SS-13: repeated calls reuse one instance instead of re-initializing."""
    s1 = storage_for_kind("local")
    s2 = storage_for_kind("local")
    assert s1 is s2
    assert isinstance(s1, LocalArtifactStorage)


def test_storage_for_kind_caches_s3_client():
    """SS-13: the boto3 client is built once and reused per kind."""
    s1 = storage_for_kind("s3")
    s2 = storage_for_kind("s3")
    assert s1 is s2
    assert isinstance(s1, S3ArtifactStorage)
    assert s1._client is s2._client


def test_reset_storage_cache_drops_instances():
    s1 = storage_for_kind("local")
    reset_storage_cache()
    s2 = storage_for_kind("local")
    assert s1 is not s2


def test_get_storage_follows_settings(monkeypatch):
    monkeypatch.setattr(settings, "storage_kind", "local")
    assert isinstance(get_storage(), LocalArtifactStorage)
    reset_storage_cache()
    monkeypatch.setattr(settings, "storage_kind", "s3")
    assert isinstance(get_storage(), S3ArtifactStorage)
