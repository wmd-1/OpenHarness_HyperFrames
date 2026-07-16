# Delta Spec: Monorepo Layout (OpenHarness_HyperFrames)

## ADDED Requirements

### Requirement: Repository top-level layout
The repository root SHALL contain first-class sibling directories:
`OpenHarness/` (the OpenHarness framework), `service/` (the FastAPI video
backend), and `web/` (the web frontend), plus `openspec/`, the Docker build
files (`Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.gitignore`),
and build-context assets (`hyperframes_github_skills/`, `docker/`, `ohmo/`,
`output_hyperframes/`).

#### Scenario: framework stays isolated
- **Given** the OpenHarness framework core lives under `OpenHarness/src/`
- **When** the repo is checked out
- **Then** `service/` and `web/` exist as siblings of `OpenHarness/`, not
  nested inside it.

### Requirement: Docker build context is the repo root
The `docker compose` build context SHALL be the repository root (`.`). The
`Dockerfile` COPYs (`hyperframes_github_skills/`, `docker/chrome/...`,
`service`, `docker/supervisord.conf`) SHALL resolve relative to the repo root.
Framework source is NOT baked into the image; it is mounted at runtime via
`/app/src` (compose volume `./OpenHarness/src:/app/src`).

#### Scenario: compose mounts framework from OpenHarness/
- **Given** the build context is the repo root
- **When** `docker compose up` starts the `openharness` or `api` service
- **Then** `./OpenHarness/src:/app/src`, `./OpenHarness/ohmo:/app/ohmo`,
  `./OpenHarness/frontend:/app/frontend` are mounted, and
  `./service:/opt/oh-service` is mounted for the `api` service.

### Requirement: Backend test location
The backend's tests SHALL live at `service/tests/` and be run with `pytest`
from the `service/` directory. `service/pyproject.toml` SHALL set
`testpaths = ["tests"]` and include the service root on `pythonpath` so the
`app` package is importable.

#### Scenario: backend tests pass after restructure
- **Given** tests were moved from `OpenHarness/tests/service/` to `service/tests/`
- **When** `cd service && python -m pytest` runs
- **Then** all backend tests pass (baseline ~78 passed).

### Requirement: Frontend dev proxy to backend
The `web/` frontend SHALL be a Vite + React + TypeScript app. During
development it SHALL proxy API requests (`/v1`, `/healthz`) to the backend
at `http://localhost:8000` so no CORS configuration is required in dev.

#### Scenario: dev frontend reaches backend without CORS
- **Given** the `web` dev server runs and the `api` container exposes `:8000`
- **When** the UI calls `/v1/videos`
- **Then** Vite proxies to `http://localhost:8000/v1/videos`.

### Requirement: Production CORS
When the frontend is served from a different origin than the API, the backend
SHALL allow that origin via `OH_CORS_ORIGINS` (comma-separated). With
`OH_CORS_ORIGINS` empty, no cross-origin requests are permitted.

#### Scenario: explicit origin allowed
- **Given** `OH_CORS_ORIGINS=https://app.example.com`
- **When** a browser at that origin calls the API
- **Then** the response includes the matching CORS headers.

## MODIFIED Requirements
(none — backend API surface is unchanged; this change only relocates code.)
