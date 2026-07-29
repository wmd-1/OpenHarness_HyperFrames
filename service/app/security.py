"""Input vetting for caller-supplied ``oh`` CLI flags.

The ``extra_oh_args`` field lets API clients forward extra flags to the ``oh``
CLI. Because ``--permission-mode full_auto`` (and ``--output``) are emitted
*before* ``extra_args`` in :mod:`app.workers.runner`, a caller could otherwise
append a conflicting flag and downgrade permissions or redirect artifacts.

We therefore keep a conservative allowlist of safe flags and a hard blocklist of
safety-critical flags that must never be caller-controlled.  Additionally,
flag values are type-checked and shell-metachar-rejected (N17/S4).
"""

from __future__ import annotations

import hashlib
import logging
import time
from secrets import compare_digest

logger = logging.getLogger(__name__)


# --- Multi-key tenant resolution (WS-A, R15) ---------------------------------
#
# In-process TTL caches (bounded by OH_APIKEY_CACHE_TTL, default 60s):
# - positive key lookups (sha256 digest -> (tenant_id, actor_key_id)), so
#   deactivation takes effect within the TTL;
# - the "api_keys table is empty" flag used by the open-mode check.
# Negative lookups are NOT cached (unbounded attacker-controlled keyspace).
# Mirrors session-service/app/security.py (shared api_keys table, D1.3).

_key_cache: dict[str, tuple[float, tuple[str, str | None]]] = {}
_empty_cache: tuple[float, bool] | None = None


def reset_apikey_cache() -> None:
    """Drop cached resolutions (tests / manage script after deactivate)."""
    global _empty_cache
    _key_cache.clear()
    _empty_cache = None


async def _api_keys_table_empty() -> bool:
    """Cached "no api_keys rows exist" check for the open-mode branch.

    Fails OPEN (returns True) when the DB is unreachable: before this change
    the auth middleware was not even registered without a configured key, so
    an open-mode deployment must keep serving through a DB blip.
    """
    global _empty_cache
    from app.config import settings

    now = time.monotonic()
    if _empty_cache is not None and _empty_cache[0] > now:
        return _empty_cache[1]
    from sqlalchemy import select

    from app import db
    from app.models import ApiKey

    try:
        async with db.async_session() as session:
            row = (await session.execute(select(ApiKey.id).limit(1))).first()
    except Exception:
        logger.warning("api_keys empty-check failed (DB unreachable) — open mode")
        return True
    empty = row is None
    _empty_cache = (now + settings.apikey_cache_ttl, empty)
    return empty


async def resolve_tenant(provided: str | None) -> tuple[str, str | None] | None:
    """Resolve an API key to ``(tenant_id, actor_key_id)`` or ``None`` (reject).

    Three-step resolution order (R15), shared by the HTTP middleware and the
    ``?api_key=`` query-param fallback on ``/file`` and ``/events``:

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

    # (3) multi-key hashed lookup (active rows only), TTL-cached. A DB error
    # counts as "no match" (fail closed for actual keys).
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

        try:
            async with db.async_session() as session:
                row = (await session.execute(
                    select(ApiKey).where(
                        ApiKey.key_hash == digest, ApiKey.active.is_(True)
                    ).limit(1)
                )).scalars().first()
        except Exception:
            logger.warning("api_keys lookup failed (DB unreachable) — rejecting key")
            row = None
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
    # ⚠️ Only add flags that are provably safe to expose to callers.
}

# flag -> (type, max_value_length) for value validation (N17/S4).
# type: "float", "int", or "str".
TYPED_FLAGS: dict[str, tuple[str, int]] = {
    "--temperature": ("float", 50),
    "--max-turns": ("int", 10),
    "--model": ("str", 256),
}

# Flags that must never be caller-controlled.
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
    "--no-headless",  # could pop a GUI / change browser behavior
    "--browser",
    "--chromium",
}

# Shell metacharacters that must never appear in flag values.
_SHELL_METACHARS = set(";&|`$(){}[]<>#!~\n\r\t\\\"'")


class InvalidOhArgError(ValueError):
    """Raised when ``extra_oh_args`` contains a disallowed or malformed token."""


def _validate_flag_value(flag: str, value: str) -> None:
    """Validate the value of a typed flag (N17/S4).

    Rejects shell metacharacters in all values, checks type and length
    for typed flags.
    """
    # Reject shell metacharacters in all values.
    if any(c in _SHELL_METACHARS for c in value):
        raise InvalidOhArgError(
            f"value for {flag!r} contains shell metacharacters"
        )

    # Type-check typed flags.
    if flag in TYPED_FLAGS:
        expected_type, max_len = TYPED_FLAGS[flag]
        if len(value) > max_len:
            raise InvalidOhArgError(
                f"value for {flag!r} exceeds max length {max_len}"
            )
        if expected_type == "float":
            try:
                float(value)
            except ValueError:
                raise InvalidOhArgError(
                    f"value for {flag!r} must be a float, got {value!r}"
                )
        elif expected_type == "int":
            try:
                int(value)
            except ValueError:
                raise InvalidOhArgError(
                    f"value for {flag!r} must be an int, got {value!r}"
                )


def vet_extra_oh_args(raw: list[str] | None) -> list[str]:
    """Validate and normalize ``extra_oh_args``.

    Args:
        raw: The caller-supplied list of extra CLI tokens (may be ``None``).

    Returns:
        A sanitized copy of the list, ready to be forwarded to ``oh``.

    Raises:
        InvalidOhArgError: if any token is not a ``--flag``, is on the
            forbidden list, is not in the allowlist, is missing a required
            value, or has a malformed/unsafe value (N17/S4).
    """
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
            _validate_flag_value(tok, val)  # N17/S4
            out.append(val)
            i += 2
        else:
            i += 1
    return out
