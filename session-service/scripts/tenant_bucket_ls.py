"""List tenant object names under a bucket prefix (e2e helper, task 4.5).

Usage: python scripts/tenant_bucket_ls.py <prefix>
Prints one object name per line (empty output = no objects). Uses the same
OH_MINIO_* settings as the gateway; exits 2 when tenant staging is disabled.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import settings  # noqa: E402


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: tenant_bucket_ls.py <prefix>", file=sys.stderr)
        return 1
    if not settings.minio_endpoint:
        print("tenant staging disabled (no OH_MINIO_ENDPOINT)", file=sys.stderr)
        return 2
    from minio import Minio

    client = Minio(
        settings.minio_endpoint,
        access_key=settings.minio_access_key.get_secret_value() if settings.minio_access_key else None,
        secret_key=settings.minio_secret_key.get_secret_value() if settings.minio_secret_key else None,
        secure=settings.minio_secure,
    )
    for obj in client.list_objects(settings.minio_bucket, prefix=sys.argv[1], recursive=True):
        print(obj.object_name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
