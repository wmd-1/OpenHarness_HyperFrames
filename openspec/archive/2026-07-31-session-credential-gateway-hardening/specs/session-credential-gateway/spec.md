# session-credential-gateway Delta Specification

> Change: `session-credential-gateway-hardening` — node-level credential gateway 契约。
> 架构声明：provider credential 是**节点级资产**（node-level credential gateway）；本 change 不引入 tenant secret persistence。

## ADDED Requirements

### Requirement: Provider credentials MUST be injected via process env at backend spawn, never persisted tenant-side

The gateway MUST inject the upstream provider credential into the `oh --backend-only` subprocess environment at spawn time, as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` (selected per the env-var mapping requirement). Tenant-side storage (the MinIO `tenants/{tenant_id}/` prefix, the local staging tree, and the tenant `settings.json`) MUST NEVER contain any secret material. The CLI flag `--api-key` MUST NOT be relied upon for provider authentication (verified ineffective against provider profiles).

#### Scenario: backend authenticates via injected env with a secret-free tenant config
- **WHEN** a backend is spawned with a scrubbed tenant `settings.json` (no credential keys) and the gateway injects the resolved credential env var
- **THEN** the backend reaches `ready` with `auth_status=configured` using the injected credential

#### Scenario: tenant-side artifacts stay secret-free after sessions run
- **WHEN** inspecting the tenant bucket prefix and local staging after sessions have run turns and staged out
- **THEN** no object or file contains any denylisted credential key (`api_key`, `*_token`, `*_secret`, `password`, …)

### Requirement: The tenant settings seed MUST be a recursively scrubbed derivation of the node's global settings

The first-seen tenant seed MUST be derived from the node's global `settings.json` (path configurable via `OH_GLOBAL_SETTINGS_PATH`, default `~/.openharness/settings.json`) by recursively removing secret keys at every nesting level (including `profiles.*`). The denylist (case-insensitive, matching keys equal to or ending with): `api_key`, `token`, `access_token`, `refresh_token`, `auth_token`, `secret`, `client_secret`, `password`, plus the patterns `*_key`/`*_token`/`*_secret`; `credential_slot` MUST be forced to `null`. Non-sensitive provider configuration (model, base_url, api_format, provider, active_profile, profiles) MUST be preserved. After scrubbing, the serialized output MUST be re-asserted to contain none of the denylisted keys. If the global file is missing or unparseable the seed MUST fall back to `{}` with a logged warning.

#### Scenario: seed preserves provider config and drops every secret
- **WHEN** the global settings contain `api_key` at top level and token/secret keys nested inside `profiles.*`
- **THEN** the derived seed retains model/base_url/api_format/profiles/active_profile and contains no denylisted key at any depth

#### Scenario: missing or corrupt global settings degrade to the empty seed
- **WHEN** the global settings file is absent or contains invalid JSON
- **THEN** the seed is `{}` and a warning is logged (no crash, no partial secret leak)

### Requirement: Credential resolution MUST follow the fixed priority chain

The gateway MUST resolve the credential value in exactly this order, falling through level by level, and this contract MUST be locked by tests:

```
OH_PROVIDER_API_KEY                      (explicit gateway-level override)
  > OPENAI_API_KEY / ANTHROPIC_API_KEY   (the mapped env var already present in the service process env)
  > global settings.json api_key         (node-level file)
  > none                                 (no injection; warning logged; oh's own fallback applies)
```

All env levels MUST be read from live `os.environ` (not a startup snapshot). A scrubbed tenant `settings.json` MUST NOT be able to override the injected env credential (it physically contains no credential keys, and the subprocess env override order keeps injected values authoritative).

#### Scenario: gateway-level override wins over all lower levels
- **WHEN** `OH_PROVIDER_API_KEY`, the mapped env var, and the global file `api_key` all carry different values
- **THEN** the injected credential equals `OH_PROVIDER_API_KEY`

#### Scenario: mapped env var beats the file value
- **WHEN** `OH_PROVIDER_API_KEY` is unset, the mapped env var is set, and the global file carries a different `api_key`
- **THEN** the injected credential equals the mapped env var's value

#### Scenario: file fallback and none
- **WHEN** only the global file carries an `api_key` — or no level carries a value
- **THEN** the file value is injected — or nothing is injected and a warning is logged

### Requirement: The credential env var name MUST be mapped from the global provider profile

The env var to inject MUST be selected from the global settings: `profiles[active_profile].auth_source` `openai_api_key` → `OPENAI_API_KEY`, `anthropic_api_key` → `ANTHROPIC_API_KEY`; when the active profile is missing or its auth_source is unrecognized, fall back to top-level `api_format` (`openai` → `OPENAI_API_KEY`, `anthropic` → `ANTHROPIC_API_KEY`); when still undecidable, no credential is injected and a warning is logged.

#### Scenario: auth_source drives the mapping
- **WHEN** the active profile's auth_source is `openai_api_key`
- **THEN** the credential is injected as `OPENAI_API_KEY`

#### Scenario: api_format fallback covers a missing profile
- **WHEN** `active_profile` is absent but top-level `api_format` is `anthropic`
- **THEN** the credential is injected as `ANTHROPIC_API_KEY`

### Requirement: Credential resolution MUST happen at each spawn with no caching

The resolver MUST NOT cache credential values or parsed global settings across spawns: every backend spawn re-reads `os.environ` and the global settings file, so credential rotation or environment changes take effect on the next spawn without restarting session-service. A read or parse failure of the file MUST be treated as "level absent" (fall through to the next priority level), never as a crash.

#### Scenario: rotation takes effect without a service restart
- **WHEN** the global settings `api_key` is changed while session-service keeps running
- **THEN** the next spawned backend receives the new value (and reverting the file restores the old behavior, again without restart)

### Requirement: A legacy-seed repair tool MUST classify and repair existing tenant settings safely

A gateway-operated script MUST walk every `tenants/*/openharness/settings.json` in the bucket and classify it as: `empty_seed` (parses to `{}`) — the ONLY class automatically rewritten with the derived scrubbed seed (bucket and, when present, local staging together); `invalid` (unparseable JSON, missing essential provider fields, or containing denylisted secret keys) — reported per-tenant with a redacted summary and NEVER modified; `ok` (non-empty valid config) — skipped and NEVER overwritten. The tool MUST default to dry-run, require an explicit `--apply` to write, and report `repaired / skipped_ok / invalid / failed` counts.

#### Scenario: only the legacy empty seed is rewritten
- **WHEN** the tool runs with `--apply` against a bucket containing a `{}` seed, a customized valid config, and a corrupt file
- **THEN** only the `{}` seed is replaced with the derived seed; the other two are untouched and the corrupt one appears in the `invalid` report

#### Scenario: dry-run never writes
- **WHEN** the tool runs without `--apply`
- **THEN** the full classification report is produced and no object or staging file is modified

### Requirement: The real-backend startup contract MUST be verifiable via an env-gated test

An integration test using the real `oh` binary inside the existing image MUST verify the full chain — scrubbed tenant settings + injected env credential → backend emits `ready` with `auth_status=configured` — and the negative form — same scrubbed settings with no credential env → non-zero exit mentioning the missing-key error. This test MUST be gated by `OH_REAL_BACKEND_TEST=1` (skipped entirely by default) so the default pytest suite stays stub-based and credential-free.

#### Scenario: positive chain guards the auth_source/env contract
- **WHEN** the gated test spawns the real backend with a scrubbed config dir and the resolved credential env
- **THEN** `ready` arrives within the startup timeout with provider/base_url matching the global settings

#### Scenario: negative chain locks the failure shape
- **WHEN** the gated test spawns the real backend with the same scrubbed config dir and all credential envs removed
- **THEN** the process exits non-zero and its output contains the no-API-key error, proving credentials flow only through the gateway's injection
