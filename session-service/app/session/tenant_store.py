"""Tenant data staging between MinIO (authoritative) and local scratch (WS-B).

Design (openspec session-container-pool-multitenancy, D2 rev2):

- The ONLY authoritative source of tenant data is the MinIO bucket
  (``OH_MINIO_BUCKET``, default ``oh-tenants``) under the prefix
  ``tenants/{tid}/{openharness,rules}/``.
- The node-local tree ``{tenants_root}/{tid}/`` is a *disposable* staging
  area: it can be wiped at any time and rebuilt from MinIO (stateless nodes).
- ``stage_in``  : mirror bucket prefix -> staging (with delete propagation).
  MinIO unreachable raises :class:`TenantStoreError` -> the router fails fast
  with 503 and no session is created.
- ``stage_out`` : mirror staging -> bucket prefix (with delete propagation),
  exponential-backoff retries; on final failure the staging tree is KEPT, the
  ``oh_tenant_sync_failures_total`` counter is bumped and ``False`` returned
  (hooks must never crash the session lifecycle).
- First-seen tenant: empty prefix -> idempotently seed a credential-free
  ``openharness/settings.json`` under the tenant lock. Credentials NEVER
  enter the bucket or staging — the gateway injects them via process env.
- All same-tenant stage-in/stage-out are serialized by a per-tenant
  ``asyncio.Lock`` (D8: covers the old-session/new-session handover window).
- The blocking ``minio`` SDK is only imported lazily and always driven from a
  worker thread (``asyncio.to_thread``) so the event loop never blocks. With
  ``OH_MINIO_ENDPOINT`` unset the store is disabled and every operation is a
  local-only no-op (single-tenant/dev deployments, existing tests).
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import time
from pathlib import Path

import structlog

from app.config import settings
from app.observability.metrics import TENANT_SYNC_FAILURES

logger = structlog.get_logger(__name__)

# Retry schedule (seconds) for stage-out mirroring.
_STAGE_OUT_BACKOFF = (0.5, 1.0, 2.0)

# Content of the seeded per-tenant OpenHarness settings file. Deliberately an
# empty object: provider keys and any other credentials are injected by the
# gateway through the backend process env, never through files.
_SETTINGS_SEED = json.dumps({}, indent=2) + "\n"


class TenantStoreError(RuntimeError):
    """MinIO unreachable / staging impossible — routers map this to 503."""


# --- tenant id / path safety ---------------------------------------------------

_tenant_locks: dict[str, asyncio.Lock] = {}


def tenant_lock(tenant_id: str) -> asyncio.Lock:
    """Per-tenant lock serializing all stage-in/stage-out for that tenant."""
    lock = _tenant_locks.get(tenant_id)
    if lock is None:
        lock = _tenant_locks.setdefault(tenant_id, asyncio.Lock())
    return lock


def validate_tenant_id(tenant_id: str) -> str:
    """Reject tenant ids that could escape the staging/bucket prefix."""
    if (
        not tenant_id
        or len(tenant_id) > 128
        or "/" in tenant_id
        or "\\" in tenant_id
        or ".." in tenant_id
        or tenant_id.startswith(".")
    ):
        raise ValueError(f"invalid tenant id: {tenant_id!r}")
    return tenant_id


def tenant_local_root(tenant_id: str) -> Path:
    """``{tenants_root}/{tid}`` — the tenant's disposable staging root."""
    return settings.tenants_root / validate_tenant_id(tenant_id)


def local_config_dir(tenant_id: str) -> Path:
    """Staging dir handed to the backend as ``OPENHARNESS_CONFIG_DIR``."""
    return tenant_local_root(tenant_id) / "openharness"


def local_data_dir(tenant_id: str) -> Path:
    """Staging dir handed to the backend as ``OPENHARNESS_DATA_DIR``."""
    return local_config_dir(tenant_id) / "data"


def local_rules_dir(tenant_id: str) -> Path:
    """Staged ``rules/`` tree, copied into each session workspace (D2.3)."""
    return tenant_local_root(tenant_id) / "rules"


def safe_tenant_path(tenant_id: str, candidate: Path) -> Path:
    """Resolve ``candidate`` and require it under ``{tenants_root}/{tid}/``.

    Every local delete in this module goes through this check (spec: cleanup
    paths MUST be validated against the tenant prefix — path traversal guard).
    """
    root = tenant_local_root(tenant_id).resolve()
    resolved = candidate.resolve()
    if resolved != root and root not in resolved.parents:
        raise ValueError(f"path {candidate} escapes tenant staging root {root}")
    return resolved


# --- MinIO plumbing (lazy import; blocking SDK, thread-driven) ------------------


def enabled() -> bool:
    """Tenant syncing is active only when a MinIO endpoint is configured."""
    return bool(settings.minio_endpoint)


def _remote_prefix(tenant_id: str) -> str:
    return f"tenants/{validate_tenant_id(tenant_id)}/"


def _client():
    from minio import Minio  # lazy: not installed in minio-less deployments

    return Minio(
        settings.minio_endpoint,
        access_key=settings.minio_access_key.get_secret_value() if settings.minio_access_key else None,
        secret_key=settings.minio_secret_key.get_secret_value() if settings.minio_secret_key else None,
        secure=settings.minio_secure,
    )


def _ensure_bucket(client) -> None:
    from minio.error import S3Error

    try:
        if not client.bucket_exists(settings.minio_bucket):
            client.make_bucket(settings.minio_bucket)
    except S3Error as exc:  # two gateways racing make_bucket is fine
        if exc.code not in ("BucketAlreadyOwnedByYou", "BucketAlreadyExists"):
            raise


def _list_remote(client, tenant_id: str) -> dict[str, object]:
    """Map relative path -> object entry for the tenant's bucket prefix."""
    prefix = _remote_prefix(tenant_id)
    out: dict[str, object] = {}
    for obj in client.list_objects(settings.minio_bucket, prefix=prefix, recursive=True):
        rel = obj.object_name[len(prefix):]
        if rel:
            out[rel] = obj
    return out


def _list_local(tenant_id: str) -> dict[str, Path]:
    """Map relative path -> file path for the tenant's staging tree.

    Symlinks are NEVER followed or listed: the gateway plants a ``skills``
    symlink into the staging config dir (shared node-local skills) and that
    tree must neither be pushed to the bucket nor touched by delete
    propagation.
    """
    root = tenant_local_root(tenant_id)
    if not root.is_dir():
        return {}
    out: dict[str, Path] = {}
    for dirpath, _dirnames, filenames in os.walk(root, followlinks=False):
        for name in filenames:
            p = Path(dirpath) / name
            if p.is_symlink():
                continue
            out[str(p.relative_to(root))] = p
    return out


def _link_shared_skills(tenant_id: str) -> None:
    """Symlink the node's shared skills into the tenant config dir.

    ``oh`` resolves user skills at ``{OPENHARNESS_CONFIG_DIR}/skills``
    (``skills/loader.py::get_user_skills_dir``); with the config dir redirected
    to tenant staging the node-wide skills (synced by the ``oh`` wrapper to
    ``~/.openharness/skills``) would vanish. The symlink restores them without
    copying; it is excluded from stage-out (symlinks are never mirrored).
    """
    source = Path.home() / ".openharness" / "skills"
    if not source.is_dir():
        return
    link = local_config_dir(tenant_id) / "skills"
    if link.is_symlink() or link.exists():
        return
    link.parent.mkdir(parents=True, exist_ok=True)
    link.symlink_to(source, target_is_directory=True)


def _stage_in_sync(tenant_id: str) -> None:
    from minio.error import S3Error  # noqa: F401  (typed errors surface below)

    client = _client()
    _ensure_bucket(client)
    root = tenant_local_root(tenant_id)
    remote = _list_remote(client, tenant_id)
    prefix = _remote_prefix(tenant_id)

    if not remote:
        # First-seen tenant: idempotently seed a credential-free settings.json
        # in the bucket, then fall through to mirror it down.
        import io

        seed = _SETTINGS_SEED.encode("utf-8")
        client.put_object(
            settings.minio_bucket,
            prefix + "openharness/settings.json",
            io.BytesIO(seed),
            length=len(seed),
            content_type="application/json",
        )
        remote = _list_remote(client, tenant_id)

    # Download/overwrite everything under the prefix (small text corpus).
    for rel, _obj in remote.items():
        dest = safe_tenant_path(tenant_id, root / rel)
        dest.parent.mkdir(parents=True, exist_ok=True)
        client.fget_object(settings.minio_bucket, prefix + rel, str(dest))

    # Delete propagation: local files no longer present in the bucket go away.
    for rel, path in _list_local(tenant_id).items():
        if rel not in remote:
            safe_tenant_path(tenant_id, path).unlink(missing_ok=True)
    # Drop now-empty directories (bottom-up, never following symlinks).
    if root.is_dir():
        for dirpath, _dirnames, _filenames in os.walk(root, topdown=False, followlinks=False):
            d = Path(dirpath)
            if d != root and not d.is_symlink():
                try:
                    d.rmdir()
                except OSError:
                    pass

    # The backend expects its config/data/rules dirs to exist.
    local_data_dir(tenant_id).mkdir(parents=True, exist_ok=True)
    local_rules_dir(tenant_id).mkdir(parents=True, exist_ok=True)
    _link_shared_skills(tenant_id)


def _stage_out_sync(tenant_id: str) -> None:
    client = _client()
    _ensure_bucket(client)
    prefix = _remote_prefix(tenant_id)
    local = _list_local(tenant_id)

    for rel, path in local.items():
        client.fput_object(settings.minio_bucket, prefix + rel, str(path))

    # Delete propagation: bucket objects with no local counterpart go away.
    for rel in _list_remote(client, tenant_id):
        if rel not in local:
            client.remove_object(settings.minio_bucket, prefix + rel)


def _purge_session_sync(tenant_id: str, oh_session_id: str) -> None:
    """Remove per-session object prefixes after final stage-out (destroy)."""
    client = _client()
    prefix = _remote_prefix(tenant_id)
    for sub in ("openharness/data/memory/", "openharness/data/sessions/"):
        victim_prefix = prefix + sub + oh_session_id
        for obj in client.list_objects(
            settings.minio_bucket, prefix=victim_prefix, recursive=True
        ):
            client.remove_object(settings.minio_bucket, obj.object_name)


def _has_local_snapshot(tenant_id: str, oh_session_id: str) -> bool:
    """Cheap fs check: any ``sessions/{oh_session_id}*`` entry in staging."""
    base = local_data_dir(tenant_id) / "sessions"
    if not base.is_dir():
        return False
    return any(base.glob(oh_session_id + "*"))


def _has_remote_snapshot_sync(tenant_id: str, oh_session_id: str) -> bool:
    """Bucket prefix probe for the session's snapshot objects."""
    client = _client()
    prefix = _remote_prefix(tenant_id) + "openharness/data/sessions/" + oh_session_id
    for _obj in client.list_objects(
        settings.minio_bucket, prefix=prefix, recursive=True
    ):
        return True
    return False


# --- public async API ------------------------------------------------------------


async def has_session_snapshot(tenant_id: str, oh_session_id: str) -> bool:
    """Whether a recoverable native snapshot exists for this session.

    Feeds the ``resumable`` business field (spec session-tenant-isolation):
    the node-local staging directory is consulted first (fs stat, cheap); the
    tenant-bucket prefix is queried only when the local copy is absent, and
    skipped entirely when the store is disabled. Probe errors degrade to
    ``False`` (never advertise a resume that cannot be satisfied).
    """
    validate_tenant_id(tenant_id)
    if not oh_session_id:
        return False
    if _has_local_snapshot(tenant_id, oh_session_id):
        return True
    if not enabled():
        return False
    try:
        return await asyncio.to_thread(
            _has_remote_snapshot_sync, tenant_id, oh_session_id
        )
    except Exception as exc:  # noqa: BLE001 — probe is advisory, not fatal
        logger.warning(
            "tenant_snapshot_check_failed", tenant_id=tenant_id, error=str(exc)
        )
        return False


async def copy_rules_into_workspace(tenant_id: str, workspace: Path) -> None:
    """Copy the staged ``rules/`` tree into ``{workspace}/.claude/rules`` (D2.3).

    Copy target verified against OpenHarness rules discovery:
    ``prompts/claudemd.py::discover_claude_md_files`` walks from cwd upward
    collecting ``.claude/rules/*.md`` — so per-session rules land in
    ``{cwd}/.claude/rules/``. Snapshot semantics: copied once at create.
    """
    src = local_rules_dir(tenant_id)
    if not src.is_dir() or not any(src.iterdir()):
        return
    dest = workspace / ".claude" / "rules"
    await asyncio.to_thread(
        shutil.copytree, src, dest, dirs_exist_ok=True
    )


async def stage_in(tenant_id: str) -> None:
    """Mirror the tenant's bucket prefix into local staging (create/resume).

    Raises :class:`TenantStoreError` when MinIO is unreachable (routers map it
    to 503 fail-fast — no session may start without authoritative data).
    Always leaves the staging skeleton (config/data/rules dirs) in place,
    even with the store disabled (local-only isolation still applies).
    """
    validate_tenant_id(tenant_id)
    async with tenant_lock(tenant_id):
        if not enabled():
            local_data_dir(tenant_id).mkdir(parents=True, exist_ok=True)
            local_rules_dir(tenant_id).mkdir(parents=True, exist_ok=True)
            _link_shared_skills(tenant_id)
            return
        try:
            await asyncio.to_thread(_stage_in_sync, tenant_id)
        except Exception as exc:
            TENANT_SYNC_FAILURES.labels(direction="in").inc()
            logger.error("tenant_stage_in_failed", tenant_id=tenant_id, error=str(exc))
            raise TenantStoreError(f"tenant stage-in failed: {exc}") from exc


async def stage_out(tenant_id: str) -> bool:
    """Mirror local staging back to the bucket (turn/evict/close/orphan hooks).

    Retries with exponential backoff; on final failure keeps the staging tree,
    bumps ``oh_tenant_sync_failures_total`` and returns ``False`` — lifecycle
    hooks log and continue (loss window SLO: at most one in-flight turn).
    """
    validate_tenant_id(tenant_id)
    async with tenant_lock(tenant_id):
        if not enabled():
            return True
        last_exc: Exception | None = None
        for attempt, delay in enumerate((0.0,) + _STAGE_OUT_BACKOFF):
            if delay:
                await asyncio.sleep(delay)
            try:
                await asyncio.to_thread(_stage_out_sync, tenant_id)
                return True
            except Exception as exc:  # noqa: BLE001 — retried, then reported
                last_exc = exc
                logger.warning(
                    "tenant_stage_out_retry",
                    tenant_id=tenant_id,
                    attempt=attempt,
                    error=str(exc),
                )
        TENANT_SYNC_FAILURES.labels(direction="out").inc()
        logger.error(
            "tenant_stage_out_failed", tenant_id=tenant_id, error=str(last_exc)
        )
        return False


async def destroy_session_data(tenant_id: str, oh_session_id: str) -> None:
    """Final cleanup for a destroyed session (after its final stage-out).

    Removes the session's memory/session-snapshot traces both locally and in
    the bucket (``data/memory/{ohsid}*``, ``data/sessions/{ohsid}*``). Local
    deletes are prefix-validated; ``rmtree`` runs in a worker thread (SS-17).
    """
    validate_tenant_id(tenant_id)
    if not oh_session_id:
        return
    async with tenant_lock(tenant_id):
        data_root = local_data_dir(tenant_id)
        for sub in ("memory", "sessions"):
            base = data_root / sub
            if not base.is_dir():
                continue
            for victim in base.glob(oh_session_id + "*"):
                victim = safe_tenant_path(tenant_id, victim)
                if victim.is_dir():
                    await asyncio.to_thread(shutil.rmtree, victim, True)
                else:
                    victim.unlink(missing_ok=True)
        if enabled():
            try:
                await asyncio.to_thread(_purge_session_sync, tenant_id, oh_session_id)
            except Exception as exc:  # noqa: BLE001 — cleanup is best-effort
                TENANT_SYNC_FAILURES.labels(direction="out").inc()
                logger.error(
                    "tenant_purge_failed",
                    tenant_id=tenant_id,
                    oh_session_id=oh_session_id,
                    error=str(exc),
                )
