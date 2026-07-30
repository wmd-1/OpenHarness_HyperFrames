"""Session workspace archiving between local ``/workspaces/{sid}`` and MinIO.

Design (openspec add-session-workspace-archive, plan rev3):

- Objects live under ``tenants/{tid}/workspaces/{sid}/`` in the tenant bucket:
  ``manifest.json`` (the index "table": tenant id, session id, per-file object
  addresses) plus the file bodies under ``files/{relpath}`` — separated so the
  manifest can be listed without touching file bodies.
- The manifest is ALWAYS a ``complete`` snapshot. A sync round PUTs a
  ``sync.inprogress.json`` marker first, uploads file bodies, rewrites the
  manifest (``sync_seq`` +1, monotonic), removes now-unreferenced objects and
  finally deletes the marker — an interrupted round leaves the previous
  complete manifest fully readable and its debris identifiable for GC.
- Deletion propagation uses ``deleted[]`` tombstones with version-first
  resolution (rev3): every node records the last manifest ``sync_seq`` it
  observed in a local sidecar ``.oh_sync_state.json`` (hard-excluded from the
  archive, never uploaded). A locally-present tombstoned path is a genuine
  recreation only when ``base_sync_seq >= deleted_seq``; with no sidecar the
  mtime-vs-``deleted_at`` comparison is a logged fallback only — an anomalous
  future mtime can never resurrect a deleted file on its own.
- stage-in runs tombstone resolution FIRST (before the per-file LWW compare)
  using the PRE-stage-in sidecar baseline, deleting stale residuals locally;
  only then is the sidecar advanced to the manifest's ``sync_seq``.
- Every operation is serialized by a per-session ``asyncio.Lock`` (deliberately
  NOT the tenant lock: workspace rounds must not block sibling sessions) and
  is best-effort: failures bump ``oh_workspace_sync_failures_total`` and log,
  never break the session lifecycle. With ``OH_MINIO_ENDPOINT`` unset the
  store is a no-op.
"""

from __future__ import annotations

import asyncio
import io
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import structlog

from app.config import settings
from app.observability.metrics import WORKSPACE_SYNC_FAILURES
from app.session import tenant_store
from app.session.tenant_store import validate_tenant_id

logger = structlog.get_logger(__name__)

# Retry schedule (seconds) for stage-out rounds (mirrors tenant_store).
_STAGE_OUT_BACKOFF = (0.5, 1.0, 2.0)

SCHEMA_VERSION = 1
MANIFEST_NAME = "manifest.json"
MARKER_NAME = "sync.inprogress.json"
# Local-only sidecar holding the node's observed manifest baseline. Hard
# exclusion: never uploaded, never listed by the files API, independent of
# the configurable ignore list (rev3).
SIDECAR_NAME = ".oh_sync_state.json"

# mtime equality tolerance (os.utime round-trips float seconds exactly on
# ext4/xfs; the epsilon absorbs filesystems with coarser timestamps).
_MTIME_EPS = 1e-3

_workspace_locks: dict[str, asyncio.Lock] = {}


def workspace_lock(sid: Any) -> asyncio.Lock:
    """Per-session lock serializing stage-in/stage-out for that workspace."""
    key = str(sid)
    lock = _workspace_locks.get(key)
    if lock is None:
        lock = _workspace_locks.setdefault(key, asyncio.Lock())
    return lock


def discard_lock(sid: Any) -> None:
    """Drop the per-session lock entry after close (bounds the dict)."""
    _workspace_locks.pop(str(sid), None)


def enabled() -> bool:
    """Workspace archiving is active only when MinIO is configured."""
    return bool(settings.minio_endpoint)


def workspace_remote_prefix(tenant_id: str, sid: Any) -> str:
    """Single point of object-key derivation (tenant validated, sid sane)."""
    sid_s = str(sid)
    if not sid_s or "/" in sid_s or "\\" in sid_s or ".." in sid_s:
        raise ValueError(f"invalid session id: {sid_s!r}")
    return f"tenants/{validate_tenant_id(tenant_id)}/workspaces/{sid_s}/"


def files_remote_prefix(tenant_id: str, sid: Any) -> str:
    return workspace_remote_prefix(tenant_id, sid) + "files/"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_iso_ts(value: Any) -> float | None:
    """ISO-8601 string -> epoch seconds (None when absent/unparseable)."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value)).timestamp()
    except ValueError:
        return None


def _node_id() -> str:
    return settings.node_id or "local"


# --- local fs helpers ------------------------------------------------------------


def _safe_local_path(cwd: Path, rel: str) -> Path | None:
    """Resolve ``rel`` and require it under ``cwd`` (escape guard)."""
    if not rel or rel.startswith(("/", "\\")) or ".." in Path(rel).parts:
        logger.warning("workspace_path_rejected", path=rel)
        return None
    root = cwd.resolve()
    resolved = (cwd / rel).resolve()
    if resolved != root and root not in resolved.parents:
        logger.warning("workspace_path_rejected", path=rel)
        return None
    return cwd / rel


def _ignore_fragments() -> set[str]:
    return {f.strip() for f in settings.workspace_sync_ignore.split(",") if f.strip()}


def _scan_local(cwd: Path) -> dict[str, os.stat_result]:
    """Map rel path -> stat for every syncable file in the workspace.

    Symlinks are never followed or listed; ignored fragments prune whole
    subtrees; the sidecar is hard-excluded regardless of the ignore config.
    """
    out: dict[str, os.stat_result] = {}
    if not cwd.is_dir():
        return out
    ignores = _ignore_fragments()
    for dirpath, dirnames, filenames in os.walk(cwd, followlinks=False):
        dirnames[:] = [
            d for d in dirnames
            if d not in ignores and not (Path(dirpath) / d).is_symlink()
        ]
        for name in filenames:
            p = Path(dirpath) / name
            if p.is_symlink():
                continue
            rel = str(p.relative_to(cwd))
            if rel == SIDECAR_NAME:
                continue  # hard exclusion (rev3)
            parts = Path(rel).parts
            if any(part in ignores for part in parts) or ".." in parts:
                continue
            try:
                out[rel] = p.stat()
            except OSError:
                continue  # vanished mid-scan
    return out


def _read_sidecar(cwd: Path) -> int | None:
    """The node's observed manifest baseline (``base_sync_seq``), if any."""
    try:
        data = json.loads((cwd / SIDECAR_NAME).read_text("utf-8"))
        seq = data.get("base_sync_seq")
        return int(seq) if seq is not None else None
    except (OSError, ValueError, TypeError):
        return None


def _write_sidecar(cwd: Path, base_sync_seq: int) -> None:
    try:
        payload = {"base_sync_seq": base_sync_seq, "updated_at": _now_iso()}
        (cwd / SIDECAR_NAME).write_text(json.dumps(payload), "utf-8")
    except OSError as exc:
        logger.warning("workspace_sidecar_write_failed", cwd=str(cwd), error=str(exc))


# --- MinIO plumbing ---------------------------------------------------------------


def _get_manifest_sync(client, prefix: str) -> dict[str, Any] | None:
    """Fetch the manifest; only a ``complete`` snapshot is trusted (rev2)."""
    from minio.error import S3Error

    try:
        resp = client.get_object(settings.minio_bucket, prefix + MANIFEST_NAME)
        try:
            data = json.loads(resp.read().decode("utf-8"))
        finally:
            resp.close()
            resp.release_conn()
    except S3Error as exc:
        if exc.code in ("NoSuchKey", "NoSuchObject"):
            return None
        raise
    if not isinstance(data, dict) or data.get("sync_state") != "complete":
        return None
    return data


def _put_json(client, key: str, payload: dict[str, Any]) -> None:
    body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    client.put_object(
        settings.minio_bucket,
        key,
        io.BytesIO(body),
        length=len(body),
        content_type="application/json",
    )


def _entry_matches(entry: dict[str, Any], st: os.stat_result) -> bool:
    try:
        return (
            int(entry.get("size", -1)) == st.st_size
            and abs(float(entry.get("mtime", 0.0)) - st.st_mtime) < _MTIME_EPS
        )
    except (TypeError, ValueError):
        return False


# --- stage-out (sync core) --------------------------------------------------------


def _resolve_tombstones(
    base_deleted: dict[str, dict],
    present: dict[str, os.stat_result],
    node_base: int | None,
) -> set[str]:
    """Version-first tombstone resolution (rev3): which locally-present
    tombstoned paths are genuine recreations (eligible for re-upload)."""
    resurrect: set[str] = set()
    for rel, tomb in base_deleted.items():
        if rel not in present:
            continue
        deleted_seq = int(tomb.get("deleted_seq") or 0)
        if node_base is not None:
            if node_base >= deleted_seq:
                resurrect.add(rel)  # node saw the deletion -> real recreation
            else:
                logger.warning(
                    "workspace_stale_residual_skipped",
                    path=rel,
                    base_sync_seq=node_base,
                    deleted_seq=deleted_seq,
                )
        else:
            # No baseline info at all: clock-based fallback, always logged.
            deleted_at = _parse_iso_ts(tomb.get("deleted_at"))
            if deleted_at is None or present[rel].st_mtime > deleted_at:
                resurrect.add(rel)
            logger.warning(
                "workspace_tombstone_mtime_fallback",
                path=rel,
                resurrected=rel in resurrect,
            )
    return resurrect


def _stage_out_sync(
    tenant_id: str,
    sid: str,
    cwd: Path,
    oh_session_id: str,
    session_status: str,
) -> None:
    client = tenant_store._client()
    tenant_store._ensure_bucket(client)
    prefix = workspace_remote_prefix(tenant_id, sid)
    files_prefix = prefix + "files/"
    bucket = settings.minio_bucket

    # Rebase on the latest remote complete manifest (rev2): another node may
    # have advanced sync_seq since this node last looked.
    base = _get_manifest_sync(client, prefix)
    base_seq = int(base.get("sync_seq") or 0) if base else 0
    base_files: dict[str, dict] = (
        {e["path"]: e for e in base.get("files") or [] if e.get("path")} if base else {}
    )
    base_deleted: dict[str, dict] = (
        {e["path"]: e for e in base.get("deleted") or [] if e.get("path")} if base else {}
    )
    node_base = _read_sidecar(cwd)
    new_seq = base_seq + 1
    now = _now_iso()

    # In-progress marker BEFORE any object mutation: an interrupted round is
    # identifiable garbage while the previous complete manifest stays intact.
    _put_json(
        client,
        prefix + MARKER_NAME,
        {"node_id": _node_id(), "sync_seq": new_seq, "started_at": now},
    )

    present = _scan_local(cwd)
    resurrect = _resolve_tombstones(base_deleted, present, node_base)

    # Quota filtering: per-file cap, then total cap newest-mtime-first.
    skipped: list[dict[str, str]] = []
    max_file = settings.workspace_sync_max_file_mb * 1024 * 1024
    max_total = settings.workspace_sync_max_total_mb * 1024 * 1024
    candidates: list[tuple[str, os.stat_result]] = []
    for rel, st in present.items():
        if st.st_size > max_file:
            skipped.append({"path": rel, "reason": "file_too_large"})
        else:
            candidates.append((rel, st))
    candidates.sort(key=lambda t: t[1].st_mtime, reverse=True)
    total = 0
    eligible: dict[str, os.stat_result] = {}
    for rel, st in candidates:
        if total + st.st_size > max_total:
            skipped.append({"path": rel, "reason": "total_quota_exceeded"})
            continue
        total += st.st_size
        eligible[rel] = st

    # Upload phase (file bodies first — the manifest is rewritten only after
    # every body is durable, keeping the complete-snapshot invariant).
    new_files: list[dict[str, Any]] = []
    for rel, st in eligible.items():
        if rel in base_deleted and rel not in resurrect:
            continue  # stale residual: never re-uploaded (rev3)
        entry = base_files.get(rel)
        if entry is not None and _entry_matches(entry, st):
            confirmed = dict(entry)
            confirmed["last_seen_sync_seq"] = new_seq  # confirmed present
            new_files.append(confirmed)
            continue
        local = _safe_local_path(cwd, rel)
        if local is None:
            continue
        result = client.fput_object(bucket, files_prefix + rel, str(local))
        new_files.append(
            {
                "path": rel,
                "size": st.st_size,
                "mtime": round(st.st_mtime, 6),
                "etag": getattr(result, "etag", None),
                "last_seen_sync_seq": new_seq,
            }
        )

    # Size/quota-skipped files that were archived before keep their last
    # synced version in the manifest (the archive never silently loses them).
    kept_paths = {e["path"] for e in new_files}
    for item in skipped:
        entry = base_files.get(item["path"])
        if entry is not None and item["path"] not in kept_paths:
            new_files.append(dict(entry))
            kept_paths.add(item["path"])

    # Delete propagation: baseline files gone locally become tombstones.
    new_deleted: list[dict[str, Any]] = []
    for rel in base_files:
        if rel not in present and rel not in kept_paths:
            new_deleted.append({"path": rel, "deleted_seq": new_seq, "deleted_at": now})

    # Carry forward existing tombstones minus genuine recreations (which are
    # actually back in files[]) and minus those past the retention window.
    cutoff = datetime.now(timezone.utc) - timedelta(
        days=settings.workspace_tombstone_retention_days
    )
    for rel, tomb in base_deleted.items():
        if rel in resurrect and rel in kept_paths:
            continue  # recreated and re-uploaded -> tombstone removed
        deleted_at = _parse_iso_ts(tomb.get("deleted_at"))
        if deleted_at is not None and deleted_at < cutoff.timestamp():
            continue  # pruned by retention
        new_deleted.append(tomb)

    new_files.sort(key=lambda e: e["path"])
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "tenant_id": tenant_id,
        "session_id": sid,
        "oh_session_id": oh_session_id,
        "bucket": bucket,
        "files_prefix": files_prefix,
        "sync_seq": new_seq,
        "last_synced_at": now,
        "node_id": _node_id(),
        "sync_state": "complete",
        "session_status": session_status,
        "total_files": len(new_files),
        "total_bytes": sum(int(e.get("size") or 0) for e in new_files),
        "files": new_files,
        "skipped": skipped,
        "deleted": new_deleted,
    }
    _put_json(client, prefix + MANIFEST_NAME, manifest)

    # Only after the new complete manifest is durable: remove unreferenced
    # bodies (delete propagation + interrupted-round debris GC), then the
    # marker. A crash here leaves harmless orphans, never a broken manifest.
    referenced = {files_prefix + e["path"] for e in new_files}
    for obj in client.list_objects(bucket, prefix=files_prefix, recursive=True):
        if obj.object_name not in referenced:
            client.remove_object(bucket, obj.object_name)
    client.remove_object(bucket, prefix + MARKER_NAME)

    # Advance the node's observed baseline (rev3).
    _write_sidecar(cwd, new_seq)


# --- stage-in (sync core) ---------------------------------------------------------


def _stage_in_sync(tenant_id: str, sid: str, cwd: Path) -> None:
    client = tenant_store._client()
    prefix = workspace_remote_prefix(tenant_id, sid)
    manifest = _get_manifest_sync(client, prefix)
    if manifest is None:
        return  # nothing archived yet -> no-op
    files_prefix = str(manifest.get("files_prefix") or (prefix + "files/"))
    bucket = settings.minio_bucket

    # Rev3 ordering invariant: tombstone resolution FIRST, with the
    # PRE-stage-in baseline — tombstoned paths never enter the LWW compare,
    # and stale residuals are deleted locally BEFORE the sidecar is advanced
    # (otherwise the advanced baseline would recast them as recreations).
    old_base = _read_sidecar(cwd)
    tombstones = [t for t in manifest.get("deleted") or [] if t.get("path")]
    for tomb in tombstones:
        rel = str(tomb["path"])
        local = _safe_local_path(cwd, rel)
        if local is None or local.is_symlink() or not local.is_file():
            continue
        deleted_seq = int(tomb.get("deleted_seq") or 0)
        if old_base is not None:
            if old_base >= deleted_seq:
                continue  # genuine recreation: keep, next stage-out re-uploads
            local.unlink(missing_ok=True)
            logger.warning(
                "workspace_stale_residual_removed",
                path=rel,
                base_sync_seq=old_base,
                deleted_seq=deleted_seq,
            )
        else:
            deleted_at = _parse_iso_ts(tomb.get("deleted_at"))
            kept = deleted_at is None or local.stat().st_mtime > deleted_at
            if not kept:
                local.unlink(missing_ok=True)
            logger.warning(
                "workspace_tombstone_mtime_fallback", path=rel, kept=kept
            )
    tombstoned = {str(t["path"]) for t in tombstones}

    # Per-file state comparison + mtime LWW (rev2).
    for entry in manifest.get("files") or []:
        rel = str(entry.get("path") or "")
        if not rel or rel in tombstoned:
            continue
        local = _safe_local_path(cwd, rel)
        if local is None:
            continue
        m_mtime = float(entry.get("mtime") or 0.0)
        if local.is_file() and not local.is_symlink():
            st = local.stat()
            if _entry_matches(entry, st):
                continue  # in sync -> zero download
            if st.st_mtime > m_mtime + _MTIME_EPS:
                logger.warning(
                    "workspace_stage_in_conflict", path=rel, resolution="local_kept"
                )
                continue  # local is an un-archived newer edit
            logger.warning(
                "workspace_stage_in_conflict", path=rel, resolution="archive_wins"
            )
        local.parent.mkdir(parents=True, exist_ok=True)
        client.fget_object(bucket, files_prefix + rel, str(local))
        if m_mtime:
            os.utime(local, (m_mtime, m_mtime))

    # Success: only now advance the node's observed baseline (rev3).
    _write_sidecar(cwd, int(manifest.get("sync_seq") or 0))


# --- public async API ---------------------------------------------------------------


async def stage_out(
    tenant_id: str,
    sid: Any,
    cwd: Path,
    *,
    oh_session_id: str = "",
    session_status: str = "",
) -> bool:
    """Archive one sync round (turn/evict/close/orphan hooks). Best-effort:
    retries with backoff, then bumps the metric and returns ``False`` —
    NEVER raises into the session lifecycle."""
    if not enabled():
        return True
    async with workspace_lock(sid):
        last_exc: Exception | None = None
        for attempt, delay in enumerate((0.0,) + _STAGE_OUT_BACKOFF):
            if delay:
                await asyncio.sleep(delay)
            try:
                await asyncio.to_thread(
                    _stage_out_sync, tenant_id, str(sid), cwd, oh_session_id, session_status
                )
                return True
            except Exception as exc:  # noqa: BLE001 — retried, then reported
                last_exc = exc
                logger.warning(
                    "workspace_stage_out_retry",
                    sid=str(sid),
                    attempt=attempt,
                    error=str(exc),
                )
        WORKSPACE_SYNC_FAILURES.labels(direction="out").inc()
        logger.error(
            "workspace_stage_out_failed", sid=str(sid), error=str(last_exc)
        )
        return False


async def stage_in(tenant_id: str, sid: Any, cwd: Path) -> bool:
    """Restore the workspace from its archive (before backend spawn).

    Best-effort (unlike the fail-fast tenant stage-in): the conversation
    context lives in the OpenHarness snapshot, so a resume without files
    beats a 503."""
    if not enabled():
        return True
    async with workspace_lock(sid):
        try:
            await asyncio.to_thread(_stage_in_sync, tenant_id, str(sid), cwd)
            return True
        except Exception as exc:  # noqa: BLE001 — best-effort restore
            WORKSPACE_SYNC_FAILURES.labels(direction="in").inc()
            logger.warning(
                "workspace_stage_in_failed", sid=str(sid), error=str(exc)
            )
            return False


async def load_manifest(tenant_id: str, sid: Any) -> dict[str, Any] | None:
    """Read the complete manifest (files API archive source). None when the
    store is disabled, nothing is archived yet, or the read fails."""
    if not enabled():
        return None

    def _load() -> dict[str, Any] | None:
        client = tenant_store._client()
        return _get_manifest_sync(client, workspace_remote_prefix(tenant_id, sid))

    try:
        return await asyncio.to_thread(_load)
    except Exception as exc:  # noqa: BLE001 — read path is advisory
        logger.warning("workspace_manifest_read_failed", sid=str(sid), error=str(exc))
        return None


# --- file API plumbing (archive downloads) ------------------------------------------


def presigned_archive_url(tenant_id: str, sid: Any, rel: str) -> str | None:
    """Presigned GET for an archived file body (D7): only when a public
    endpoint is configured — a URL signed against the in-cluster endpoint
    would be unreachable from the browser. Pure signing, no network I/O."""
    if not enabled() or not settings.s3_public_endpoint:
        return None
    try:
        from minio import Minio

        public = settings.s3_public_endpoint.rstrip("/")
        secure = public.startswith("https://")
        host = public.split("://", 1)[-1]
        client = Minio(
            host,
            access_key=settings.minio_access_key.get_secret_value() if settings.minio_access_key else None,
            secret_key=settings.minio_secret_key.get_secret_value() if settings.minio_secret_key else None,
            secure=secure,
            # Fixed region: presigning must stay pure offline signing — without
            # it the SDK issues a get_bucket_location call against the public
            # endpoint, which is typically unreachable from inside the cluster.
            region="us-east-1",
        )
        return client.presigned_get_object(
            settings.minio_bucket,
            files_remote_prefix(tenant_id, sid) + rel,
            expires=timedelta(hours=1),
        )
    except Exception as exc:  # noqa: BLE001 — falls back to gateway streaming
        logger.warning("workspace_presign_failed", sid=str(sid), path=rel, error=str(exc))
        return None


def open_archive_object(tenant_id: str, sid: Any, rel: str):
    """Blocking open of an archived file body (gateway streaming fallback).

    Returns the minio response (caller must ``close()`` + ``release_conn()``
    after consuming ``stream()``); raises ``FileNotFoundError`` when absent.
    """
    from minio.error import S3Error

    client = tenant_store._client()
    key = files_remote_prefix(tenant_id, sid) + rel
    try:
        return client.get_object(settings.minio_bucket, key)
    except S3Error as exc:
        if exc.code in ("NoSuchKey", "NoSuchObject"):
            raise FileNotFoundError(key) from exc
        raise

