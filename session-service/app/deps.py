"""FastAPI dependency injection helpers."""

from typing import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession

from app import db


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Yield an async DB session, explicitly closed in ``finally`` (SS-8).

    Matches :func:`app.db.get_async_session` so both dependencies release the
    connection even when the route handler raises.
    """
    async with db.async_session() as session:
        try:
            yield session
        finally:
            await session.close()


def tenant_from_request(request) -> str:
    """Read the tenant_id resolved by the auth middleware, or ``"default``."""
    return getattr(request.state, "tenant_id", "default") or "default"


def actor_from_request(request) -> str | None:
    """Read the API-key id resolved by the auth middleware (for audit)."""
    return getattr(request.state, "actor_key_id", None)
