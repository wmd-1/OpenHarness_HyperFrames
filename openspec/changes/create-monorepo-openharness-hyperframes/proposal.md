# Proposal: Create OpenHarness_HyperFrames Monorepo

## Status
Proposed

## Summary
Create a brand-new git repository **`OpenHarness_HyperFrames`** at
`D:/WorkBuddy-Workspace/Openharness_hyperframes_Development/OpenHarness_HyperFrames/`
that consolidates **all current project code** into one repo with a clean,
flat top-level layout where the OpenHarness framework, the FastAPI video
backend (`service/`), and the new web frontend (`web/`) are independent,
sibling directories.

This **replaces** the earlier in-place `restructure-top-level-layout`
proposal (which kept everything nested under `OpenHarness/`). The user
reversed that direction in favor of a single new repo.

## Motivation
- The backend (`service/`) and the new frontend (`web/`) are independent of
  the OpenHarness framework and should be first-class siblings, not nested
  inside the framework tree.
- A single new repo yields one git history and avoids the earlier
  "service leaves `OpenHarness/.git`" problem.
- User explicitly asked: *"新开一个新的仓库，名字叫 OpenHarness_HyperFrames，
  里面包含所有的代码"*.

## Target Layout (new repo root)
```
OpenHarness_HyperFrames/                 <- git init here; build context = this dir
├── OpenHarness/                        <- framework (copied from OpenHarness/)
│   ├── src/openharness/               <- framework core (mounted at /app/src)
│   ├── frontend/terminal/             <- existing React TUI (mounted /app/frontend)
│   ├── tests/                         <- FRAMEWORK tests (backend tests moved out)
│   └── ... (rest of framework tree)
├── service/                           <- backend (copied from OpenHarness/service/)
│   ├── app/                           <- FastAPI + Celery + routers/schemas/workers
│   ├── alembic/                       <- migrations
│   ├── tests/                         <- backend tests (moved from OpenHarness/tests/service/)
│   └── pyproject.toml               <- testpaths fixed -> ["tests"]
├── web/                               <- NEW frontend (Vite + React + TS scaffold)
├── openspec/                          <- project specs (moved from OpenHarness/openspec/)
├── docker/                            <- chrome zip + supervisord.conf (Dockerfile COPY target)
├── hyperframes_github_skills/         <- baked into image (/opt/oh-skills-builtin)
├── ohmo/                             <- mounted /app/ohmo
├── output_hyperframes/               <- mounted /app/videos source
├── Dockerfile                         <- build context = repo root
├── docker-compose.yml                 <- framework mounts prefixed with OpenHarness/
├── .dockerignore / .gitignore / .env.example / README.md
```

## What moves / what changes
1. **Copy** (not move — original `OpenHarness/` is kept as backup, per user)
   the entire `OpenHarness/` working tree (excluding `.git`, and excluding
   `service/` + `tests/service/` which are handled separately) into
   `OpenHarness_HyperFrames/OpenHarness/` as the framework subdir.
2. **Copy** `service/` → `OpenHarness_HyperFrames/service/` (backend, repo root).
3. **Copy** backend tests `tests/service/` → `service/tests/`; fix
   `service/pyproject.toml` `testpaths = ["tests"]` (was `["../../tests/service"]`)
   and add `pythonpath = ["."]` so the `app` package imports.
4. **Promote to repo root** the build-context artifacts the Dockerfile/compose
   reference at the build root: `Dockerfile`, `docker-compose.yml`,
   `.dockerignore`, `.gitignore`, `.env.example`, `README.md`,
   `hyperframes_github_skills/`, `docker/`, `ohmo/`, `output_hyperframes/`,
   and `openspec/`.
   Remaining inside `OpenHarness/`: `src/`, `frontend/`, framework `tests/`,
   and other framework files — **no `service/` and no `tests/service/`**.
5. **Rewrite `docker-compose.yml`** volume mounts — prefix framework mounts
   with `OpenHarness/`:
   - `./src:/app/src` → `./OpenHarness/src:/app/src`
   - `./ohmo:/app/ohmo` → `./OpenHarness/ohmo:/app/ohmo`
   - `./frontend:/app/frontend` → `./OpenHarness/frontend:/app/frontend`
   - `./output_hyperframes/videos:/app/videos` → unchanged (already at repo root)
   - `./service:/opt/oh-service` → unchanged (service is now at repo root)
   - `build.context: .` stays = repo root.
   **The `Dockerfile` needs ZERO edits** — its `COPY` lines
   (`hyperframes_github_skills/`, `docker/chrome/...`, `service`,
   `docker/supervisord.conf`) all resolve because those dirs/files are now
   at the repo root. Framework source is never baked in (only mounted at
   runtime via `/app/src`), so nothing else changes.

## Backend API the frontend must correspond to
FastAPI *"OpenHarness Video Service"* v0.1.0, base path `/v1/videos` + `/healthz`:
| Method | Path | Body / Returns |
|--------|------|----------------|
| GET | `/healthz` | `{status, db, redis}` |
| POST | `/v1/videos` (201) | body `{prompt:str(1–8000), timeout_seconds:int(30–3600)=900, extra_oh_args:str[]=[], idempotency_key?:str}` → `{task_id, status, links{self,file,events}}` |
| GET | `/v1/videos/{task_id}` | `VideoTaskResponse` (full task detail) |
| GET | `/v1/videos/{task_id}/file` | stream `video/mp4` (supports HTTP Range) |
| GET | `/v1/videos/{task_id}/events` | SSE (`event: log` / `done` / `error`) |
| DELETE | `/v1/videos/{task_id}` | cancel (queued/running) or delete (done) → `{task_id, status, message}` |

- **CORS**: backend allows only `OH_CORS_ORIGINS` (comma-separated); empty ⇒
  no cross-origin. **In dev**, the frontend uses a Vite proxy to `:8000`,
  so no CORS config is needed. **In prod**, set `OH_CORS_ORIGINS` to the
  web origin.

## Frontend scaffold (`web/`) — scope
A **minimal but real** Vite + React + TypeScript scaffold that demonstrably
corresponds to the backend:
- `vite.config.ts` dev proxy: `/v1` and `/healthz` → `http://localhost:8000`.
- `src/api.ts`: typed client for the schemas above.
- `src/App.tsx`: submit prompt → `POST /v1/videos` → poll
  `GET /v1/videos/{id}` → show status + link to `/file` and `/events` (SSE).
- `.env.example` (`VITE_API_BASE=/`), `README.md` (run instructions).

Full product UI (auth, task history list, error UX, pagination) is a
**FOLLOW-UP** OpenSpec change, explicitly out of scope here.

## Non-Goals
- No full production frontend (deferred to next change).
- No `docker build` / `docker compose build` execution in this change
  (network-heavy: downloads Chrome, Kokoro + Whisper models). Build
  correctness is verified by inspection of `COPY`/volume path mapping.
- Original `OpenHarness/` is kept as a backup (user chose copy, not move);
  its `.git` history is preserved untouched. The new repo starts with a
  fresh `git init` + single initial commit (no inherited history).

## Risks / Mitigations
- **pytest import paths**: after moving tests into `service/tests`, run
  `cd service && python -m pytest`; fix `pyproject.toml` (add
  `pythonpath = ["."]`) so `app` is importable. Target: tests pass
  (baseline ~78 passed per project memory).
- **Compose relative mounts**: `./service` resolves from repo root (now the
  build context). The earlier `../service` anti-pattern is avoided.
- **Large local copy**: use `tar` pipe excluding `.git` to avoid copying
  the old history; `hyperframes_github_skills/` may be sizable but copy is local.
- **CORS in prod**: documented; requires `OH_CORS_ORIGINS` set to the web
  origin when served from a different host than the API.

## Verification
- `cd OpenHarness_HyperFrames/service && python -m pytest` → green (~78 passed).
- `cd OpenHarness_HyperFrames/web && npm install && npm run build`
  (or `npx tsc --noEmit`) → builds / typechecks.
- `git -C OpenHarness_HyperFrames status` shows the new tree; initial commit made.
- Docker: inspected path mapping is correct; full `docker compose build` is left
  as a manual step for the user (network-heavy).
