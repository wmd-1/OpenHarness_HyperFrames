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


def get_current_tenant_id() -> str:
    """Return the caller's tenant_id.

    In single-node/open mode (no auth configured) this resolves to ``"default"``.
    When auth is enabled the ``X-API-Key`` middleware (registered in main.py)
    stashes the resolved tenant_id on ``request.state.tenant_id``; routers read
    it from there via :func:`tenant_from_request`.
    """
    return "default"


def tenant_from_request(request) -> str:
    """Read the tenant_id resolved by the auth middleware, or ``"default``."""
    return getattr(request.state, "tenant_id", "default") or "default"


def actor_from_request(request) -> str | None:
    """Read the API-key id resolved by the auth middleware (for audit)."""
    return getattr(request.state, "actor_key_id", None)
