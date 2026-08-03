"""Unit tests for the recovery policy (Change 1).

Covers:
  * the pure 4-state decision matrix (completed_turns x has_valid_snapshot);
  * the snapshot-marker abstraction in tenant_store (no filenames in the policy);
  * resolve_for_conversation raising RecoveryFailedError for the unrecoverable case.

Run inside the existing image, e.g.:
  docker exec openharness-session sh -lc 'cd /opt/oh-session-service && \
    /root/.openharness-venv/bin/python -m pytest tests/test_recovery_decision.py -q'
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.session import tenant_store
from app.session.recovery import (
    RecoveryFailedError,
    ResumeDecision,
    count_completed_turns,
    resolve_for_conversation,
    resolve_resume_decision,
)


# --- pure decision matrix -------------------------------------------------------

@pytest.mark.parametrize(
    "completed_turns,has_valid_snapshot,expected",
    [
        (0, False, ResumeDecision.FRESH),       # no context, no snapshot -> fresh
        (0, True, ResumeDecision.RESUME),       # snapshot present -> resume
        (3, True, ResumeDecision.RESUME),       # snapshot present -> resume
        (3, False, ResumeDecision.RECOVERY_FAILED),  # context lost -> fail, no drop
    ],
)
def test_resolve_resume_decision_matrix(completed_turns, has_valid_snapshot, expected):
    assert (
        resolve_resume_decision(
            completed_turns=completed_turns, has_valid_snapshot=has_valid_snapshot
        )
        is expected
    )


# --- snapshot marker abstraction (constraint 3) ---------------------------------

def test_has_valid_snapshot_marker_local(tmp_path: Path):
    sessions_root = tmp_path / "sessions"
    sess = sessions_root / "abc"
    sess.mkdir(parents=True)

    # empty session dir -> no marker
    assert tenant_store._has_valid_snapshot_marker(sessions_root, "abc") is False

    # zero-byte json -> still not a valid marker
    (sess / "latest.json").write_bytes(b"")
    assert tenant_store._has_valid_snapshot_marker(sessions_root, "abc") is False

    # non-empty marker -> valid
    (sess / "latest.json").write_bytes(b"{}")
    assert tenant_store._has_valid_snapshot_marker(sessions_root, "abc") is True

    # a stray non-json file must not create a false positive
    (sess / "notes.txt").write_bytes(b"x")
    assert tenant_store._has_valid_snapshot_marker(sessions_root, "abc") is True

    # prefix match on directory name (oh_session_id is a prefix)
    extra = sessions_root / "abc-extra"
    extra.mkdir()
    (extra / "session-x.json").write_bytes(b"{}")
    assert tenant_store._has_valid_snapshot_marker(sessions_root, "abc") is True


def test_has_valid_snapshot_marker_ignores_empty_dir():
    # A directory created by get_project_session_dir()'s mkdir side effect but
    # containing no marker must NOT be treated as a valid snapshot.
    assert tenant_store._has_valid_snapshot_marker(Path("/nonexistent-root"), "abc") is False


# --- orchestration: resolve_for_conversation ------------------------------------

def _fake_db(completed: int) -> MagicMock:
    db = MagicMock()
    db.execute = AsyncMock(return_value=MagicMock(scalar_one=lambda: completed))
    return db


def test_resolve_for_conversation_resume():
    db = _fake_db(completed=1)
    with patch.object(
        tenant_store, "has_valid_snapshot", new=AsyncMock(return_value=True)
    ):
        decision = asyncio.run(
            resolve_for_conversation(
                conversation_id="cid", tenant_id="t", oh_session_id="s", db=db
            )
        )
    assert decision is ResumeDecision.RESUME


def test_resolve_for_conversation_fresh():
    db = _fake_db(completed=0)
    with patch.object(
        tenant_store, "has_valid_snapshot", new=AsyncMock(return_value=False)
    ):
        decision = asyncio.run(
            resolve_for_conversation(
                conversation_id="cid", tenant_id="t", oh_session_id="s", db=db
            )
        )
    assert decision is ResumeDecision.FRESH


def test_resolve_for_conversation_recovery_failed_raises():
    db = _fake_db(completed=2)
    with patch.object(
        tenant_store, "has_valid_snapshot", new=AsyncMock(return_value=False)
    ):
        with pytest.raises(RecoveryFailedError) as exc:
            asyncio.run(
                resolve_for_conversation(
                    conversation_id="cid", tenant_id="t", oh_session_id="s", db=db
                )
            )
    assert exc.value.completed_turns == 2
    assert exc.value.conversation_id == "cid"


def test_count_completed_turns_counts_only_completed():
    db = _fake_db(completed=4)
    assert asyncio.run(count_completed_turns(db, "cid")) == 4
