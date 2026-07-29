"""FastAPI dependency injection helpers."""

from typing import AsyncGenerator

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import async_session
from app.config import settings
from app.storage.base import VideoStorage
from app.storage.local import LocalVideoStorage
from app.storage.s3 import S3VideoStorage


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Yield an async DB session (auto-close)."""
    async with async_session() as session:
        yield session


def get_tenant_id(request: Request) -> str:
    """Return the tenant resolved by the auth middleware (WS-A, R15).

    The middleware sets ``request.state.tenant_id`` on every non-health
    request; 'default' covers direct calls that bypass the middleware.
    """
    return getattr(request.state, "tenant_id", "default")


def get_storage() -> VideoStorage:
    """Return the configured video storage backend.

    Honors ``settings.storage_kind`` so the default dependency matches the
    deployment topology (scale-multi-instance Phase 3).
    """
    return storage_for_kind(settings.storage_kind)


def storage_for_kind(kind: str) -> VideoStorage:
    """Select a storage backend for a task's recorded ``storage_kind``.

    Used by the download endpoint so a task's artifact is read from the same
    backend it was written to (design source R4).
    """
    if kind == "s3":
        return S3VideoStorage()
    return LocalVideoStorage()
