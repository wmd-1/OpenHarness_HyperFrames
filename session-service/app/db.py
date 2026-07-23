"""SQLAlchemy async engine and session factory (mirrors service/app/db.py).

``engine`` and ``async_session`` are module-level attributes so callers MUST
reference them through the module (``from app import db`` then ``db.async_session``)
rather than binding the name at import time — this lets tests reconfigure the
factory via :func:`reconfigure` without stale references.
"""

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings

engine: AsyncEngine = create_async_engine(
    settings.db_url,
    echo=False,
    pool_size=20,
    max_overflow=10,
    pool_pre_ping=True,
)

async_session: async_sessionmaker[AsyncSession] = async_sessionmaker(
    engine, class_=AsyncSession, expire_on_commit=False
)


def reconfigure(new_engine: AsyncEngine, new_factory: async_sessionmaker[AsyncSession]) -> None:
    """Replace the global engine + session factory (used by tests).

    Also disposes the previous engine so its pool is released.
    """
    import asyncio

    global engine, async_session
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            loop.create_task(engine.dispose())
        else:
            loop.run_until_complete(engine.dispose())
    except Exception:
        pass
    engine = new_engine
    async_session = new_factory


async def get_async_session() -> AsyncSession:  # type: ignore[misc]
    """FastAPI dependency that yields an async DB session."""
    async with async_session() as session:
        try:
            yield session
        finally:
            await session.close()
