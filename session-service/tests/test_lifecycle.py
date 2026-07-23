"""Tests for the session lifecycle state machine (spec D3)."""

import pytest

from app.session.lifecycle import (
    IllegalTransition,
    SessionState,
    can_transition,
    is_live_process,
    is_terminal,
    transition,
)


def test_creating_to_live():
    assert transition(SessionState.CREATING, SessionState.LIVE) == SessionState.LIVE


def test_live_idle_roundtrip():
    s = transition(SessionState.LIVE, SessionState.IDLE)
    assert s == SessionState.IDLE
    s = transition(SessionState.IDLE, SessionState.LIVE)
    assert s == SessionState.LIVE


def test_idle_to_cold_eviction():
    assert transition(SessionState.IDLE, SessionState.COLD) == SessionState.COLD


def test_cold_to_live_rehydrate():
    assert transition(SessionState.COLD, SessionState.LIVE) == SessionState.LIVE


def test_failed_to_cold_recoverable():
    # FAILED is recoverable -> COLD -> resume.
    assert transition(SessionState.FAILED, SessionState.COLD) == SessionState.COLD


def test_illegal_transition_raises():
    with pytest.raises(IllegalTransition):
        transition(SessionState.CLOSED, SessionState.LIVE)


def test_closed_is_terminal():
    assert is_terminal(SessionState.CLOSED)
    assert is_terminal(SessionState.EXPIRED)


def test_failed_is_not_terminal():
    """FAILED is recoverable (-> COLD -> resume), so NOT absorbing."""
    assert not is_terminal(SessionState.FAILED)


def test_is_live_process():
    assert is_live_process(SessionState.LIVE)
    assert is_live_process(SessionState.IDLE)
    assert not is_live_process(SessionState.COLD)
    assert not is_live_process(SessionState.CLOSED)


def test_can_transition_matrix():
    assert can_transition(SessionState.LIVE, SessionState.COLD)
    assert not can_transition(SessionState.COLD, SessionState.IDLE)
