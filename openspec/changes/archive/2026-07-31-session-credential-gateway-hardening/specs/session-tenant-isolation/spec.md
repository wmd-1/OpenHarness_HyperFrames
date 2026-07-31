# session-tenant-isolation Delta Specification

> Change: `session-credential-gateway-hardening` — seed 派生与 secret 红线细化。

## MODIFIED Requirements

### Requirement: A first-seen tenant MUST be seeded idempotently in the bucket

When a session is created for a `tenant_id` whose prefix does not exist in the bucket, the gateway MUST seed `tenants/{tenant_id}/openharness/settings.json` from a server-owned template, inside the per-tenant sync lock. The template MUST be the recursively scrubbed, credential-free derivation of the node's global `settings.json` (per the `session-credential-gateway` seed requirement) — it carries the non-sensitive provider configuration (model, base_url, api_format, provider, active_profile, profiles) the backend needs to start, and MUST NEVER contain any secret. When the global settings file is missing or unparseable the template degrades to `{}`. Seeding MUST be idempotent (retries and races cannot corrupt or duplicate the seed). Tenants MUST NOT be able to influence the template content in this change.

#### Scenario: repeated first-create seeds exactly once
- **WHEN** the first create-session for a brand-new tenant is retried after a transient failure
- **THEN** the tenant prefix ends up with exactly one server-seeded `settings.json` and the session proceeds against it

#### Scenario: a first-seen tenant's backend starts with provider config but no secret
- **WHEN** a brand-new tenant's first session spawns its backend against the freshly seeded staging
- **THEN** the backend resolves the correct provider profile from the seed, authenticates via the gateway-injected env credential, and the seed file contains no denylisted credential key

### Requirement: The backend MUST be pointed at the staged tenant directory in both runtimes

In `process` runtime the gateway MUST inject `OPENHARNESS_CONFIG_DIR`/`OPENHARNESS_DATA_DIR` (resolving into `{tenants_root}/{tenant_id}/openharness/`) into the spawned `oh --backend-only` environment, together with the resolved provider credential env var (`OPENAI_API_KEY`/`ANTHROPIC_API_KEY`, per the `session-credential-gateway` priority and mapping contract). In `container` runtime the gateway MUST bind-mount `{tenants_root}/{tenant_id}/openharness/` to `/root/.openharness` at container create time. Credentials (upstream LLM API keys) MUST NOT be stored in the bucket or the staging directory — the prohibition is testable as the recursive denylist contract (`api_key`, `*_key`, `*_token`, `*_secret`, `token`, `secret`, `password` at any nesting depth); they remain server-injected via environment, resolved fresh at every spawn.

#### Scenario: user-scope agent memory is isolated between tenants
- **WHEN** a session of tenant A writes user-scope agent memory (`data/agent-memory/{agent_type}/`) and tenant B then runs a session with the same agent type
- **THEN** tenant B's session cannot read tenant A's entries

#### Scenario: user-scope agent memory is shared within a tenant
- **WHEN** one session of tenant A writes user-scope agent memory, the session ends, and a later session of tenant A starts (possibly on another node)
- **THEN** the later session reads the memory written by the first, round-tripped through MinIO

#### Scenario: no credential material in bucket or staging
- **WHEN** inspecting the `tenants/{tenant_id}/` prefix and the local staging directory after sessions have run
- **THEN** no upstream API-key/credential material is present in any object or file — no denylisted key exists at any nesting depth of any staged JSON document

#### Scenario: credential env accompanies the config redirection
- **WHEN** a `process`-runtime backend is spawned for any tenant
- **THEN** its environment carries both the tenant staging redirection (`OPENHARNESS_CONFIG_DIR`/`OPENHARNESS_DATA_DIR`) and the gateway-resolved credential env var (when one is resolvable), and the injected credential takes precedence over any inherited env value
