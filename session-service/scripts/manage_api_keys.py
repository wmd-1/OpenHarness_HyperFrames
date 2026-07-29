#!/usr/bin/env python3
"""API-key management CLI for multi-key tenant authentication (WS-A).

Connects directly to the shared Postgres (``OH_DB_SYNC_URL``) — there is no
management HTTP API by design. The raw key is printed ONCE at creation and
never stored (only its ``sha256`` hex digest lands in ``api_keys.key_hash``).

Usage (inside the session container, cwd=/opt/oh-session-service):

    python scripts/manage_api_keys.py create --tenant acme [--label "ci bot"]
    python scripts/manage_api_keys.py list [--tenant acme]
    python scripts/manage_api_keys.py revoke <key-id>

Revocation takes effect within the gateway's resolver cache TTL
(``OH_APIKEY_CACHE_TTL``, default 60s).
"""

from __future__ import annotations

import argparse
import hashlib
import secrets
import sys
import uuid
from pathlib import Path

# Make the session-service package importable as ``app`` when invoked as
# ``python scripts/manage_api_keys.py``.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import create_engine, select  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.config import settings  # noqa: E402
from app.models import ApiKey  # noqa: E402


def _engine():
    return create_engine(settings.db_sync_url)


def cmd_create(args: argparse.Namespace) -> int:
    raw = f"sk-oh-{secrets.token_urlsafe(32)}"
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    row = ApiKey(
        id=uuid.uuid4(),
        key_hash=digest,
        tenant_id=args.tenant,
        label=args.label,
        active=True,
    )
    with Session(_engine()) as session:
        session.add(row)
        session.commit()
        key_id = str(row.id)
    print(f"key_id:    {key_id}")
    print(f"tenant_id: {args.tenant}")
    if args.label:
        print(f"label:     {args.label}")
    print(f"api_key:   {raw}")
    print("Store this key now — it cannot be recovered (only its hash is kept).")
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    stmt = select(ApiKey).order_by(ApiKey.created_at.asc())
    if args.tenant:
        stmt = stmt.where(ApiKey.tenant_id == args.tenant)
    with Session(_engine()) as session:
        rows = session.execute(stmt).scalars().all()
    if not rows:
        print("no api keys")
        return 0
    for row in rows:
        state = "active" if row.active else "revoked"
        label = row.label or "-"
        print(f"{row.id}  {row.tenant_id:<24} {state:<8} {label}  {row.created_at:%Y-%m-%d %H:%M}")
    return 0


def cmd_revoke(args: argparse.Namespace) -> int:
    try:
        key_id = uuid.UUID(args.key_id)
    except ValueError:
        print(f"invalid key id: {args.key_id}", file=sys.stderr)
        return 2
    with Session(_engine()) as session:
        row = session.get(ApiKey, key_id)
        if row is None:
            print(f"key not found: {key_id}", file=sys.stderr)
            return 1
        row.active = False
        session.commit()
    print(f"revoked {key_id} (effective within OH_APIKEY_CACHE_TTL={settings.apikey_cache_ttl:.0f}s)")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    p_create = sub.add_parser("create", help="create a key for a tenant (prints the raw key once)")
    p_create.add_argument("--tenant", required=True, help="tenant id (= user id) the key resolves to")
    p_create.add_argument("--label", default=None, help="optional human-readable label")
    p_create.set_defaults(func=cmd_create)

    p_list = sub.add_parser("list", help="list keys (hashes are never shown)")
    p_list.add_argument("--tenant", default=None, help="filter by tenant id")
    p_list.set_defaults(func=cmd_list)

    p_revoke = sub.add_parser("revoke", help="deactivate a key by its id")
    p_revoke.add_argument("key_id", help="the key_id printed at creation / shown by list")
    p_revoke.set_defaults(func=cmd_revoke)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
