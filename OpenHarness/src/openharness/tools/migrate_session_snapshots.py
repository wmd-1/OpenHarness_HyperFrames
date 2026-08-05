#!/usr/bin/env python3
"""One-off, idempotent migration of legacy OpenHarness session snapshots.

Background
----------
Before the session_id lifecycle fix (openspec change
``2026-08-05-oh-session-id-resume-contract``), the real ``oh`` backend generated
a random ``session_id`` (``uuid4``) for each run and persisted snapshots under
that random id, while session-service addressed ``oh --resume <id>`` by the
stable cwd-based id (``"<cwd.name>-<sha1(resolve(cwd))[:12]>"``). The two
namespaces never matched, so RESUME failed with ``Session not found``.

This script re-keys legacy snapshots so that ``latest.json["session_id"]`` and
the ``session-<id>.json`` file name both equal the directory name (== cwd-based
id), making them addressable by ``--resume``.

Properties
----------
* Idempotent: dirs already consistent (``session-<dir>.json`` exists and
  ``latest.json["session_id"] == dir``) are skipped, so re-running is a no-op.
* Safe: each file is rewritten atomically (temp file + replace). A broken
  ``latest.json`` is reported and skipped without aborting the whole run.
* Manual: run once per tenant data dir; NOT executed automatically at backend
  startup. Supports ``--dry-run`` to preview.

Usage
-----
    python -m openharness.tools.migrate_session_snapshots \
        --data-dir /tenants/<tid>/openharness/data [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json_atomic(path: Path, data: dict) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(path)


def _session_id_of(latest: Path) -> str | None:
    if not latest.exists():
        return None
    try:
        return _read_json(latest).get("session_id")
    except (json.JSONDecodeError, OSError):
        return None


def rekey_data_dir(data_dir: Path, *, dry_run: bool = False) -> dict:
    """Re-key legacy snapshots in ``<data_dir>/sessions/*`` to the dir name.

    Returns a report dict with ``scanned``/``migrated``/``skipped``/``errors``.
    """
    report: dict[str, object] = {"scanned": 0, "migrated": 0, "skipped": 0, "errors": []}
    sessions_root = data_dir / "sessions"
    if not sessions_root.is_dir():
        return report  # type: ignore[return-value]

    for dir_path in sorted(sessions_root.iterdir()):
        if not dir_path.is_dir():
            continue
        report["scanned"] = int(report["scanned"]) + 1  # type: ignore[index]
        dir_name = dir_path.name
        latest = dir_path / "latest.json"
        target = dir_path / f"session-{dir_name}.json"

        # Idempotency: already consistent -> skip.
        if target.exists() and _session_id_of(latest) == dir_name:
            report["skipped"] = int(report["skipped"]) + 1  # type: ignore[index]
            continue

        try:
            # Re-key latest.json.
            if latest.exists():
                data = _read_json(latest)
                data["session_id"] = dir_name
                if not dry_run:
                    _write_json_atomic(latest, data)

            # Rename legacy session-<old>.json -> session-<dir>.json.
            for old in dir_path.glob("session-*.json"):
                if old.name == target.name:
                    continue
                new = target
                if new.exists():
                    # Keep the newer of the two (latest.json is authoritative).
                    if old.stat().st_mtime <= new.stat().st_mtime:
                        continue
                embedded = _read_json(old)
                embedded["session_id"] = dir_name
                if not dry_run:
                    _write_json_atomic(new, embedded)
                    old.unlink()
            report["migrated"] = int(report["migrated"]) + 1  # type: ignore[index]
        except (json.JSONDecodeError, OSError) as exc:
            report["errors"].append({"dir": dir_name, "error": str(exc)})  # type: ignore[arg-type]

    return report  # type: ignore[return-value]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Re-key legacy OpenHarness session snapshots to the cwd-based id."
    )
    parser.add_argument(
        "--data-dir",
        required=True,
        type=Path,
        help="Tenant data dir, e.g. /tenants/<tid>/openharness/data",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview changes without writing any files",
    )
    args = parser.parse_args(argv)

    report = rekey_data_dir(args.data_dir, dry_run=args.dry_run)
    print(json.dumps(report, indent=2))
    return 1 if report["errors"] else 0  # type: ignore[index]


if __name__ == "__main__":
    sys.exit(main())
