"""Tests for the video file download endpoint (streaming + Range, #3 / #8).

Covers:
- #3: a real 200 stream returns the full file via the threadpool-offloaded
  ``_iterfile`` generator (event loop stays free), with correct bytes/headers.
- #8: an ``Accept-Ranges: bytes`` advertisement that is honest -- a ``Range``
  request returns 206 with ``Content-Range`` and only the requested tail.
"""

import shutil
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.deps import get_db, get_storage
from app.main import app
from app.models import Base, TaskStatus, VideoTask
from app.storage.local import LocalVideoStorage


SQLALCHEMY_DATABASE_URL = "sqlite+aiosqlite://"
engine = create_async_engine(SQLALCHEMY_DATABASE_URL, echo=False)
TestAsyncSession = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


@pytest.fixture(autouse=True)
async def setup_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


@pytest.fixture
async def db_session():
    async with TestAsyncSession() as session:
        yield session


@pytest.fixture
async def stream_env(db_session):
    """Client wired to a temp storage pre-populated with a 1024-byte file."""
    tmp = tempfile.mkdtemp()
    storage = LocalVideoStorage(root=Path(tmp))
    payload = bytes((i % 256) for i in range(1024))
    key = "clip.mp4"
    (Path(tmp) / key).write_bytes(payload)

    async def _override_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_storage] = lambda: storage
    # download_video uses storage_for_kind(task.storage_kind) — not
    # Depends(get_storage) — so patch it to return the test storage.
    with patch("app.routers.videos.storage_for_kind", return_value=storage):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac, key, payload
    app.dependency_overrides.clear()
    shutil.rmtree(tmp, ignore_errors=True)


async def test_download_streams_full_file(stream_env, db_session):
    client, key, payload = stream_env
    task = VideoTask(prompt="x", status=TaskStatus.SUCCEEDED, output_path=key)
    db_session.add(task)
    await db_session.commit()
    await db_session.refresh(task)

    resp = await client.get(f"/v1/videos/{task.id}/file")

    assert resp.status_code == 200
    assert resp.content == payload
    assert resp.headers["accept-ranges"] == "bytes"
    assert int(resp.headers["content-length"]) == len(payload)
    assert resp.headers["content-type"] == "video/mp4"


async def test_download_range_returns_206(stream_env, db_session):
    client, key, payload = stream_env
    task = VideoTask(prompt="x", status=TaskStatus.SUCCEEDED, output_path=key)
    db_session.add(task)
    await db_session.commit()
    await db_session.refresh(task)

    resp = await client.get(
        f"/v1/videos/{task.id}/file",
        headers={"Range": "bytes=10-"},
    )

    assert resp.status_code == 206
    assert resp.content == payload[10:]
    assert resp.headers["content-range"] == f"bytes 10-{len(payload) - 1}/{len(payload)}"
    assert int(resp.headers["content-length"]) == len(payload) - 10


async def test_download_range_with_end_byte_returns_exact_bytes(stream_env, db_session):
    """Range: bytes=10-20 MUST return exactly 11 bytes (end-start+1) (L5).

    The old code ignored the end byte and always streamed to EOF.
    """
    client, key, payload = stream_env
    task = VideoTask(prompt="x", status=TaskStatus.SUCCEEDED, output_path=key)
    db_session.add(task)
    await db_session.commit()
    await db_session.refresh(task)

    resp = await client.get(
        f"/v1/videos/{task.id}/file",
        headers={"Range": "bytes=10-20"},
    )

    assert resp.status_code == 206
    assert len(resp.content) == 11, "must return exactly end-start+1 = 11 bytes"
    assert resp.content == payload[10:21]
    assert resp.headers["content-range"] == f"bytes 10-20/{len(payload)}"
    assert int(resp.headers["content-length"]) == 11


async def test_download_range_suffix_returns_last_n_bytes(stream_env, db_session):
    """Range: bytes=-10 MUST return the last 10 bytes (L5)."""
    client, key, payload = stream_env
    task = VideoTask(prompt="x", status=TaskStatus.SUCCEEDED, output_path=key)
    db_session.add(task)
    await db_session.commit()
    await db_session.refresh(task)

    resp = await client.get(
        f"/v1/videos/{task.id}/file",
        headers={"Range": "bytes=-10"},
    )

    assert resp.status_code == 206
    assert len(resp.content) == 10
    assert resp.content == payload[-10:]
    assert resp.headers["content-range"] == f"bytes {len(payload) - 10}-{len(payload) - 1}/{len(payload)}"
    assert int(resp.headers["content-length"]) == 10
