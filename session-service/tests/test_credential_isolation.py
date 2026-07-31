"""Credential gateway tests (openspec session-credential-gateway-hardening, 5.1-5.3).

Three layers, all offline (no MinIO, no real backend):

- seed derivation (tenant_store.settings_seed): non-sensitive fields survive,
  denylisted keys are stripped at every nesting depth (full recursive key
  scan), missing/corrupt global file degrades to ``{}``; first-seen stage-in
  seeds the derived scrubbed copy (fake MinIO);
- resolver priority chain (credentials.resolve_provider_credential):
  OH_PROVIDER_API_KEY > mapped env var > global settings api_key > None, and
  the auth_source/api_format -> env var mapping quadrants;
- no-cache + override-order invariants: rotation is picked up by the very
  next resolve; supervisor-injected env_overrides beat the ambient process
  env in OhBackendProcess._build_env.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

from app.config import settings
from app.session import credentials, tenant_store
from tests.test_workspace_store import FakeMinio

# A realistic global settings file: provider config worth keeping mixed with
# credential material at several nesting depths (denylist coverage: explicit
# names + *_key/*_token/*_secret patterns + credential_slot).
GLOBAL_SETTINGS = {
    "model": "gpt-5",
    "base_url": "https://llm.example.com/v1",
    "api_format": "openai",
    "active_profile": "prod",
    "api_key": "sk-top-level-secret",
    "access_token": "tok-access",
    "token": "tok-bare",
    "secret": "s3cret",
    "password": "pw",
    "signing_key": "sig-key",
    "profiles": {
        "prod": {
            "model": "gpt-5",
            "auth_source": "openai_api_key",
            "client_secret": "cs-nested",
            "credential_slot": "slot-1",
        },
        "alt": {"auth_source": "anthropic_api_key", "refresh_token": "rt"},
    },
    "mcp_servers": [{"name": "browser", "auth_token": "at-in-list"}],
}


def _all_keys(node: object, out: set[str]) -> set[str]:
    """Collect every dict key at every nesting depth (full key-name scan)."""
    if isinstance(node, dict):
        for key, value in node.items():
            out.add(str(key))
            _all_keys(value, out)
    elif isinstance(node, list):
        for item in node:
            _all_keys(item, out)
    return out


@pytest.fixture()
def global_settings(tmp_path, monkeypatch) -> Path:
    """Point the gateway at a per-test global settings path (not yet written)."""
    path = tmp_path / "global-settings.json"
    monkeypatch.setattr(settings, "global_settings_path", path)
    return path


@pytest.fixture()
def clean_cred_env(monkeypatch):
    """Strip every credential env var the resolver reads (hermetic chain)."""
    for var in ("OH_PROVIDER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"):
        monkeypatch.delenv(var, raising=False)


# --- 5.1 seed derivation ---------------------------------------------------------


def test_seed_keeps_nonsensitive_and_strips_denylist_recursively(global_settings):
    global_settings.write_text(json.dumps(GLOBAL_SETTINGS))
    seed = json.loads(tenant_store.settings_seed())

    # Non-sensitive provider configuration survives.
    assert seed["model"] == "gpt-5"
    assert seed["base_url"] == "https://llm.example.com/v1"
    assert seed["api_format"] == "openai"
    assert seed["active_profile"] == "prod"
    assert seed["profiles"]["prod"]["auth_source"] == "openai_api_key"
    assert seed["mcp_servers"][0]["name"] == "browser"

    # Full recursive key-name scan: no denylisted key at any depth.
    keys = _all_keys(seed, set())
    assert not any(tenant_store._is_secret_key(k) for k in keys), keys
    # credential_slot is kept but forced to null.
    assert seed["profiles"]["prod"]["credential_slot"] is None


def test_seed_missing_file_falls_back_empty(global_settings):
    assert not global_settings.exists()
    assert json.loads(tenant_store.settings_seed()) == {}


@pytest.mark.parametrize("body", ["{not json", '["root", "is", "a", "list"]'])
def test_seed_corrupt_or_nonobject_falls_back_empty(global_settings, body):
    global_settings.write_text(body)
    assert json.loads(tenant_store.settings_seed()) == {}


@pytest.mark.asyncio
async def test_stage_in_first_seen_seeds_derived_scrubbed_copy(
    global_settings, tmp_path, monkeypatch
):
    """First-seen tenant gets the derived seed (bucket + staging), secret-free."""
    global_settings.write_text(json.dumps(GLOBAL_SETTINGS))
    fake = FakeMinio()
    monkeypatch.setattr(settings, "minio_endpoint", "minio:9000")
    monkeypatch.setattr(settings, "tenants_root", tmp_path / "tenants")
    monkeypatch.setattr(tenant_store, "_client", lambda: fake)
    tenant_store._tenant_locks.clear()

    tid = f"t-{uuid.uuid4().hex[:10]}"
    await tenant_store.stage_in(tid)

    body = fake.store[f"tenants/{tid}/openharness/settings.json"]
    seeded = json.loads(body.decode("utf-8"))
    assert seeded["api_format"] == "openai"  # a derived copy, not the old `{}`
    assert not any(tenant_store._is_secret_key(k) for k in _all_keys(seeded, set()))
    assert b"sk-top-level-secret" not in body

    local = tenant_store.local_config_dir(tid) / "settings.json"
    assert local.read_bytes() == body  # staging mirrors the bucket seed


# --- 5.2 resolver priority chain + env var mapping --------------------------------


def _write_openai(global_settings: Path, api_key: str | None = "sk-file") -> None:
    cfg: dict = {"api_format": "openai"}
    if api_key is not None:
        cfg["api_key"] = api_key
    global_settings.write_text(json.dumps(cfg))


def test_priority_gateway_override_wins(global_settings, clean_cred_env, monkeypatch):
    _write_openai(global_settings)
    monkeypatch.setenv("OH_PROVIDER_API_KEY", "sk-gateway")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-env")
    assert credentials.resolve_provider_credential() == ("OPENAI_API_KEY", "sk-gateway")


def test_priority_mapped_env_beats_file(global_settings, clean_cred_env, monkeypatch):
    _write_openai(global_settings)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-env")
    assert credentials.resolve_provider_credential() == ("OPENAI_API_KEY", "sk-env")


def test_priority_file_is_last_resort(global_settings, clean_cred_env):
    _write_openai(global_settings)
    assert credentials.resolve_provider_credential() == ("OPENAI_API_KEY", "sk-file")


def test_priority_all_levels_empty_returns_none(global_settings, clean_cred_env):
    _write_openai(global_settings, api_key=None)
    assert credentials.resolve_provider_credential() is None


def test_undetermined_env_var_returns_none_even_with_override(
    global_settings, clean_cred_env, monkeypatch
):
    """No auth_source/api_format -> no injection target, whole chain is moot."""
    global_settings.write_text(json.dumps({"model": "gpt-5"}))
    monkeypatch.setenv("OH_PROVIDER_API_KEY", "sk-gateway")
    assert credentials.resolve_provider_credential() is None


@pytest.mark.parametrize(
    "cfg,expected",
    [
        # auth_source of the active profile decides.
        (
            {"active_profile": "p", "profiles": {"p": {"auth_source": "openai_api_key"}}},
            "OPENAI_API_KEY",
        ),
        (
            {"active_profile": "p", "profiles": {"p": {"auth_source": "anthropic_api_key"}}},
            "ANTHROPIC_API_KEY",
        ),
        # Unknown auth_source falls back to the top-level api_format.
        (
            {
                "active_profile": "p",
                "profiles": {"p": {"auth_source": "vault"}},
                "api_format": "anthropic",
            },
            "ANTHROPIC_API_KEY",
        ),
        # No profiles at all: api_format alone.
        ({"api_format": "openai"}, "OPENAI_API_KEY"),
        # Nothing to go on.
        ({"model": "gpt-5"}, None),
    ],
)
def test_target_env_var_mapping(cfg, expected):
    assert credentials._target_env_var(cfg) == expected


# --- 5.3 no-cache + override order -------------------------------------------------


def test_resolver_is_uncached(global_settings, clean_cred_env):
    """Rotation contract: the very next resolve sees the rewritten file."""
    _write_openai(global_settings, api_key="sk-old")
    assert credentials.resolve_provider_credential() == ("OPENAI_API_KEY", "sk-old")
    _write_openai(global_settings, api_key="sk-new")
    assert credentials.resolve_provider_credential() == ("OPENAI_API_KEY", "sk-new")


def test_env_credential_not_overridable_by_settings_file(
    global_settings, clean_cred_env, monkeypatch
):
    """Injection wins: the seed carries no credential key a tenant could set,
    and _build_env applies the supervisor's overrides AFTER os.environ."""
    from app.session.process import OhBackendProcess

    global_settings.write_text(json.dumps(GLOBAL_SETTINGS))
    seed = json.loads(tenant_store.settings_seed())
    assert not any(tenant_store._is_secret_key(k) for k in _all_keys(seed, set()))

    monkeypatch.setenv("OPENAI_API_KEY", "sk-ambient")
    proc = OhBackendProcess(
        cwd=Path("/tmp"),
        permission_mode="full_auto",
        env_overrides={"OPENAI_API_KEY": "sk-injected"},
    )
    assert proc._build_env()["OPENAI_API_KEY"] == "sk-injected"
