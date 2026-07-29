"""Input vetting for caller-supplied ``oh`` CLI flags.

Mirrors ``service/app/security.py``: an allowlist of safe flags, a hard
blocklist of safety-critical flags that must never be caller-controlled, and
type/shell-metacharacter validation on values.

The session service server-fixed-injects ``--permission-mode``/``--cwd``/
``--output-format``/``--api-key``/``--resume``/``--backend-only`` (spec D6, R:
``extra_oh_args`` MUST be allowlist- and value-validated); those appear in
FORBIDDEN_OH_FLAGS so a caller cannot override them.
"""

from __future__ import annotations

import hashlib
import time
from secrets import compare_digest


def api_key_matches(provided: str | None) -> bool:
    """Constant-time API-key comparison against the configured key.

    Shared by the REST auth middleware, the WS handshake and the artifact-GET
    ``?api_key=`` query-param path (A2) so all entry points use one check.
    """
    from app.config import settings

    expected = settings.api_key.get_secret_value() if settings.api_key else ""
    return compare_digest(provided or "", expected)


# --- Multi-key tenant resolution (WS-A) --------------------------------------
#
# In-process TTL caches (bounded by OH_APIKEY_CACHE_TTL, default 60s):
# - positive key lookups (sha256 digest -> (tenant_id, actor_key_id)), so
#   revocation takes effect within the TTL;
# - the "api_keys table is empty" flag used by the open-mode check.
# Negative lookups are NOT cached (unbounded attacker-controlled keyspace).

_key_cache: dict[str, tuple[float, tuple[str, str | None]]] = {}
_empty_cache: tuple[float, bool] | None = None


def reset_apikey_cache() -> None:
    """Drop cached resolutions (tests / manage script after revoke)."""
    global _empty_cache
    _key_cache.clear()
    _empty_cache = None


async def _api_keys_table_empty() -> bool:
    """Cached "no api_keys rows exist" check for the open-mode branch."""
    global _empty_cache
    from app.config import settings

    now = time.monotonic()
    if _empty_cache is not None and _empty_cache[0] > now:
        return _empty_cache[1]
    from sqlalchemy import select

    from app import db
    from app.models import ApiKey

    async with db.async_session() as session:
        row = (await session.execute(select(ApiKey.id).limit(1))).first()
    empty = row is None
    _empty_cache = (now + settings.apikey_cache_ttl, empty)
    return empty


async def resolve_tenant(provided: str | None) -> tuple[str, str | None] | None:
    """Resolve an API key to ``(tenant_id, actor_key_id)`` or ``None`` (reject).

    Resolution order (spec: "Requests MUST be authenticated and scoped to a
    tenant"), shared by the REST middleware, the WS handshake and the
    artifact-GET ``?api_key=`` path:

    1. open mode — no ``api_key`` configured, ``require_auth`` false and the
       ``api_keys`` table empty -> tenant ``default``;
    2. legacy single-key — constant-time match against ``settings.api_key``
       -> tenant ``default`` (pre-change behavior);
    3. multi-key — ``sha256(provided)`` looked up in ``api_keys``
       (``active=true`` only) -> the row's tenant, ``actor_key_id`` = row id.
    """
    from app.config import settings

    configured = settings.api_key.get_secret_value() if settings.api_key else ""

    # (2) legacy single-key compare — constant-time, no DB round-trip.
    if configured and compare_digest(provided or "", configured):
        return ("default", None)

    # (3) multi-key hashed lookup (active rows only), TTL-cached.
    if provided:
        digest = hashlib.sha256(provided.encode("utf-8")).hexdigest()
        now = time.monotonic()
        cached = _key_cache.get(digest)
        if cached is not None and cached[0] > now:
            return cached[1]
        if cached is not None:
            _key_cache.pop(digest, None)
        from sqlalchemy import select

        from app import db
        from app.models import ApiKey

        async with db.async_session() as session:
            row = (await session.execute(
                select(ApiKey).where(
                    ApiKey.key_hash == digest, ApiKey.active.is_(True)
                ).limit(1)
            )).scalars().first()
        if row is not None:
            result = (row.tenant_id, str(row.id))
            _key_cache[digest] = (now + settings.apikey_cache_ttl, result)
            return result

    # (1) open mode — nothing configured anywhere -> tenant "default".
    if not configured and not settings.require_auth and await _api_keys_table_empty():
        return ("default", None)

    return None


# flag -> does it consume a following value?
ALLOWED_OH_FLAGS: dict[str, bool] = {
    "--temperature": True,
    "--max-turns": True,
    "--model": True,
    "--no-cache": False,
    "--verbose": False,
    "--effort": True,
    # ⚠️ Only add flags that are provably safe to expose to callers.
}

# flag -> (type, max_value_length) for value validation.
TYPED_FLAGS: dict[str, tuple[str, int]] = {
    "--temperature": ("float", 50),
    "--max-turns": ("int", 10),
    "--model": ("str", 256),
    "--effort": ("str", 16),
}

# Flags that must never be caller-controlled — server-fixed injection only.
FORBIDDEN_OH_FLAGS = {
    "--permission-mode",
    "--permission_mode",
    "--output",
    "--output-format",
    "-p",
    "--prompt",
    "--workspace",
    "--cwd",
    "--root",
    "--headed",
    "--no-headless",
    "--browser",
    "--chromium",
    "--api-key",
    "-k",
    "--resume",
    "-r",
    "--backend-only",
}

# Shell metacharacters that must never appear in flag values.
_SHELL_METACHARS = set(";&|`$(){}[]<>#!~\n\r\t\\\"'")


class InvalidOhArgError(ValueError):
    """Raised when ``extra_oh_args`` contains a disallowed or malformed token."""


def _validate_flag_value(flag: str, value: str) -> None:
    if any(c in _SHELL_METACHARS for c in value):
        raise InvalidOhArgError(f"value for {flag!r} contains shell metacharacters")
    if flag in TYPED_FLAGS:
        expected_type, max_len = TYPED_FLAGS[flag]
        if len(value) > max_len:
            raise InvalidOhArgError(f"value for {flag!r} exceeds max length {max_len}")
        if expected_type == "float":
            try:
                float(value)
            except ValueError as exc:
                raise InvalidOhArgError(
                    f"value for {flag!r} must be a float, got {value!r}"
                ) from exc
        elif expected_type == "int":
            try:
                int(value)
            except ValueError as exc:
                raise InvalidOhArgError(
                    f"value for {flag!r} must be an int, got {value!r}"
                ) from exc


def vet_extra_oh_args(raw: list[str] | None) -> list[str]:
    """Validate and normalize ``extra_oh_args`` (mirrors service/security.py)."""
    if not raw:
        return []

    out: list[str] = []
    i = 0
    n = len(raw)
    while i < n:
        tok = raw[i]
        if not isinstance(tok, str) or not tok.startswith("--"):
            raise InvalidOhArgError(f"only --flags are allowed, got {tok!r}")
        if tok in FORBIDDEN_OH_FLAGS:
            raise InvalidOhArgError(f"flag {tok!r} is not caller-controllable")
        if tok not in ALLOWED_OH_FLAGS:
            raise InvalidOhArgError(f"flag {tok!r} is not in the allowlist")
        out.append(tok)
        if ALLOWED_OH_FLAGS[tok]:
            if i + 1 >= n:
                raise InvalidOhArgError(f"flag {tok!r} requires a value")
            val = raw[i + 1]
            _validate_flag_value(tok, val)
            out.append(val)
            i += 2
        else:
            i += 1
    return out
