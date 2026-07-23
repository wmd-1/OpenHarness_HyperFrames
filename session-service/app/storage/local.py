"""Local filesystem artifact storage (shared volume / NFS).

Mirrors ``service/app/storage/local.py``. Artifacts are keyed by
``<session_id>/<turn_index>/<filename>`` under the configured video_dir.
"""

import shutil
from pathlib import Path
from typing import BinaryIO

from app.config import settings


class LocalArtifactStorage:
    """Store artifacts on a local directory backed by a shared volume or NFS."""

    def __init__(self, root: Path | None = None) -> None:
        self._root = root or settings.video_dir
        self._root.mkdir(parents=True, exist_ok=True)

    def save(self, key: str, src: Path) -> str:
        dst = self._root / key
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(str(src), str(dst))
        return key

    def open(self, key: str) -> tuple[BinaryIO, int]:
        path = self._root / key
        if not path.exists():
            raise FileNotFoundError(f"Artifact not found: {key}")
        size = path.stat().st_size
        return open(path, "rb"), size  # noqa: SIM115

    def delete(self, key: str) -> None:
        path = self._root / key
        if path.exists():
            path.unlink()

    def exists(self, key: str) -> bool:
        return (self._root / key).exists()

    def presigned_url(self, key: str, expires: int = 3600) -> str | None:
        return None
