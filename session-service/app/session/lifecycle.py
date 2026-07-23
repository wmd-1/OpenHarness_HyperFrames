"""Session lifecycle state machine (spec D3).

States::

    CREATING → LIVE ⇄ IDLE → COLD → (--resume) → LIVE
    terminal: CLOSED / EXPIRED / FAILED

- ``LIVE``: subprocess running + ≥1 WS connection.
- ``IDLE``: subprocess running, zero WS connections, ``idle_grace_seconds`` countdown.
- ``COLD``: subprocess shut down; snapshot preserved on the shared volume;
  ``oh_session_id`` / ``workspace_path`` persisted for ``--resume``.

Transitions are validated so an illegal move raises :class:`IllegalTransition`.
"""

from __future__ import annotations

import enum


class SessionState(str, enum.Enum):
    CREATING = "creating"
    LIVE = "live"
    IDLE = "idle"
    COLD = "cold"
    CLOSED = "closed"
    EXPIRED = "expired"
    FAILED = "failed"


class IllegalTransition(ValueError):
    """Raised when a state transition is not permitted from the current state."""


# Allowed transitions: current -> {set of next states}.
_TRANSITIONS: dict[SessionState, set[SessionState]] = {
    SessionState.CREATING: {SessionState.LIVE, SessionState.FAILED, SessionState.CLOSED},
    SessionState.LIVE: {SessionState.IDLE, SessionState.COLD, SessionState.FAILED, SessionState.CLOSED, SessionState.EXPIRED},
    SessionState.IDLE: {SessionState.LIVE, SessionState.COLD, SessionState.FAILED, SessionState.CLOSED, SessionState.EXPIRED},
    SessionState.COLD: {SessionState.LIVE, SessionState.CLOSED, SessionState.EXPIRED, SessionState.FAILED},
    # terminal states are absorbing
    SessionState.CLOSED: set(),
    SessionState.EXPIRED: set(),
    SessionState.FAILED: {SessionState.COLD, SessionState.LIVE, SessionState.CLOSED},
}


def can_transition(current: SessionState, target: SessionState) -> bool:
    return target in _TRANSITIONS.get(current, set())


def transition(current: SessionState, target: SessionState) -> SessionState:
    """Validate and return the new state, or raise :class:`IllegalTransition`."""
    if not can_transition(current, target):
        raise IllegalTransition(f"cannot transition {current.value} -> {target.value}")
    return target


def is_terminal(state: SessionState) -> bool:
    """True for absorbing terminal states (CLOSED / EXPIRED).

    FAILED is recoverable (→ COLD → resume) so it is NOT terminal here.
    """
    return state in (SessionState.CLOSED, SessionState.EXPIRED)


def is_live_process(state: SessionState) -> bool:
    """True when the state implies a running subprocess (LIVE/IDLE)."""
    return state in (SessionState.LIVE, SessionState.IDLE)


__all__ = [
    "SessionState",
    "IllegalTransition",
    "can_transition",
    "transition",
    "is_terminal",
    "is_live_process",
]
