"""In-process session supervisor.

Owns the registry of live sessions and drives the full lifecycle:
creation → LIVE ⇄ IDLE → COLD → (--resume) → LIVE, with single-writer turn
serialization, crash isolation, turn timeout, idle eviction, and per-turn
artifact registration.

This is the heart of the protocol bridge (spec D1–D8). Each :class:`LiveSession`
wraps one :class:`OhBackendProcess` + :class:`ProtocolAdapter` plus turn/state
bookkeeping.
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, AsyncGenerator

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import Conversation, ConversationTurn, SessionStatus, TurnArtifact, TurnStatus
from app.observability.metrics import SESSIONS_LIVE, track_turn
from app.session import logs as log_stream
from app.session import registry as route_registry
from app.session.adapter import ProtocolAdapter
from app.session.artifacts import locate_output_file, probe_mp4
from app.session.lifecycle import IllegalTransition, SessionState, is_live_process, transition
from app.session.process import OhBackendProcess, derive_oh_session_id
from app.storage.s3 import storage_for_kind

log = logging.getLogger(__name__)


class SessionNotFound(KeyError):
    pass


class SessionBusy(Exception):
    """A turn is already in progress (single-writer)."""


class TurnCapExceeded(Exception):
    pass


class BackendCrashed(Exception):
    """Signals the subprocess exited mid-turn (handled distinctly from errors)."""


class LiveSession:
    """One live (or cold) session's in-memory state."""

    def __init__(
        self,
        *,
        sid: uuid.UUID,
        tenant_id: str,
        cwd: Path,
        oh_session_id: str,
        permission_policy: str,
        extra_args: list[str],
        epoch: int,
    ) -> None:
        self.sid = sid
        self.tenant_id = tenant_id
        self.cwd = cwd
        self.oh_session_id = oh_session_id
        self.permission_policy = permission_policy
        self.extra_args = extra_args
        self.epoch = epoch
        self.state: SessionState = SessionState.CREATING

        self.process: OhBackendProcess | None = None
        self.adapter: ProtocolAdapter | None = None

        # Single-writer: at most one turn at a time.
        self._busy = False
        self._turn_index: int = 0
        self._assistant_buf: list[str] = []
        self._turn_stdout: list[str] = []  # non-prefixed lines for artifact location

        # Interactive approvals: request_id -> future awaiting client reply.
        self._pending_approvals: dict[str, asyncio.Future[dict[str, Any]]] = {}

        # WS connection tracking (for idle eviction).
        self.ws_connections: set[Any] = set()
        self._idle_task: asyncio.Task[None] | None = None
        self._heartbeat_task: asyncio.Task[None] | None = None
        self._log_task: asyncio.Task[None] | None = None

    @property
    def busy(self) -> bool:
        return self._busy

    def is_live(self) -> bool:
        return self.process is not None and is_live_process(self.state)


class SessionSupervisor:
    """Process-local registry + lifecycle driver."""

    def __init__(self) -> None:
        self._sessions: dict[uuid.UUID, LiveSession] = {}

    # --- registry queries ---------------------------------------------------

    def get(self, sid: uuid.UUID | str) -> LiveSession:
        sid = uuid.UUID(str(sid)) if not isinstance(sid, uuid.UUID) else sid
        if sid not in self._sessions:
            raise SessionNotFound(sid)
        return self._sessions[sid]

    def has(self, sid: uuid.UUID | str) -> bool:
        try:
            uuid.UUID(str(sid)) if not isinstance(sid, uuid.UUID) else sid
        except (ValueError, AttributeError):
            return False
        key = uuid.UUID(str(sid)) if not isinstance(sid, uuid.UUID) else sid
        return key in self._sessions

    def live_count(self) -> int:
        return sum(1 for s in self._sessions.values() if s.is_live())

    @property
    def capacity(self) -> int:
        return settings.max_live_sessions

    # --- creation -----------------------------------------------------------

    async def create_session(
        self,
        *,
        db: AsyncSession,
        tenant_id: str,
        permission_policy: str | None = None,
        extra_args: list[str] | None = None,
        actor_key_id: str | None = None,
    ) -> Conversation:
        """Create a session: DB row + persistent workspace + spawn subprocess.

        ``oh_session_id`` is derived from ``cwd`` *before* spawning (spec D8) so
        it is available for ``--resume`` even if the first turn never reaches a
        ``state_snapshot`` event.
        """
        policy = permission_policy or settings.permission_policy
        sid = uuid.uuid4()
        cwd = Path(settings.workspace_root) / str(sid)
        cwd.mkdir(parents=True, exist_ok=True)
        oh_session_id = derive_oh_session_id(cwd)
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=settings.session_ttl_seconds)

        conv = Conversation(
            id=sid,
            tenant_id=tenant_id,
            actor_key_id=actor_key_id,
            oh_session_id=oh_session_id,
            workspace_path=str(cwd),
            status=SessionStatus.CREATING,
            permission_policy=policy,
            extra_oh_args=json.dumps(extra_args or []),
            expires_at=expires_at,
        )
        db.add(conv)
        await db.commit()
        await db.refresh(conv)

        epoch = await route_registry.next_epoch(str(sid))
        live = LiveSession(
            sid=sid,
            tenant_id=tenant_id,
            cwd=cwd,
            oh_session_id=oh_session_id,
            permission_policy=policy,
            extra_args=extra_args or [],
            epoch=epoch,
        )
        self._sessions[sid] = live

        await self._spawn(live, resume=False)
        # Reflect the now-live state in the DB row.
        conv.status = SessionStatus.LIVE
        await db.commit()
        await db.refresh(conv)
        return conv

    async def create_session_from_existing(
        self,
        conv: Conversation,
        tenant_id: str,
        *,
        db: AsyncSession,
    ) -> None:
        """Re-arm a live session for an existing DB row (reconnect to a non-COLD,
        non-live session whose process was lost on a gateway restart)."""
        from pathlib import Path

        cwd = Path(conv.workspace_path) if conv.workspace_path else Path(settings.workspace_root) / str(conv.id)
        cwd.mkdir(parents=True, exist_ok=True)
        oh_session_id = conv.oh_session_id or derive_oh_session_id(cwd)
        epoch = await route_registry.next_epoch(str(conv.id))
        live = LiveSession(
            sid=conv.id,
            tenant_id=tenant_id,
            cwd=cwd,
            oh_session_id=oh_session_id,
            permission_policy=conv.permission_policy,
            extra_args=json.loads(conv.extra_oh_args or "[]"),
            epoch=epoch,
        )
        live._turn_index = conv.turn_count
        live.state = SessionState.CREATING
        self._sessions[conv.id] = live
        await self._spawn(live, resume=False)
        conv.status = SessionStatus.LIVE
        await db.commit()

    async def _spawn(self, live: LiveSession, *, resume: bool) -> None:
        """Spawn (or rehydrate) the ``oh --backend-only`` subprocess."""
        await self._ensure_capacity()

        oh_sid = live.oh_session_id if resume else None
        proc = OhBackendProcess(
            cwd=live.cwd,
            permission_mode=live.permission_policy,
            oh_session_id=oh_sid,
            extra_args=live.extra_args,
        )
        await proc.start()
        adapter = ProtocolAdapter(proc)
        await adapter.start()

        live.process = proc
        live.adapter = adapter
        live.state = transition(live.state, SessionState.LIVE) if resume else SessionState.LIVE
        SESSIONS_LIVE.inc()

        # Route registration + heartbeat for multi-node affinity (Phase 3).
        await route_registry.register_route(str(live.sid), proc.pid or 0, live.epoch)
        live._heartbeat_task = asyncio.create_task(self._heartbeat(live))
        # Drain diagnostic logs to the bounded Redis stream.
        live._log_task = asyncio.create_task(self._drain_logs(live))
        # Consume startup events (ready/state_snapshot/tasks_snapshot) so they
        # do not leak into the first turn's event stream.
        await self._await_ready(live)

    async def _await_ready(self, live: LiveSession, timeout: float = 15.0) -> None:
        """Drain startup events until ``ready`` is seen (or timeout).

        The native backend emits ``ready`` + ``state_snapshot`` +
        ``tasks_snapshot`` at startup; if left in the queue the first turn
        would re-emit them as frames. We consume them here so the first turn
        only sees its own events.
        """
        assert live.adapter is not None
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        startup_types = {"ready", "state_snapshot", "tasks_snapshot", "compact_progress"}
        while True:
            remaining = max(0.1, deadline - loop.time())
            try:
                event = await asyncio.wait_for(live.adapter.events.get(), timeout=remaining)
            except asyncio.TimeoutError:
                log.warning("session %s: no ready event within timeout", live.sid)
                return
            if event is None:
                return  # process gone
            if event.type == "ready":
                # Non-blocking drain of the startup burst that follows ``ready``
                # (state_snapshot, tasks_snapshot…). Stop at the first non-startup
                # event or an empty queue so we never block on turn events.
                while True:
                    try:
                        extra = live.adapter.events.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                    if extra is None:
                        break
                    if extra.type not in startup_types:
                        # A real turn event arrived during startup drain — requeue
                        # it (at the tail) rather than dropping it.
                        await live.adapter.events.put(extra)
                        break
                return
            # Before ready: discard other startup events too.

    async def _ensure_capacity(self) -> None:
        """Evict the longest-idle session to COLD if at capacity (spec 4.4)."""
        if self.live_count() < settings.max_live_sessions:
            return
        # Pick the IDLE session idle longest (or any IDLE, then LIVE w/ no ws).
        candidates = [
            s for s in self._sessions.values()
            if s.is_live() and not s.ws_connections and not s.busy
        ]
        if not candidates:
            raise RuntimeError("capacity full and no idle session to evict")
        target = candidates[0]
        await self._evict(target)

    async def _evict(self, live: LiveSession) -> None:
        """Gracefully shut down a session to COLD (snapshot preserved)."""
        if live.state not in (SessionState.LIVE, SessionState.IDLE):
            return
        log.info("evicting session %s to COLD", live.sid)
        await self._teardown_process(live, graceful=True)
        live.state = transition(live.state, SessionState.COLD)
        SESSIONS_LIVE.dec()

    async def rehydrate(self, live: LiveSession, *, db: AsyncSession) -> None:
        """Rehydrate a COLD session via ``oh --resume <oh_session_id>``."""
        if live.state != SessionState.COLD:
            return
        # Single-writer lock prevents two nodes resuming the same cwd (spec 4.3).
        holder = f"{settings.node_id or 'local'}:{live.epoch}"
        acquired = await route_registry.acquire_lock(str(live.sid), holder)
        if not acquired:
            raise RuntimeError("session is being rehydrated by another node")
        try:
            await self._spawn(live, resume=True)
        finally:
            await route_registry.release_lock(str(live.sid), holder)

    # --- turn execution -----------------------------------------------------

    async def stream_turn(
        self,
        sid: uuid.UUID | str,
        text: str,
        *,
        db: AsyncSession,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """Run one turn: submit_line → stream events → turn_complete.

        Enforces single-writer (yields a ``busy`` frame if already running) and
        the per-turn timeout (kills the process group on expiry). Finalization
        (persist turn + register artifacts) happens BEFORE the terminal
        ``turn_complete``/``turn_error`` frame is yielded, so a consumer that
        ``break``s after the terminal frame still gets a persisted turn.
        """
        live = self.get(sid)
        if live.busy:
            yield {"type": "busy"}
            return
        if live._turn_index >= settings.max_turns_per_session:
            yield {"type": "turn_error", "message": "max_turns_per_session exceeded"}
            return

        live._busy = True
        live._assistant_buf.clear()
        live._turn_stdout.clear()
        turn_index = live._turn_index

        # Persist the turn row as RUNNING.
        turn = ConversationTurn(
            conversation_id=live.sid,
            turn_index=turn_index,
            prompt=text,
            status=TurnStatus.RUNNING,
        )
        db.add(turn)
        conv = await db.get(Conversation, live.sid)
        if conv is not None:
            conv.turn_count = turn_index + 1
            conv.last_active_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(turn)

        loop = asyncio.get_running_loop()
        deadline = loop.time() + settings.turn_timeout_seconds
        try:
            with track_turn():
                assert live.adapter is not None
                await live.adapter.submit_line(text)
                # Inline event pump so finalization precedes the terminal yield.
                while True:
                    timeout = max(0.1, deadline - loop.time())
                    try:
                        event = await asyncio.wait_for(
                            live.adapter.events.get(), timeout=timeout
                        )
                    except asyncio.TimeoutError:
                        await live.process.kill_group() if live.process else None
                        await self._finalize_turn(live, turn, db, TurnStatus.TIMED_OUT, "turn timed out")
                        yield {"type": "turn_error", "message": "turn timed out"}
                        return
                    if event is None:
                        # stdout EOF — crash -> FAILED + COLD.
                        await self._handle_crash(live)
                        await self._finalize_turn(live, turn, db, TurnStatus.FAILED, "backend process exited unexpectedly")
                        yield {"type": "turn_error", "message": "backend process exited unexpectedly"}
                        return
                    if event.type == "modal_request" and event.modal:
                        await self._await_approval(live, event)
                    if event.type == "line_complete":
                        # Finalize BEFORE yielding the terminal frame.
                        await self._finalize_turn(live, turn, db, TurnStatus.COMPLETED, None)
                        yield {"type": "turn_complete", "turn_index": turn_index}
                        return
                    frame = self._map_event(live, event, turn_index)
                    if frame is not None:
                        yield frame
        except asyncio.CancelledError:
            await self._finalize_turn(live, turn, db, TurnStatus.INTERRUPTED, None)
            yield {"type": "turn_complete", "turn_index": turn_index, "interrupted": True}
            raise
        except Exception as exc:
            log.exception("turn failed: %s", exc)
            await self._finalize_turn(live, turn, db, TurnStatus.FAILED, str(exc))
            yield {"type": "turn_error", "message": str(exc)}
        finally:
            live._busy = False

    def _map_event(self, live: LiveSession, event, turn_index: int) -> dict[str, Any] | None:
        """Map a BackendEvent to a WS frame dict (spec D2 event mapping)."""
        t = event.type
        if t == "assistant_delta":
            live._assistant_buf.append(event.message or "")
            return {"type": "delta", "text": event.message or "", "turn_index": turn_index}
        if t == "assistant_complete":
            live._assistant_buf.append(event.message or "")
            return {"type": "delta", "text": event.message or "", "turn_index": turn_index, "final": True}
        if t == "tool_started":
            return {"type": "tool_start", "tool_name": event.tool_name, "tool_input": event.tool_input, "turn_index": turn_index}
        if t == "tool_completed":
            return {"type": "tool_end", "tool_name": event.tool_name, "output": event.output, "is_error": event.is_error, "turn_index": turn_index}
        if t == "todo_update":
            return {"type": "todo", "todo_markdown": event.todo_markdown, "turn_index": turn_index}
        if t == "line_complete":
            return {"type": "turn_complete", "turn_index": turn_index}
        if t == "modal_request":
            modal = event.modal or {}
            return {
                "type": "approval_request",
                "request_id": modal.get("request_id"),
                "modal": modal,
                "turn_index": turn_index,
            }
        if t == "error":
            return {"type": "turn_error", "message": event.message, "turn_index": turn_index}
        if t == "ready":
            return {"type": "session_ready"}
        # Unknown event: transparent passthrough (spec robustness).
        return {"type": "event", "event": event.model_dump(exclude_none=True), "turn_index": turn_index}

    async def _await_approval(self, live: LiveSession, event) -> None:
        """Register a pending approval; the client replies via respond_approval."""
        modal = event.modal or {}
        rid = modal.get("request_id")
        if not rid:
            return
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict[str, Any]] = loop.create_future()
        live._pending_approvals[rid] = fut
        # Auto-deny after the approval timeout (spec: unanswered -> denial).
        async def _timeout():
            try:
                await asyncio.wait_for(asyncio.shield(fut), timeout=settings.approval_timeout_seconds)
            except asyncio.TimeoutError:
                if not fut.done():
                    fut.set_result({"allowed": False, "reply": "reject", "answer": ""})
        asyncio.create_task(_timeout())

    async def respond_approval(
        self, sid: uuid.UUID | str, request_id: str, *, allowed: bool, reply: str | None = None, answer: str | None = None
    ) -> None:
        live = self.get(sid)
        fut = live._pending_approvals.pop(request_id, None)
        assert live.adapter is not None
        modal_kind = None
        if fut is not None and not fut.done():
            fut.set_result({"allowed": allowed, "reply": reply, "answer": answer})
        # Forward to the subprocess.
        if answer is not None:
            await live.adapter.respond_question(request_id, answer)
        else:
            await live.adapter.respond_permission(request_id, allowed, reply)

    async def interrupt(self, sid: uuid.UUID | str) -> None:
        """Interrupt the active turn (spec: interrupt cancels the active turn)."""
        live = self.get(sid)
        assert live.adapter is not None
        await live.adapter.interrupt()

    async def _handle_crash(self, live: LiveSession) -> None:
        """Unexpected stdout EOF: fail current turn, transition to COLD."""
        log.warning("session %s backend crashed -> COLD", live.sid)
        if live.state in (SessionState.LIVE, SessionState.IDLE):
            live.state = SessionState.FAILED
            try:
                live.state = transition(live.state, SessionState.COLD)
            except IllegalTransition:
                live.state = SessionState.COLD
            SESSIONS_LIVE.dec()
        await self._cancel_helpers(live)

    async def _finalize_turn(
        self,
        live: LiveSession,
        turn: ConversationTurn,
        db: AsyncSession,
        status: TurnStatus,
        error: str | None,
    ) -> None:
        """Persist the turn row + register artifacts (best-effort).

        Wrapped so a persistence failure never prevents the terminal frame from
        being delivered to the client — the turn record is best-effort.
        """
        try:
            turn.status = status
            turn.error_message = error
            turn.assistant_text = "".join(live._assistant_buf) or None
            turn.finished_at = datetime.now(timezone.utc)
            if status == TurnStatus.COMPLETED:
                live._turn_index += 1
            db.add(turn)
            if status in (TurnStatus.COMPLETED, TurnStatus.INTERRUPTED):
                await self._register_artifacts(live, turn, db)
            await db.commit()
        except Exception as exc:
            log.warning("turn finalize failed (sid=%s): %s", live.sid, exc)
            try:
                await db.rollback()
            except Exception:
                pass

    async def _register_artifacts(
        self, live: LiveSession, turn: ConversationTurn, db: AsyncSession
    ) -> None:
        """Locate + probe + persist artifacts produced this turn (spec 3.5)."""
        stdout_blob = "\n".join(live._turn_stdout)
        try:
            path = locate_output_file(stdout_blob, live.cwd)
        except Exception:
            return
        try:
            meta = probe_mp4(path)
        except Exception:
            meta = None
        storage = storage_for_kind(settings.storage_kind)
        key = f"{live.sid}/{turn.turn_index}/{path.name}"
        try:
            storage.save(key, path)
        except Exception as exc:
            log.warning("artifact save failed: %s", exc)
            return
        art = TurnArtifact(
            conversation_id=live.sid,
            turn_index=turn.turn_index,
            storage_kind=settings.storage_kind,
            storage_key=key,
            filename=path.name,
            file_size_bytes=meta.file_size_bytes if meta else None,
            duration_seconds=meta.duration_seconds if meta else None,
            resolution=meta.resolution if meta else None,
            fps=meta.fps if meta else None,
        )
        db.add(art)

    async def _drain_logs(self, live: LiveSession) -> None:
        """Forward non-protocol stdout lines to the bounded Redis log stream."""
        assert live.adapter is not None
        try:
            while True:
                line = await live.adapter.logs.get()
                if line is None:
                    return
                live._turn_stdout.append(line)
                await log_stream.append_log(str(live.sid), line)
        except asyncio.CancelledError:
            raise
        except Exception:
            pass

    async def _heartbeat(self, live: LiveSession) -> None:
        """Refresh the route TTL while the session is live (Phase 3)."""
        try:
            while live.is_live():
                await asyncio.sleep(settings.route_ttl_seconds // 2)
                if live.process is not None:
                    await route_registry.heartbeat_route(
                        str(live.sid), live.process.pid or 0, live.epoch
                    )
        except asyncio.CancelledError:
            raise
        except Exception:
            pass

    # --- connection / idle tracking -----------------------------------------

    def attach_ws(self, sid: uuid.UUID | str, ws: Any) -> LiveSession:
        live = self.get(sid)
        live.ws_connections.add(ws)
        self._cancel_idle_timer(live)
        if live.state == SessionState.IDLE:
            live.state = transition(SessionState.IDLE, SessionState.LIVE)
        return live

    def detach_ws(self, sid: uuid.UUID | str, ws: Any) -> None:
        try:
            live = self.get(sid)
        except SessionNotFound:
            return
        live.ws_connections.discard(ws)
        if not live.ws_connections and live.state == SessionState.LIVE:
            live.state = transition(SessionState.LIVE, SessionState.IDLE)
            self._start_idle_timer(live)

    def _start_idle_timer(self, live: LiveSession) -> None:
        self._cancel_idle_timer(live)
        live._idle_task = asyncio.create_task(self._idle_evict(live))

    def _cancel_idle_timer(self, live: LiveSession) -> None:
        if live._idle_task is not None:
            live._idle_task.cancel()
            live._idle_task = None

    async def _idle_evict(self, live: LiveSession) -> None:
        try:
            await asyncio.sleep(settings.idle_grace_seconds)
            if not live.ws_connections and live.state == SessionState.IDLE:
                await self._evict(live)
        except asyncio.CancelledError:
            pass

    # --- teardown / close ---------------------------------------------------

    async def _teardown_process(self, live: LiveSession, *, graceful: bool) -> None:
        if live.adapter is not None:
            try:
                if graceful:
                    await live.adapter.shutdown()
            except Exception:
                pass
        if live.process is not None:
            if graceful:
                try:
                    await live.process.shutdown(grace=10.0)
                except Exception:
                    await live.process.kill_group()
            else:
                await live.process.kill_group()
        await self._cancel_helpers(live)

    async def _cancel_helpers(self, live: LiveSession) -> None:
        for task_attr in ("_idle_task", "_heartbeat_task", "_log_task"):
            task = getattr(live, task_attr, None)
            if task is not None:
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass
                setattr(live, task_attr, None)
        if live.adapter is not None:
            await live.adapter.stop()
            live.adapter = None
        live.process = None

    async def close(
        self,
        sid: uuid.UUID | str,
        *,
        db: AsyncSession,
    ) -> None:
        """DELETE: kill process, clean workspace/snapshot/artifacts/redis, CLOSED.

        Preserves completed turns' terminal records (spec: DELETE preserves
        completed turn history).
        """
        live = self.get(sid)
        await self._teardown_process(live, graceful=False)
        if live.state in (SessionState.LIVE, SessionState.IDLE):
            SESSIONS_LIVE.dec()
        live.state = SessionState.CLOSED
        # Clean workspace + native snapshot dir.
        if live.cwd.exists():
            shutil.rmtree(live.cwd, ignore_errors=True)
        await route_registry.clear_route(str(sid))
        await route_registry.release_lock(str(sid), f"{settings.node_id or 'local'}:{live.epoch}")
        await log_stream.clear_logs(str(sid))
        # Delete artifacts' files (rows preserved for audit via ondelete CASCADE
        # — but spec wants resources cleaned; we delete storage objects + rows
        # for artifacts, keep turn rows).
        arts = (await db.execute(
            select(TurnArtifact).where(TurnArtifact.conversation_id == live.sid)
        )).scalars().all()
        storage = storage_for_kind(settings.storage_kind)
        for art in arts:
            try:
                storage.delete(art.storage_key)
            except Exception:
                pass
            await db.delete(art)
        conv = await db.get(Conversation, live.sid)
        if conv is not None:
            conv.status = SessionStatus.CLOSED
            conv.workspace_path = None
        await db.commit()
        self._sessions.pop(live.sid, None)

    async def shutdown_all(self) -> None:
        """Graceful gateway shutdown: tear down every live session."""
        for sid in list(self._sessions.keys()):
            try:
                live = self._sessions[sid]
                await self._teardown_process(live, graceful=True)
                SESSIONS_LIVE.dec()
            except Exception:
                pass
        self._sessions.clear()

    async def orphan_scan(self) -> int:
        """Startup scan: reclaim workspace dirs with no live route (spec 4.5).

        Returns the count of orphaned workspaces cleaned. Residual snapshots
        from a crashed/restarted node are safe to leave (they rehydrate on the
        next connect); only workspaces whose session row is CLOSED/absent are
        removed to bound disk growth.
        """
        cleaned = 0
        root = Path(settings.workspace_root)
        if not root.exists():
            return 0
        for entry in root.iterdir():
            if not entry.is_dir():
                continue
            try:
                sid = uuid.UUID(entry.name)
            except ValueError:
                continue
            route = await route_registry.get_route(str(sid))
            if route is not None:
                continue  # owned somewhere — leave it
            # No route: check DB status. Remove only if CLOSED/EXPIRED/absent.
            from app import db as _db

            async with _db.async_session() as db:
                conv = await db.get(Conversation, sid)
                if conv is None or conv.status in (SessionStatus.CLOSED, SessionStatus.EXPIRED):
                    shutil.rmtree(entry, ignore_errors=True)
                    cleaned += 1
                    if conv is not None:
                        conv.workspace_path = None
                        await db.commit()
        if cleaned:
            log.info("orphan scan cleaned %d stale workspace(s)", cleaned)
        return cleaned


# Module-level singleton (the gateway is single-process per node; multi-node
# affinity is handled by the Redis routing table + reverse proxy in Phase 3).
supervisor = SessionSupervisor()


def get_supervisor() -> SessionSupervisor:
    return supervisor
