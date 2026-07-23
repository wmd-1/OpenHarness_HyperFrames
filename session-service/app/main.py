"""FastAPI application entry point for the session service.

Mirrors ``service/app/main.py`` structure (lifespan, CORS, optional API-key
middleware) and wires the session/ws/health/metrics routers.
"""

from contextlib import asynccontextmanager
import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from secrets import compare_digest

from app.config import settings
from app.observability.logging import configure_logging
from app.observability.metrics import metrics_router
from app.observability.tracing import setup_tracing
from app.routers import health, sessions, ws

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging()
    setup_tracing(app)
    # Startup: reclaim orphaned workspaces from a previous crash/restart (spec 4.5).
    from app.session.supervisor import get_supervisor

    try:
        await get_supervisor().orphan_scan()
    except Exception as exc:
        logger.warning("orphan scan failed: %s", exc)
    yield
    # Graceful shutdown: tear down every live session.
    await get_supervisor().shutdown_all()
    from app import db

    await db.engine.dispose()


app = FastAPI(
    title="OpenHarness Interactive Session Service",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS — explicit origins only.
_cors_origins = (
    [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
    if settings.cors_origins
    else []
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=bool(_cors_origins),
    allow_methods=["*"],
    allow_headers=["*"],
)


def _assert_auth_config() -> None:
    if settings.require_auth and not settings.api_key:
        raise RuntimeError(
            "require_auth=True but api_key is not set; "
            "set OH_API_KEY or disable OH_REQUIRE_AUTH"
        )


_assert_auth_config()

# Auth middleware (mirror service/). Exempts /healthz, /readyz, /metrics.
if settings.require_auth or settings.api_key:

    @app.middleware("http")
    async def api_key_middleware(request: Request, call_next):
        if request.url.path in ("/healthz", "/readyz", "/metrics"):
            return await call_next(request)
        provided = request.headers.get("X-API-Key", "")
        expected = settings.api_key.get_secret_value() if settings.api_key else ""
        if not compare_digest(provided, expected):
            return JSONResponse(status_code=401, content={"detail": "Invalid API key"})
        # Stash tenant/actor for downstream (single-key mode → "default").
        request.state.tenant_id = "default"
        request.state.actor_key_id = None
        return await call_next(request)
else:
    # Open mode: still stash a default tenant so deps resolve uniformly.
    @app.middleware("http")
    async def _default_tenant(request: Request, call_next):
        request.state.tenant_id = "default"
        request.state.actor_key_id = None
        return await call_next(request)


app.include_router(sessions.router)
app.include_router(ws.router)
app.include_router(health.router)
app.include_router(metrics_router)
