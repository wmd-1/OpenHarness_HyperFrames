"""Application configuration via pydantic-settings.

Mirrors ``service/app/config.py`` conventions (OH_ env prefix, SecretStr api_key)
and adds session-lifecycle specific knobs.
"""

from pathlib import Path

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="OH_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Database (shared Postgres, same instance as service/) ---
    db_url: str = "postgresql+asyncpg://localhost:5432/oh"
    db_sync_url: str = "postgresql+psycopg://localhost:5432/oh"
    db_migration_url: str = "postgresql+asyncpg://localhost:5432/oh"

    # --- Redis (shared with service/; use a *different db number* to avoid
    # colliding with the video-service keyspace / Celery broker). ---
    broker_url: str = "redis://localhost:6379/1"

    # --- Storage (mirror service/) ---
    video_dir: Path = Path("/var/openharness/videos")
    workspace_root: Path = Path("/workspaces")
    storage_kind: str = "local"
    s3_endpoint: str | None = None
    s3_bucket: str | None = None
    s3_region: str | None = None
    s3_access_key: str | None = None
    s3_secret_key: str | None = None

    # --- oh CLI ---
    oh_bin: str = "/root/.local/bin/oh"
    headless_shell_path: str = "/opt/chrome-headless-shell-linux64/chrome-headless-shell"
    # OpenHarness upstream API key forwarded to the spawned ``oh`` subprocess
    # via ``--api-key`` (server-fixed injection, never caller-controlled).
    oh_api_key: SecretStr | None = None

    # --- Session lifecycle ---
    # Max live ``oh --backend-only`` subprocesses on this node.
    max_live_sessions: int = 16
    # Grace period (seconds) a session may sit with zero WS connections before
    # being evicted to COLD (snapshot preserved on the shared volume).
    idle_grace_seconds: int = 300
    # Total session lifetime cap (seconds) — a session older than this is expired.
    session_ttl_seconds: int = 86400
    # Per-turn wall-clock timeout; exceeding it kills the process group.
    turn_timeout_seconds: int = 900
    # Bounds snapshot growth — after this many turns further submits are rejected.
    max_turns_per_session: int = 200
    # Default permission policy for new sessions: ``full_auto`` (unattended) or
    # ``interactive`` (approvals round-tripped to the client).
    permission_policy: str = "full_auto"
    # Unanswered approval/question timeout (seconds) -> treated as a denial.
    approval_timeout_seconds: int = 300

    # --- Multi-node affinity routing ---
    # Stable identity of this node (for the Redis routing table). When unset a
    # random uuid is generated at startup.
    node_id: str | None = None
    # Base URL peers use to reach this node (for transparent reverse-proxy
    # forwarding, spec D4). When unset, falls back to ``http://<node_id>:<port>``.
    node_base_url: str | None = None
    # Heartbeat TTL (seconds) for the session:route:<sid> entry.
    route_ttl_seconds: int = 30
    # Bound on the per-session Redis Stream log (approximate maxlen).
    log_stream_maxlen: int = 2000

    # --- API ---
    api_host: str = "0.0.0.0"
    api_port: int = 8001
    api_workers: int = 1

    # --- Auth (mirror service/) ---
    api_key: SecretStr | None = None
    require_auth: bool = False

    # --- Rate limiting (mirror service/) ---
    rate_limit_capacity: int = 10
    rate_limit_refill: float = 1.0

    # --- Per-tenant quotas ---
    # Max concurrent LIVE sessions per tenant.
    tenant_max_concurrent: int = 8
    # Max sessions created per tenant per day.
    tenant_max_daily: int = 200

    # --- CORS ---
    cors_origins: str = ""


settings = Settings()
