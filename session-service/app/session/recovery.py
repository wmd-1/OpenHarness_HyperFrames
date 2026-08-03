"""Recovery policy — the single source of truth for the resume decision.

This module MUST be the only place that decides whether a session is resumed
(``--resume``), fresh-spawned, or unrecoverable. REST (``routers/sessions.py``),
WS (``routers/ws.py``) and any future gateway re-arm / reconciliation MUST call
into here instead of re-implementing the matrix (user constraint 2026-08-03).

It depends only on:
  * ``completed_turns`` — count of successfully completed turns for the
    conversation (the reliable "has context" signal; ``conversations.turn_count``
    is NOT used because failed/interrupted turns also increment it);
  * ``has_valid_snapshot`` — a boolean produced by the tenant store's snapshot
    marker abstraction. The recovery layer NEVER sees filenames — snapshot
    format knowledge is confined to ``tenant_store`` (constraint 3).
"""
from __future__ import annotations

from enum import Enum

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ConversationTurn, TurnStatus
from app.session import tenant_store


class ResumeDecision(str, Enum):
    """Outcome of the recovery matrix."""

    FRESH = "fresh"               # no snapshot + 0 completed turns -> fresh spawn
    RESUME = "resume"             # valid snapshot present -> ``--resume``
    RECOVERY_FAILED = "recovery_failed"  # context exists but no snapshot


class RecoveryFailedError(Exception):
    """Raised when a session has completed turns but no recoverable snapshot.

    Carries the decision context so callers (change 2) can map it to a 409 /
    1011 ``RECOVERY_FAILED`` response without re-evaluating the matrix.
    """

    def __init__(self, conversation_id: str, *, completed_turns: int) -> None:
        self.conversation_id = conversation_id
        self.completed_turns = completed_turns
        super().__init__(
            f"session {conversation_id} has {completed_turns} completed turn(s) "
            f"but no recoverable snapshot; recovery declined (no silent data loss)"
        )


def resolve_resume_decision(
    *, completed_turns: int, has_valid_snapshot: bool
) -> ResumeDecision:
    """Pure decision function (no I/O) — directly unit-testable.

    Matrix:
        has_valid_snapshot=True                -> RESUME
        has_valid_snapshot=False, completed=0  -> FRESH
        has_valid_snapshot=False, completed>0  -> RECOVERY_FAILED
    """
    if has_valid_snapshot:
        return ResumeDecision.RESUME
    if completed_turns == 0:
        return ResumeDecision.FRESH
    return ResumeDecision.RECOVERY_FAILED


async def count_completed_turns(db: AsyncSession, conversation_id) -> int:
    """Count only successfully completed turns (the reliable context signal)."""
    result = await db.execute(
        select(func.count())
        .select_from(ConversationTurn)
        .where(
            ConversationTurn.conversation_id == conversation_id,
            ConversationTurn.status == TurnStatus.COMPLETED,
        )
    )
    return int(result.scalar_one() or 0)


async def resolve_for_conversation(
    *,
    conversation_id,
    tenant_id: str,
    oh_session_id: str,
    db: AsyncSession,
    store=tenant_store,
) -> ResumeDecision:
    """Resolve the decision for a persisted conversation.

    Raises :class:`RecoveryFailedError` when the decision is
    ``RECOVERY_FAILED`` so callers need not re-check the matrix — they simply
    catch the error (change 2 maps it to the client-facing response).
    """
    completed = await count_completed_turns(db, conversation_id)
    has_snap = await store.has_valid_snapshot(tenant_id, oh_session_id or "")
    decision = resolve_resume_decision(
        completed_turns=completed, has_valid_snapshot=has_snap
    )
    if decision is ResumeDecision.RECOVERY_FAILED:
        raise RecoveryFailedError(conversation_id, completed_turns=completed)
    return decision
