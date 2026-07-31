#!/usr/bin/env python3
"""
qwen3_asr_server.py — 远端 GPU 部署参考脚本（deployment reference, NOT a runtime
component of OpenHarness_HyperFrames）。

架构：FastAPI wrapper + Qwen3ASRModel.LLM（vLLM 作进程内 offline 推理引擎）
      + Qwen3-ForcedAligner（NAR 强制对齐，产出词级时间戳）。
注意：这不是 OpenAI-compatible 的 `vllm serve` HTTP server —— 标准 vllm serve
      只能返回纯文本，词级时间戳必须经 ForcedAligner，本脚本将两者封装为一次
      HTTP 调用。

API contract（本项目容器侧唯一依赖面，见 openspec design D2）：
  POST /transcribe   multipart/form-data
    file        required   音频文件（wav/mp3/mp4/m4a/flac…，ffmpeg 统一转 16k mono wav）
    language    optional   Qwen 全名（"Chinese"/"English"…）；缺省 = 服务端自动语种识别
    model       optional   校验用；单模型部署可不发
    timestamps  optional   "1"(默认) / "0"
  200 → {"ok":true,"language":"English","text":"…",
         "words":[{"text":"Hello","start":0.0,"end":0.42},…] | null,  # 秒，全局时间轴
         "duration_s":12.34}
  4xx/5xx → {"ok":false,"error":"…"}       # 音频超长为 413
  GET /healthz → {"status":"ok","model":"…","aligner":"…","aligner_languages":[…]}

长音频：chunk 切分（带时间戳 180s/chunk、低能量边界）与 timestamp offset 合并由
qwen_asr 包在 transcribe() 内部原生完成，本脚本不自研 chunk；仅做
QWEN3_ASR_MAX_AUDIO_SEC 时长预检（ffprobe，超限 413）。

环境变量（默认值即推荐配置）：
  QWEN3_ASR_MODEL          默认 Qwen/Qwen3-ASR-1.7B          （转写 + 语种识别）
  QWEN3_ALIGNER_MODEL      默认 Qwen/Qwen3-ForcedAligner-0.6B（仅强制对齐，不做识别；
                           缺失/置空则 words 恒为 null）
  QWEN3_ASR_GPU_UTIL       默认 0.8   vLLM gpu_memory_utilization
  QWEN3_ASR_PORT           默认 8092
  QWEN3_ASR_MAX_AUDIO_SEC  默认 3600  单请求最大音频时长（秒），超限 413

依赖（远端部署方管理，不进本项目容器）：
  pip install "qwen-asr[vllm]" fastapi uvicorn python-multipart
  系统需有 ffmpeg / ffprobe。

启动：
  python qwen3_asr_server.py
自测：
  curl -s http://<host>:8092/healthz
  curl -s -F file=@sample.wav http://<host>:8092/transcribe | jq .
"""

import os
import shutil
import subprocess
import tempfile

import uvicorn
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse

ASR_MODEL = os.environ.get("QWEN3_ASR_MODEL", "Qwen/Qwen3-ASR-1.7B")
ALIGNER_MODEL = os.environ.get("QWEN3_ALIGNER_MODEL", "Qwen/Qwen3-ForcedAligner-0.6B")
GPU_UTIL = float(os.environ.get("QWEN3_ASR_GPU_UTIL", "0.8"))
PORT = int(os.environ.get("QWEN3_ASR_PORT", "8092"))
MAX_AUDIO_SEC = float(os.environ.get("QWEN3_ASR_MAX_AUDIO_SEC", "3600"))

app = FastAPI(title="Qwen3-ASR wrapper", docs_url=None, redoc_url=None)
_model = None  # lazy-init in main()


def _err(status: int, msg: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"ok": False, "error": msg})


def _probe_duration(path: str):
    """Return audio duration in seconds via ffprobe, or None if unprobeable."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, timeout=60,
        )
        return float(out.stdout.strip())
    except Exception:
        return None


def _to_wav16k(src: str, dst: str) -> None:
    """Normalize any container/codec to 16k mono wav (what qwen_asr expects)."""
    subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
         "-i", src, "-vn", "-ac", "1", "-ar", "16000", dst],
        check=True, timeout=600,
    )


@app.get("/healthz")
def healthz():
    aligner_langs = []
    if _model is not None and _model.forced_aligner is not None:
        aligner_langs = _model.forced_aligner.get_supported_languages() or []
    return {
        "status": "ok",
        "model": ASR_MODEL,
        "aligner": ALIGNER_MODEL if ALIGNER_MODEL else None,
        "aligner_languages": aligner_langs,
    }


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    language: str = Form(None),
    model: str = Form(None),
    timestamps: str = Form("1"),
):
    if model and model != ASR_MODEL:
        return _err(400, f"model mismatch: serving {ASR_MODEL}, requested {model}")
    if language and language not in _model.get_supported_languages():
        return _err(400, f"unsupported language: {language}")

    want_ts = timestamps != "0"
    if want_ts and _model.forced_aligner is None:
        want_ts = False  # words will be null; client treats result as unusable

    with tempfile.TemporaryDirectory(prefix="qwen3asr-") as td:
        raw = os.path.join(td, "upload" + os.path.splitext(file.filename or "")[1])
        with open(raw, "wb") as f:
            shutil.copyfileobj(file.file, f)

        wav = os.path.join(td, "audio.wav")
        try:
            _to_wav16k(raw, wav)
        except Exception as e:
            return _err(400, f"ffmpeg failed to decode audio: {e}")

        duration = _probe_duration(wav)
        if duration is not None and duration > MAX_AUDIO_SEC:
            return _err(
                413,
                f"audio too long: {duration:.1f}s > QWEN3_ASR_MAX_AUDIO_SEC={MAX_AUDIO_SEC:.0f}s",
            )

        # qwen_asr handles long audio internally: low-energy-boundary chunking
        # (180s/chunk with timestamps) + global-timeline offset merge.
        try:
            result = _model.transcribe(
                wav, language=language or None, return_time_stamps=want_ts,
            )[0]
        except Exception as e:
            return _err(500, f"transcribe failed: {e}")

    words = None
    if want_ts and result.time_stamps is not None:
        # ForcedAlignItem.start_time/end_time are already seconds, global timeline.
        words = [
            {"text": it.text, "start": it.start_time, "end": it.end_time}
            for it in result.time_stamps
        ]
    return {
        "ok": True,
        "language": result.language,
        "text": result.text,
        "words": words,
        "duration_s": duration,
    }


def main():
    global _model
    from qwen_asr import Qwen3ASRModel  # noqa: PLC0415 — import after CUDA env is set

    _model = Qwen3ASRModel.LLM(
        model=ASR_MODEL,
        forced_aligner=ALIGNER_MODEL or None,
        gpu_memory_utilization=GPU_UTIL,
        max_new_tokens=4096,
    )
    uvicorn.run(app, host="0.0.0.0", port=PORT)


if __name__ == "__main__":
    main()
