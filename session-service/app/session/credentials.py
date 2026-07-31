"""Node-level credential gateway: provider credential resolution (spawn time).

Provider credentials (upstream LLM API keys) are a *node-level* asset. They
never enter the tenant bucket, the staging tree or any settings.json seed —
the supervisor injects them into the spawned ``oh --backend-only`` process
environment, resolved fresh at **every spawn** by this module.

Priority contract (session-credential-gateway spec, fixed order)::

    OH_PROVIDER_API_KEY                      (explicit gateway-level override)
      > OPENAI_API_KEY / ANTHROPIC_API_KEY   (the mapped env var, process env)
      > global settings.json  api_key        (OH_GLOBAL_SETTINGS_PATH)
      > none                                 (no injection + warning)

Env-var name mapping: ``profiles[active_profile].auth_source``
(``openai_api_key`` -> ``OPENAI_API_KEY``, ``anthropic_api_key`` ->
``ANTHROPIC_API_KEY``) with fallback to the top-level ``api_format``; when
neither determines a target the resolver returns ``None`` with a warning.

NO caching of any kind: ``os.environ`` and the global settings file are read
on every call, so credential rotation affects the next spawn without a
service restart. A missing/unreadable/corrupt global file is treated as that
priority level being absent (degrade, never crash).
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import structlog

from app.config import settings

logger = structlog.get_logger(__name__)

# auth_source -> env var the ``oh`` provider profile actually reads. Verified
# in-container: ``--api-key`` is NOT honored by profile auth sources; only the
# env var is (plan rev2 §1 matrix).
_AUTH_SOURCE_ENV = {
    "openai_api_key": "OPENAI_API_KEY",
    "anthropic_api_key": "ANTHROPIC_API_KEY",
}
# Fallback mapping from the top-level ``api_format``.
_API_FORMAT_ENV = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
}


def _load_global_settings() -> dict:
    """Read the node-global settings.json; any failure degrades to ``{}``."""
    try:
        raw = json.loads(
            Path(settings.global_settings_path).read_text(encoding="utf-8")
        )
        return raw if isinstance(raw, dict) else {}
    except Exception:  # noqa: BLE001 — this level is simply absent
        return {}


def _target_env_var(cfg: dict) -> str | None:
    """Which env var the backend's active provider profile will look up."""
    profiles = cfg.get("profiles")
    active = cfg.get("active_profile")
    if isinstance(profiles, dict) and isinstance(active, str):
        profile = profiles.get(active)
        if isinstance(profile, dict):
            env_var = _AUTH_SOURCE_ENV.get(str(profile.get("auth_source", "")).lower())
            if env_var:
                return env_var
    return _API_FORMAT_ENV.get(str(cfg.get("api_format", "")).lower())


def resolve_provider_credential() -> tuple[str, str] | None:
    """Resolve ``(env_var, key)`` to inject into the next backend spawn.

    Called once per spawn — deliberately uncached (rotation without restart).
    Returns ``None`` when the target env var cannot be determined or no level
    of the priority chain yields a key; the caller then injects nothing and
    the backend falls back to its inherited env / own config.
    """
    cfg = _load_global_settings()
    env_var = _target_env_var(cfg)
    if env_var is None:
        logger.warning(
            "credential_env_var_undetermined",
            path=str(settings.global_settings_path),
        )
        return None
    file_key = cfg.get("api_key")
    key = (
        os.environ.get("OH_PROVIDER_API_KEY")
        or os.environ.get(env_var)
        or (file_key if isinstance(file_key, str) and file_key else None)
    )
    if key:
        return (env_var, key)
    logger.warning("no_provider_credential_resolved", env_var=env_var)
    return None
