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
