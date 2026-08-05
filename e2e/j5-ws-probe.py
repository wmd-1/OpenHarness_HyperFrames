#!/usr/bin/env python3
"""J5 second-submit boundary probe (READ-ONLY diagnostic, no business code touched).

Pure WebSocket client — no browser, no frontend — so the observed behaviour is
purely the session-service contract:

    submit(#1) -> ... -> turn_complete
      (wait DELAY_MS)
    submit(#2) -> ??? (busy / delta / silence)

Usage (inside the session container):
    python3 j5-ws-probe.py <delay_ms> [<label>]

Prints one JSON line prefixed with ``J5_PROBE `` containing every frame with a
millisecond-resolution timestamp relative to the first turn_complete.
"""
from __future__ import annotations

import asyncio
import json
import sys
import time

import websockets
import urllib.request

BASE = "http://localhost:8001"
WS_BASE = "ws://localhost:8001"
API_KEY = "j5-probe-key"


def create_session() -> str:
    req = urllib.request.Request(
        f"{BASE}/v1/sessions",
        data=json.dumps({"permission_policy": "full_auto"}).encode(),
        headers={"Content-Type": "application/json", "X-API-Key": API_KEY},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read())["session_id"]


def rest_submit(sid: str, text: str) -> dict:
    """REST fallback submit — bypasses ws.py's ``turn_task`` guard and hits
    ``supervisor.stream_turn``'s own ``live.busy`` check instead."""
    req = urllib.request.Request(
        f"{BASE}/v1/sessions/{sid}/turns",
        data=json.dumps({"text": text}).encode(),
        headers={"Content-Type": "application/json", "X-API-Key": API_KEY},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return {"status": resp.status, "body": json.loads(resp.read())}
    except urllib.error.HTTPError as exc:  # type: ignore[attr-defined]
        return {"status": exc.code, "body": exc.read().decode()[:200]}


def list_turns(sid: str) -> list:
    req = urllib.request.Request(
        f"{BASE}/v1/sessions/{sid}/turns", headers={"X-API-Key": API_KEY}
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = json.loads(resp.read())
    if isinstance(body, dict):
        for key in ("turns", "items", "data"):
            if isinstance(body.get(key), list):
                return body[key]
        return [body]
    return body


async def probe(delay_ms: int, label: str, via_rest: bool = False) -> dict:
    sid = create_session()
    frames: list[dict] = []
    t_complete1 = None
    sent: list[dict] = []
    url = f"{WS_BASE}/v1/sessions/{sid}/ws?api_key={API_KEY}"
    async with websockets.connect(url, max_size=None) as ws:
        t0 = time.time()

        def rel(ts: float) -> float:
            base = t_complete1 if t_complete1 is not None else t0
            return round((ts - base) * 1000, 1)

        async def send(op: dict) -> None:
            sent.append({"t_ms": rel(time.time()), "op": op})
            await ws.send(json.dumps(op))

        # wait session_ready
        deadline = time.time() + 30
        ready = False
        second_sent = False
        completes = 0
        while time.time() < deadline:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=max(0.1, deadline - time.time()))
            except asyncio.TimeoutError:
                break
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            rec = {
                "t_ms": rel(time.time()),
                "type": msg.get("type"),
                "turn_index": msg.get("turn_index"),
                "has_artifact": msg.get("has_artifact"),
                "message": (msg.get("message") or "")[:100] or None,
            }
            frames.append(rec)
            if msg.get("type") == "session_ready" and not ready:
                ready = True
                await send({"op": "submit", "text": "probe turn one"})
            elif msg.get("type") == "turn_complete":
                completes += 1
                if completes == 1:
                    t_complete1 = time.time()
                    rec["t_ms"] = 0.0
                    if delay_ms:
                        await asyncio.sleep(delay_ms / 1000)
                    if via_rest:
                        t_send = rel(time.time())
                        res = await asyncio.to_thread(
                            rest_submit, sid, "probe turn two (rest)"
                        )
                        sent.append({"t_ms": t_send, "op": "REST POST /turns", "result": res})
                        second_sent = True
                        break
                    await send({"op": "submit", "text": "probe turn two"})
                    second_sent = True
                    deadline = time.time() + 25
                else:
                    break
            elif msg.get("type") == "busy":
                # keep listening for a few more seconds to prove nothing follows
                deadline = min(deadline, time.time() + 5)
        await asyncio.sleep(0.2)
    # settle, then read DB truth via REST
    await asyncio.sleep(1.0)
    turns = list_turns(sid)
    return {
        "label": label,
        "delay_ms": delay_ms,
        "sid": sid,
        "second_sent": second_sent,
        "frames": frames,
        "sent": sent,
        "rest_turn_count": len(turns),
        "rest_turn_indexes": [t.get("turn_index") for t in turns],
    }


async def main() -> None:
    delay_ms = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    label = sys.argv[2] if len(sys.argv) > 2 else f"delay{delay_ms}"
    via_rest = len(sys.argv) > 3 and sys.argv[3] == "rest"
    result = await probe(delay_ms, label, via_rest)
    print("J5_PROBE " + json.dumps(result))


if __name__ == "__main__":
    asyncio.run(main())
