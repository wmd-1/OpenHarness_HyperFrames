"""Tests for S3 streaming storage (X2).

Verifies that ``save`` uses ``upload_fileobj`` (not ``put_object``) and
``open`` returns the lazy ``StreamingBody`` (not a pre-read ``BytesIO``).
"""

import io
import tempfile
from pathlib import Path

import pytest

from app.storage.s3 import S3VideoStorage


class FakeStreamingBody:
    """Simulates boto3's StreamingBody — lazy, chunk-readable, not pre-read."""

    def __init__(self, data: bytes) -> None:
        self._buf = io.BytesIO(data)

    def read(self, size: int = -1) -> bytes:
        if size == -1:
            return self._buf.read()
        return self._buf.read(size)

    def close(self) -> None:
        self._buf.close()


class FakeS3Client:
    """Minimal S3 client mock that records calls and simulates streaming."""

    def __init__(self) -> None:
        self._store: dict[str, bytes] = {}
        self.put_object_calls: list[dict] = []
        self.upload_fileobj_calls: list[tuple] = []
        self.get_object_calls: list[dict] = []

    def put_object(self, **kwargs) -> None:
        self.put_object_calls.append(kwargs)
        self._store[kwargs["Key"]] = kwargs["Body"]

    def upload_fileobj(self, fh, bucket: str, key: str) -> None:
        self.upload_fileobj_calls.append((bucket, key))
        self._store[key] = fh.read()

    def get_object(self, **kwargs) -> dict:
        self.get_object_calls.append(kwargs)
        key = kwargs["Key"]
        data = self._store[key]
        return {
            "Body": FakeStreamingBody(data),
            "ContentLength": len(data),
        }

    def head_object(self, **kwargs) -> dict:
        if kwargs["Key"] not in self._store:
            raise FileNotFoundError("Not found")
        return {"ContentLength": len(self._store[kwargs["Key"]])}

    def delete_object(self, **kwargs) -> None:
        self._store.pop(kwargs["Key"], None)

    def generate_presigned_url(self, *args, **kwargs) -> str:
        return "https://fake.example.com/signed"


# ---- save tests ----


class TestS3SaveStreaming:
    """S3VideoStorage.save MUST stream, not buffer the whole file (X2)."""

    def test_save_uses_upload_fileobj_not_put_object(self):
        """save MUST call upload_fileobj, not put_object(Body=fh.read()) (X2)."""
        fake = FakeS3Client()
        storage = S3VideoStorage(client=fake, bucket="test-bucket")

        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
            f.write(b"\x00" * 4096)
            src = Path(f.name)

        try:
            key = storage.save("task-123", src)
        finally:
            src.unlink()

        assert key == "task-123.mp4"
        assert len(fake.upload_fileobj_calls) == 1
        assert fake.upload_fileobj_calls[0] == ("test-bucket", "task-123.mp4")
        assert len(fake.put_object_calls) == 0

    def test_save_preserves_file_contents(self):
        """Data uploaded via upload_fileobj must match the source file."""
        fake = FakeS3Client()
        storage = S3VideoStorage(client=fake, bucket="test-bucket")

        payload = b"VIDEO_DATA_" * 1000  # ~10 KB
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
            f.write(payload)
            src = Path(f.name)

        try:
            storage.save("task-content", src)
        finally:
            src.unlink()

        assert fake._store["task-content.mp4"] == payload


# ---- open tests ----


class TestS3OpenStreaming:
    """S3VideoStorage.open MUST return a lazy stream, not BytesIO (X2)."""

    def test_open_returns_streaming_body_not_bytesio(self):
        """open MUST return the raw StreamingBody, not a pre-read BytesIO (X2)."""
        fake = FakeS3Client()
        fake._store["task-456.mp4"] = b"\x00" * 4096

        storage = S3VideoStorage(client=fake, bucket="test-bucket")
        stream, size = storage.open("task-456.mp4")

        assert not isinstance(stream, io.BytesIO)
        assert size == 4096
        stream.close()

    def test_open_supports_chunked_read(self):
        """The returned stream MUST support chunked reads (no pre-buffering)."""
        fake = FakeS3Client()
        fake._store["task-789.mp4"] = b"hello world"

        storage = S3VideoStorage(client=fake, bucket="test-bucket")
        stream, size = storage.open("task-789.mp4")

        assert size == 11
        chunk = stream.read(5)
        assert chunk == b"hello"
        chunk2 = stream.read(6)
        assert chunk2 == b" world"
        stream.close()

    def test_open_read_all(self):
        """The returned stream can also be fully read."""
        fake = FakeS3Client()
        fake._store["task-full.mp4"] = b"complete video data"

        storage = S3VideoStorage(client=fake, bucket="test-bucket")
        stream, size = storage.open("task-full.mp4")

        assert size == 19
        assert stream.read() == b"complete video data"
        stream.close()
