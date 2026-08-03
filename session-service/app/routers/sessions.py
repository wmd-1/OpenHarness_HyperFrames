"""/v1/sessions REST surface (non-WS endpoints).

- ``POST /v1/sessions`` — create a session (rate-limited, quota-checked).
- ``GET /v1/sessions`` — tenant session list (paged, business fields).
- ``GET /v1/sessions/{sid}`` — session details.
- ``DELETE /v1/sessions/{sid}`` — kill + clean + CLOSED (preserves turn records).
- ``POST /v1/sessions/{sid}/turns`` — non-WS turn fallback (409 if busy).
- ``GET /v1/sessions/{sid}/turns`` — historical turns (cursor-paged, read-only OK).
- ``GET /v1/sessions/{sid}/turns/{idx}/artifact`` — artifact download (Range).
- ``GET /v1/sessions/{sid}/workspace/files`` — workspace listing (live/archive).
- ``GET /v1/sessions/{sid}/workspace/files/{path}`` — workspace file download.
"""

from __future__ import annotations

import base64
import json
import os
import mimetypes
import re
import time
import uuid
from datetime import datetime, time as dt_time, timezone
from typing import AsyncGenerator

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.deps import actor_from_request, get_db, tenant_from_request
from app.models import (
    Conversation,
    ConversationTurn,
    SessionStatus,
    TurnArtifact,
    TurnStatus,
)
from app.observability.metrics import SESSION_CREATE_DURATION
from app.ratelimit import _client_ip, check_rate_limit
from app.schemas import (
    ArtifactResponse,
    DeleteResponse,
    SessionCreateRequest,
    SessionListResponse,
    SessionResponse,
    SessionSummary,
    TurnListResponse,
    TurnResponse,
    TurnSubmitRequest,
    WorkspaceFileEntry,
    WorkspaceFileListResponse,
)
from app.session import tenant_store, workspace_store
from app.session.lifecycle import SessionState
from app.session.pool import PoolAdmissionError, TenantQuotaExceeded
from app.session.supervisor import CapacityFullError, SessionNotFound, get_supervisor
from app.session.tenant_store import TenantStoreError
from app.storage.s3 import storage_for_kind

router = APIRouter(prefix="/v1/sessions", tags=["sessions"])

# Content-Disposition filename whitelist (SS-6): anything outside [\w\-.] is
# replaced so a crafted filename cannot inject header syntax.
_FILENAME_SAFE = re.compile(r"[^\w\-.]")


def _sanitize_filename(name: str) -> str:
    return _FILENAME_SAFE.sub("_", name)


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


async def _business_fields(conv: Conversation) -> tuple[bool, bool]:
    """Centralized ``(resumable, read_only)`` mapping (session-history-switch
    D7/D8) — the single place internal status maps to the frontend contract.

    ``read_only``: terminal states (closed/expired) are view-only.
    ``resumable``: not read-only, and for COLD/FAILED sessions the snapshot
    presence check must pass — except 0-turn sessions, which stay resumable
    because rehydrate falls back to a fresh spawn (no context to lose).
    """
    read_only = conv.status in (SessionStatus.CLOSED, SessionStatus.EXPIRED)
    resumable = not read_only
    if (
        resumable
        and conv.status in (SessionStatus.COLD, SessionStatus.FAILED)
        and conv.turn_count > 0
    ):
        resumable = await tenant_store.has_valid_snapshot(
            conv.tenant_id, conv.oh_session_id or ""
        )
    return resumable, read_only


# NOTE: the collection route is registered before the ``/{sid}`` routes
# (D9) — the ``sid: uuid.UUID`` converter would not match "" anyway, but the
# ordering keeps resolution explicit.
@router.get("", response_model=SessionListResponse)
async def list_sessions(
    request: Request,
    status: SessionStatus | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
) -> SessionListResponse:
    """Tenant session list: newest-first, paged, with business fields (D9)."""
    tenant_id = tenant_from_request(request)
    where = [Conversation.tenant_id == tenant_id]
    if status is not None:
        where.append(Conversation.status == status)
    total = (await db.execute(
        select(func.count()).select_from(Conversation).where(*where)
    )).scalar_one()
    convs = (await db.execute(
        select(Conversation)
        .where(*where)
        .order_by(Conversation.created_at.desc())
        .limit(limit)
        .offset(offset)
    )).scalars().all()
    # Title source: first-turn prompts for the whole page in ONE query (no
    # N+1), truncated to 80 chars.
    titles: dict[uuid.UUID, str] = {}
    if convs:
        rows = (await db.execute(
            select(ConversationTurn.conversation_id, ConversationTurn.prompt).where(
                ConversationTurn.conversation_id.in_([c.id for c in convs]),
                ConversationTurn.turn_index == 0,
            )
        )).all()
        titles = {cid: prompt[:80] for cid, prompt in rows}
    items = []
    for conv in convs:
        resumable, read_only = await _business_fields(conv)
        items.append(
            SessionSummary(
                session_id=conv.id,
                status=conv.status,
                title=titles.get(conv.id),
                turn_count=conv.turn_count,
                resumable=resumable,
                read_only=read_only,
                created_at=conv.created_at,
                last_active_at=conv.last_active_at,
            )
        )
    return SessionListResponse(items=items, total=total, limit=limit, offset=offset)


@router.post("", response_model=SessionResponse, status_code=201)
async def create_session(
    body: SessionCreateRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> SessionResponse:
    # Rate limit (fail-open).
    if not await check_rate_limit(_client_ip(request)):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")

    # E2E fault injection (gated, OFF in production). Lets the frontend E2E
    # exercise 403/503 create-failure paths without stressing shared capacity
    # or changing daily-quota config that would break other suites.
    if os.environ.get("OH_E2E_FAULT_INJECTION") == "1":
        fault = request.query_params.get("fault")
        if fault == "403":
            raise HTTPException(status_code=403, detail="injected 403 (e2e)")
        if fault == "503":
            raise HTTPException(
                status_code=503,
                detail="injected 503 (e2e)",
                headers={"Retry-After": "1"},
            )

    tenant_id = tenant_from_request(request)
    actor = actor_from_request(request)

    sup = get_supervisor()
    # Per-tenant daily creation quota (SS-18) under the quota lock (SS-3).
    # The concurrent-quota + capacity checks moved into ContainerPool.acquire
    # (WS-D): its check-and-claim sections are event-loop-atomic, so the
    # TOCTOU the lock used to close for them no longer exists — and holding
    # the lock across a (possibly queue-waiting) create would serialize every
    # tenant's creates behind one waiter, defeating the FIFO queue.
    async with sup.quota_lock:
        if settings.tenant_max_daily > 0:
            day_start = datetime.combine(
                datetime.now(timezone.utc).date(), dt_time.min, tzinfo=timezone.utc
            )
            created_today = (await db.execute(
                select(func.count())
                .select_from(Conversation)
                .where(
                    Conversation.tenant_id == tenant_id,
                    Conversation.created_at >= day_start,
                )
            )).scalar_one()
            if created_today >= settings.tenant_max_daily:
                # Structured code (E1): lets the client distinguish "quota
                # exhausted" from a permission-denied 403 without text matching.
                raise HTTPException(
                    status_code=403,
                    detail={
                        "code": "daily_quota_exceeded",
                        "message": "Daily session quota exceeded",
                    },
                )

    started = time.monotonic()
    try:
        conv = await sup.create_session(
            db=db,
            tenant_id=tenant_id,
            permission_policy=body.permission_policy,
            extra_args=body.extra_oh_args,
            actor_key_id=actor,
        )
    except TenantQuotaExceeded:
        # Pool admission stage 1 (WS-D): tenant already at tenant_max_concurrent.
        raise HTTPException(status_code=429, detail="Concurrent session quota exceeded")
    except PoolAdmissionError as exc:
        # Queue full / queue timeout (WS-D): back-pressure with Retry-After.
        raise HTTPException(
            status_code=503,
            detail=str(exc),
            headers={"Retry-After": str(exc.retry_after or max(1, int(settings.pool_queue_timeout)))},
        )
    except CapacityFullError:
        # Queue disabled (pool_queue_size=0): pre-pool fail-fast behavior.
        raise HTTPException(status_code=503, detail="node capacity full")
    except TenantStoreError:
        # WS-B fail-fast: tenant authoritative store unreachable -> no
        # session is created (stage-in already rolled back any partials).
        raise HTTPException(status_code=503, detail="tenant data store unavailable")
    # Cold-start latency histogram (WS-D observability): admission wait +
    # stage-in + backend spawn through ready.
    SESSION_CREATE_DURATION.observe(time.monotonic() - started)
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


@router.get("/{sid}/turns", response_model=TurnListResponse)
async def list_turns(
    sid: uuid.UUID,
    request: Request,
    after_index: int = Query(default=-1, ge=-1),
    limit: int = Query(default=50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
) -> TurnListResponse:
    """Historical turns, cursor-paged by ``after_index`` (D9).

    Closed/expired sessions remain readable (read-only history); access is
    tenant-scoped (404 for other tenants' sessions).
    """
    tenant_id = tenant_from_request(request)
    await _load_owned(sid, tenant_id, db)
    total = (await db.execute(
        select(func.count())
        .select_from(ConversationTurn)
        .where(ConversationTurn.conversation_id == sid)
    )).scalar_one()
    turns = (await db.execute(
        select(ConversationTurn)
        .where(
            ConversationTurn.conversation_id == sid,
            ConversationTurn.turn_index > after_index,
        )
        .order_by(ConversationTurn.turn_index.asc())
        .limit(limit)
    )).scalars().all()
    # Batched has_artifact flags for the page (one query, no N+1).
    artifact_turns: set[int] = set()
    if turns:
        artifact_turns = set((await db.execute(
            select(TurnArtifact.turn_index).where(
                TurnArtifact.conversation_id == sid,
                TurnArtifact.turn_index.in_([t.turn_index for t in turns]),
            )
        )).scalars().all())
    items = [
        TurnResponse(
            turn_id=t.id,
            turn_index=t.turn_index,
            status=t.status,
            prompt=t.prompt,
            assistant_text=t.assistant_text,
            error_message=t.error_message,
            has_artifact=t.turn_index in artifact_turns,
            started_at=t.started_at,
            finished_at=t.finished_at,
        )
        for t in turns
    ]
    return TurnListResponse(items=items, total=total)


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
    has_artifact = False
    async for frame in sup.stream_turn(sid, body.text, db=db):
        if frame.get("type") == "turn_complete":
            has_artifact = bool(frame.get("has_artifact", False))
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
        has_artifact=has_artifact,
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
    filename = _sanitize_filename(art.filename or f"{sid}_{idx}.mp4")
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


# --- workspace files API (spec session-workspace-archive D7) -------------------


def _ws_reject_traversal(rel: str) -> None:
    """400 on ``..``, absolute or backslashed workspace paths (spec)."""
    if not rel or rel.startswith(("/", "\\")) or "\\" in rel or ".." in Path(rel).parts:
        raise HTTPException(status_code=400, detail="Invalid path")


def _ws_page(
    entries: list[WorkspaceFileEntry],
    limit: int,
    page_token: str | None,
    prefix: str | None,
) -> tuple[int, list[WorkspaceFileEntry], str | None]:
    """Slice sorted entries into one page. The opaque cursor is the last
    returned path (base64), so a path-ordered walk has no gaps/duplicates
    even if files appear or vanish between pages (rev2 pagination)."""
    if prefix:
        entries = [e for e in entries if e.path.startswith(prefix)]
    total = len(entries)
    if page_token:
        try:
            # validate=True: garbage cursors are a 400, not silently-empty
            # decodes (urlsafe_b64decode ignores foreign chars by default).
            after = base64.b64decode(
                page_token.encode(), altchars=b"-_", validate=True
            ).decode()
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid page_token")
        entries = [e for e in entries if e.path > after]
    page = entries[:limit]
    next_token = (
        base64.urlsafe_b64encode(page[-1].path.encode()).decode()
        if len(entries) > limit
        else None
    )
    return total, page, next_token


def _ws_live_cwd(sid: uuid.UUID) -> Path | None:
    """The real-time local directory when the session is LIVE/IDLE here."""
    sup = get_supervisor()
    if sup.has(sid):
        live = sup.get(sid)
        if live.state in (SessionState.LIVE, SessionState.IDLE):
            return live.cwd
    return None


@router.get("/{sid}/workspace/files", response_model=WorkspaceFileListResponse)
async def list_workspace_files(
    sid: uuid.UUID,
    request: Request,
    limit: int = Query(500, ge=1, le=5000),
    page_token: str | None = Query(None),
    prefix: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
) -> WorkspaceFileListResponse:
    """Workspace file listing: live / archive / none sources (D7)."""
    tenant_id = tenant_from_request(request)
    conv = await _load_owned(sid, tenant_id, db)

    cwd = _ws_live_cwd(sid)
    if cwd is None:
        manifest = await workspace_store.load_manifest(tenant_id, sid)
        if manifest is not None:
            entries = [
                WorkspaceFileEntry(
                    path=e["path"],
                    size=int(e.get("size") or 0),
                    mtime=e.get("mtime"),
                    etag=e.get("etag"),
                )
                for e in manifest.get("files") or []
                if e.get("path")
            ]
            entries.sort(key=lambda e: e.path)
            total, page, next_token = _ws_page(entries, limit, page_token, prefix)
            return WorkspaceFileListResponse(
                source="archive",
                # LIVE/IDLE served from the archive (live on another node):
                # a snapshot lagging at most one turn.
                stale=conv.status in (SessionStatus.LIVE, SessionStatus.IDLE),
                sync_seq=manifest.get("sync_seq"),
                last_synced_at=manifest.get("last_synced_at"),
                total=total,
                files=page,
                next_page_token=next_token,
            )
        # No archive: a still-present local dir (COLD on this node, or a
        # MinIO-less deployment) is served directly.
        if conv.workspace_path and Path(conv.workspace_path).is_dir():
            cwd = Path(conv.workspace_path)

    if cwd is not None:
        # Same view as archiving would produce (ignore rules + sidecar
        # excluded, symlinks skipped).
        stats = await run_in_threadpool(workspace_store.scan_local, cwd)
        entries = [
            WorkspaceFileEntry(path=p, size=st.st_size, mtime=st.st_mtime)
            for p, st in stats.items()
        ]
        entries.sort(key=lambda e: e.path)
        total, page, next_token = _ws_page(entries, limit, page_token, prefix)
        return WorkspaceFileListResponse(
            source="live", total=total, files=page, next_page_token=next_token
        )

    # No archive, no local directory: empty list, not 404 (the session exists).
    return WorkspaceFileListResponse(source="none", files=[], next_page_token=None)


@router.get("/{sid}/workspace/files/{path:path}")
async def download_workspace_file(
    sid: uuid.UUID,
    path: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Workspace file download: live streams local; archive prefers a
    presigned 302 (public endpoint configured) else proxies through the
    gateway (D7)."""
    tenant_id = tenant_from_request(request)
    conv = await _load_owned(sid, tenant_id, db)
    _ws_reject_traversal(path)
    if path == workspace_store.SIDECAR_NAME:
        raise HTTPException(status_code=404, detail="File not found")
    media_type = mimetypes.guess_type(path)[0] or "application/octet-stream"
    headers = {
        "Content-Disposition": f'attachment; filename="{_sanitize_filename(Path(path).name)}"',
    }

    cwd = _ws_live_cwd(sid)
    if cwd is None:
        manifest = await workspace_store.load_manifest(tenant_id, sid)
        if manifest is not None:
            entry = next(
                (e for e in manifest.get("files") or [] if e.get("path") == path),
                None,
            )
            if entry is None:
                raise HTTPException(status_code=404, detail="File not found")
            presigned = workspace_store.presigned_archive_url(tenant_id, sid, path)
            if presigned is not None and request.query_params.get("mode") != "stream":
                from fastapi.responses import RedirectResponse

                return RedirectResponse(url=presigned, status_code=302)
            try:
                resp = await run_in_threadpool(
                    workspace_store.open_archive_object, tenant_id, sid, path
                )
            except FileNotFoundError:
                raise HTTPException(status_code=404, detail="File not found")
            size = int(entry.get("size") or 0)
            if size:
                headers["Content-Length"] = str(size)

            async def _iter_archive() -> AsyncGenerator[bytes, None]:
                it = resp.stream(1024 * 1024)
                try:
                    while True:
                        chunk = await run_in_threadpool(lambda: next(it, None))
                        if chunk is None:
                            break
                        yield chunk
                finally:
                    resp.close()
                    resp.release_conn()

            return StreamingResponse(
                _iter_archive(), media_type=media_type, headers=headers
            )
        if conv.workspace_path and Path(conv.workspace_path).is_dir():
            cwd = Path(conv.workspace_path)

    if cwd is not None:
        # Resolves symlink escapes on top of the raw traversal check above.
        local = workspace_store.safe_local_path(cwd, path)
        if local is None:
            raise HTTPException(status_code=400, detail="Invalid path")
        if local.is_symlink() or not local.is_file():
            raise HTTPException(status_code=404, detail="File not found")
        headers["Content-Length"] = str(local.stat().st_size)
        fileobj = await run_in_threadpool(local.open, "rb")
        return StreamingResponse(_iterfile(fileobj), media_type=media_type, headers=headers)

    raise HTTPException(status_code=404, detail="File not found")

