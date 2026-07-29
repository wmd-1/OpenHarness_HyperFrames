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
    # Max accepted size (bytes) of one OHJSON backend-event payload (SS-14);
    # oversized payloads are rejected instead of parsed.
    backend_event_max_bytes: int = 1048576

    # --- API ---
    api_host: str = "0.0.0.0"
    api_port: int = 8001
    api_workers: int = 1

    # --- Auth (mirror service/) ---
    api_key: SecretStr | None = None
    require_auth: bool = False
    # TTL (seconds) of the in-process api_keys lookup cache (WS-A). Revoking a
    # key takes effect within this window.
    apikey_cache_ttl: float = 60.0

    # --- Rate limiting (mirror service/) ---
    rate_limit_capacity: int = 10
    rate_limit_refill: float = 1.0
    # Comma-separated peer IPs allowed to set X-Forwarded-For (SS-5). When the
    # direct peer is not in this list the XFF header is ignored, so clients
    # cannot forge their rate-limit key. Empty (default) = never trust XFF.
    trusted_proxy: str = ""

    # --- Per-tenant quotas ---
    # Max concurrent LIVE sessions per tenant. Default 1 (rev2, spec D8): one
    # user (= tenant) has a single active session, so tenant-level stage-in/
    # stage-out degenerates to "pull on entry, push on exit" with no
    # concurrent-write merge semantics. Deployments MAY raise this, but then
    # last-writer-wins applies to user-scope memory (documented risk).
    tenant_max_concurrent: int = 1
    # Max sessions created per tenant per day.
    tenant_max_daily: int = 200

    # --- Tenant data (WS-B: MinIO authoritative source + local staging) ---
    # S3-compatible endpoint host:port (no scheme), e.g. "minio:9000". Unset
    # disables tenant staging entirely (single-tenant/dev fallback).
    minio_endpoint: str | None = None
    minio_access_key: SecretStr | None = None
    minio_secret_key: SecretStr | None = None
    # Bucket holding all tenant prefixes ``tenants/{tid}/{openharness,rules}/``.
    minio_bucket: str = "oh-tenants"
    # TLS toggle for the MinIO client (compose-internal traffic is plain HTTP).
    minio_secure: bool = False
    # Node-local *disposable* staging root; ``/tenants/{tid}/`` mirrors the
    # tenant's bucket prefix and can be wiped and rebuilt from MinIO.
    tenants_root: Path = Path("/tenants")

    # --- Backend runtime (WS-C) ---
    # Which backend runtime the supervisor spawns: "process" (default,
    # oh --backend-only subprocess — existing behaviour) or "container"
    # (one disposable docker container per session, spec D3/D4).
    session_runtime: str = "process"
    # Image used for per-session containers. Defaults to the existing main
    # image tag (compose OH_VERSION_HYPERFRAMES_VERSION) — never rebuilt.
    session_image: str = (
        "openharness_hyperframes_qwen-tts_pptx:v0.1.9_v0.7.77_v1.4_v2.1"
    )
    # Per-container resource limits (D4 security/resource baseline).
    container_mem_limit: str = "2g"
    container_cpus: float = 2.0
    container_pids_limit: int = 512
    # cap_drop=ALL baseline. Disable only if Chrome needs caps that e2e (Q2)
    # shows cannot be individually re-added.
    container_cap_drop: bool = True
    # Comma-separated bind specs (``source:dest[:mode]``) for per-session
    # containers. Defaults mirror the compose named volumes so a sibling
    # container sees the same /workspaces, /tenants, videos and shared
    # ~/.openharness (skills) trees as the gateway. Deployments append the
    # host-path source mounts here (e.g. ``/host/repo/OpenHarness/src:/app/src``).
    container_binds: str = (
        "openharness-workspaces:/workspaces"
        ",openharness-tenants:/tenants"
        ",openharness-videos:/var/openharness/videos"
        ",openharness-config:/root/.openharness"
    )
    # Docker API endpoint. Unset = aiodocker default (unix socket). Point at a
    # docker-socket-proxy URL to narrow the root-equivalent sock surface (D7).
    docker_host: str | None = None

    # --- Pool scheduling (WS-D) ---
    # Bounded FIFO admission queue when the node is full and nothing is
    # evictable. 0 disables queueing entirely (pre-pool fail-fast: full -> 503).
    pool_queue_size: int = 32
    # Max seconds a create/rehydrate request may wait in the queue before it
    # is rejected with 503 + Retry-After.
    pool_queue_timeout: float = 15.0

    # --- CORS ---
    cors_origins: str = ""


settings = Settings()
