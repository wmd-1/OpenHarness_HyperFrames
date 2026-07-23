"""Artifact storage protocol interface (mirrors service/app/storage/base.py).

Per-turn artifacts (videos/files) are registered in ``turn_artifacts`` and read
through the same storage abstraction as ``service/`` so downloads honor Range
and S3 presigned redirects identically.
"""

from pathlib import Path
from typing import BinaryIO, Protocol, runtime_checkable


@runtime_checkable
class ArtifactStorage(Protocol):
    """Abstract interface for artifact file storage backends."""

    def save(self, key: str, src: Path) -> str:
        """Save an artifact file and return its storage key."""
        ...

    def open(self, key: str) -> tuple[BinaryIO, int]:
        """Open a stored artifact for reading. Returns (fileobj, size)."""
        ...

    def delete(self, key: str) -> None:
        """Delete a stored artifact file."""
        ...

    def exists(self, key: str) -> bool:
        """Check whether a stored artifact exists."""
        ...

    def presigned_url(self, key: str, expires: int = 3600) -> str | None:
        """Return a time-limited download URL, or None if unsupported."""
        ...
