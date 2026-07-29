#!/usr/bin/env python3
"""Minimal WS client driver for the container-runtime e2e (task 3.8).

Runs INSIDE the session gateway container via ``docker compose exec`` — the
venv ships ``websockets`` (uvicorn[standard]) and the host stays limited to
docker/curl per the image-based-testing rule.

Usage:
    ws_e2e_driver.py touch <sid> <api_key>          # attach then detach (arms the idle timer)
    ws_e2e_driver.py turn  <sid> <api_key> <text>   # submit one turn, wait for turn_complete
    ws_e2e_driver.py hold  <sid> <api_key> [secs]   # stay attached (keeps the session LIVE)

``turn`` against a COLD session exercises the rehydrate-on-connect path
(fresh --resume backend, container runtime included).
"""

from __future__ import annotations

import asyncio
import json
import sys


async def main() -> int:
    mode, sid, key = sys.argv[1], sys.argv[2], sys.argv[3]
    import websockets

    url = f"ws://localhost:8001/v1/sessions/{sid}/ws?api_key={key}"
    async with websockets.connect(url, open_timeout=30) as ws:
        if mode == "touch":
            await asyncio.sleep(1)
            return 0

        if mode == "hold":
            secs = float(sys.argv[4]) if len(sys.argv) > 4 else 60.0
            # Stay attached for the FULL duration: the server pushes frames
            # unprompted (session_ready, replays), so a single recv() would
            # detach almost immediately. Drain until the deadline instead.
            deadline = asyncio.get_running_loop().time() + secs
            while True:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    return 0
                try:
                    await asyncio.wait_for(ws.recv(), timeout=remaining)
                except asyncio.TimeoutError:
                    return 0
                except Exception:
                    return 0  # server closed us (evict/crash) — holding is over

        if mode == "turn":
            text = sys.argv[4]
            await ws.send(json.dumps({"op": "submit", "text": text}))
            while True:
                frame = json.loads(await asyncio.wait_for(ws.recv(), timeout=120))
                ftype = frame.get("type")
                if ftype == "turn_complete" and not frame.get("replayed"):
                    print(json.dumps(frame))
                    return 0
                if ftype == "turn_error":
                    print(json.dumps(frame), file=sys.stderr)
                    return 1

    return 2


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
