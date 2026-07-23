#!/usr/bin/env python3
"""Faithful ``oh --backend-only`` stub for the session-service test suite.

Speaks the native OHJSON line protocol so the protocol bridge, lifecycle, and
WS streaming can be exercised end-to-end without a real LLM API key (mirrors the
role of ``e2e/oh_stub.sh`` for the video service).

Usage (the session service spawns it as ``oh``):
    oh_backend_stub.py --backend-only --cwd <dir> --permission-mode <mode> [--resume <sid>]

Behaviour per ``submit_line``:
  1. emit ``assistant_delta`` (greeting echoing the prompt)
  2. emit ``tool_started`` / ``tool_completed`` (simulated)
  3. write a tiny valid mp4 into the cwd (so artifact registration works)
  4. emit ``line_complete``
On ``interrupt``: emit ``line_complete`` (interrupted).
On ``shutdown``: emit ``shutdown`` and exit 0.
"""

from __future__ import annotations

import json
import os
import sys
import signal
import subprocess
import time
from pathlib import Path

OHJSON = "OHJSON:"


def emit(event: dict) -> None:
    """Write one OHJSON event line to stdout, flushed."""
    line = OHJSON + json.dumps(event, ensure_ascii=False) + "\n"
    sys.stdout.buffer.write(line.encode("utf-8"))
    sys.stdout.buffer.flush()


def emit_ready() -> None:
    emit({
        "type": "ready",
        "state": {"cwd": os.getcwd(), "permission_mode": os.environ.get("OPENHARNESS_PERMISSION_MODE", "full_auto")},
        "tasks": [],
        "mcp_servers": [],
        "bridge_sessions": [],
        "commands": ["/help", "/resume"],
    })
    emit({"type": "state_snapshot", "state": {"permission_mode": "full_auto"}})


def write_mp4(cwd: Path, name: str = "out.mp4") -> str:
    """Write a 1-second solid-blue mp4 via ffmpeg (falls back to empty file)."""
    out = cwd / name
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=1",
             "-pix_fmt", "yuv420p", str(out)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30, check=True,
        )
    except Exception:
        out.write_bytes(b"")
    return name


def handle_submit(line: str, cwd: Path, turn_index: int) -> None:
    """Simulate one turn: delta -> tool -> mp4 -> line_complete."""
    # Assistant text delta.
    emit({"type": "assistant_delta", "message": f"Stub reply to: {line}"})
    emit({"type": "assistant_complete", "message": f"Stub reply to: {line}"})

    # Simulated tool call that produces the video artifact.
    emit({"type": "tool_started", "tool_name": "render_video", "tool_input": {"prompt": line}})
    name = write_mp4(cwd)
    # The marker the artifact locator looks for.
    sys.stdout.buffer.write(f"**Output:** `{name}`\n".encode())
    sys.stdout.buffer.flush()
    emit({"type": "tool_completed", "tool_name": "render_video", "output": f"wrote {name}", "is_error": False})

    emit({"type": "tasks_snapshot", "tasks": []})
    emit({"type": "line_complete"})


def main() -> int:
    args = sys.argv[1:]
    cwd = Path.cwd()
    resume = None
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--cwd" and i + 1 < len(args):
            cwd = Path(args[i + 1])
            cwd.mkdir(parents=True, exist_ok=True)
            os.chdir(cwd)
            i += 2
            continue
        if a in ("--resume", "-r") and i + 1 < len(args):
            resume = args[i + 1]
            i += 2
            continue
        if a in ("--backend-only", "--permission-mode"):
            i += 2 if a == "--permission-mode" else 1
            continue
        if a.startswith("--"):
            # consume a value if the next token isn't a flag
            if i + 1 < len(args) and not args[i + 1].startswith("--"):
                i += 2
            else:
                i += 1
            continue
        i += 1

    # Honor SIGTERM (the supervisor kills the process group on timeout/cancel).
    def _term(*_):
        emit({"type": "error", "message": "terminated"})
        sys.exit(143)
    signal.signal(signal.SIGTERM, _term)

    emit_ready()
    if resume:
        # On resume, the upstream re-emits ready then waits; nothing extra needed.
        pass

    turn_index = 0
    while True:
        raw = sys.stdin.buffer.readline()
        if not raw:
            break
        payload = raw.decode("utf-8").strip()
        if not payload:
            continue
        try:
            req = json.loads(payload)
        except json.JSONDecodeError:
            emit({"type": "error", "message": f"invalid request: {payload[:80]}"})
            continue
        t = req.get("type")
        if t == "shutdown":
            emit({"type": "shutdown"})
            break
        if t == "interrupt":
            emit({"type": "line_complete"})
            continue
        if t in ("permission_response", "question_response"):
            continue
        if t == "submit_line":
            line = req.get("line", "")
            # Simulate a little work so timeout/interrupt paths are exercisable.
            time.sleep(float(os.environ.get("OH_STUB_TURN_SECONDS", "0")))
            handle_submit(line, cwd, turn_index)
            turn_index += 1
            continue
        emit({"type": "error", "message": f"unknown request type: {t}"})

    return 0


if __name__ == "__main__":
    sys.exit(main())
