"""Protocol adapter — translate between subprocess lines and typed events.

Responsibilities (spec D2):
- Read stdout lines from :class:`OhBackendProcess`.
  - ``OHJSON:`` prefix → strip → parse :class:`BackendEvent` → emit on
    ``events`` queue.
  - non-prefix → emit on ``logs`` queue (diagnostic log stream, bounded in
    Redis by the log writer).
- Encode client operations as bare-JSON :class:`FrontendRequest` lines written
  to stdin (``submit_line`` / ``interrupt`` / ``permission_response`` /
  ``question_response`` / ``shutdown``).

Robustness: malformed JSON or unknown ``type`` never crashes the adapter — the
line is logged and skipped (spec: "Adapter对畸形行不崩").
"""

from __future__ import annotations

import asyncio
import json
import logging

from app.session.process import OhBackendProcess
from app.session.protocol import OHJSON_PREFIX, BackendEvent, FrontendRequest

log = logging.getLogger(__name__)


class ProtocolAdapter:
    """Bridges one subprocess's line stream to typed event/log queues."""

    def __init__(self, process: OhBackendProcess) -> None:
        self._process = process
        self.events: asyncio.Queue[BackendEvent | None] = asyncio.Queue()
        self.logs: asyncio.Queue[str | None] = asyncio.Queue()
        self._reader: asyncio.Task[None] | None = None

    async def start(self) -> None:
        self._reader = asyncio.create_task(self._read_loop())

    async def _read_loop(self) -> None:
        try:
            while True:
                line = await self._process.stdout_lines.get()
                if line is None:
                    # EOF — signal both queues so consumers can react.
                    await self.events.put(None)
                    await self.logs.put(None)
                    return
                await self._handle_line(line)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning("adapter read loop error: %s", exc)
            await self.events.put(None)
            await self.logs.put(None)

    async def _handle_line(self, line: str) -> None:
        if line.startswith(OHJSON_PREFIX):
            payload = line[len(OHJSON_PREFIX):]
            try:
                data = json.loads(payload)
            except json.JSONDecodeError:
                log.warning("malformed OHJSON line, routing to logs: %r", line[:200])
                await self.logs.put(line)
                return
            try:
                event = BackendEvent.model_validate(data)
            except Exception as exc:
                # Unknown/extra fields are allowed; only a missing ``type`` would
                # fail. Fall back to a raw passthrough event.
                log.warning("BackendEvent validation failed (%s); passthrough", exc)
                event = BackendEvent(type=str(data.get("type", "unknown")), **{
                    k: v for k, v in data.items() if k != "type"
                })
            await self.events.put(event)
        else:
            await self.logs.put(line)

    # --- Client → subprocess (bare-JSON writes) -------------------------------

    async def _write(self, request: FrontendRequest) -> None:
        await self._process.write_line(request.model_dump_json(exclude_none=True))

    async def submit_line(self, line: str) -> None:
        await self._write(FrontendRequest(type="submit_line", line=line))

    async def interrupt(self) -> None:
        await self._write(FrontendRequest(type="interrupt"))

    async def shutdown(self) -> None:
        await self._write(FrontendRequest(type="shutdown"))

    async def respond_permission(self, request_id: str, allowed: bool, reply: str | None = None) -> None:
        await self._write(
            FrontendRequest(
                type="permission_response",
                request_id=request_id,
                allowed=allowed,
                permission_reply=reply,
            )
        )

    async def respond_question(self, request_id: str, answer: str) -> None:
        await self._write(
            FrontendRequest(type="question_response", request_id=request_id, answer=answer)
        )

    async def stop(self) -> None:
        if self._reader is not None:
            self._reader.cancel()
            try:
                await self._reader
            except (asyncio.CancelledError, Exception):
                pass
