# Spec Delta: video-conversation (add-multi-turn-conversation)

**Change ID:** `add-multi-turn-conversation`
**Capability:** `video-conversation` (new)
**Affects:** `OpenHarness/src/openharness/ui/app.py`, `OpenHarness/src/openharness/cli.py`, `service/app/**`, `service/alembic/versions/**`, `service/tests/**`

> This delta introduces a new capability: multi-turn video conversations built on
> `oh`'s **native** session resume. It adds a headless-resume requirement to `oh`
> and a conversation orchestration layer to the backend. Each turn is an
> independent render producing its own video; turns share one workspace and one
> `oh` session and run strictly sequentially.

---

## ADDED Requirements

### Requirement: Headless print mode MUST support native session resume

`run_print_mode` MUST honor `--resume <session_id>` and `--continue`: when either is present it MUST restore the prior conversation messages from the on-disk snapshot (keyed by `cwd`) before running the turn, and after the turn completes it MUST persist the updated snapshot via `save_session_snapshot`. Resume MUST NOT force the interactive REPL — `oh -p <prompt> --resume <sid>` MUST run non-interactively without a controlling TTY.

#### Scenario: headless resume restores prior context and runs without a TTY
- GIVEN a session snapshot exists for `cwd` under id `sid`
- WHEN `oh -p "next instruction" --resume sid` runs with no TTY attached
- THEN the prior messages are restored, the turn runs in print mode (no REPL), and the process exits after one turn

#### Scenario: headless run persists the updated snapshot
- GIVEN a headless turn runs to completion for session `sid`
- WHEN the process exits
- THEN the on-disk snapshot for `sid` includes the new user prompt and assistant reply (a subsequent `--resume sid` sees them)

---

### Requirement: A headless run MUST emit its session id on a machine-readable channel

A headless `oh` run MUST expose the `session_id` it created or resumed so a non-interactive caller can capture it: in `stream-json` output as a `{"type":"session","session_id":...}` event, and in `text` output as a stable, parseable stderr line. The emitted id MUST match the id under which the snapshot is saved.

#### Scenario: stream-json emits a session event
- GIVEN `oh -p "hello" --output-format stream-json`
- WHEN the run starts
- THEN one emitted JSON line has `type == "session"` and a non-empty `session_id`, and that id names the saved snapshot file

#### Scenario: emitted id round-trips through resume
- GIVEN a first headless run emits `session_id = sid`
- WHEN a second run uses `--resume sid`
- THEN the snapshot is found and the prior context is restored

---

### Requirement: A conversation MUST group ordered render turns over one shared workspace

The backend MUST provide a `Conversation` resource that owns a single shared workspace directory (a reused `cwd`) and a captured `oh_session_id`, and that groups an ordered list of turns. Each turn MUST be an independent `VideoTask` with a `conversation_id` and a monotonically increasing `turn_index` (starting at 0) that produces its own video artifact. All turns of a conversation MUST render in the same workspace directory (not a fresh per-task directory).

#### Scenario: first turn creates the conversation and its workspace
- GIVEN `POST /v1/conversations` with a prompt
- WHEN the request succeeds
- THEN a conversation is created, a turn-0 `VideoTask` is enqueued with `turn_index=0`, and the response returns `conversation_id`, `task_id`, and `turn_index=0`

#### Scenario: turns of one conversation share a workspace
- GIVEN a conversation with turn 0 completed
- WHEN turn 1 renders
- THEN both turns used the same workspace directory (`workspace_root/<conversation_id>`), not per-task directories

---

### Requirement: Continuation turns MUST resume the conversation's `oh` session

`POST /v1/conversations/{cid}/turns` MUST create the next turn in the same workspace and the worker MUST run `oh -p <prompt> --resume <oh_session_id>` so the model retains prior context natively. The `oh_session_id` MUST be captured from `oh`'s emitted session id on the first turn and persisted on the conversation; turns after the first MUST NOT start a new session.

#### Scenario: second turn resumes the first turn's session
- GIVEN turn 0 completed and persisted `oh_session_id = sid` on the conversation
- WHEN turn 1 is enqueued and rendered
- THEN the worker invokes `oh` with `--resume sid` in the shared workspace

#### Scenario: first turn captures and stores the session id
- GIVEN turn 0 runs with no prior session
- WHEN `oh` emits its `session_id`
- THEN the conversation row is updated with that `oh_session_id`

---

### Requirement: Turns MUST be sequential per conversation

Creating a new turn MUST be rejected with `409` when the conversation's latest turn is not in a terminal state (`SUCCEEDED`/`FAILED`/`CANCELED`). This guarantees a single writer to the shared workspace and a correctly ordered session snapshot; at most one turn per conversation may be non-terminal at any time.

#### Scenario: overlapping turn is rejected
- GIVEN a conversation whose latest turn is `RUNNING`
- WHEN `POST /v1/conversations/{cid}/turns` is called
- THEN the response is `409` and no new turn is created

#### Scenario: continuation allowed after the previous turn is terminal
- GIVEN a conversation whose latest turn is `SUCCEEDED`
- WHEN a new turn is requested
- THEN the turn is created with `turn_index = previous + 1` and enqueued

---

### Requirement: A per-conversation turn cap MUST bound growth

The backend MUST enforce a configurable maximum number of turns per conversation (`max_turns_per_conversation`); a continuation beyond the cap MUST be rejected with `409` (or `422`). This bounds unbounded session snapshot growth and shared-workspace accumulation.

#### Scenario: exceeding the turn cap is rejected
- GIVEN `max_turns_per_conversation = 3` and a conversation already has 3 turns
- WHEN a 4th turn is requested
- THEN the request is rejected and no turn is created

---

### Requirement: Conversation workspace/session cleanup MUST be deferred to conversation lifecycle

A successful conversation turn MUST NOT delete the shared workspace or the `oh` session snapshot (later turns depend on them). The shared workspace and session MUST be removed only when the conversation is deleted or expires. This overrides the single-shot "remove workspace immediately on success" behavior specifically for turns that carry a `conversation_id`.

#### Scenario: successful turn keeps the shared workspace
- GIVEN a conversation turn completes `SUCCEEDED`
- WHEN the worker finishes
- THEN the shared workspace and session snapshot still exist (available to the next turn)

#### Scenario: deleting the conversation removes the shared workspace
- GIVEN a conversation with several turns
- WHEN `DELETE /v1/conversations/{cid}` is called
- THEN the shared workspace, the session snapshot, and every turn's artifact are removed

---

### Requirement: Conversation retrieval MUST expose ordered turns; deletion MUST cascade and preserve per-turn status

`GET /v1/conversations/{cid}` MUST return the conversation with its turns in ascending `turn_index` order (each turn exposing at least `task_id`, `turn_index`, `status`, and a download link when available), and `GET /v1/conversations` MUST return a paginated list. `DELETE /v1/conversations/{cid}` MUST remove all turn artifacts + the shared workspace/session but MUST NOT rewrite each turn's terminal status (consistent with single-shot DELETE semantics).

#### Scenario: get returns turns in order
- GIVEN a conversation with turns 0,1,2
- WHEN `GET /v1/conversations/{cid}` is called
- THEN the turns are returned ordered by `turn_index` ascending

#### Scenario: delete preserves terminal statuses
- GIVEN a conversation whose turn 0 is `SUCCEEDED` and turn 1 is `FAILED`
- WHEN `DELETE /v1/conversations/{cid}` is called
- THEN resources are removed and the recorded turn statuses stay `SUCCEEDED`/`FAILED`

---

### Requirement: Single-shot video creation MUST remain unchanged

`POST /v1/videos` MUST continue to create a standalone `VideoTask` with `conversation_id = NULL`, rendered in its own per-task workspace with the existing immediate-success cleanup. Adding the conversation feature MUST NOT alter single-shot request/response shapes or behavior.

#### Scenario: single-shot task has no conversation linkage
- GIVEN `POST /v1/videos` with a prompt
- WHEN the task is created
- THEN `conversation_id` is `NULL`, a per-task workspace is used, and the response schema is unchanged

---

### Requirement: The conversation schema MUST be added via a forward migration

An Alembic migration (the next revision after `003`; confirm the real head via `alembic heads` before setting `down_revision`) MUST create a `conversations` table and add `conversation_id` (nullable FK) and `turn_index` (nullable int) to `video_tasks`, with an index on `(conversation_id, turn_index)`. The migration MUST be backward compatible: existing single-shot rows keep `conversation_id = NULL`.

#### Scenario: migration adds table and columns without breaking existing rows
- GIVEN a database at revision `003` with existing single-shot tasks
- WHEN the new migration is applied
- THEN the `conversations` table and the two `video_tasks` columns exist, and existing rows have `conversation_id = NULL`

---

## MODIFIED Requirements

(None — this change introduces a new capability and does not alter existing `video-service-hardening` requirements. The deferred-cleanup interaction is expressed above as a conversation-scoped ADDED requirement.)
