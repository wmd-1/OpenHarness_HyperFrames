"""OH_OH_BIN startup validation (session-acceptance-hardening P1-2).

Semantic contract: OH_OH_BIN is a single executable path (argv[0]); command
strings are rejected with a wrapper-script hint. process runtime fails fast,
container runtime degrades to a warning.
"""

from __future__ import annotations

import pytest

from app.config import settings
from app.main import _validate_oh_bin


def test_nonexistent_path_fails_fast_in_process_runtime(monkeypatch):
    monkeypatch.setattr(settings, "session_runtime", "process")
    monkeypatch.setattr(settings, "oh_bin", "/nonexistent/oh")
    with pytest.raises(RuntimeError, match="does not exist"):
        _validate_oh_bin()


def test_whitespace_value_hints_wrapper_script(monkeypatch):
    # Misconfigured command string (e.g. "python3 /path/stub.py") — rule 1.
    monkeypatch.setattr(settings, "session_runtime", "process")
    monkeypatch.setattr(settings, "oh_bin", "python3 /opt/stub.py")
    with pytest.raises(RuntimeError, match="wrapper script"):
        _validate_oh_bin()


def test_non_executable_file_fails(monkeypatch, tmp_path):
    plain = tmp_path / "oh"
    plain.write_text("#!/bin/sh\n")
    plain.chmod(0o644)
    monkeypatch.setattr(settings, "session_runtime", "process")
    monkeypatch.setattr(settings, "oh_bin", str(plain))
    with pytest.raises(RuntimeError, match="not executable"):
        _validate_oh_bin()


def test_executable_path_passes(monkeypatch, tmp_path):
    binary = tmp_path / "oh"
    binary.write_text("#!/bin/sh\n")
    binary.chmod(0o755)
    monkeypatch.setattr(settings, "session_runtime", "process")
    monkeypatch.setattr(settings, "oh_bin", str(binary))
    _validate_oh_bin()  # no raise


def test_container_runtime_only_warns(monkeypatch, caplog):
    monkeypatch.setattr(settings, "session_runtime", "container")
    monkeypatch.setattr(settings, "oh_bin", "/nonexistent/oh")
    with caplog.at_level("WARNING", logger="app.main"):
        _validate_oh_bin()  # no raise
    assert any("OH_OH_BIN validation failed" in r.message for r in caplog.records)
