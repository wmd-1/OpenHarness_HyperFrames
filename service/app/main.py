"""FastAPI application entry point."""

from contextlib import asynccontextmanager
import logging
import re

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.observability.logging import configure_logging
from app.observability.metrics import metrics_router
from app.observability.tracing import setup_tracing
from app.routers import health, videos
from app.security import resolve_tenant

logger = logging.getLogger(__name__)


def _warn_no_db_credentials() -> None:
    """N16: warn at startup when the DB URL carries no credentials.

    The default ``db_url`` no longer embeds a plaintext password.  In
    production the operator is expected to supply credentials via
    ``OH_DB_URL`` or a ``.env`` file.  This check emits a visible warning
    (not a fatal error) so local dev still works without env config.
    """
    from urllib.parse import urlparse

    parsed = urlparse(settings.db_url)
    if not parsed.username or not parsed.password:
        logger.warning(
            "Database URL has no credentials (user/password). "
            "Set OH_DB_URL with credentials for production use."
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: startup / shutdown hooks."""
    # Startup (Phase 5 observability). `configure_logging` is idempotent;
    # `setup_tracing` is a silent no-op if OpenTelemetry is unavailable, so the
    # service always boots regardless of the tracing dependency state (R8).
    configure_logging()
    setup_tracing(app)
    # Idempotently ensure the tenant bucket exists (video-tenant-storage R5).
    # ensure_bucket never raises; an unreachable MinIO only logs a warning so
    # an OH_STORAGE_KIND=local topology boots without S3 at all.
    if settings.storage_kind == "s3":
        import asyncio

        from app.storage.s3 import S3VideoStorage

        if not await asyncio.to_thread(S3VideoStorage().ensure_bucket):
            logger.warning(
                "S3 bucket %s unavailable at startup; uploads will fail "
                "until MinIO is reachable",
                settings.s3_bucket,
            )
    yield
    # Shutdown
    from app.db import engine

    await engine.dispose()


app = FastAPI(
    title="OpenHarness Video Service",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS — explicit origins only. Credentials are enabled solely when origins
# are explicitly configured; otherwise no cross-origin access is granted.
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

# --- Auth middleware (S1/S2 + WS-A multi-key tenancy) ---
# Always registered: every request resolves to a tenant_id via the shared
# three-step function (open mode → legacy single key → hashed api_keys
# lookup), so multi-key deployments are enforced even without OH_API_KEY /
# OH_REQUIRE_AUTH set. Single-key compare stays constant-time (R15).
def _assert_auth_config() -> None:
    """Boot-time check: if require_auth is on, an api_key MUST be set."""
    if settings.require_auth and not settings.api_key:
        raise RuntimeError(
            "require_auth=True but api_key is not set; "
            "set OH_API_KEY or disable OH_REQUIRE_AUTH"
        )


_assert_auth_config()
_warn_no_db_credentials()

# Only /file and /events may authenticate via ?api_key= (browser EventSource /
# <a> downloads cannot set custom headers). All other endpoints stay
# header-only (R15).
_QUERY_KEY_PATH_RE = re.compile(r"^/v1/videos/[0-9a-fA-F-]+/(file|events)$")


@app.middleware("http")
async def api_key_middleware(request, call_next):
    # /healthz and /readyz are always accessible (liveness/readiness probes).
    if request.url.path in ("/healthz", "/readyz"):
        return await call_next(request)
    provided = request.headers.get("X-API-Key", "")
    if (
        not provided
        and request.method == "GET"
        and _QUERY_KEY_PATH_RE.match(request.url.path)
    ):
        provided = request.query_params.get("api_key", "")
    resolved = await resolve_tenant(provided or None)
    if resolved is None:
        from fastapi.responses import JSONResponse

        return JSONResponse(status_code=401, content={"detail": "Invalid API key"})
    # Stash tenant/actor for downstream deps (multi-key → the row's tenant;
    # single-key / open mode → "default").
    request.state.tenant_id, request.state.actor_key_id = resolved
    return await call_next(request)


# Register routers
app.include_router(videos.router)
app.include_router(health.router)
# Phase 5 (R8): Prometheus scrape endpoint exposing oh_render_inflight etc.
app.include_router(metrics_router)
