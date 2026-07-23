"""Per-turn artifact location and probing.

Reuses the ``service/`` output-file location + ffprobe logic so session
artifacts (videos/files produced by a turn) are registered identically to
video-task artifacts.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from subprocess import PIPE, run


class OutputNotFoundError(Exception):
    """Raised when no mp4 output file can be located."""


@dataclass
class VideoMeta:
    duration_seconds: float | None = None
    resolution: str | None = None
    fps: int | None = None
    file_size_bytes: int | None = None


_RE_ZH = re.compile(r"\*\*输出文件[:：]\*\*\s*`([^`]+\.mp4)`")
_RE_EN = re.compile(r"\*\*[Oo]utput[:：]\*\*\s*`([^`]+\.mp4)`")
_RE_PLAIN = re.compile(r"[Oo]utput\s+file[:：]\s*`?([^\s`]+\.mp4)`?")


def locate_output_file(stdout: str, workspace: Path) -> Path:
    """Find the mp4 output produced by a turn (mirrors service/ parser)."""
    ws_resolved = workspace.resolve()
    for pattern in (_RE_ZH, _RE_EN, _RE_PLAIN):
        m = pattern.search(stdout)
        if m:
            candidate = Path(m.group(1))
            if not candidate.is_absolute():
                candidate = workspace / candidate
            try:
                resolved = candidate.resolve()
                resolved.relative_to(ws_resolved)
            except ValueError:
                continue
            if candidate.exists():
                return candidate
    mp4s = sorted(
        ws_resolved.rglob("*.mp4"), key=lambda p: p.stat().st_mtime, reverse=True
    )
    if mp4s:
        return mp4s[0]
    raise OutputNotFoundError(f"No mp4 output found in workspace {workspace}")


def probe_mp4(path: Path) -> VideoMeta:
    """Use ffprobe to extract duration, resolution, fps, and file size."""
    meta = VideoMeta(file_size_bytes=path.stat().st_size if path.exists() else None)
    try:
        result = run(
            [
                "ffprobe", "-v", "quiet",
                "-print_format", "json",
                "-show_format", "-show_streams",
                str(path),
            ],
            stdout=PIPE,
            stderr=PIPE,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            return meta
        data = json.loads(result.stdout)
        fmt = data.get("format", {})
        if "duration" in fmt:
            meta.duration_seconds = round(float(fmt["duration"]), 3)
        for stream in data.get("streams", []):
            if stream.get("codec_type") == "video":
                w = stream.get("width")
                h = stream.get("height")
                if w and h:
                    meta.resolution = f"{w}x{h}"
                rfr = stream.get("r_frame_rate", "")
                if "/" in rfr:
                    num, den = rfr.split("/", 1)
                    if int(den) != 0:
                        meta.fps = round(int(num) / int(den))
                break
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass
    return meta
