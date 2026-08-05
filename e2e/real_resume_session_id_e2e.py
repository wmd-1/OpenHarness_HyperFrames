"""Real-stack RESUME contract E2E (D.4) — run INSIDE openharness-session.

Drives the live session-service REST+WS with the REAL oh backend (no stub),
perfoming a real LLM turn, then a container restart triggers rehydrate via
`oh --resume <oh_session_id>`, then a second real turn. Validates that the
snaled snapshot's session_id == dir (the core fix).

Usage (host):
  docker cp real_resume_session_id_e2e.py openharness-session:/tmp/e2e.py
  docker exec openharness-session /root/.openharness-venv/bin/python /tmp/e2e.py --phase create
  docker restart openharness-session
  docker exec openharness-session /root/.openharness-venv/bin/python /tmp/e2e.py --phase resume
"""
import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

import httpx
import websockets

BASE = "http://127.0.0.1:8001"
API_KEY = os.environ.get("OH_E2E_API_KEY", "x")
HDR = {"X-API-Key": API_KEY}
WS_KEY = API_KEY
STATE_FILE = Path("/tmp/resume_e2e.json")
TURN_TIMEOUT = 180.0


def log(*a):
    print("[e2e]", *a, flush=True)


async def create_session() -> dict:
    async with httpx.AsyncClient(base_url=BASE, timeout=60) as c:
        r = await c.post("/v1/sessions", headers=HDR, json={})
        if r.status_code >= 400:
            log("CREATE FAILED", r.status_code, r.text[:500])
            sys.exit(1)
        return r.json()


async def ws_turn(sid: str, text: str) -> dict:
    url = f"ws://127.0.0.1:8001/v1/sessions/{sid}/ws?api_key={WS_KEY}"
    async with websockets.connect(url, max_size=2**26) as ws:
        # wait for session_ready
        ready = None
        while True:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=60))
            if msg.get("type") == "session_ready":
                ready = msg
                break
            if msg.get("type") == "error":
                log("WS ERROR during ready", msg)
                sys.exit(1)
        log("session_ready:", ready)
        await ws.send(json.dumps({"op": "submit", "text": text}))
        frames = 0
        last = None
        while True:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=TURN_TIMEOUT))
            t = msg.get("type")
            frames += 1
            if t == "turn_complete":
                last = msg
                break
            if t == "error":
                log("WS ERROR during turn", msg)
                sys.exit(1)
            if t == "backend_closed" and msg.get("reason") not in (None, "normal"):
                log("backend_closed abnormal", msg)
        log(f"turn_complete after {frames} frames:", last)
        return last


async def get_session(sid: str) -> dict:
    async with httpx.AsyncClient(base_url=BASE, timeout=30) as c:
        r = await c.get(f"/v1/sessions/{sid}", headers=HDR)
        return r.json()


def check_snapshot(oh_session_id: str) -> bool:
    """Verify a snapshot exists whose session_id == dir (oh_session_id)."""
    found = False
    for p in Path("/tenants").rglob("latest.json"):
        if p.parent.name != oh_session_id:
            continue
        try:
            data = json.loads(p.read_text())
        except Exception as e:
            log("  snapshot read error", p, e)
            continue
        sid_in = data.get("session_id")
        log(f"  snapshot {p}: session_id={sid_in!r} dir={p.parent.name!r}")
        if sid_in == p.parent.name == oh_session_id:
            found = True
    return found


async def phase_create():
    conv = await create_session()
    sid = conv["session_id"]
    oh_id = conv.get("oh_session_id")
    log("created sid=", sid, "oh_session_id=", oh_id)
    res = await ws_turn(sid, "Ping. Reply with exactly the single word PONG.")
    conv2 = await get_session(sid)
    tc = conv2.get("turn_count")
    log("after turn1 turn_count=", tc)
    STATE_FILE.write_text(json.dumps({"sid": sid, "oh_session_id": oh_id}))
    assert tc and tc >= 1, f"turn1 did not persist (turn_count={tc})"
    log("PHASE CREATE OK")


async def phase_resume():
    st = json.loads(STATE_FILE.read_text())
    sid, oh_id = st["sid"], st["oh_session_id"]
    log("resuming sid=", sid, "oh_session_id=", oh_id)
    res = await ws_turn(sid, "Now reply with exactly the single word OK.")
    conv = await get_session(sid)
    tc = conv.get("turn_count")
    log("after turn2 turn_count=", tc)
    snapshot_ok = check_snapshot(oh_id)
    log("snapshot session_id==dir:", snapshot_ok)
    assert tc and tc >= 2, f"resume turn did not persist (turn_count={tc})"
    assert snapshot_ok, "no snapshot with session_id == dir found"
    log("PHASE RESUME OK")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", choices=["create", "resume"], required=True)
    args = ap.parse_args()
    t0 = time.time()
    if args.phase == "create":
        asyncio.run(phase_create())
    else:
        asyncio.run(phase_resume())
    log(f"done in {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
