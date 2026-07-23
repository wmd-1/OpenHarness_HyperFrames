# OpenHarness Interactive Session Service

A stateful, multi-turn interactive session service that bridges the native
`oh --backend-only` line protocol to a WebSocket/REST gateway. Sibling to the
existing `service/` (video-task) backend — both run side-by-side behind a single
nginx, routed by path.

## What it does

- Spawns one `oh --backend-only` subprocess per session (own process group, so a
  crash/timeout is isolated to that session).
- Streams `assistant_delta` / `tool_*` / `turn_complete` events to the client over
  WebSocket in real time.
- Preserves multi-turn context (one long-lived process per session) and survives
  idle eviction / reconnect via `oh --resume` (LIVE ⇄ IDLE → COLD → resume → LIVE).
- Registers per-turn artifacts (videos/files) and serves them with HTTP Range.
- Multi-node affinity: a Redis routing table + transparent reverse-proxy
  forwarding keep a session pinned to its owning node.

## Architecture (protocol bridge)

```
client ──WS──▶ gateway ──stdin (bare JSON)──▶ oh --backend-only
        ◀──WS──        ◀──stdout (OHJSON: lines)──
```

The adapter strips the `OHJSON:` prefix, parses events into loose Pydantic
models (unknown types are forwarded, never dropped), and encodes client ops as
bare-JSON `FrontendRequest` lines. See `app/session/`.

## Layout

```
session-service/
├── app/
│   ├── config.py            # OH_ env settings
│   ├── db.py                # async engine + session factory (reconfigurable)
│   ├── models.py            # conversations / conversation_turns / turn_artifacts
│   ├── security.py          # extra_oh_args allowlist + value validation
│   ├── ratelimit.py         # token-bucket (fail-open)
│   ├── main.py              # FastAPI app + auth middleware
│   ├── routers/             # sessions (REST), ws (streaming), health, metrics
│   ├── session/             # process / adapter / supervisor / lifecycle / registry / proxy / logs
│   ├── storage/             # local + S3 artifact storage
│   └── observability/       # structlog + prometheus + otel
├── alembic/                 # INDEPENDENT migration chain (alembic_version_session)
├── scripts/
│   ├── oh_backend_stub.py   # offline OHJSON stub (no LLM key needed)
│   └── contract_smoke.py    # real oh --backend-only contract check
├── tests/                   # 66 tests (protocol, lifecycle, WS, Range, security…)
└── pyproject.toml
```

## Dual-backend deployment

The video service (`service/`) and this session service run as separate
processes sharing one Postgres + Redis + workspaces volume:

| Path | Backend | Port |
|------|---------|------|
| `/v1/videos/**`, `/healthz` | `service/` (api) | 8000 |
| `/v1/sessions/**` (REST + WS) | `session-service/` (session) | 8001 |

nginx (`web/nginx.conf.template`) routes by path and upgrades the WS handshake
for `/v1/sessions/{sid}/ws`. Redis uses **db=1** for the session service to
avoid colliding with the video service's keyspace (db=0). Migrations use a
separate version table (`alembic_version_session`) so they never touch
`video_tasks` or the video-service migration head.

## Running

```bash
# Build the test image (based on oh-e2e-test:latest — ships oh CLI, chrome, ffmpeg)
docker build -t oh-session-test:latest -f Dockerfile.session-test .

# Run the full test suite (offline, uses the oh backend stub)
docker run --rm oh-session-test:latest

# Contract smoke against the REAL oh --backend-only (needs an API key to start)
docker run --rm --entrypoint /root/.openharness-venv/bin/python \
  -e ANTHROPIC_API_KEY=sk-... oh-session-test:latest \
  /opt/oh-session-service/scripts/contract_smoke.py

# Full stack (video + session + web)
docker compose up
```

## Key design decisions

- **No `lease_token`**: sessions are stateful and not replayable (unlike the
  video service's stateless-replay mechanism).
- **`oh_session_id` derived from `cwd`** before spawn (`{cwd.name}-{sha1(resolve(cwd))[:12]}`),
  so resume works even if no `state_snapshot` event arrives.
- **Single-writer**: at most one turn per session; a concurrent `submit` yields
  a `busy` frame (WS) or `409` (REST).
- **Server-fixed CLI flags**: `--permission-mode`/`--cwd`/`--api-key`/`--resume`/
  `--backend-only` are always injected by the server; caller-supplied
  `extra_oh_args` are allowlist- and value-validated (422 on violation).
```
