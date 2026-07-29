#!/usr/bin/env python3
"""Tenant offboarding: purge a tenant's video data (video-tenant-storage R7).

Deletes, for one tenant:
- all MinIO objects under ``tenants/{tid}/videos/`` (this service's sub-prefix
  ONLY — session-side data under the same tenant root is never touched), and
- all ``video_tasks`` rows with that ``tenant_id``.

Local-backend artifacts referenced by the tenant's rows (legacy
``storage_kind='local'``) are removed from ``{video_dir}`` as well, so a mixed
local/S3 history is fully cleaned.

Usage (inside the api container, cwd=/opt/oh-service):

    python scripts/purge_tenant.py <tenant-id> --dry-run   # preview only
    python scripts/purge_tenant.py <tenant-id> --yes       # actually delete
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Make the service package importable as ``app`` when invoked as
# ``python scripts/purge_tenant.py``.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import create_engine, delete, select  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.config import settings  # noqa: E402
from app.models import VideoTask  # noqa: E402
from app.storage.keys import validate_tenant_id  # noqa: E402


def _engine():
    return create_engine(settings.db_sync_url)


def _list_s3_keys(tenant_id: str) -> list[str]:
    """List object keys under this service's videos/ sub-prefix only (R7)."""
    from app.storage.s3 import _make_client

    client = _make_client(settings.s3_endpoint)
    prefix = f"tenants/{tenant_id}/videos/"
    keys: list[str] = []
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=settings.s3_bucket, Prefix=prefix):
        keys.extend(obj["Key"] for obj in page.get("Contents", []))
    return keys


def _delete_s3_keys(keys: list[str]) -> None:
    from app.storage.s3 import _make_client

    client = _make_client(settings.s3_endpoint)
    # delete_objects caps at 1000 keys per call.
    for i in range(0, len(keys), 1000):
        batch = keys[i : i + 1000]
        client.delete_objects(
            Bucket=settings.s3_bucket,
            Delete={"Objects": [{"Key": k} for k in batch], "Quiet": True},
        )


def purge(tenant_id: str, *, dry_run: bool) -> int:
    validate_tenant_id(tenant_id)
    if tenant_id == "default":
        print(
            "refusing to purge the 'default' tenant (shared open-mode data)",
            file=sys.stderr,
        )
        return 2

    # --- Collect ---
    with Session(_engine()) as db:
        rows = db.execute(
            select(VideoTask.id, VideoTask.storage_kind, VideoTask.output_path).where(
                VideoTask.tenant_id == tenant_id
            )
        ).all()
    local_keys = [
        out for (_id, kind, out) in rows if out and kind != "s3"
    ]

    s3_keys: list[str] = []
    if settings.s3_bucket:
        try:
            s3_keys = _list_s3_keys(tenant_id)
        except Exception as exc:
            print(f"WARNING: cannot list S3 objects ({exc}); rerun when MinIO is up", file=sys.stderr)
            if not dry_run:
                return 1

    print(f"tenant:        {tenant_id}")
    print(f"video_tasks:   {len(rows)} row(s)")
    print(f"s3 objects:    {len(s3_keys)} under tenants/{tenant_id}/videos/")
    print(f"local files:   {len(local_keys)} under {settings.video_dir}")
    if dry_run:
        print("dry-run: nothing deleted")
        return 0

    # --- Delete (objects first, rows last, so a crash leaves rediscoverable rows) ---
    if s3_keys:
        _delete_s3_keys(s3_keys)
        print(f"deleted {len(s3_keys)} S3 object(s)")
    for key in local_keys:
        p = Path(settings.video_dir) / key
        if p.exists():
            p.unlink()
    if local_keys:
        print(f"deleted {len(local_keys)} local file(s)")

    with Session(_engine()) as db:
        result = db.execute(delete(VideoTask).where(VideoTask.tenant_id == tenant_id))
        db.commit()
        print(f"deleted {result.rowcount} video_tasks row(s)")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("tenant_id", help="tenant to purge (whitelist-validated)")
    parser.add_argument("--dry-run", action="store_true", help="preview without deleting")
    parser.add_argument("--yes", action="store_true", help="confirm actual deletion")
    args = parser.parse_args(argv)

    if not args.dry_run and not args.yes:
        print("pass --dry-run to preview or --yes to confirm deletion", file=sys.stderr)
        return 2
    try:
        return purge(args.tenant_id, dry_run=args.dry_run)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
