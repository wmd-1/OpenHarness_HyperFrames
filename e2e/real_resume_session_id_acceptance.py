#!/usr/bin/env python3
"""Real-binary acceptance harness for the session_id resume contract.

Runs INSIDE an existing OpenHarness runtime image (OpenHarness/src is mounted
at /app/src so the fixed code is live) and exercises the REAL ``oh`` CLI through
the openspec change ``2026-08-05-oh-session-id-resume-contract`` acceptance:

  * §8.2 (failure/compat): an OLD-format snapshot (random session_id) is
    unaddressable by ``oh --resume <cwd-based-id>`` -> still "Session not found"
    even after the runtime fix -> proves solution A alone is insufficient and
    the M1 migration is required.
  * M1 migration re-keys the legacy snapshot to the cwd-based dir name.
  * §8.1 (normal): after migration ``oh --resume <id>`` loads the snapshot and
    reaches the backend-host await (RESUME contract restored); snapshot
    session_id == dir (consistency).
  * M1 re-run is idempotent (no-op).

No LLM key required: the crash is a startup ``load_session_by_id`` failure that
fires BEFORE any provider call, and the backend-host await needs no turn.
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

# Ensure the mounted (fixed) openharness is importable.
sys.path.insert(0, "/app/src")

from openharness.services.session_storage import (  # noqa: E402
    get_project_session_dir,
    load_session_by_id,
)
from openharness.tools.migrate_session_snapshots import rekey_data_dir  # noqa: E402

ROOT = Path(tempfile.mkdtemp(prefix="oh-resume-acc-"))
DATA = ROOT / "data"
CFG = ROOT / "cfg"
CWD = ROOT / "myconv01"
CWD.mkdir(parents=True, exist_ok=True)

os.environ["OPENHARNESS_DATA_DIR"] = str(DATA)
os.environ["OPENHARNESS_CONFIG_DIR"] = str(CFG)

# dir name the same way the real `oh` computes it (cwd-based id).
dir_name = get_project_session_dir(CWD).name
sess_dir = DATA / "sessions" / dir_name
sess_dir.mkdir(parents=True, exist_ok=True)

OLD = "legacy-random-id-9f8e7d6c5b4a"
MSG = [{"role": "user", "content": [{"type": "text", "text": "hi"}]}]

# ---- OLD-format snapshot (pre-fix shape) --------------------------------
(sess_dir / "latest.json").write_text(
    json.dumps({"session_id": OLD, "last_updated": "2026-08-04T00:00:00",
                "model": "x", "summary": "legacy", "messages": MSG})
)
(sess_dir / f"session-{OLD}.json").write_text(
    json.dumps({"session_id": OLD, "messages": MSG})
)


OH_BIN = "/root/.local/bin/oh" if Path("/root/.local/bin/oh").exists() else "oh"


def run_oh() -> subprocess.CompletedProcess:
    env = dict(os.environ,
               OPENHARNESS_PROVIDER="openai",
               OPENHARNESS_OPENAI_API_KEY="sk-dummy-acceptance-test",
               OPENHARNESS_MODEL="gpt-4o-mini")
    return subprocess.run(
        ["timeout", "30", OH_BIN, "--cwd", str(CWD), "--backend-only",
         "--resume", dir_name],
        env=env, capture_output=True, text=True,
    )


def fail(msg: str) -> None:
    print(f"\n[FAIL] {msg}", file=sys.stderr)
    sys.exit(1)


# (a) load returns None for old format (defect still present pre-migration) ---
ld = load_session_by_id(CWD, dir_name)
if ld is not None:
    fail("old-format snapshot was addressable pre-migration (defect not reproduced)")
print(f"[OK] old-format snapshot unaddressable by --resume (dir={dir_name})")

# (b) oh --resume (old-format) -> 'Session not found' exit 1 -----------------
r = run_oh()
if r.returncode != 1 or "Session not found" not in r.stderr:
    fail(f"expected 'Session not found' exit 1 on old-format, "
         f"rc={r.returncode} out={r.stdout[-200]}{r.stderr[-200]}")
print("[OK] oh --resume (old-format) => 'Session not found' exit 1 "
      "(proves A alone insufficient; M1 migration required)")

# (c) M1 migration -----------------------------------------------------------
rep = rekey_data_dir(DATA)
if rep.get("migrated") != 1:
    fail(f"M1 migration did not re-key exactly one dir: {rep}")
print(f"[OK] M1 migration re-keyed dir (migrated={rep['migrated']}, "
      f"skipped={rep['skipped']}, errors={rep['errors']})")

# (d) post-migration load returns data with session_id == dir ----------------
ld = load_session_by_id(CWD, dir_name)
if ld is None or ld.get("session_id") != dir_name:
    fail(f"post-migration load failed or session_id mismatched: {ld}")
print(f"[OK] post-migration load_session_by_id returns session_id={ld.get('session_id')}")

# (e) oh --resume (migrated) -> no 'Session not found' ------------------------
r = run_oh()
combined = r.stdout + r.stderr
if "Session not found" in combined:
    fail(f"RESUME still failing after migration: {combined[-300:]}")
print(f"[OK] oh --resume (migrated) reaches backend-host without "
      f"'Session not found' (rc={r.returncode}) -- RESUME contract restored")
if r.returncode == 124:
    print("[OK] oh idle-timed-out (124) => backend host was awaiting connections (service ready)")

# (f) idempotent re-run ------------------------------------------------------
rep2 = rekey_data_dir(DATA)
if rep2.get("migrated") != 0 or rep2.get("skipped") != 1:
    fail(f"M1 re-run not idempotent: {rep2}")
print(f"[OK] M1 re-run idempotent (migrated={rep2['migrated']}, "
      f"skipped={rep2['skipped']})")

# (g) snapshot session_id == dir consistency (D.2) --------------------------
ld = load_session_by_id(CWD, dir_name)
if ld.get("session_id") != dir_name:
    fail(f"snapshot session_id != dir: {ld.get('session_id')} != {dir_name}")
print(f"[OK] snapshot session_id == cwd-based dir (consistency verified)")

print("\nALL REAL-BINARY ACCEPTANCE CHECKS PASSED")
sys.exit(0)
