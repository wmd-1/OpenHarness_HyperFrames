"""WebSocket real-time turn streaming (spec: "A WebSocket turn MUST stream").

``GET /v1/sessions/{sid}/ws`` accepts client messages:
- ``{"op":"submit","text":"..."}`` → ``submit_line`` → streams delta/tool_*/turn_complete.
- ``{"op":"interrupt"}`` → native ``interrupt``.
- ``{"op":"approval","request_id":"...","allowed":true,"reply":"once","answer":"..."}``.

On connect: rehydrate COLD sessions via ``--resume``; replay completed turns
after ``last_turn_index`` (spec: reconnect MUST replay missed turn completions).
Auth: the API key is checked *before* ``accept()`` (spec: WS handshake enforces
the key before accept).
"""

from __future__ import annotations

import asyncio
import json
import uuid
from secrets import compare_digest

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query
from sqlalchemy import select

from app.config import settings
from app import db
from app.models import Conversation, ConversationTurn, SessionStatus, TurnStatus
from app.ratelimit import _client_ip, check_rate_limit
from app.session.supervisor import CapacityFullError, SessionNotFound, get_supervisor

router = APIRouter(tags=["ws"])


def _ws_authed(websocket: WebSocket) -> tuple[bool, str, str | None]:
    """Resolve auth before accept. Returns (ok, tenant_id, actor_key_id).

    When auth is disabled (no api_key / require_auth), the tenant is "default".
    The key may arrive as a header or a ``?api_key=`` query param (browsers
    cannot set headers on WS handshakes).
    """
    if not (settings.require_auth or settings.api_key):
        return True, "default", None
    provided = (
        websocket.headers.get("X-API-Key")
        or websocket.query_params.get("api_key")
        or ""
    )
    expected = settings.api_key.get_secret_value() if settings.api_key else ""
    if not compare_digest(provided, expected):
        return False, "", None
    return True, "default", None


async def _replay_missed_turns(
    sid: uuid.UUID, last_turn_index: int, websocket: WebSocket
) -> None:
    """Replay turn_complete records completed after ``last_turn_index``."""
    async with db.async_session() as session:
        turns = (await session.execute(
            select(ConversationTurn)
            .where(
                ConversationTurn.conversation_id == sid,
                ConversationTurn.turn_index > last_turn_index,
                ConversationTurn.status == TurnStatus.COMPLETED,
            )
            .order_by(ConversationTurn.turn_index.asc())
        )).scalars().all()
    for turn in turns:
        await websocket.send_json({
            "type": "turn_complete",
            "turn_index": turn.turn_index,
            "replayed": True,
            "assistant_text": turn.assistant_text,
        })


@router.websocket("/v1/sessions/{sid}/ws")
async def session_ws(
    websocket: WebSocket,
    sid: str,
    last_turn_index: int | None = Query(default=None),
):
    ok, tenant_id, actor = _ws_authed(websocket)
    if not ok:
        await websocket.close(code=4401, reason="Invalid API key")
        return

    # Rate limit WS connection establishment (same IP token bucket as POST).
    if not check_rate_limit(_client_ip(websocket)):
        await websocket.close(code=4429, reason="Rate limit exceeded")
        return

    try:
        sid_uuid = uuid.UUID(sid)
    except ValueError:
        await websocket.close(code=4400, reason="Invalid session id")
        return

    # Multi-node affinity (spec D4): if another node owns this session's live
    # process, transparently reverse-proxy the WS there (no client redirect).
    from app.session.proxy import proxy_ws

    if await proxy_ws(websocket, sid, websocket.url.path, websocket.url.query):
        return  # proxied to the owning node — nothing more to do here.

    # Load + tenant-check the session before accepting.
    async with db.async_session() as session:
        conv = await session.get(Conversation, sid_uuid)
    if conv is None or conv.tenant_id != tenant_id:
        await websocket.close(code=4404, reason="Session not found")
        return
    if conv.status in (SessionStatus.CLOSED, SessionStatus.EXPIRED):
        await websocket.close(code=4403, reason="Session is closed")
        return

    await websocket.accept()
    sup = get_supervisor()

    # Rehydrate a COLD session on connect (spec: reconnect to COLD rehydrates).
    live = None
    try:
        live = sup.get(sid_uuid)
    except SessionNotFound:
        async with db.async_session() as session:
            conv2 = await session.get(Conversation, sid_uuid)
            if conv2 is not None and conv2.status == SessionStatus.COLD:
                from app.session.supervisor import LiveSession
                from app.session.process import derive_oh_session_id
                from pathlib import Path
                from app.session import registry as route_registry

                cwd = Path(conv2.workspace_path) if conv2.workspace_path else Path(settings.workspace_root) / sid
                epoch = await route_registry.next_epoch(sid)
                live = LiveSession(
                    sid=sid_uuid,
                    tenant_id=tenant_id,
                    cwd=cwd,
                    oh_session_id=conv2.oh_session_id or derive_oh_session_id(cwd),
                    permission_policy=conv2.permission_policy,
                    extra_args=json.loads(conv2.extra_oh_args or "[]"),
                    epoch=epoch,
                )
                live.state = SessionStatus.COLD
                sup._sessions[sid_uuid] = live
                try:
                    await sup.rehydrate(live, db=session)
                except CapacityFullError:
                    await websocket.close(code=4500, reason="session unavailable")
                    return
                conv2.status = SessionStatus.LIVE
                await session.commit()

    if live is None:
        async with db.async_session() as session:
            conv3 = await session.get(Conversation, sid_uuid)
            if conv3 is not None:
                try:
                    await sup.create_session_from_existing(conv3, tenant_id, db=session)
                except CapacityFullError:
                    await websocket.close(code=4500, reason="session unavailable")
                    return
                live = sup.get(sid_uuid)

    if live is None:
        await websocket.send_json({"type": "turn_error", "message": "session unavailable"})
        await websocket.close(code=4500, reason="session unavailable")
        return

    sup.attach_ws(sid_uuid, websocket)

    # session readiness precedes the first turn (spec: "session readiness
    # precedes the first turn"); then replay any turns completed after the
    # client's last_turn_index, then resume live streaming.
    await websocket.send_json({"type": "session_ready", "session_id": str(sid_uuid)})
    if last_turn_index is not None:
        await _replay_missed_turns(sid_uuid, last_turn_index, websocket)

    # Concurrent reader: messages are read in a background task so a ``submit``
    # arriving while a turn is streaming can be rejected with a ``busy`` frame
    # immediately (single-writer, spec scenario: concurrent submit is rejected).
    incoming: asyncio.Queue = asyncio.Queue()
    send_lock = asyncio.Lock()
    turn_task: asyncio.Task | None = None

    async def _safe_send(payload: dict) -> None:
        async with send_lock:
            await websocket.send_json(payload)

    async def _run_turn(text: str) -> None:
        async with db.async_session() as session:
            async for frame in sup.stream_turn(sid_uuid, text, db=session):
                await _safe_send(frame)

    async def _reader():
        try:
            while True:
                raw = await websocket.receive_text()
                await incoming.put(raw)
        except WebSocketDisconnect:
            await incoming.put(None)
        except Exception:
            await incoming.put(None)

    reader = asyncio.create_task(_reader())
    try:
        while True:
            raw = await incoming.get()
            if raw is None:
                break
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await _safe_send({"type": "error", "message": "invalid JSON"})
                continue
            op = msg.get("op")
            if op == "submit":
                text = msg.get("text", "")
                if not text:
                    continue
                if turn_task is not None and not turn_task.done():
                    # Single-writer: reject concurrent submit with a busy frame.
                    await _safe_send({"type": "busy"})
                    continue
                turn_task = asyncio.create_task(_run_turn(text))
            elif op == "interrupt":
                await sup.interrupt(sid_uuid)
            elif op == "approval":
                await sup.respond_approval(
                    sid_uuid,
                    msg.get("request_id", ""),
                    allowed=bool(msg.get("allowed", True)),
                    reply=msg.get("reply"),
                    answer=msg.get("answer"),
                )
            elif op == "ping":
                await _safe_send({"type": "pong"})
            else:
                await _safe_send({"type": "error", "message": f"unknown op: {op}"})
    except WebSocketDisconnect:
        pass
    finally:
        reader.cancel()
        if turn_task is not None and not turn_task.done():
            turn_task.cancel()
        sup.detach_ws(sid_uuid, websocket)
