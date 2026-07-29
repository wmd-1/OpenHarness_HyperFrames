"""Local filesystem video storage (shared volume / NFS)."""

import shutil
from pathlib import Path
from typing import BinaryIO

from app.config import settings
from app.storage.base import VideoStorage


class LocalVideoStorage:
    """Store videos on a local directory, backed by a shared volume or NFS mount.

    Directory layout (key is used as a relative path, R3)::

        <video_dir>/
            tenants/<tenant_id>/videos/<task_id>.mp4   # tenant-prefixed keys
            <task_id>.mp4                              # legacy flat keys
    """

    def __init__(self, root: Path | None = None) -> None:
        self._root = root or settings.video_dir
        self._root.mkdir(parents=True, exist_ok=True)

    def save(self, key: str, src: Path) -> str:
        dst = self._root / key
        # Tenant-prefixed keys are nested paths; create parents on demand.
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(str(src), str(dst))
        return key

    def open(self, key: str) -> tuple[BinaryIO, int]:
        path = self._root / key
        if not path.exists():
            raise FileNotFoundError(f"Video file not found: {key}")
        size = path.stat().st_size
        return open(path, "rb"), size  # noqa: SIM115

    def delete(self, key: str) -> None:
        path = self._root / key
        if path.exists():
            path.unlink()

    def exists(self, key: str) -> bool:
        return (self._root / key).exists()

    def presigned_url(self, key: str, expires: int = 3600) -> str | None:
        # Local/NFS storage has no concept of a presigned URL; callers fall
        # back to streaming the file directly (scale-multi-instance R4).
        return None
