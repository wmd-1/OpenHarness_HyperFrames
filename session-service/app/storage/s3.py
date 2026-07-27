"""S3-compatible artifact storage (mirrors service/app/storage/s3.py).

Reused so a session-service deployed alongside ``service/`` reads/writes the
same bucket. The key layout (``<session_id>/<turn_index>/<filename>``) keeps
session artifacts namespaced apart from video-task artifacts.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import BinaryIO

from app.config import settings
from app.storage.local import LocalArtifactStorage

log = logging.getLogger(__name__)

try:
    import boto3
    from botocore.client import Config as BotoConfig
except Exception:  # pragma: no cover - boto3 is a hard dep but stay defensive
    boto3 = None
    BotoConfig = None


class S3ArtifactStorage:
    """Store artifacts in an S3-compatible bucket."""

    def __init__(self) -> None:
        if boto3 is None:  # pragma: no cover
            raise RuntimeError("boto3 is required for S3 storage")
        self._bucket = settings.s3_bucket or "openharness"
        self._client = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint,
            region_name=settings.s3_region or "us-east-1",
            aws_access_key_id=settings.s3_access_key,
            aws_secret_access_key=settings.s3_secret_key,
            config=BotoConfig(signature_version="s3v4", s3={"addressing_style": "path"}),
        )

    def save(self, key: str, src: Path) -> str:
        self._client.upload_file(str(src), self._bucket, key)
        return key

    def open(self, key: str) -> tuple[BinaryIO, int]:
        obj = self._client.get_object(Bucket=self._bucket, Key=key)
        body = obj["Body"]
        size = int(obj.get("ContentLength", 0))
        return body, size

    def delete(self, key: str) -> None:
        try:
            self._client.delete_object(Bucket=self._bucket, Key=key)
        except Exception:
            pass

    def exists(self, key: str) -> bool:
        try:
            self._client.head_object(Bucket=self._bucket, Key=key)
            return True
        except Exception:
            return False

    def presigned_url(self, key: str, expires: int = 3600) -> str | None:
        try:
            return self._client.generate_presigned_url(
                "get_object",
                Params={"Bucket": self._bucket, "Key": key},
                ExpiresIn=expires,
            )
        except Exception:
            return None


# Per-kind instance cache (SS-13).
_storage_cache: dict[str, "LocalArtifactStorage | S3ArtifactStorage"] = {}


def storage_for_kind(kind: str) -> LocalArtifactStorage | S3ArtifactStorage:
    """Select a storage backend by kind (mirrors service/app/deps.py).

    Instances are cached per kind (SS-13) so repeated artifact operations
    reuse one boto3 client instead of re-initializing it every call.
    """
    cached = _storage_cache.get(kind)
    if cached is not None:
        return cached
    storage: LocalArtifactStorage | S3ArtifactStorage
    if kind == "s3":
        storage = S3ArtifactStorage()
    else:
        storage = LocalArtifactStorage()
    _storage_cache[kind] = storage
    return storage


def reset_storage_cache() -> None:
    """Drop cached storage instances (tests / settings reload)."""
    _storage_cache.clear()


def get_storage() -> LocalArtifactStorage | S3ArtifactStorage:
    """Return the configured artifact storage backend."""
    return storage_for_kind(settings.storage_kind)
