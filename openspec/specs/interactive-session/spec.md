# interactive-session Specification

## Purpose
TBD - created by archiving change 2026-08-05-rehydrate-turn-index-restore. Update Purpose after archive.
## Requirements
### Requirement: Rehydration MUST restore the in-memory turn cursor
When a `COLD` session is rehydrated (idle eviction reconnect or gateway-restart recovery), the supervisor MUST restore the in-memory `LiveSession._turn_index` from the authoritative `conversations.turn_count` before spawning the backend, so the next submitted turn uses a `turn_index` that does not collide with already-committed turns under the `(conversation_id, turn_index)` unique constraint (`uq_turns_conv_idx`).

The rehydrate path MUST behave identically to `create_session_from_existing` with respect to the turn cursor: `live._turn_index = conv.turn_count`. If the conversation row cannot be located, the cursor MUST retain its default value (`0`) rather than raise, and rehydrate MUST proceed normally.

#### Scenario: resumed turn does not reuse a committed index
- **WHEN** a session has 1 committed turn (`turn_count=1`) and is rehydrated after a gateway restart
- **THEN** the next submitted turn is persisted with `turn_index=1` (not `0`), and no `uq_turns_conv_idx` IntegrityError is raised

#### Scenario: rehydrate mirrors the re-arm cursor restore
- **WHEN** a `COLD` session is rehydrated via the WS reconnect path
- **THEN** `live._turn_index` equals `conv.turn_count`, matching the `create_session_from_existing` re-arm path

#### Scenario: missing conversation row does not raise
- **WHEN** rehydrate runs but the conversation row is absent
- **THEN** the cursor keeps its default value and rehydrate proceeds without raising

