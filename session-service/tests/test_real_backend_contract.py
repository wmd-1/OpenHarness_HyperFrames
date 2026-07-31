"""Real-backend startup contract (openspec session-credential-gateway-hardening, 6.1).

Gated by ``OH_REAL_BACKEND_TEST=1`` (the whole module skips otherwise — the
default stub pipeline never spawns a real backend). Locks the ``oh``
auth_source/env-injection contract the gateway relies on (plan rev2 §4-D):

- positive: a scrubbed (credential-free) CONFIG_DIR + the resolver-injected
  env var boot a real ``oh --backend-only`` to ``ready`` within 15s with
  ``auth_status == "configured"`` and provider/base_url matching the global
  config;
- negative: the same CONFIG_DIR with every credential env var removed exits
  non-zero with the no-API-key failure shape.

Run inside the existing image:
    docker compose run --rm --entrypoint bash session -c \
      "cd /opt/oh-session-service && OH_REAL_BACKEND_TEST=1 \
       python -m pytest tests/test_real_backend_contract.py -x -q"
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import pytest

from app.config import settings
from app.session import credentials, tenant_store

pytestmark = [
    pytest.mark.asyncio,
    pytest.mark.skipif(
        os.environ.get("OH_REAL_BACKEND_TEST") != "1",
        reason="real-backend contract harness only (OH_REAL_BACKEND_TEST=1)",
    ),
]

OH_BIN = os.environ.get("OH_REAL_OH_BIN", "/root/.local/bin/oh")
GLOBAL_SETTINGS = Path.home() / ".openharness" / "settings.json"
READY_TIMEOUT = 15.0
CRED_ENV_VARS = ("OH_PROVIDER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY")


def _find_key(node: object, key: str) -> object | None:
    """First value of ``key`` at any nesting depth (payload-shape tolerant)."""
    if isinstance(node, dict):
        if key in node:
            return node[key]
        for value in node.values():
            found = _find_key(value, key)
            if found is not None:
                return found
    elif isinstance(node, list):
        for item in node:
            found = _find_key(item, key)
            if found is not None:
                return found
    return None


@pytest.fixture()
def scrubbed_config_dir(tmp_path, monkeypatch) -> Path:
    """CONFIG_DIR seeded exactly like a first-seen tenant (derived, scrubbed)."""
    if not Path(OH_BIN).exists():
        pytest.skip(f"real oh binary not found at {OH_BIN}")
    if not GLOBAL_SETTINGS.exists():
        pytest.skip(f"no global settings at {GLOBAL_SETTINGS}")
    monkeypatch.setattr(settings, "global_settings_path", GLOBAL_SETTINGS)
    seed = tenant_store.settings_seed()
    assert json.loads(seed) != {}, "global settings must derive a non-empty seed"

    config_dir = tmp_path / "openharness"
    (config_dir / "data").mkdir(parents=True)
    (config_dir / "settings.json").write_text(seed, encoding="utf-8")
    return config_dir


async def _spawn_oh(config_dir: Path, cwd: Path, env: dict[str, str]):
    cwd.mkdir(parents=True, exist_ok=True)
    env = dict(env)
    env["OPENHARNESS_CONFIG_DIR"] = str(config_dir)
    env["OPENHARNESS_DATA_DIR"] = str(config_dir / "data")
    env.setdefault("PYTHONUNBUFFERED", "1")
    return await asyncio.create_subprocess_exec(
        OH_BIN,
        "--backend-only",
        "--cwd",
        str(cwd),
        "--permission-mode",
        "full_auto",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        cwd=str(cwd),
        env=env,
        start_new_session=True,
    )


async def _kill(proc) -> None:
    if proc.returncode is None:
        proc.kill()
    try:
        await asyncio.wait_for(proc.wait(), timeout=5.0)
    except asyncio.TimeoutError:
        pass


async def test_real_backend_ready_with_scrubbed_settings_and_env_credential(
    scrubbed_config_dir, tmp_path
):
    """Full positive chain: scrubbed seed + injected env -> ready/configured."""
    cred = credentials.resolve_provider_credential()
    if cred is None:
        pytest.skip("no provider credential resolvable on this node")

    env = dict(os.environ)
    for var in CRED_ENV_VARS:
        env.pop(var, None)  # the injection must stand alone
    env[cred[0]] = cred[1]

    proc = await _spawn_oh(scrubbed_config_dir, tmp_path / "ws", env)
    ready = None
    try:
        async with asyncio.timeout(READY_TIMEOUT):
            while True:
                raw = await proc.stdout.readline()
                if not raw:
                    code = await proc.wait()
                    pytest.fail(f"backend exited before ready (exit={code})")
                line = raw.decode("utf-8", errors="replace").strip()
                if line.startswith("OHJSON:"):
                    event = json.loads(line[len("OHJSON:"):])
                    if event.get("type") == "ready":
                        ready = event
                        break
    finally:
        await _kill(proc)

    assert ready is not None
    assert _find_key(ready, "auth_status") == "configured"
    # Provider chain identity: the backend must be running the SAME provider
    # configuration the global settings describe. ``base_url``/``model`` are
    # the strong signals (the ready event's ``provider`` field is a display
    # name normalized from the base_url — e.g. "deepseek" for a deepseek
    # base_url under api_format=openai — so it is not comparable 1:1).
    global_cfg = json.loads(GLOBAL_SETTINGS.read_text(encoding="utf-8"))
    for cfg_key in ("base_url", "model"):
        expected = global_cfg.get(cfg_key)
        got = _find_key(ready, cfg_key)
        if expected is not None and got is not None:
            assert got == expected, f"{cfg_key}: ready={got!r} != global={expected!r}"


async def test_real_backend_fails_without_credential(scrubbed_config_dir, tmp_path):
    """Negative shape lock: scrubbed seed + NO credential env -> non-zero exit
    with the no-API-key error (§1 matrix failure form)."""
    env = dict(os.environ)
    for var in CRED_ENV_VARS:
        env.pop(var, None)

    proc = await _spawn_oh(scrubbed_config_dir, tmp_path / "ws-nocred", env)
    try:
        async with asyncio.timeout(30.0):
            out_bytes, _ = await proc.communicate()
    except TimeoutError:
        await _kill(proc)
        pytest.fail("backend did not exit without a credential")

    output = out_bytes.decode("utf-8", errors="replace")
    assert proc.returncode != 0, f"expected non-zero exit, got {proc.returncode}"
    lowered = output.lower()
    assert "no api key" in lowered or "no credentials" in lowered, output[-2000:]
