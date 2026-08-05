## ADDED Requirements

### Requirement: A native backend subprocess MUST persist its snapshot under the stable --resume identity

The session-service derives a stable session identity `oh_session_id = "{cwd.name}-{sha1(resolve(cwd))[:12]}"` *before* spawning the backend, uses it both as the snapshot directory name and as the `--resume` argument, and injects it into the backend process environment as `OH_SESSION_ID`. The native `oh` backend MUST honor `OH_SESSION_ID` (when present) as the `session_id` it uses when persisting snapshots, so that the snapshot file identity and the `--resume` key live in the **same namespace** and RESUME resolves losslessly.

When `OH_SESSION_ID` is unset (native `oh` used outside session-service), the backend MAY fall back to generating an ephemeral `session_id` (e.g. `uuid4().hex[:12]`); this opt-in contract only constrains behavior when the variable is provided.

#### Scenario: snapshot is saved under the injected OH_SESSION_ID
- **WHEN** `oh --backend-only` runs with `OH_SESSION_ID=410d1bc7-...-63c1c29565d3` and completes a turn
- **THEN** the backend writes `sessions/410d1bc7-...-63c1c29565d3/session-410d1bc7-...-63c1c29565d3.json` and a `latest.json` whose `session_id` equals `410d1bc7-...-63c1c29565d3`

#### Scenario: a resumed session loads without "Session not found"
- **WHEN** the supervisor later spawns `oh --resume 410d1bc7-...-63c1c29565d3 --backend-only` for the same `cwd`
- **THEN** the backend finds the snapshot by that id, emits `ready`, and does NOT exit with "Session not found"

#### Scenario: native oh without OH_SESSION_ID keeps legacy behavior
- **WHEN** `oh` runs with no `OH_SESSION_ID` set
- **THEN** it persists snapshots under an ephemeral id (e.g. `session-<12-hex>.json`), behavior unchanged from before this contract

#### Scenario: snapshot directory name always equals its session_id
- **WHEN** any session snapshot exists under `OPENHARNESS_DATA_DIR/sessions/<dir>/`
- **THEN** `<dir>` equals the `session_id` recorded in that directory's `latest.json` (the directory name IS the stable resume identity)
