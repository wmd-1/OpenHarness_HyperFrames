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

## Production deployment notes (security)

- **Enable auth in production**: the service defaults to *open mode* (no
  auth) for local development. Set `OH_API_KEY=<random secret>` and
  `OH_REQUIRE_AUTH=true` (both forwarded by `docker-compose.yml`) before
  exposing the service beyond localhost. With auth enabled, only the GET
  download endpoints (turn artifact + workspace file) accept `?api_key=` as
  a fallback for `<a>`/`<video>` elements; everything else is header-only
  (`X-API-Key`).
- **Single worker per process — always**: `SessionSupervisor` /
  `ContainerPool` / `SessionRegistry` are in-process singletons holding live
  subprocess handles, the admission queue and approval futures. The service
  fail-fasts at startup if `OH_API_WORKERS != 1`. Scale horizontally by
  running more *nodes* (`OH_NODE_ID` + Redis routing table), never more
  uvicorn workers.
- **Multi-node proxying is plaintext `ws://`**: the transparent WS
  reverse-proxy between gateway nodes (`app/session/proxy.py`) forwards the
  client's `X-API-Key` over unencrypted `ws://` to the owning node. Node-to-
  node traffic MUST stay on a trusted/encrypted internal network (compose
  network, VPC, WireGuard/mTLS mesh) — never across the public internet.
- **Port binding**: compose publishes the gateway as `127.0.0.1:8001` only;
  external clients go through the nginx front (`web/`), which also
  terminates TLS and upgrades the WS handshake.

## Multi-tenant auth & data isolation (WS-A / WS-B)

- **Multi-key auth (WS-A)**: besides the legacy single `OH_API_KEY` (tenant
  `default`), keys live hashed in the `api_keys` table and map to a
  `tenant_id` (`scripts/manage_api_keys.py create/revoke/list`). Resolution
  is TTL-cached in-process (`OH_APIKEY_CACHE_TTL`, default 60s — the upper
  bound for revocation to take effect). Sessions are tenant-scoped: foreign
  sessions are indistinguishable from missing ones (404).
- **MinIO as the authoritative tenant store (WS-B)**: when
  `OH_MINIO_ENDPOINT` is set, tenant memory/session data lives under the
  bucket prefix `tenants/{tid}/` (`OH_MINIO_BUCKET`, default `oh-tenants`).
  Nodes are stateless: create/rehydrate **stage-in** to the local scratch
  tree `OH_TENANTS_ROOT` (`/tenants`), and turn-complete / evict / close /
  orphan-reap **stage-out** back to the bucket (retry with backoff, then
  `oh_tenant_sync_failures_total`). MinIO unreachable ⇒ `503` fail-fast, no
  session starts without authoritative data. Staged `rules/` are snapshotted
  into `{cwd}/.claude/rules` at create.
- **Loss-window SLO**: a node crash loses at most the memory delta since the
  last stage-out (i.e. the last completed turn).
- **Single active session per tenant**: `OH_TENANT_MAX_CONCURRENT` defaults
  to `1`, which together with the per-tenant sync lock removes concurrent
  writers on a tenant prefix; raising it accepts last-writer-wins on tenant
  data.

## Pooled admission (WS-D)

Every create/rehydrate acquires a slot from `ContainerPool` (all
check-and-claim steps are event-loop-atomic):

1. tenant concurrency quota (`OH_TENANT_MAX_CONCURRENT`) → `429`;
2. node capacity `OH_MAX_LIVE_SESSIONS` (default 16) — admit if below;
3. full ⇒ evict the longest-idle IDLE session to COLD to free a slot;
4. nothing evictable ⇒ bounded FIFO wait queue (`OH_POOL_QUEUE_SIZE`,
   default 32; `OH_POOL_QUEUE_TIMEOUT`, default 15s). Queue full or timed
   out ⇒ `503` + `Retry-After`; `OH_POOL_QUEUE_SIZE=0` degrades to the old
   fail-fast `503`. Per-tenant queue occupancy is capped by the same quota.

Freed slots (exit/destroy/evict/failed spawn) wake the queue head. Metrics:
`oh_pool_backends_live`, `oh_pool_queue_depth`, `oh_pool_queue_wait_seconds`,
`oh_pool_evictions_total`, `oh_pool_admission_rejected_total{reason}`,
`oh_session_create_duration_seconds`.

## Container runtime & docker.sock (WS-C)

With `OH_SESSION_RUNTIME=container` each session runs in a **disposable**
docker container (image = `OH_SESSION_IMAGE`, the existing main image tag —
never rebuilt), bridged over the docker attach stream. Containers are labeled
`oh.sid`/`oh.tenant`/`oh.node`, run with `cap_drop=ALL` (toggle:
`OH_CONTAINER_CAP_DROP`), `no-new-privileges`, `pids_limit`, mem/cpu limits
and no published ports, and are force-deleted after use — never reused.

> **⚠ docker.sock is root-equivalent.** The compose file mounts
> `/var/run/docker.sock` into the session gateway only; anyone who can reach
> that socket controls the host. Keep the gateway container itself
> unreachable from untrusted networks, and for defense-in-depth point
> `OH_DOCKER_HOST` at a [docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy)
> that only allows `create/start/attach/kill/delete/events/ping` — the
> gateway needs nothing else. The `process` runtime (default) does not use
> the socket at all.

Sibling-container mounts come from `OH_CONTAINER_BINDS` (comma-separated
`source:dest[:mode]`, defaulting to the compose named volumes for
`/workspaces`, `/tenants`, videos and `~/.openharness`). Deployments that
mount OpenHarness source into the gateway must append the equivalent
*host-path* binds here — named volumes resolve on the host dockerd, not
inside the gateway.
