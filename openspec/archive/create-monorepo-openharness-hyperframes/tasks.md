# Tasks — Create OpenHarness_HyperFrames Monorepo

## Phase 0 — Prep
- [ ] Note baseline for reference only: `git -C OpenHarness log --oneline -1`.

## Phase 1 — Create repo + copy framework
- [ ] `mkdir -p OpenHarness_HyperFrames` at workspace root.
- [ ] `git init` in `OpenHarness_HyperFrames`.
- [ ] Copy `OpenHarness/` tree (exclude `.git`, `service`, `tests/service`) →
      `OpenHarness_HyperFrames/OpenHarness/` via a `tar` pipe (avoids `.git`).
- [ ] Copy `service/` → `OpenHarness_HyperFrames/service/`.
- [ ] Copy `tests/service/` → `OpenHarness_HyperFrames/service/tests/`.

## Phase 2 — Promote repo-level build artifacts to root
- [ ] Move to repo root: `Dockerfile`, `docker-compose.yml`, `.dockerignore`,
      `.gitignore`, `.env.example`, `README.md`, `hyperframes_github_skills/`,
      `docker/`, `ohmo/`, `output_hyperframes/`, `openspec/`.
- [ ] Confirm `OpenHarness/` now contains: `src/`, `frontend/`, framework
      `tests/` (no `service/`, no `tests/service/`).

## Phase 3 — Fix backend test config
- [ ] Edit `service/pyproject.toml`: `testpaths = ["tests"]`, add
      `pythonpath = ["."]`.
- [ ] `cd service && python -m pytest` → green (expect ~78 passed).
      Fix imports if needed.

## Phase 4 — Rewrite docker-compose.yml mounts
- [ ] Prefix framework volume mounts with `OpenHarness/`:
      `src`, `ohmo`, `frontend`, `output_hyperframes`.
- [ ] Keep `./service:/opt/oh-service` (repo root, unchanged).
- [ ] Verify `build.context: .` resolves to the new repo root.

## Phase 5 — Frontend scaffold (web/)
- [ ] Create `web/` (Vite + React + TS): `package.json`, `vite.config.ts`
      (proxy `/v1` + `/healthz` → `:8000`), `tsconfig.json`,
      `tsconfig.node.json`, `index.html`, `src/main.tsx`, `src/api.ts`
      (typed client), `src/App.tsx` (submit → poll → file/events),
      `.env.example`, `README.md`.
- [ ] `cd web && npm install && npm run build` (or `npx tsc --noEmit`) → OK.

## Phase 6 — Root README + commit
- [ ] Write repo-root `README.md`: monorepo layout, how to run backend
      (`docker compose up`) + frontend (`web/`), and the CORS note
      (`OH_CORS_ORIGINS` for prod).
- [ ] `git -C OpenHarness_HyperFrames add -A && git commit -m "chore: init
      OpenHarness_HyperFrames monorepo (framework + service + web)"`.

## Phase 7 — Retire old in-place proposal
- [ ] (Already removed) `openspec/changes/restructure-top-level-layout/`.
- [ ] Leave original `OpenHarness/` as a backup; do not delete.
