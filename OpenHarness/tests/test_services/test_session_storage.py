"""Tests for session persistence."""

from __future__ import annotations

import json
from pathlib import Path

from openharness.api.usage import UsageSnapshot
from openharness.engine.messages import ConversationMessage, TextBlock
from openharness.services.session_storage import (
    export_session_markdown,
    get_project_session_dir,
    load_session_by_id,
    load_session_snapshot,
    resolve_session_id,
    save_session_snapshot,
)


def test_save_and_load_session_snapshot(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("OPENHARNESS_DATA_DIR", str(tmp_path / "data"))
    project = tmp_path / "repo"
    project.mkdir()

    path = save_session_snapshot(
        cwd=project,
        model="claude-test",
        system_prompt="system",
        messages=[ConversationMessage(role="user", content=[TextBlock(text="hello")])],
        usage=UsageSnapshot(input_tokens=1, output_tokens=2),
        tool_metadata={
            "task_focus_state": {"goal": "Fix compact carry-over"},
            "recent_verified_work": ["Focused session storage test passed"],
        },
    )

    assert path.exists()
    snapshot = load_session_snapshot(project)
    assert snapshot is not None
    assert snapshot["model"] == "claude-test"
    assert snapshot["usage"]["output_tokens"] == 2
    assert snapshot["tool_metadata"]["task_focus_state"]["goal"] == "Fix compact carry-over"
    assert snapshot["tool_metadata"]["recent_verified_work"] == ["Focused session storage test passed"]


def test_export_session_markdown(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("OPENHARNESS_DATA_DIR", str(tmp_path / "data"))
    project = tmp_path / "repo"
    project.mkdir()

    path = export_session_markdown(
        cwd=project,
        messages=[
            ConversationMessage(role="user", content=[TextBlock(text="hello")]),
            ConversationMessage(role="assistant", content=[TextBlock(text="world")]),
        ],
    )

    assert path.exists()
    content = path.read_text(encoding="utf-8")
    assert "OpenHarness Session Transcript" in content
    assert "hello" in content
    assert "world" in content


def test_load_session_snapshot_sanitizes_legacy_empty_assistant_messages(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("OPENHARNESS_DATA_DIR", str(tmp_path / "data"))
    project = tmp_path / "repo"
    project.mkdir()

    target_dir = get_project_session_dir(project)
    payload = {
        "session_id": "legacy123",
        "cwd": str(project),
        "model": "claude-test",
        "system_prompt": "system",
        "messages": [
            {"role": "user", "content": [{"type": "text", "text": "hello"}]},
            {"role": "assistant", "content": None},
            {"role": "assistant", "content": []},
            {"role": "assistant", "content": [{"type": "text", "text": "world"}]},
        ],
        "usage": {"input_tokens": 1, "output_tokens": 1},
        "tool_metadata": {},
        "created_at": 1.0,
        "summary": "hello",
        "message_count": 4,
    }
    (target_dir / "latest.json").write_text(json.dumps(payload), encoding="utf-8")

    snapshot = load_session_snapshot(project)
    assert snapshot is not None
    assert snapshot["message_count"] == 2
    assert [message["role"] for message in snapshot["messages"]] == ["user", "assistant"]
    assert snapshot["messages"][1]["content"][0]["text"] == "world"


def test_resolve_session_id_honors_env(monkeypatch):
    monkeypatch.setenv("OH_SESSION_ID", "abc123-def456")
    assert resolve_session_id() == "abc123-def456"


def test_resolve_session_id_falls_back_to_random_without_env(monkeypatch):
    monkeypatch.delenv("OH_SESSION_ID", raising=False)
    sid = resolve_session_id()
    assert len(sid) == 12
    assert all(c in "0123456789abcdef" for c in sid)


def test_save_snapshot_uses_env_session_id_and_resume_hits(tmp_path, monkeypatch):
    """Native contract (openspec 2026-08-05-oh-session-id-resume-contract):

    When session-service injects OH_SESSION_ID, snapshots persist under that id
    and ``--resume <id>`` (load_session_by_id) must hit.
    """
    monkeypatch.setenv("OPENHARNESS_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("OH_SESSION_ID", "abc123-def456")
    project = tmp_path / "repo"
    project.mkdir()

    save_session_snapshot(
        cwd=project,
        session_id=resolve_session_id(),
        model="claude-test",
        system_prompt="system",
        messages=[ConversationMessage(role="user", content=[TextBlock(text="hello")])],
        usage=UsageSnapshot(input_tokens=1, output_tokens=2),
        tool_metadata={},
    )
    # Snapshot must persist under the env-derived id (not a random id).
    session_file = get_project_session_dir(project) / "session-abc123-def456.json"
    assert session_file.exists()

    # Resume lookup by the same id must hit; unknown id must miss.
    assert load_session_by_id(project, "abc123-def456") is not None
    assert load_session_by_id(project, "does-not-exist") is None


def test_migrate_session_snapshots_idempotent(tmp_path):
    """M1 migration (openspec 2026-08-05-oh-session-id-resume-contract):

    Legacy snapshots written with a random session_id are re-keyed to the
    directory name (= cwd-based id), and re-running is a no-op.
    """
    from openharness.tools.migrate_session_snapshots import rekey_data_dir

    data_dir = tmp_path / "data"
    sessions = data_dir / "sessions"
    sessions.mkdir(parents=True)
    dir_name = "410d1bc7-b531-4b74-a84d-4c24707c8e14-63c1c29565d3"
    d = sessions / dir_name
    d.mkdir()
    legacy = {
        "session_id": "b0ddc8dabccf",
        "cwd": "/workspaces/" + dir_name,
        "model": "x",
        "messages": [],
    }
    (d / "session-b0ddc8dabccf.json").write_text(json.dumps(legacy))
    (d / "latest.json").write_text(json.dumps(legacy))

    r1 = rekey_data_dir(data_dir)
    assert r1["migrated"] == 1
    assert (d / f"session-{dir_name}.json").exists()
    assert json.loads((d / "latest.json").read_text())["session_id"] == dir_name
    assert json.loads((d / f"session-{dir_name}.json").read_text())["session_id"] == dir_name

    # Idempotent: second run is a no-op (already consistent -> skipped).
    r2 = rekey_data_dir(data_dir)
    assert r2["migrated"] == 0
    assert r2["skipped"] == 1

