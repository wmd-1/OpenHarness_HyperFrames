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
