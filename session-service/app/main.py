"""FastAPI application entry point for the session service.

Mirrors ``service/app/main.py`` structure (lifespan, CORS, optional API-key
middleware) and wires the session/ws/health/metrics routers.
"""

from contextlib import asynccontextmanager
import logging
import re

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.observability.logging import configure_logging
from app.observability.metrics import metrics_router
from app.observability.tracing import setup_tracing
from app.routers import health, sessions, ws
from app.security import resolve_tenant

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
    # Dispose shared Redis pools (SS-2 mitigation: no leaked pools on reload).
    from app import ratelimit
    from app.session import logs as log_stream
    from app.session import registry as route_registry

    await ratelimit.close_redis()
    await route_registry.close_client()
    await log_stream.close_client()
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

# A2: only the artifact GET may authenticate via ?api_key= (media elements
# cannot set request headers). Every other REST path stays header-only.
_ARTIFACT_PATH_RE = re.compile(r"^/v1/sessions/[0-9a-fA-F-]+/turns/\d+/artifact$")


# Unified auth middleware (WS-A): every request goes through resolve_tenant
# (open mode → legacy single key → hashed api_keys lookup), so multi-key
# deployments are enforced even without OH_API_KEY / OH_REQUIRE_AUTH set.
# Exempts /healthz, /readyz, /metrics.
@app.middleware("http")
async def api_key_middleware(request: Request, call_next):
    if request.url.path in ("/healthz", "/readyz", "/metrics"):
        return await call_next(request)
    provided = request.headers.get("X-API-Key", "")
    if (
        not provided
        and request.method == "GET"
        and _ARTIFACT_PATH_RE.match(request.url.path)
    ):
        provided = request.query_params.get("api_key", "")
    resolved = await resolve_tenant(provided or None)
    if resolved is None:
        return JSONResponse(status_code=401, content={"detail": "Invalid API key"})
    # Stash tenant/actor for downstream deps (multi-key → the row's tenant;
    # single-key / open mode → "default").
    request.state.tenant_id, request.state.actor_key_id = resolved
    return await call_next(request)


app.include_router(sessions.router)
app.include_router(ws.router)
app.include_router(health.router)
app.include_router(metrics_router)
