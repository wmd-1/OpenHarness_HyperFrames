"""Repair legacy empty `{}` tenant settings seeds (one-shot, default dry-run).

Change session-credential-gateway-hardening, D8: legacy tenants were seeded
with an empty `{}` settings.json, which makes `oh --backend-only` fall back to
a provider profile it has no credentials for and exit at startup. This script
walks every ``tenants/{tid}/openharness/settings.json`` object in the bucket
and classifies it:

- ``empty_seed``  — strictly ``{}`` after JSON parse: the ONLY auto-repaired
  class. Overwritten with :func:`tenant_store.settings_seed` (credential-free
  derivation of the node's global settings), both in the bucket AND in the
  local staging tree (prevents a later stage-out pushing the stale `{}` back).
- ``invalid``     — unparseable JSON, or parseable but missing every provider
  key field (``api_format`` / ``active_profile`` / ``provider``), or carrying
  a denylisted secret key (historical leak). Reported (secrets redacted),
  NEVER modified — human follow-up required.
- ``ok``          — non-empty with provider configuration: skipped, never
  auto-overwritten.

Run inside the existing image, BEFORE restarting the service (no concurrent
stage-out):

    docker compose exec session python \
        /opt/oh-session-service/scripts/repair_tenant_settings_seed.py [--apply]

Default is ``--dry-run``; only ``--apply`` writes.
"""

from __future__ import annotations

import argparse
import io
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import settings  # noqa: E402
from app.session import tenant_store  # noqa: E402

_SETTINGS_RE = re.compile(r"^tenants/([^/]+)/openharness/settings\.json$")


def _find_secret_keys(node: object, found: list[str], prefix: str = "") -> None:
    """Collect denylisted key paths (values are never captured)."""
    if isinstance(node, dict):
        for key, value in node.items():
            path = f"{prefix}.{key}" if prefix else str(key)
            if isinstance(key, str) and tenant_store._is_secret_key(key):
                found.append(path)
            _find_secret_keys(value, found, path)
    elif isinstance(node, list):
        for i, item in enumerate(node):
            _find_secret_keys(item, found, f"{prefix}[{i}]")


def _classify(raw: bytes) -> tuple[str, str]:
    """Return ``(category, reason)`` for one settings.json body."""
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001 — classification, not control flow
        return "invalid", f"unparseable JSON: {exc}"
    if parsed == {}:
        return "empty_seed", "legacy empty seed"
    if not isinstance(parsed, dict):
        return "invalid", f"root is {type(parsed).__name__}, not an object"
    secret_keys: list[str] = []
    _find_secret_keys(parsed, secret_keys)
    if secret_keys:
        return "invalid", f"denylisted secret key(s): {', '.join(secret_keys)}"
    if not any(k in parsed for k in ("api_format", "active_profile", "provider")):
        return (
            "invalid",
            "no provider key field (api_format/active_profile/provider all missing)",
        )
    return "ok", "provider configuration present"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="write repairs (default: dry-run, report only)",
    )
    args = parser.parse_args()

    if not settings.minio_endpoint:
        print("tenant staging disabled (no OH_MINIO_ENDPOINT)", file=sys.stderr)
        return 2

    seed_text = tenant_store.settings_seed()
    if json.loads(seed_text) == {}:
        print(
            "WARNING: settings_seed() derives to {} (global settings missing/"
            "unparseable) — repairing now would rewrite empty seeds with "
            "another empty seed; fix OH_GLOBAL_SETTINGS_PATH first.",
            file=sys.stderr,
        )
        return 3

    client = tenant_store._client()
    counts = {"repaired": 0, "skipped_ok": 0, "invalid": 0, "failed": 0}
    details: list[str] = []
    mode = "APPLY" if args.apply else "DRY-RUN"

    for obj in client.list_objects(settings.minio_bucket, prefix="tenants/", recursive=True):
        match = _SETTINGS_RE.match(obj.object_name)
        if not match:
            continue
        tid = match.group(1)
        try:
            resp = client.get_object(settings.minio_bucket, obj.object_name)
            try:
                raw = resp.read()
            finally:
                resp.close()
                resp.release_conn()
            category, reason = _classify(raw)
            if category == "ok":
                counts["skipped_ok"] += 1
                details.append(f"[ok]        {tid}: {reason}")
            elif category == "invalid":
                counts["invalid"] += 1
                details.append(f"[invalid]   {tid}: {reason} (NOT modified)")
            else:  # empty_seed — the only auto-repaired class
                if args.apply:
                    body = seed_text.encode("utf-8")
                    client.put_object(
                        settings.minio_bucket,
                        obj.object_name,
                        io.BytesIO(body),
                        length=len(body),
                        content_type="application/json",
                    )
                    # Refresh local staging too: an un-refreshed staging copy
                    # would push the stale {} back on the next stage-out.
                    local = tenant_store.local_config_dir(tid) / "settings.json"
                    if local.exists():
                        local.write_text(seed_text, encoding="utf-8")
                counts["repaired"] += 1
                details.append(f"[empty_seed] {tid}: {reason} -> derived seed")
        except Exception as exc:  # noqa: BLE001 — keep walking, report at end
            counts["failed"] += 1
            details.append(f"[failed]    {tid}: {exc}")

    print(f"repair_tenant_settings_seed ({mode})")
    for line in details:
        print(line)
    print(
        f"repaired={counts['repaired']} skipped_ok={counts['skipped_ok']} "
        f"invalid={counts['invalid']} failed={counts['failed']}"
    )
    if not args.apply and counts["repaired"]:
        print("(dry-run: nothing written — re-run with --apply)")
    return 0 if counts["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
