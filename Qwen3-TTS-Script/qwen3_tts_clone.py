#!/usr/bin/env python3
"""Qwen3-TTS (vllm-omni) 声音克隆批量生成脚本 —— 复用同一本地参考音频。

针对基于 vllm-omni 部署的 Qwen3-TTS Base 模型（/v1/audio/speech 端点），
在多次生成中复用相同的参考提示，避免每次请求都重复计算参考音频特征。

两种复用模式：

1. upload（默认，推荐）：
   通过 POST /v1/audio/voices 把本地参考音频 + 转写文本上传一次，
   之后每次 /v1/audio/speech 只传 voice=<名字>。服务端按音色名缓存
   参考特征（speaker cache），后续请求不再传输音频、不再重复计算。
   上传是幂等的：脚本先 GET /v1/audio/voices 检查，已存在则直接复用。

2. inline：
   本地音频只读取/编码一次成 base64 data URL，每次请求都带同一个
   字符串。服务端按该字符串的 sha1 缓存解码结果（_ref_audio_resolve_cache），
   且首次请求后模型侧参考特征被标记为 ready，后续同样跳过重算。
   适合不想在服务端留下音色记录的场景，代价是每次请求重复传 base64。

用法示例：

    # 上传一次音色，批量生成多句（推荐）
    python qwen3_tts_clone.py \
        --ref-audio /path/to/reference.wav \
        --ref-text "参考音频的转写文本" \
        --text "第一句话。" --text "第二句话。"

    # 从文件读取文本（每行一句）
    python qwen3_tts_clone.py \
        --ref-audio /path/to/reference.wav \
        --ref-text "参考音频的转写文本" \
        --input-file sentences.txt

    # inline 模式（不上传音色，靠服务端缓存复用）
    python qwen3_tts_clone.py --mode inline \
        --ref-audio /path/to/reference.wav \
        --ref-text "参考音频的转写文本" \
        --input-file sentences.txt
"""

import argparse
import base64
import hashlib
import os
import sys
import time

import httpx

DEFAULT_API_BASE = "http://localhost:8091"
DEFAULT_API_KEY = "EMPTY"

_MIME_BY_EXT = {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".mpeg": "audio/mpeg",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
}


def read_audio_bytes(audio_path: str) -> bytes:
    if not os.path.isfile(audio_path):
        raise FileNotFoundError(f"参考音频不存在: {audio_path}")
    with open(audio_path, "rb") as f:
        return f.read()


def guess_mime(audio_path: str) -> str:
    ext = os.path.splitext(audio_path.lower())[1]
    return _MIME_BY_EXT.get(ext, "audio/wav")


def encode_audio_to_data_url(audio_bytes: bytes, mime_type: str) -> str:
    b64 = base64.b64encode(audio_bytes).decode("utf-8")
    return f"data:{mime_type};base64,{b64}"


def default_voice_name(audio_bytes: bytes) -> str:
    """按音频内容 hash 生成稳定的音色名，同一音频多次运行自动复用。"""
    digest = hashlib.sha1(audio_bytes).hexdigest()[:12]
    return f"clone_{digest}"


def auth_headers(api_key: str) -> dict:
    return {"Authorization": f"Bearer {api_key}"}


def voice_exists(client: httpx.Client, api_base: str, api_key: str, name: str) -> bool:
    """检查音色是否已上传（GET /v1/audio/voices，幂等复用）。"""
    resp = client.get(f"{api_base}/v1/audio/voices", headers=auth_headers(api_key))
    resp.raise_for_status()
    data = resp.json()
    name_lower = name.lower()
    for entry in data.get("uploaded_voices") or []:
        entry_name = entry.get("name") if isinstance(entry, dict) else entry
        if isinstance(entry_name, str) and entry_name.lower() == name_lower:
            return True
    return any(isinstance(v, str) and v.lower() == name_lower for v in data.get("voices") or [])


def upload_voice(
    client: httpx.Client,
    api_base: str,
    api_key: str,
    name: str,
    audio_path: str,
    audio_bytes: bytes,
    ref_text: str,
    consent: str,
) -> None:
    """POST /v1/audio/voices 上传参考音频，服务端预计算并缓存参考特征。"""
    files = {"audio_sample": (os.path.basename(audio_path), audio_bytes, guess_mime(audio_path))}
    form = {"name": name, "consent": consent, "ref_text": ref_text}
    resp = client.post(
        f"{api_base}/v1/audio/voices",
        files=files,
        data=form,
        headers=auth_headers(api_key),
    )
    if resp.status_code != 200:
        raise RuntimeError(f"上传音色失败 ({resp.status_code}): {resp.text}")
    print(f"[upload] 音色 '{name}' 上传成功")


def synthesize(
    client: httpx.Client,
    api_base: str,
    api_key: str,
    payload: dict,
    output_path: str,
) -> float:
    """调用 /v1/audio/speech 生成一句，返回耗时（秒）。"""
    start = time.perf_counter()
    resp = client.post(
        f"{api_base}/v1/audio/speech",
        json=payload,
        headers={**auth_headers(api_key), "Content-Type": "application/json"},
    )
    elapsed = time.perf_counter() - start
    if resp.status_code != 200:
        raise RuntimeError(f"生成失败 ({resp.status_code}): {resp.text}")
    # 服务端可能以 200 返回 JSON 错误体
    try:
        text = resp.content.decode("utf-8")
        if text.startswith('{"error"'):
            raise RuntimeError(f"生成失败: {text}")
    except UnicodeDecodeError:
        pass  # 二进制音频，正常
    with open(output_path, "wb") as f:
        f.write(resp.content)
    return elapsed


def collect_texts(args) -> list[str]:
    texts: list[str] = list(args.text or [])
    if args.input_file:
        with open(args.input_file, encoding="utf-8") as f:
            texts.extend(line.strip() for line in f if line.strip())
    if not texts:
        raise SystemExit("错误: 请通过 --text（可多次）或 --input-file 提供至少一句文本")
    return texts


def parse_args():
    parser = argparse.ArgumentParser(
        description="Qwen3-TTS (vllm-omni) 复用同一参考音频的批量声音克隆脚本",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--api-base", default=DEFAULT_API_BASE, help=f"服务地址 (默认: {DEFAULT_API_BASE})")
    parser.add_argument("--api-key", default=DEFAULT_API_KEY, help="API key (默认: EMPTY)")
    parser.add_argument(
        "--model",
        "-m",
        default=None,
        help="模型名 (默认不发送, 服务端跳过校验; 如指定须与 GET /v1/models 返回的名字一致, "
        "本地挂载部署时通常是挂载路径)",
    )
    parser.add_argument(
        "--mode",
        choices=["upload", "inline"],
        default="upload",
        help="参考提示复用方式: upload=上传一次音色后按名引用(默认); inline=每次带同一 base64 靠服务端缓存",
    )
    parser.add_argument("--ref-audio", required=True, help="本地参考音频路径 (wav/mp3/flac/ogg)")
    parser.add_argument("--ref-text", default=None, help="参考音频的转写文本 (ICL 模式必填)")
    parser.add_argument(
        "--x-vector-only",
        action="store_true",
        help="仅用说话人向量克隆 (无需 ref_text, 但克隆质量会下降)",
    )
    parser.add_argument("--voice-name", default=None, help="upload 模式音色名 (默认按音频内容 hash 生成)")
    parser.add_argument("--consent", default="local_script_consent", help="upload 模式的 consent 标识")
    parser.add_argument("--force-upload", action="store_true", help="即使音色已存在也重新上传")
    parser.add_argument("--text", action="append", help="要合成的文本，可多次传入")
    parser.add_argument("--input-file", default=None, help="文本文件，每行一句")
    parser.add_argument("--language", default=None, help="语言: Auto/Chinese/English/... (默认服务端自动)")
    parser.add_argument("--max-new-tokens", type=int, default=None, help="生成 token 上限")
    parser.add_argument(
        "--response-format",
        default="wav",
        choices=["wav", "mp3", "flac", "pcm", "aac", "opus"],
        help="输出音频格式 (默认: wav)",
    )
    parser.add_argument("--output-dir", "-o", default="outputs", help="输出目录 (默认: ./outputs)")
    parser.add_argument("--timeout", type=float, default=300.0, help="单次请求超时秒数 (默认: 300)")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if not args.x_vector_only and not (args.ref_text and args.ref_text.strip()):
        print("错误: ICL 克隆模式需要 --ref-text (或改用 --x-vector-only)", file=sys.stderr)
        return 1

    texts = collect_texts(args)
    audio_bytes = read_audio_bytes(args.ref_audio)
    os.makedirs(args.output_dir, exist_ok=True)

    # 构造每次请求共用的基础 payload。model 字段在 vllm-omni 中可选:
    # 不传则服务端跳过模型名校验(本地路径挂载部署时模型名是路径, 不传最通用)
    base_payload: dict = {
        "task_type": "Base",
        "response_format": args.response_format,
    }
    if args.model:
        base_payload["model"] = args.model
    if args.language:
        base_payload["language"] = args.language
    if args.max_new_tokens:
        base_payload["max_new_tokens"] = args.max_new_tokens
    if args.x_vector_only:
        base_payload["x_vector_only_mode"] = True

    with httpx.Client(timeout=args.timeout) as client:
        if args.mode == "upload":
            voice_name = args.voice_name or default_voice_name(audio_bytes)
            if not args.force_upload and voice_exists(client, args.api_base, args.api_key, voice_name):
                print(f"[upload] 音色 '{voice_name}' 已存在，直接复用（跳过上传）")
            else:
                upload_voice(
                    client,
                    args.api_base,
                    args.api_key,
                    voice_name,
                    args.ref_audio,
                    audio_bytes,
                    args.ref_text or "",
                    args.consent,
                )
            base_payload["voice"] = voice_name
        else:
            # inline: data URL 只编码一次，每次请求复用完全相同的字符串，
            # 命中服务端 ref_audio 解码缓存与首次请求后的特征 warmup
            print("[inline] 参考音频编码一次，后续请求复用同一 data URL（服务端缓存生效）")
            base_payload["ref_audio"] = encode_audio_to_data_url(audio_bytes, guess_mime(args.ref_audio))
            if args.ref_text:
                base_payload["ref_text"] = args.ref_text

        print(f"共 {len(texts)} 句待合成，输出目录: {args.output_dir}")
        total = 0.0
        for i, text in enumerate(texts, start=1):
            payload = {**base_payload, "input": text}
            output_path = os.path.join(args.output_dir, f"{i:03d}.{args.response_format}")
            try:
                elapsed = synthesize(client, args.api_base, args.api_key, payload, output_path)
            except RuntimeError as e:
                print(f"[{i}/{len(texts)}] 失败: {e}", file=sys.stderr)
                return 1
            total += elapsed
            preview = text if len(text) <= 30 else text[:30] + "..."
            print(f"[{i}/{len(texts)}] {elapsed:.2f}s -> {output_path}  ({preview})")

        print(f"完成: {len(texts)} 句，总耗时 {total:.2f}s，平均 {total / len(texts):.2f}s/句")
    return 0


if __name__ == "__main__":
    sys.exit(main())
