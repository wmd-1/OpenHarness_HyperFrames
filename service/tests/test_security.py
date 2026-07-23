"""Tests for extra_oh_args validation (N5/N17/S4)."""

import pytest

from app.security import InvalidOhArgError, vet_extra_oh_args


# ---- Allowlist / blocklist ----


def test_safe_flag_with_valid_value_passes():
    """A safe flag with a valid value passes through unchanged."""
    result = vet_extra_oh_args(["--temperature", "0.7"])
    assert result == ["--temperature", "0.7"]


def test_permission_mode_override_rejected():
    """permission-mode must never be caller-controllable."""
    with pytest.raises(InvalidOhArgError):
        vet_extra_oh_args(["--permission-mode", "not_full_auto"])


def test_unknown_flag_rejected():
    """Flags not in the allowlist are rejected."""
    with pytest.raises(InvalidOhArgError):
        vet_extra_oh_args(["--dangerous-flag", "value"])


def test_flag_only_no_value():
    """Boolean flags (no value) pass through."""
    result = vet_extra_oh_args(["--verbose"])
    assert result == ["--verbose"]


# ---- Type checking (N17) ----


def test_non_numeric_temperature_rejected():
    """--temperature value must be a float."""
    with pytest.raises(InvalidOhArgError, match="must be a float"):
        vet_extra_oh_args(["--temperature", "hot"])


def test_valid_float_temperature_passes():
    """--temperature accepts float values."""
    result = vet_extra_oh_args(["--temperature", "0.5"])
    assert result == ["--temperature", "0.5"]


def test_non_integer_max_turns_rejected():
    """--max-turns value must be an int."""
    with pytest.raises(InvalidOhArgError, match="must be an int"):
        vet_extra_oh_args(["--max-turns", "many"])


def test_valid_integer_max_turns_passes():
    """--max-turns accepts int values."""
    result = vet_extra_oh_args(["--max-turns", "10"])
    assert result == ["--max-turns", "10"]


# ---- Shell metachar rejection (S4) ----


def test_shell_metachar_in_value_rejected():
    """Values with shell metacharacters are rejected."""
    with pytest.raises(InvalidOhArgError, match="shell metachar"):
        vet_extra_oh_args(["--model", "gpt;rm -rf /"])


def test_pipe_in_value_rejected():
    """Pipe character in value is rejected."""
    with pytest.raises(InvalidOhArgError, match="shell metachar"):
        vet_extra_oh_args(["--model", "a|b"])


def test_backtick_in_value_rejected():
    """Backtick in value is rejected."""
    with pytest.raises(InvalidOhArgError, match="shell metachar"):
        vet_extra_oh_args(["--model", "`whoami`"])


def test_clean_model_value_passes():
    """A clean model name passes through."""
    result = vet_extra_oh_args(["--model", "claude-sonnet-4"])
    assert result == ["--model", "claude-sonnet-4"]


# ---- Length validation (N5) ----


def test_overlong_model_value_rejected():
    """--model value exceeding max length is rejected."""
    long_val = "a" * 257
    with pytest.raises(InvalidOhArgError, match="exceeds max length"):
        vet_extra_oh_args(["--model", long_val])
