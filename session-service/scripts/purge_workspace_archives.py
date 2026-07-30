"""Purge expired session workspace archives from MinIO (task 4.1, rev2).

Usage:
    python scripts/purge_workspace_archives.py --older-than-days N [--tenant TID] [--dry-run]

For every ``tenants/{tid}/workspaces/{sid}/`` prefix in the tenant bucket:

- manifest ``last_synced_at`` older than the cutoff -> the whole workspace
  archive (``files/``, ``manifest.json``, marker) is deleted;
- otherwise the workspace is kept, but stale ``sync.inprogress.json`` markers
  and ``files/`` objects not referenced by the manifest (orphans left by an
  interrupted sync round) are garbage-collected — only when they are older
  than ``--gc-grace-hours`` so an in-flight sync round is never raced;
- a manifest-less prefix (crash before the first manifest ever landed) is
  treated as fully orphaned and deleted once every object passed the cutoff.

Never wired into a scheduler; operators run it manually (design D8).
Exit codes: 0 ok, 1 usage error, 2 archiving disabled (no OH_MINIO_ENDPOINT).
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import settings  # noqa: E402


def _parse_iso(value: object) -> datetime | None:
    try:
        dt = datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--older-than-days", type=int, required=True, metavar="N",
                        help="purge archives whose manifest last_synced_at is older than N days")
    parser.add_argument("--tenant", default=None, help="restrict to a single tenant id")
    parser.add_argument("--gc-grace-hours", type=int, default=24,
                        help="min object age before markers/orphans are GC'd (default 24)")
    parser.add_argument("--dry-run", action="store_true", help="print actions without deleting")
    args = parser.parse_args()
    if args.older_than_days < 0 or args.gc_grace_hours < 0:
        parser.error("--older-than-days and --gc-grace-hours must be >= 0")

    from app.session import workspace_store
    from app.session.tenant_store import _client, validate_tenant_id
    from app.session.workspace_store import MANIFEST_NAME, MARKER_NAME

    if not workspace_store.enabled():
        print("workspace archiving disabled (no OH_MINIO_ENDPOINT)", file=sys.stderr)
        return 2

    import json

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=args.older_than_days)
    gc_cutoff = now - timedelta(hours=args.gc_grace_hours)
    bucket = settings.minio_bucket
    client = _client()

    scan_prefix = "tenants/"
    if args.tenant:
        scan_prefix = f"tenants/{validate_tenant_id(args.tenant)}/workspaces/"

    # Group object keys (with their last_modified) by workspace prefix.
    workspaces: dict[str, list] = {}
    for obj in client.list_objects(bucket, prefix=scan_prefix, recursive=True):
        parts = obj.object_name.split("/")
        # tenants/{tid}/workspaces/{sid}/...
        if len(parts) < 5 or parts[0] != "tenants" or parts[2] != "workspaces":
            continue
        ws_prefix = "/".join(parts[:4]) + "/"
        workspaces.setdefault(ws_prefix, []).append(obj)

    removed = kept = gc_count = 0

    def _remove(key: str, why: str) -> None:
        nonlocal removed
        removed += 1
        print(f"{'DRY-RUN ' if args.dry_run else ''}delete {key}  [{why}]")
        if not args.dry_run:
            client.remove_object(bucket, key)

    for ws_prefix, objects in sorted(workspaces.items()):
        manifest = None
        manifest_key = ws_prefix + MANIFEST_NAME
        if any(o.object_name == manifest_key for o in objects):
            resp = client.get_object(bucket, manifest_key)
            try:
                manifest = json.loads(resp.read().decode("utf-8"))
            finally:
                resp.close()
                resp.release_conn()

        if manifest is not None:
            synced_at = _parse_iso(manifest.get("last_synced_at"))
            if synced_at is not None and synced_at < cutoff:
                for obj in objects:
                    _remove(obj.object_name, f"expired (last_synced_at={synced_at.isoformat()})")
                continue
            # Fresh workspace: GC stale marker + unreferenced files/ orphans
            # left by an interrupted round; grace period avoids racing a sync.
            files_prefix = ws_prefix + "files/"
            referenced = {files_prefix + str(e.get("path", "")) for e in manifest.get("files", [])}
            for obj in objects:
                if obj.last_modified and obj.last_modified >= gc_cutoff:
                    continue
                if obj.object_name == ws_prefix + MARKER_NAME:
                    _remove(obj.object_name, "stale sync marker")
                    gc_count += 1
                elif obj.object_name.startswith(files_prefix) and obj.object_name not in referenced:
                    _remove(obj.object_name, "orphan not referenced by manifest")
                    gc_count += 1
            kept += 1
            continue

        # No manifest at all: fully orphaned prefix — delete once every
        # object is older than the cutoff (age proxy = last_modified).
        if all(o.last_modified and o.last_modified < cutoff for o in objects):
            for obj in objects:
                _remove(obj.object_name, "manifest-less orphan workspace")
        else:
            kept += 1

    print(
        f"{'DRY-RUN: ' if args.dry_run else ''}scanned {len(workspaces)} workspace(s); "
        f"kept {kept}, removed {removed} object(s) ({gc_count} via marker/orphan GC)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
