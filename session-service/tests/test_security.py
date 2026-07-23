"""Tests for extra_oh_args allowlist + value validation (spec: 5.1 / R)."""

import pytest

from app.security import InvalidOhArgError, vet_extra_oh_args


def test_none_returns_empty():
    assert vet_extra_oh_args(None) == []


def test_allowed_flag_with_value():
    assert vet_extra_oh_args(["--model", "gpt-5"]) == ["--model", "gpt-5"]


def test_allowed_bool_flag():
    assert vet_extra_oh_args(["--no-cache"]) == ["--no-cache"]


def test_overriding_permission_mode_rejected():
    """Spec scenario: overriding permission-mode is rejected with 422."""
    with pytest.raises(InvalidOhArgError, match="not caller-controllable"):
        vet_extra_oh_args(["--permission-mode", "not_full_auto"])


def test_cwd_rejected():
    with pytest.raises(InvalidOhArgError):
        vet_extra_oh_args(["--cwd", "/etc"])


def test_resume_rejected():
    with pytest.raises(InvalidOhArgError):
        vet_extra_oh_args(["--resume", "abc"])


def test_backend_only_rejected():
    with pytest.raises(InvalidOhArgError):
        vet_extra_oh_args(["--backend-only"])


def test_api_key_rejected():
    with pytest.raises(InvalidOhArgError):
        vet_extra_oh_args(["--api-key", "sk-xxx"])


def test_non_flag_rejected():
    with pytest.raises(InvalidOhArgError, match="only --flags"):
        vet_extra_oh_args(["rm", "-rf"])


def test_unlisted_flag_rejected():
    with pytest.raises(InvalidOhArgError, match="not in the allowlist"):
        vet_extra_oh_args(["--dangerous-flag"])


def test_shell_metachar_in_value_rejected():
    """Spec scenario: a value with shell metacharacters is rejected."""
    with pytest.raises(InvalidOhArgError, match="shell metacharacters"):
        vet_extra_oh_args(["--model", "gpt;rm -rf /"])


def test_int_value_type_checked():
    with pytest.raises(InvalidOhArgError, match="must be an int"):
        vet_extra_oh_args(["--max-turns", "notanint"])


def test_float_value_type_checked():
    with pytest.raises(InvalidOhArgError, match="must be a float"):
        vet_extra_oh_args(["--temperature", "hot"])


def test_value_length_checked():
    with pytest.raises(InvalidOhArgError, match="exceeds max length"):
        vet_extra_oh_args(["--model", "x" * 300])


def test_missing_value_rejected():
    with pytest.raises(InvalidOhArgError, match="requires a value"):
        vet_extra_oh_args(["--model"])


def test_schema_validator_translates_to_value_error():
    """The schema validator wraps InvalidOhArgError into a pydantic ValueError."""
    from app.schemas import SessionCreateRequest
    from pydantic import ValidationError

    with pytest.raises(ValidationError) as exc_info:
        SessionCreateRequest(extra_oh_args=["--permission-mode", "x"])
    # The 422-style error mentions the flag.
    assert "not caller-controllable" in str(exc_info.value)
