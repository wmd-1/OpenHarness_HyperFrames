"""S3-compatible object storage backend (AWS S3 / MinIO).

Implements the :class:`~app.storage.base.VideoStorage` protocol. The boto3
client is injectable so tests can drive it with an in-memory fake instead of a
real bucket (design source R4 / R10).

``boto3`` is imported lazily (only when a real client is constructed) so the
module imports cleanly in environments where S3 is not used.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import BinaryIO

from app.config import settings
from app.storage.base import VideoStorage

logger = logging.getLogger(__name__)


def _make_client(endpoint: str | None):
    """Build a boto3 S3 client with fast-fail timeouts (R8/R11)."""
    import boto3
    import botocore

    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        region_name=settings.s3_region,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
        config=botocore.config.Config(connect_timeout=3, read_timeout=5),
    )


class S3VideoStorage:
    """Store videos as objects in an S3-compatible bucket."""

    def __init__(
        self,
        client=None,
        bucket: str | None = None,
        endpoint: str | None = None,
        public_client=None,
    ) -> None:
        self._bucket = bucket or settings.s3_bucket
        self._endpoint = endpoint or settings.s3_endpoint
        if client is None:
            # Bound the client timeouts so an unreachable/slow S3 endpoint fails
            # fast (seconds, not the 60s boto3 default). This keeps /healthz and
            # normal storage ops from hanging when MinIO is down (R8/R11).
            client = _make_client(self._endpoint)
        self._client = client
        # Separate client bound to the operator-provided public endpoint;
        # presigned URLs are only issued through it (video-tenant-storage R6).
        # Lazily built so local/no-public deployments never construct it.
        self._public_client = public_client

    def save(self, key: str, src: Path) -> str:
        # X2: stream the file via upload_fileobj (multipart) instead of
        # put_object(Body=fh.read()) which buffers the whole file in memory.
        with open(src, "rb") as fh:
            self._client.upload_fileobj(fh, self._bucket, key)
        return key

    def open(self, key: str) -> tuple[BinaryIO, int]:
        # X2: return the lazy StreamingBody instead of pre-reading the whole
        # object into a BytesIO. This prevents OOM on large video downloads.
        resp = self._client.get_object(Bucket=self._bucket, Key=key)
        size = resp["ContentLength"]
        return resp["Body"], size

    def delete(self, key: str) -> None:
        self._client.delete_object(Bucket=self._bucket, Key=key)

    def exists(self, key: str) -> bool:
        try:
            self._client.head_object(Bucket=self._bucket, Key=key)
            return True
        except Exception:
            return False

    def presigned_url(self, key: str, expires: int = 3600) -> str | None:
        """Return a publicly reachable presigned URL, or None to force streaming.

        Only issued when the operator configured ``OH_S3_PUBLIC_ENDPOINT``
        (video-tenant-storage R6): a URL signed against the in-cluster
        endpoint (e.g. ``http://minio:9000``) is useless to external clients,
        so without a public endpoint the download route falls back to
        streaming instead of emitting a broken 302.
        """
        if not settings.s3_public_endpoint:
            return None
        try:
            if self._public_client is None:
                self._public_client = _make_client(settings.s3_public_endpoint)
            return self._public_client.generate_presigned_url(
                "get_object",
                Params={"Bucket": self._bucket, "Key": key},
                ExpiresIn=expires,
            )
        except Exception:
            return None

    def ensure_bucket(self) -> bool:
        """Idempotently ensure the bucket exists (head → create if missing).

        Returns True when the bucket exists (or was created); False when S3
        is unreachable / creation failed. Never raises — callers only warn so
        an ``OH_STORAGE_KIND=local`` topology boots without MinIO (R5).
        """
        try:
            self._client.head_bucket(Bucket=self._bucket)
            return True
        except Exception:
            try:
                self._client.create_bucket(Bucket=self._bucket)
                logger.info("Created S3 bucket %s", self._bucket)
                return True
            except Exception:
                logger.warning(
                    "S3 bucket %s not reachable/creatable", self._bucket
                )
                return False
