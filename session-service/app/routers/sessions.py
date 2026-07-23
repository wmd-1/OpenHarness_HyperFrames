"""/v1/sessions REST surface (non-WS endpoints).

- ``POST /v1/sessions`` — create a session (rate-limited, quota-checked).
- ``GET /v1/sessions/{sid}`` — session details.
- ``DELETE /v1/sessions/{sid}`` — kill + clean + CLOSED (preserves turn records).
- ``POST /v1/sessions/{sid}/turns`` — non-WS turn fallback (409 if busy).
- ``GET /v1/sessions/{sid}/turns/{idx}/artifact`` — artifact download (Range).
"""

from __future__ import annotations

import json
import uuid
from typing import AsyncGenerator

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.deps import actor_from_request, get_db, tenant_from_request
from app.models import Conversation, SessionStatus, TurnArtifact, TurnStatus
from app.ratelimit import _client_ip, check_rate_limit
from app.schemas import (
    ArtifactResponse,
    DeleteResponse,
    SessionCreateRequest,
    SessionResponse,
    TurnResponse,
    TurnSubmitRequest,
)
from app.session.supervisor import SessionBusy, SessionNotFound, get_supervisor
from app.storage.s3 import storage_for_kind

router = APIRouter(prefix="/v1/sessions", tags=["sessions"])


def _to_response(conv: Conversation, request: Request) -> SessionResponse:
    ws_url = None
    if conv.status not in (SessionStatus.CLOSED, SessionStatus.EXPIRED):
        ws_url = f"/v1/sessions/{conv.id}/ws"
    return SessionResponse(
        session_id=conv.id,
        status=conv.status,
        permission_policy=conv.permission_policy,
        turn_count=conv.turn_count,
        oh_session_id=conv.oh_session_id,
        created_at=conv.created_at,
        last_active_at=conv.last_active_at,
        ws_url=ws_url,
    )


async def _load_owned(sid: uuid.UUID, tenant_id: str, db: AsyncSession) -> Conversation:
    """Load a session, enforcing tenant isolation (404 if not owned)."""
    conv = await db.get(Conversation, sid)
    if conv is None or conv.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="Session not found")
    return conv


@router.post("", response_model=SessionResponse, status_code=201)
async def create_session(
    body: SessionCreateRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> SessionResponse:
    # Rate limit (fail-open).
    if not check_rate_limit(_client_ip(request)):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")

    tenant_id = tenant_from_request(request)
    actor = actor_from_request(request)

    # Per-tenant concurrent quota.
    sup = get_supervisor()
    live_for_tenant = sum(
        1 for s in sup._sessions.values() if s.tenant_id == tenant_id and s.is_live()
    )
    if live_for_tenant >= settings.tenant_max_concurrent:
        raise HTTPException(status_code=429, detail="Concurrent session quota exceeded")

    conv = await sup.create_session(
        db=db,
        tenant_id=tenant_id,
        permission_policy=body.permission_policy,
        extra_args=body.extra_oh_args,
        actor_key_id=actor,
    )
    return _to_response(conv, request)


@router.get("/{sid}", response_model=SessionResponse)
async def get_session(
    sid: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> SessionResponse:
    tenant_id = tenant_from_request(request)
    conv = await _load_owned(sid, tenant_id, db)
    return _to_response(conv, request)


@router.delete("/{sid}", response_model=DeleteResponse)
async def delete_session(
    sid: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> DeleteResponse:
    tenant_id = tenant_from_request(request)
    conv = await _load_owned(sid, tenant_id, db)
    sup = get_supervisor()
    try:
        await sup.close(sid, db=db)
    except SessionNotFound:
        # Session not live locally — just mark CLOSED in DB.
        conv.status = SessionStatus.CLOSED
        await db.commit()
    return DeleteResponse(session_id=sid, status=SessionStatus.CLOSED, message="Session closed")


@router.post("/{sid}/turns", response_model=TurnResponse)
async def submit_turn_rest(
    sid: uuid.UUID,
    body: TurnSubmitRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> TurnResponse:
    """Non-WS turn fallback. Returns 409 if a turn is in progress."""
    tenant_id = tenant_from_request(request)
    await _load_owned(sid, tenant_id, db)
    sup = get_supervisor()
    try:
        live = sup.get(sid)
    except SessionNotFound:
        raise HTTPException(status_code=409, detail="Session not live; reconnect via WebSocket")
    if live.busy:
        raise HTTPException(status_code=409, detail="A turn is already in progress")
    # Run the turn to completion (collect the final frame set).
    final_turn = None
    async for frame in sup.stream_turn(sid, body.text, db=db):
        if frame.get("type") == "turn_complete":
            from app.models import ConversationTurn

            turns = (await db.execute(
                select(ConversationTurn)
                .where(ConversationTurn.conversation_id == sid)
                .order_by(ConversationTurn.turn_index.desc())
                .limit(1)
            )).scalars().first()
            final_turn = turns
            break
        if frame.get("type") == "turn_error":
            raise HTTPException(status_code=502, detail=frame.get("message", "turn error"))
    if final_turn is None:
        raise HTTPException(status_code=502, detail="turn did not complete")
    return TurnResponse(
        turn_id=final_turn.id,
        turn_index=final_turn.turn_index,
        status=final_turn.status,
        prompt=final_turn.prompt,
        assistant_text=final_turn.assistant_text,
        error_message=final_turn.error_message,
        started_at=final_turn.started_at,
        finished_at=final_turn.finished_at,
    )


async def _iterfile(fileobj, start: int = 0, length: int | None = None, chunk: int = 1024 * 1024) -> AsyncGenerator[bytes, None]:
    try:
        if start:
            fileobj.seek(start)
        remaining = length
        while remaining is None or remaining > 0:
            read_size = min(chunk, remaining) if remaining is not None else chunk
            data = await run_in_threadpool(fileobj.read, read_size)
            if not data:
                break
            if remaining is not None:
                remaining -= len(data)
            yield data
    finally:
        fileobj.close()


@router.get("/{sid}/turns/{idx}/artifact")
async def download_artifact(
    sid: uuid.UUID,
    idx: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Download a turn's artifact, honoring HTTP Range (mirrors service/)."""
    tenant_id = tenant_from_request(request)
    await _load_owned(sid, tenant_id, db)
    art = (await db.execute(
        select(TurnArtifact).where(
            TurnArtifact.conversation_id == sid,
            TurnArtifact.turn_index == idx,
        ).limit(1)
    )).scalars().first()
    if art is None:
        raise HTTPException(status_code=404, detail="Artifact not found")

    storage = storage_for_kind(art.storage_kind)
    # S3 presigned redirect when available.
    presigned = storage.presigned_url(art.storage_key)
    if presigned is not None and request.query_params.get("mode") != "stream":
        from fastapi.responses import RedirectResponse
        return RedirectResponse(url=presigned, status_code=302)

    try:
        fileobj, size = storage.open(art.storage_key)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Artifact file not found")

    start = 0
    end = size - 1 if size else 0
    range_header = request.headers.get("Range")
    if range_header and range_header.startswith("bytes="):
        spec = range_header[len("bytes="):].strip()
        try:
            start_str, _, end_str = spec.partition("-")
            if not start_str:
                suffix = int(end_str)
                start = max(0, size - suffix)
                end = size - 1
            else:
                start = int(start_str)
                end = min(int(end_str), size - 1) if end_str else size - 1
        except (ValueError, IndexError):
            start = 0
            end = size - 1 if size else 0
    start = max(0, min(start, end)) if size else 0
    content_length = end - start + 1 if size else 0
    is_range = range_header is not None and range_header.startswith("bytes=")
    filename = art.filename or f"{sid}_{idx}.mp4"
    headers = {
        "Content-Type": "video/mp4",
        "Content-Disposition": f'attachment; filename="{filename}"',
        "Accept-Ranges": "bytes",
        "Content-Length": str(content_length),
    }
    if is_range:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    return StreamingResponse(
        _iterfile(fileobj, start=start, length=content_length),
        status_code=206 if is_range else 200,
        media_type="video/mp4",
        headers=headers,
    )
