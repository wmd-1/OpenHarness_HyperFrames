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
import re
import select
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path

OHJSON = "OHJSON:"

# Magic token in a submitted line that makes this stub emit a full approval flow
# (permission -> edit_diff -> question). Gated by content (not a global env) so
# existing tests that never send this token are unaffected.
APPROVAL_TRIGGER = "@@approval"

# Magic token that simulates a backend crash (os._exit) to exercise frontend
# graceful handling of backend death.
CRASH_TRIGGER = "@@crash"


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
    """Write a 1-second solid-blue mp4 via ffmpeg (falls back to stub bytes)."""
    out = cwd / name
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=1",
             "-pix_fmt", "yuv420p", str(out)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30, check=True,
        )
    except Exception:
        # No ffmpeg: still produce enough deterministic bytes that Range
        # (bytes=N-M) download tests can exercise partial content.
        out.write_bytes(bytes(range(256)) * 4)
    return name


def _stdin_ready(timeout: float) -> bool:
    """Non-blocking check for pending stdin (used to honor interrupt / approval)."""
    r, _, _ = select.select([sys.stdin], [], [], timeout)
    return bool(r)


def write_snapshot_marker() -> None:
    """Faithfully emulate OpenHarness writing a session snapshot marker after a
    completed turn. This lets the session-service recovery policy (which keys off
    a valid snapshot marker) classify a resumed STUB session as RESUME instead of
    RECOVERY_FAILED. No-op when the backend env (OPENHARNESS_DATA_DIR /
    OH_SESSION_ID) is absent — the real `oh` backend writes its own snapshot and
    ignores this entirely.
    """
    data_dir = os.environ.get("OPENHARNESS_DATA_DIR")
    sid = os.environ.get("OH_SESSION_ID")
    if not data_dir or not sid:
        return
    marker_dir = Path(data_dir) / "sessions" / sid
    try:
        marker_dir.mkdir(parents=True, exist_ok=True)
        (marker_dir / "latest.json").write_text(
            json.dumps({"emulated_by": "oh_backend_stub", "resumable": True})
        )
    except OSError:
        pass


def handle_submit(line: str, cwd: Path, turn_index: int) -> None:
    """Simulate one turn: delta -> tool -> mp4 -> line_complete."""
    if line.strip().startswith("/model"):
        # Model dual-channel ②: backend acknowledges the runtime model switch
        # (real oh would reconfigure); emit a confirmation the UI can surface.
        model = line.strip().split(None, 1)[1] if " " in line.strip() else ""
        emit({"type": "assistant_delta", "message": f"Switched model to {model}"})
        emit({"type": "assistant_complete", "message": f"Switched model to {model}"})
        emit({"type": "state_snapshot", "state": {"model": model}})
        emit({"type": "line_complete"})
        return

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
    write_snapshot_marker()
    emit({"type": "line_complete"})


def run_approval_flow(line: str, cwd: Path, turn_index: int, kinds=None) -> None:
    """Emit approval frames (permission -> edit_diff -> question, or a subset
    selected via ``@@approval:<kind>``) and wait for the client's responses
    (written back to stdin by the session-service bridge)."""
    all_steps = [
        ("permission", "Approve writing the generated script file?"),
        ("edit_diff", "Approve applying the following edit diff?"),
        ("question", "Which framework should I scaffold the UI with?"),
    ]
    if kinds:
        steps = [s for s in all_steps if s[0] in kinds]
    else:
        steps = all_steps
    deadline = time.time() + 120.0  # safety cap
    for kind, message in steps:
        rid = f"req-{uuid.uuid4().hex[:8]}"
        modal: dict = {
            "request_id": rid,
            # Frontend ApprovalModal dispatches on `modal.kind` (permissions/edit_diff/question).
            "kind": kind,
            "type": kind,
            "message": message,
            "title": message,
            "timeout": 300,
        }
        if kind == "permission":
            modal["tool_name"] = "render_video"
            modal["reason"] = "生成视频需要调用渲染工具"
        if kind == "edit_diff":
            modal["path"] = "main.py"
            modal["added"] = 1
            modal["removed"] = 0
            modal["diff"] = "--- a/main.py\n+++ b/main.py\n@@\n+print('hello')\n"
        if kind == "question":
            modal["question"] = message
            modal["options"] = [{"label": "React"}, {"label": "Vue"}]
        emit({"type": "modal_request", "modal": modal})

        answered = False
        while not answered:
            if _stdin_ready(0.5):
                raw = sys.stdin.buffer.readline()
                if not raw:
                    return  # EOF: client gone
                try:
                    req = json.loads(raw.decode("utf-8").strip())
                except json.JSONDecodeError:
                    continue
                t = req.get("type")
                if t in ("permission_response", "question_response") and req.get("request_id") == rid:
                    answered = True
                elif t == "interrupt":
                    emit({"type": "line_complete", "interrupted": True})
                    return
                # ignore unrelated lines
            if time.time() > deadline:
                emit({"type": "line_complete", "interrupted": True})
                return
    # All approved: run the actual turn.
    handle_submit(line, cwd, turn_index)


def run_interruptible(line: str, cwd: Path, turn_index: int) -> None:
    """Run a normal turn but honor an incoming ``interrupt`` during the busy wait,
    ending the turn early (interrupted) instead of blocking the full duration."""
    secs = float(os.environ.get("OH_STUB_TURN_SECONDS", "0"))
    deadline = time.time() + secs
    interrupted = False
    while time.time() < deadline:
        if _stdin_ready(0.1):
            raw = sys.stdin.buffer.readline()
            if not raw:
                return
            try:
                req = json.loads(raw.decode("utf-8").strip())
            except json.JSONDecodeError:
                continue
            if req.get("type") == "interrupt":
                interrupted = True
                break
            # ignore other lines that may arrive during the wait
        else:
            time.sleep(0.02)
    if interrupted:
        emit({"type": "assistant_delta", "message": f"Interrupted: {line}"})
        emit({"type": "assistant_complete", "message": f"Interrupted: {line}"})
        emit({"type": "line_complete", "interrupted": True})
        return
    handle_submit(line, cwd, turn_index)


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
            if CRASH_TRIGGER in line:
                # Simulate a backend crash: terminate the process abnormally so
                # the session-service supervisor detects the death (-> FAILED/COLD).
                emit({"type": "error", "message": "simulated crash"})
                sys.stdout.buffer.flush()
                os._exit(1)
            if APPROVAL_TRIGGER in line:
                m = re.search(r"@@approval:(\w+)", line)
                kinds = [m.group(1)] if (m and m.group(1) in ("permission", "edit_diff", "question")) else None
                run_approval_flow(line, cwd, turn_index, kinds)
            else:
                run_interruptible(line, cwd, turn_index)
            turn_index += 1
            continue
        emit({"type": "error", "message": f"unknown request type: {t}"})

    return 0


if __name__ == "__main__":
    sys.exit(main())
