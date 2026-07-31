"""Repair script tests (openspec session-credential-gateway-hardening, 5.5).

`scripts/repair_tenant_settings_seed.py` against a fake MinIO: the three-way
classification (empty_seed / invalid / ok), dry-run never writes, --apply
repairs exactly the empty seeds (bucket + local staging), the empty-derived-
seed guard (exit 3) and the disabled-store guard (exit 2).
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

from app.config import settings
from app.session import tenant_store
from tests.test_workspace_store import FakeMinio

_SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "repair_tenant_settings_seed.py"
_spec = importlib.util.spec_from_file_location("repair_tenant_settings_seed", _SCRIPT)
repair = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(repair)

GLOBAL_SETTINGS = {"api_format": "openai", "model": "gpt-5", "api_key": "sk-node-secret"}

T_EMPTY, T_OK, T_BAD_JSON, T_LEAK = "t-empty", "t-ok", "t-badjson", "t-leak"


def _key(tid: str) -> str:
    return f"tenants/{tid}/openharness/settings.json"


@pytest.fixture()
def env(tmp_path, monkeypatch) -> FakeMinio:
    """Fake bucket with one tenant per classification + a sane global config."""
    global_path = tmp_path / "global-settings.json"
    global_path.write_text(json.dumps(GLOBAL_SETTINGS))
    monkeypatch.setattr(settings, "global_settings_path", global_path)
    monkeypatch.setattr(settings, "minio_endpoint", "minio:9000")
    monkeypatch.setattr(settings, "tenants_root", tmp_path / "tenants")

    fake = FakeMinio()
    fake.store[_key(T_EMPTY)] = b"{}\n"  # legacy seed -> repair
    fake.store[_key(T_OK)] = json.dumps(
        {"api_format": "openai", "model": "gpt-5"}
    ).encode()  # configured -> skip
    fake.store[_key(T_BAD_JSON)] = b"{not json"  # invalid -> report only
    fake.store[_key(T_LEAK)] = json.dumps(
        {"api_format": "openai", "api_key": "sk-leak"}
    ).encode()  # historical secret leak -> invalid, never touched
    fake.store["tenants/t-empty/rules/style.md"] = b"# rule"  # non-settings: ignored
    monkeypatch.setattr(tenant_store, "_client", lambda: fake)

    # Local staging copy of the stale seed (must be refreshed on --apply so a
    # later stage-out cannot push the `{}` back).
    local = tenant_store.local_config_dir(T_EMPTY) / "settings.json"
    local.parent.mkdir(parents=True)
    local.write_text("{}\n")
    return fake


def _run(monkeypatch, *argv: str) -> int:
    monkeypatch.setattr(sys, "argv", ["repair_tenant_settings_seed.py", *argv])
    return repair.main()


def test_dry_run_classifies_and_writes_nothing(env, monkeypatch, capsys):
    before = dict(env.store)
    assert _run(monkeypatch) == 0
    assert env.store == before  # dry-run: bucket untouched
    local = tenant_store.local_config_dir(T_EMPTY) / "settings.json"
    assert local.read_text() == "{}\n"  # staging untouched too

    out = capsys.readouterr().out
    assert "repaired=1 skipped_ok=1 invalid=2 failed=0" in out
    assert "sk-leak" not in out  # secrets are redacted (key paths only)
    assert "dry-run: nothing written" in out


def test_apply_repairs_only_empty_seeds(env, monkeypatch):
    assert _run(monkeypatch, "--apply") == 0
    seed = tenant_store.settings_seed()

    # The empty seed is replaced by the derived credential-free seed …
    assert env.store[_key(T_EMPTY)].decode() == seed
    parsed = json.loads(seed)
    assert parsed["api_format"] == "openai"
    assert "api_key" not in parsed  # scrubbed derivation, never the secret
    # … in the local staging copy as well.
    local = tenant_store.local_config_dir(T_EMPTY) / "settings.json"
    assert local.read_text() == seed

    # ok / invalid tenants are byte-for-byte untouched.
    assert env.store[_key(T_OK)] == json.dumps(
        {"api_format": "openai", "model": "gpt-5"}
    ).encode()
    assert env.store[_key(T_BAD_JSON)] == b"{not json"
    assert json.loads(env.store[_key(T_LEAK)])["api_key"] == "sk-leak"


def test_guard_refuses_when_seed_derives_empty(env, monkeypatch):
    """Global settings unusable -> repairing would write `{}` over `{}`: abort."""
    monkeypatch.setattr(
        settings, "global_settings_path", Path("/nonexistent/settings.json")
    )
    before = dict(env.store)
    assert _run(monkeypatch, "--apply") == 3
    assert env.store == before


def test_guard_requires_minio(monkeypatch):
    monkeypatch.setattr(settings, "minio_endpoint", None)
    assert _run(monkeypatch, "--apply") == 2
