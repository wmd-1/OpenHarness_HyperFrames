#!/usr/bin/env python3
"""Contract smoke test against the REAL ``oh --backend-only`` (spec task 6.4).

Verifies the session-service's protocol assumptions hold against the actual
native binary — WITHOUT an LLM API key (we only exercise the ``ready`` event
and a graceful ``shutdown``; no turn/LLM call is made):

  1. spawn ``oh --backend-only --cwd <tmp> --permission-mode full_auto``
  2. assert an ``OHJSON:{"type":"ready",...}`` line appears on stdout
  3. write a bare-JSON ``{"type":"shutdown"}`` to stdin
  4. assert the process exits cleanly (code 0) within a grace period

Run inside the test image (real ``oh`` present):
    docker run --rm oh-session-test:latest \\
        python /opt/oh-session-service/scripts/contract_smoke.py

If the real ``oh`` cannot start without an API key, the test reports SKIP
rather than failing.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

OHJSON = "OHJSON:"


def _oh_bin() -> str:
    # Prefer the real wrapper; fall back to the venv binary.
    for cand in (os.environ.get("OH_OH_BIN_REAL", "/root/.local/bin/oh"), "/root/.openharness-venv/bin/oh"):
        if Path(cand).exists():
            return cand
    return "oh"


def main() -> int:
    oh = _oh_bin()
    cwd = tempfile.mkdtemp(prefix="oh-contract-")
    cmd = [oh, "--backend-only", "--cwd", cwd, "--permission-mode", "full_auto"]
    print(f"[contract] spawning: {' '.join(cmd)}", flush=True)
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        cwd=cwd,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
        start_new_session=True,
    )

    saw_ready = False
    deadline = time.time() + 30
    try:
        while time.time() < deadline:
            line = proc.stdout.readline()
            if not line:
                break
            line = line.rstrip()
            if line.startswith(OHJSON):
                try:
                    ev = json.loads(line[len(OHJSON):])
                except json.JSONDecodeError:
                    continue
                if ev.get("type") == "ready":
                    saw_ready = True
                    print(f"[contract] OK: received ready event", flush=True)
                    break
            elif "api key" in line.lower() or "api_key" in line.lower() or "unauthorized" in line.lower():
                print(f"[contract] SKIP: oh requires an API key to start backend-only mode", flush=True)
                print(f"[contract]   line: {line[:160]}", flush=True)
                proc.terminate()
                return 77  # skip
        if not saw_ready:
            print("[contract] FAIL: no ready event within 30s", flush=True)
            proc.terminate()
            return 1

        # Send shutdown and assert a clean exit.
        assert proc.stdin is not None
        proc.stdin.write(json.dumps({"type": "shutdown"}) + "\n")
        proc.stdin.flush()
        try:
            rc = proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
            rc = proc.wait()
        print(f"[contract] exit code after shutdown: {rc}", flush=True)
        if rc != 0:
            print("[contract] FAIL: process did not exit cleanly", flush=True)
            return 1
        print("[contract] PASS: ready received + clean shutdown", flush=True)
        return 0
    finally:
        try:
            proc.kill()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
