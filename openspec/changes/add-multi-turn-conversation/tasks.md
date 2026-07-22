# Tasks: add-multi-turn-conversation

**Change ID:** `add-multi-turn-conversation`
**Spec delta:** `openspec/changes/add-multi-turn-conversation/specs/video-conversation/spec.md`
**Repos:** `OpenHarness/` (headless resume) + `service/` (conversation orchestration)

> TDD per task: write failing test → verify fail → implement → verify pass → commit.
> Backend suite: `cd service && python -m pytest -q`. `oh` suite: `cd OpenHarness && python -m pytest -q`.
>
> **Test-infra reality:** `service/tests/` has **no `conftest.py`** — reuse `test_videos_api.py`'s `client`/`db_session`/`setup_db` for API tests and `test_worker.py`'s `sync_db`/`_class_with` for worker tests. New conversation tests follow the same self-contained fixture style.

---

## Phase 0: OpenHarness — headless native session resume

- [ ] 0.1 **Headless resume in `run_print_mode`** — add `resume: str | None` and `continue_session: bool` params; when set, `load_session_by_id`/`load_session_snapshot` and pass `restore_messages`/`restore_tool_metadata` into `build_runtime`; after the turn, `save_session_snapshot`.
  - Files: `OpenHarness/src/openharness/ui/app.py`, `OpenHarness/tests/...`
  - Spec: ADDED "Headless print mode MUST support native session resume"

- [ ] 0.2 **Route `-p` + `--resume/--continue` to print mode** — in `cli.py`, stop the resume block from unconditionally entering `run_repl` when `print_mode` is set; forward `resume`/`continue_session` into `run_print_mode` instead. Lift the `--dry-run` guard note as needed.
  - Files: `OpenHarness/src/openharness/cli.py` (~2436-2519)
  - Spec: ADDED "Headless print mode MUST support native session resume"

- [ ] 0.3 **Emit `session_id`** — `run_print_mode` emits a `{"type":"session","session_id":...}` line in `stream-json` and a stable stderr line in `text` mode; id matches the saved snapshot name.
  - Files: `OpenHarness/src/openharness/ui/app.py`
  - Spec: ADDED "A headless run MUST emit its session id on a machine-readable channel"

**Quality Gate (Phase 0):**
- [ ] `oh -p "x" --resume <sid>` runs with no TTY, restores context, saves snapshot, prints session_id
- [ ] A first run's emitted id round-trips through a second `--resume` run

---

## Phase 1: service — data model + migration

- [ ] 1.1 **`Conversation` model + `VideoTask` columns** — add `Conversation` (id, workspace_path, oh_session_id, title/summary, status, turn_count, created_at, updated_at, expires_at); add `VideoTask.conversation_id` (nullable FK) + `turn_index` (nullable int).
  - Files: `app/models.py`, `tests/test_models*` (or via API tests)
  - Spec: ADDED "A conversation MUST group ordered render turns…" + "…forward migration"

- [ ] 1.2 **Migration after `003`** — `alembic heads` to confirm head, then new revision creating `conversations` + the two columns + index `(conversation_id, turn_index)`; existing rows keep `conversation_id = NULL`.
  - Files: `alembic/versions/<next>_conversations.py`
  - Spec: ADDED "The conversation schema MUST be added via a forward migration"

**Quality Gate (Phase 1):**
- [ ] Migration up/down runs clean; existing single-shot rows unaffected (`conversation_id = NULL`)

---

## Phase 2: service — conversation API

- [ ] 2.1 **Create conversation (turn 0)** — `POST /v1/conversations` creates a conversation + turn-0 `VideoTask` in `workspace_root/<conversation_id>`, enqueues via `get_scheduler().enqueue(...)`; returns `conversation_id`, `task_id`, `turn_index=0`, links. Reuse enqueue-failure compensation semantics.
  - Files: `app/routers/conversations.py` (new), `app/schemas.py`, `app/main.py` (register router), `tests/test_conversations_api.py` (new)
  - Spec: ADDED "A conversation MUST group ordered render turns…"

- [ ] 2.2 **Continue (turn N) + sequential enforcement + cap** — `POST /v1/conversations/{cid}/turns`; `409` if latest turn non-terminal; `409/422` if `turn_count >= max_turns_per_conversation`; else create `turn_index = prev+1`, enqueue with the conversation's `oh_session_id`.
  - Files: `app/routers/conversations.py`, `app/config.py` (`max_turns_per_conversation`), `tests/test_conversations_api.py`
  - Spec: ADDED "Continuation turns MUST resume…", "Turns MUST be sequential", "A per-conversation turn cap MUST bound growth"

- [ ] 2.3 **Get + list** — `GET /v1/conversations/{cid}` returns turns ordered by `turn_index`; `GET /v1/conversations` paginated.
  - Files: `app/routers/conversations.py`, `app/schemas.py`, `tests/test_conversations_api.py`
  - Spec: ADDED "Conversation retrieval MUST expose ordered turns…"

- [ ] 2.4 **Delete (cascade + preserve status)** — `DELETE /v1/conversations/{cid}` removes all turn artifacts + shared workspace + session snapshot; does NOT rewrite per-turn terminal status.
  - Files: `app/routers/conversations.py`, `tests/test_conversations_api.py`
  - Spec: ADDED "…deletion MUST cascade and preserve per-turn status", "…cleanup MUST be deferred…"

**Quality Gate (Phase 2):**
- [ ] `pytest tests/test_conversations_api.py -v` passes (create/continue/get/list/delete, 409 paths, cap)
- [ ] Single-shot `POST /v1/videos` tests still pass unchanged

---

## Phase 3: service — worker integration

- [ ] 3.1 **Conversation workspace reuse + `--resume` injection** — in `generate_video_task`, when `task.conversation_id` is set, use `workspace_root/<conversation_id>` (not per-task) and, for `turn_index > 0`, pass `--resume <oh_session_id>` to `run_oh`.
  - Files: `app/workers/tasks.py`, `tests/test_worker.py`
  - Spec: ADDED "Continuation turns MUST resume…", "…share one workspace"

- [ ] 3.2 **Capture + persist `oh_session_id`** — parse the emitted `session_id` from `oh` output; on turn 0 persist it onto the conversation row.
  - Files: `app/workers/parser.py`, `app/workers/tasks.py`, `tests/test_parser.py`
  - Spec: ADDED "A headless run MUST emit its session id…" (consumer side), "Continuation turns MUST resume…"

- [ ] 3.3 **Deferred cleanup for conversation turns** — a `SUCCEEDED` turn with a `conversation_id` MUST NOT remove its (shared) workspace; single-shot immediate cleanup unchanged. `cleanup_expired_tasks` removes conversation workspaces only at conversation expiry.
  - Files: `app/workers/tasks.py`, `tests/test_worker.py`
  - Spec: ADDED "Conversation workspace/session cleanup MUST be deferred…", "Single-shot video creation MUST remain unchanged"

**Quality Gate (Phase 3):**
- [ ] Turn 1 renders with `--resume <sid>` in the shared workspace; turn 0 persists the session id
- [ ] Successful conversation turn keeps the shared workspace; single-shot success still cleans immediately

---

## Phase 4: End-to-end

- [ ] 4.1 **Two-turn e2e** — create a conversation, run turn 0, then turn 1 with a follow-up that only makes sense with prior context; assert two distinct video artifacts and that turn 1 resumed the session.
  - Files: `service/tests/` (or `scripts/` smoke)
  - Spec: proposal Success Criteria

---

## Completion Checklist
- [ ] All ADDED requirements have passing tests
- [ ] `oh` headless resume works with no TTY and round-trips a session id
- [ ] Sequential-turn `409`, turn cap, deferred cleanup, and delete-cascade all verified
- [ ] Single-shot `/v1/videos` unchanged
- [ ] `cd service && python -m pytest -q` and `cd OpenHarness && python -m pytest -q` green
- [ ] `openspec validate add-multi-turn-conversation --strict` passes
