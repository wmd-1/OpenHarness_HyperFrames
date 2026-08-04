"""FastAPI application entry point for the session service.

Mirrors ``service/app/main.py`` structure (lifespan, CORS, optional API-key
middleware) and wires the session/ws/health/metrics routers.
"""

from contextlib import asynccontextmanager
import logging
import os
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


def _validate_oh_bin() -> None:
    """OH_OH_BIN semantic validation (session-acceptance-hardening P1-2).

    OH_OH_BIN is a *single executable path* — it becomes argv[0] of
    ``create_subprocess_exec`` (see app/session/process.py::build_command), so
    command strings with arguments are silently broken. Rules:

    1. no whitespace (whitespace ≈ misconfigured command string → point the
       operator at an executable wrapper script instead);
    2. path exists and is a regular file;
    3. executable bit set (``os.access(X_OK)``).

    ``process`` runtime fails fast at startup (instead of erroring on the
    first turn); ``container`` runtime only warns — the session image provides
    the binary, local absence is expected.
    """
    value = settings.oh_bin
    problem: str | None = None
    if re.search(r"\s", value):
        problem = (
            "value contains whitespace — OH_OH_BIN accepts a single executable "
            "path only, not a command string; wrap interpreter/arguments in an "
            "executable wrapper script"
        )
    elif not os.path.isfile(value):
        problem = "path does not exist or is not a regular file"
    elif not os.access(value, os.X_OK):
        problem = "file is not executable (missing +x bit)"
    if problem is None:
        return
    message = (
        f"OH_OH_BIN validation failed: {problem} (OH_OH_BIN={value!r}); "
        "fix .env / compose env, or start stub mode via "
        "`docker compose -f docker-compose.yml -f docker-compose.stub.yml`"
    )
    if settings.session_runtime == "process":
        logger.error(message)
        raise RuntimeError(message)
    logger.warning(
        "%s — continuing: container runtime spawns the backend inside the "
        "session image, which provides its own binary",
        message,
    )


async def sweep_stale_creating() -> int:
    """One-shot CREATING sweep (spec session-credential-gateway-hardening D6).

    A live session is bound to this gateway process, so no legitimate
    CREATING row can survive a restart — converge leftovers to FAILED
    (recoverable via the COLD-style rehydrate path). Single-node semantics:
    a multi-node deployment must first filter rows by node ownership
    (Redis routing table) before sweeping — evolution point, not done here.
    """
    from sqlalchemy import update

    from app import db as app_db
    from app.models import Conversation, SessionStatus

    async with app_db.async_session() as db_session:
        result = await db_session.execute(
            update(Conversation)
            .where(Conversation.status == SessionStatus.CREATING)
            .values(status=SessionStatus.FAILED)
        )
        await db_session.commit()
    return result.rowcount or 0


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging()
    setup_tracing(app)
    # Fail fast on a broken OH_OH_BIN before accepting any traffic (P1-2).
    _validate_oh_bin()
    # Node-level credential gateway (spec session-credential-gateway): warn
    # (never block — stub/e2e runs legitimately have no credential) when no
    # provider credential is resolvable at startup. Spawns re-resolve fresh.
    from app.session.credentials import resolve_provider_credential

    if resolve_provider_credential() is None:
        logger.warning(
            "no provider credential resolvable at startup — spawned backends "
            "will rely on inherited env or their own config fallback"
        )
    try:
        swept = await sweep_stale_creating()
        if swept:
            logger.warning(
                "startup sweep: marked %d stale CREATING session(s) FAILED", swept
            )
    except Exception as exc:
        logger.warning("CREATING startup sweep failed: %s", exc)
    # Startup: reclaim orphaned workspaces from a previous crash/restart (spec 4.5).
    from app.session.supervisor import get_supervisor

    try:
        await get_supervisor().orphan_scan()
    except Exception as exc:
        logger.warning("orphan scan failed: %s", exc)
    # Startup: converge orphaned LIVE/IDLE sessions (whose backend died with a
    # prior gateway) to COLD so reconnect rehydrates them (spec
    # session-lifecycle-convergence, part A).
    try:
        moved = await get_supervisor().reconcile_stale_live()
        if moved:
            logger.warning(
                "startup converge: demoted %d stale LIVE/IDLE session(s) to COLD "
                "(gateway_restart)",
                moved,
            )
    except Exception as exc:
        logger.warning("stale-live reconcile failed: %s", exc)
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
    # Narrowed to the methods/headers the frontend actually uses (F11): GET /
    # POST / DELETE plus the CORS preflight OPTIONS; only X-API-Key and
    # Content-Type are ever sent by the client.
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["X-API-Key", "Content-Type"],
)


def _assert_auth_config() -> None:
    if settings.require_auth and not settings.api_key:
        raise RuntimeError(
            "require_auth=True but api_key is not set; "
            "set OH_API_KEY or disable OH_REQUIRE_AUTH"
        )


def _assert_single_worker() -> None:
    # SessionSupervisor / ContainerPool / SessionRegistry are in-process
    # singletons holding live-session state, the admission queue and approval
    # futures. Running multiple workers in one process would fork this state and
    # corrupt scheduling. Scale horizontally via multi-node affinity
    # (OH_NODE_ID + Redis routing table), never OH_API_WORKERS > 1.
    if settings.api_workers != 1:
        raise RuntimeError(
            f"api_workers={settings.api_workers} but the session service holds "
            "in-process singleton state and MUST run with a single worker; "
            "scale out via multi-node affinity (OH_NODE_ID + Redis routing), "
            "not OH_API_WORKERS > 1"
        )


_assert_auth_config()
_assert_single_worker()

# A2: only download GETs may authenticate via ?api_key= (media/anchor elements
# cannot set request headers). Every other REST path stays header-only.
# F1: workspace file downloads are surfaced by the frontend as ?api_key= direct
# links too, so they must join the artifact GET on the query-param allowlist —
# otherwise enabling auth breaks workspace downloads with a 401.
_ARTIFACT_PATH_RE = re.compile(r"^/v1/sessions/[0-9a-fA-F-]+/turns/\d+/artifact$")
_WORKSPACE_FILE_PATH_RE = re.compile(
    r"^/v1/sessions/[0-9a-fA-F-]+/workspace/files/.+$"
)


def _is_query_param_auth_path(method: str, path: str) -> bool:
    """Only GET download endpoints may fall back to ?api_key= auth."""
    if method != "GET":
        return False
    return bool(_ARTIFACT_PATH_RE.match(path) or _WORKSPACE_FILE_PATH_RE.match(path))


# Unified auth middleware (WS-A): every request goes through resolve_tenant
# (open mode → legacy single key → hashed api_keys lookup), so multi-key
# deployments are enforced even without OH_API_KEY / OH_REQUIRE_AUTH set.
# Exempts /healthz, /readyz, /metrics.
@app.middleware("http")
async def api_key_middleware(request: Request, call_next):
    if request.url.path in ("/healthz", "/readyz", "/metrics"):
        return await call_next(request)
    provided = request.headers.get("X-API-Key", "")
    if not provided and _is_query_param_auth_path(
        request.method, request.url.path
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
