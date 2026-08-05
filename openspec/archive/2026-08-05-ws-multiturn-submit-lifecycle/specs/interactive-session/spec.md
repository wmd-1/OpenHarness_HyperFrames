## MODIFIED Requirements

### Requirement: A session MUST enforce single-writer turn serialization

A session MUST run at most one turn at a time. The single-writer state is the supervisor's authoritative `LiveSession.busy` flag (`supervisor.py`), set `True` when a turn begins (`stream_turn` entry) and `False` only after the turn is fully finalized (in `stream_turn`'s `finally`, before its trailing `stage_out` await). The WS layer MUST derive its reject decision from this same `LiveSession.busy` flag and MUST NOT use the WebSocket task lifecycle (`turn_task.done()`) as the busy signal.

A `submit` received while `LiveSession.busy` is `True` (a turn is actively streaming) MUST be rejected with a `busy` WS frame (and the non-WS turn endpoint MUST return `409`), and MUST NOT be forwarded to the subprocess. After a turn emits `turn_complete`, `LiveSession.busy` is `False` even though the turn task's trailing `stage_out` may still be running; a `submit` arriving in that window MUST be accepted and MUST create a new `ConversationTurn`. (This excludes post-turn `stage_out` from the reject window — making `stage_out` non-blocking is a separate concern.)

#### Scenario: concurrent submit during an active turn is rejected
- **WHEN** a client sends a second `submit` while the first turn is still streaming (before its `turn_complete`)
- **THEN** the service replies with a `busy` frame and does not write a second `submit_line` to the subprocess

#### Scenario: submit arriving after turn_complete is accepted (no busy window)
- **WHEN** a client receives `turn_complete` for turn N and immediately sends a `submit` for turn N+1
- **THEN** the service accepts the submit (no `busy` frame is sent), runs the new turn, and emits a `turn_complete` for turn N+1

#### Scenario: non-WS concurrent turn returns 409
- **WHEN** `POST /v1/sessions/{sid}/turns` is called while a turn is in progress
- **THEN** the response is `409`
