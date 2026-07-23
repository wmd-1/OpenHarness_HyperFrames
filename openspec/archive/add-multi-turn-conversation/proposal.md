# Proposal: Multi-Turn Conversation for the Video Service (native `oh` session resume)

**Change ID:** `add-multi-turn-conversation`
**Created:** 2026-07-21
**Status:** Draft
**Capability:** `video-conversation` (new)
**Repos touched:** `OpenHarness/` (headless session resume) + `service/` (conversation model, API, worker)

---

## Why

The `service/` backend is **single-shot / stateless**: `VideoTask` carries no
conversation linkage, `VideoCreateRequest` takes one `prompt`, and the worker
spawns `oh -p <prompt>` in a **fresh per-task workspace** and exits. There is no
way to iterate ("make the intro shorter", "now add captions") while keeping the
model's context — every request starts from zero.

`oh` **does** have native multi-turn sessions (snapshots keyed by `cwd`, restored
via `--resume <session_id>` / `--continue`), but today those flags route only into
the **interactive REPL** (`run_repl`), and the two headless paths are one-shot:
`run_print_mode` neither saves nor restores a session, and `run_task_worker`
`break`s after a single line. So headless (`-p`) multi-turn is **not currently
possible** without a small `oh` enhancement.

Driving the interactive REPL from the backend is impractical (TTY/Ink, long-lived
process bound to a conversation) and conflicts with the multi-instance Celery
"one subprocess per render" model. The clean path is to make the **headless print
path support native session resume**, and let the backend model conversations as
an ordered set of independent render turns that share one workspace + one `oh`
session.

## What Changes

Add a `video-conversation` capability spanning two repos:

**OpenHarness (`oh`) — headless session resume:**
- `run_print_mode` MUST honor `--resume <session_id>` / `--continue`: restore the
  prior messages from the on-disk snapshot before running, and **save** the
  updated snapshot after the turn (same `save_session_snapshot` the REPL uses).
- A headless run MUST emit its `session_id` on a machine-readable channel (a
  `session` event in `stream-json`, and a stable stderr line in `text` mode) so a
  non-interactive caller can capture it and resume later.

**service (`service/`) — conversation orchestration:**
- New `Conversation` resource: a shared workspace (reused `cwd`), a captured
  `oh_session_id`, and an ordered list of turns. Each turn is an **independent
  `VideoTask`** producing its own video artifact (per the chosen semantics).
- New endpoints: `POST /v1/conversations` (first turn), `POST
  /v1/conversations/{cid}/turns` (continuation), `GET /v1/conversations/{cid}`,
  `GET /v1/conversations`, `DELETE /v1/conversations/{cid}`.
- The worker reuses the conversation workspace and injects `--resume
  <oh_session_id>` for turns after the first; it captures/persists the
  `oh_session_id` emitted by `oh`.
- **Turns are sequential:** creating a new turn while the conversation's latest
  turn is non-terminal returns `409` (guarantees a single writer to the shared
  workspace and correct session ordering).
- **Workspace cleanup is deferred** for conversation turns (a successful turn does
  NOT delete the shared workspace/session — only conversation delete/expiry does).
- New migration adds a `conversations` table and `conversation_id` / `turn_index`
  columns on `video_tasks`; single-shot `POST /v1/videos` is unchanged
  (`conversation_id = NULL`).

## Scope

### In Scope
- `oh` headless `--resume` / `--continue` in `run_print_mode` (restore + save + emit `session_id`).
- Conversation data model + migration (new table + 2 columns + index).
- Conversation API (create / continue / get / list / delete) with sequential-turn enforcement.
- Worker: conversation workspace reuse, `--resume` injection, `oh_session_id` capture, deferred cleanup.
- Backward compatibility for single-shot `/v1/videos`.
- Configurable per-conversation turn cap and conversation retention/expiry.

### Out of Scope
- Long-lived `--task-worker` process-per-conversation (Option B) — rejected for architecture fit.
- Streaming/merging turns into a single evolving artifact (each turn produces its own video).
- Tenant isolation / auth changes (tracked by `harden-video-service-impl-fixes` and Phase-4 work).
- Cross-worker migration of an in-flight conversation (turns are sequential; no concurrent turn).

## Impact Analysis

| Component | Change Required | Details |
|---|---|---|
| `OpenHarness/ui/app.py` (`run_print_mode`) | Yes | accept `resume`/`continue_session`, restore + save snapshot, emit `session_id` |
| `OpenHarness/cli.py` | Yes | stop forcing REPL when `-p` + `--resume`/`--continue`; route headless resume to print mode |
| service `app/models.py` | Yes | new `Conversation` model; `VideoTask.conversation_id` + `turn_index` |
| service `app/routers/` | Yes | new `conversations.py` router (create/continue/get/list/delete) |
| service `app/schemas.py` | Yes | conversation + turn request/response schemas |
| service `app/workers/tasks.py` | Yes | conversation workspace reuse, `--resume` injection, `oh_session_id` capture, deferred cleanup |
| service `app/workers/runner.py` / `parser.py` | Yes | parse the emitted `oh_session_id` from output |
| service `app/config.py` | Yes | `max_turns_per_conversation`, conversation retention knobs |
| DB / Alembic | Yes | migration after `003` (confirm head via `alembic heads`) |
| Tests | Yes | oh headless-resume tests; service conversation API + worker tests on real fixtures |
| Docs (`openspec/specs`) | Yes | this delta (new `video-conversation` capability) |

## Architecture Considerations

- **Native `oh` sessions, no history re-composition:** the backend does not rebuild
  the transcript into the prompt; `oh` restores it from the snapshot keyed by the
  reused `cwd`. The backend only stores the `session_id` and reuses the workspace.
- **Fits the existing render model:** each turn is still a discrete Celery render
  subprocess — no long-lived per-conversation process, no TTY.
- **Single-writer invariant:** sequential turns (409 on overlap) mean the shared
  workspace and session snapshot never have concurrent writers, so no locking is
  needed beyond the existing claim/CAS machinery.
- **Backward compatible:** `conversation_id` is nullable; existing single-shot
  behavior and per-task workspaces are untouched.

## Success Criteria

- [ ] `oh -p <prompt> --resume <sid>` runs headlessly, restores prior context, saves the updated snapshot, and prints the `session_id` (no REPL, no TTY).
- [ ] `POST /v1/conversations` then `POST /v1/conversations/{cid}/turns` produces two videos whose second turn demonstrably had the first turn's context.
- [ ] A new turn while the latest turn is non-terminal returns `409`.
- [ ] A successful conversation turn does NOT delete the shared workspace; `DELETE /v1/conversations/{cid}` does.
- [ ] Single-shot `POST /v1/videos` behavior is unchanged (`conversation_id = NULL`).
- [ ] `openspec validate add-multi-turn-conversation --strict` passes.
