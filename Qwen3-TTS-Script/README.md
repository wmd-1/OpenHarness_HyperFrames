<!-- 最后更新：2026-07-30 -->

# Qwen3-TTS-Script

基于 vllm-omni 部署的 Qwen3-TTS（Base 模型）**声音克隆批量合成**脚本集。
核心能力：多次生成复用同一本地参考音频的提示特征，避免每次请求重复上传/重复计算。

## 脚本清单

| 脚本 | 用途 |
|---|---|
| `qwen3_tts_clone.py` | 上传/复用参考音色，批量把多句文本合成为音频文件 |

## 前置条件

1. **服务已启动**：vllm-omni 以 `--omni` 方式 serve Qwen3-TTS Base 模型。既支持 HF 模型名，也支持**下载到本地后挂载路径**部署，例如：
   ```bash
   # HF 模型名
   vllm serve Qwen/Qwen3-TTS-12Hz-1.7B-Base --omni --port 8091
   # 或本地挂载路径（如 ModelScope 下载的 Qwen3-TTS-12Hz-1___7B-Base 目录）
   vllm serve /models/Qwen3-TTS-12Hz-1___7B-Base --omni --port 8091
   ```
   两种方式脚本都无需额外配置（默认不发送 `model` 字段，不受模型名影响）。
   健康检查：`curl http://localhost:8091/v1/audio/voices` 返回 200 即可用。
2. **Python 依赖**：仅需 `httpx`（`pip install httpx`）。
3. **参考音频**：本地 wav/mp3/flac/ogg 文件，时长 **1~30 秒**（服务端硬性校验），
   并准备其**转写文本**（`--ref-text`，ICL 克隆模式必填）。

## 快速开始（agent 推荐调用方式）

```bash
cd /root/projects/OpenHarness_HyperFrames/Qwen3-TTS-Script

# 多句合成，参考音色只上传一次，后续自动复用
python qwen3_tts_clone.py \
    --api-base http://localhost:8091 \
    --ref-audio /path/to/reference.wav \
    --ref-text "参考音频的转写文本" \
    --text "第一句话。" \
    --text "第二句话。" \
    --output-dir ./outputs
```

或从文本文件批量读取（每行一句，空行忽略）：

```bash
python qwen3_tts_clone.py \
    --ref-audio /path/to/reference.wav \
    --ref-text "参考音频的转写文本" \
    --input-file sentences.txt
```

## 输出约定

- 音频写入 `--output-dir`（默认 `./outputs`，不存在会自动创建）。
- 文件名按文本顺序编号：`001.wav`、`002.wav`、…（扩展名跟随 `--response-format`）。
- stdout 每句打印耗时与输出路径，最后打印总耗时/平均耗时；失败时向 stderr 打印错误并以退出码 `1` 结束，成功退出码 `0`。
- agent 判定成功的方式：**退出码为 0** 且输出目录中生成了与文本数量一致的音频文件。

## 参数说明

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--api-base` | `http://localhost:8091` | vllm-omni 服务地址 |
| `--api-key` | `EMPTY` | Bearer token，本地部署一般无需修改 |
| `--model` / `-m` | 不发送 | 默认不带 `model` 字段（服务端跳过模型名校验，**本地挂载部署直接可用**）；如需指定，须与 `curl <api-base>/v1/models` 返回的名字一致（本地挂载部署时通常是挂载路径） |
| `--mode` | `upload` | 参考提示复用方式，见下节 |
| `--ref-audio` | （必填） | 本地参考音频路径 |
| `--ref-text` | 无 | 参考音频转写文本；ICL 模式必填，`--x-vector-only` 时可省略 |
| `--x-vector-only` | 关 | 仅用说话人向量克隆，无需 ref_text，但克隆质量下降 |
| `--voice-name` | 音频内容 hash（`clone_xxxx`） | upload 模式的音色名；同一音频自动得到相同名字，实现跨运行复用 |
| `--consent` | `local_script_consent` | 上传音色时的 consent 标识 |
| `--force-upload` | 关 | 音色已存在时强制重新上传（如换了 ref_text） |
| `--text` | 无 | 待合成文本，可重复传入多次 |
| `--input-file` | 无 | 文本文件，每行一句；可与 `--text` 同时使用（`--text` 在前） |
| `--language` | 服务端自动 | `Auto`/`Chinese`/`English`/`Japanese`/… |
| `--max-new-tokens` | 服务端默认 | 生成 token 上限 |
| `--response-format` | `wav` | `wav`/`mp3`/`flac`/`pcm`/`aac`/`opus` |
| `--output-dir` / `-o` | `outputs` | 输出目录 |
| `--timeout` | `300` | 单次请求超时（秒） |

## 复用机制说明（为什么第 2 句起会明显变快）

### `--mode upload`（默认，推荐）

1. 首次运行：`POST /v1/audio/voices` 上传参考音频 + ref_text，服务端预计算参考特征并按音色名缓存（speaker cache）。
2. 之后每句只发 `{"input": ..., "voice": "<音色名>", "task_type": "Base"}`——不传音频、不重算特征。
3. 幂等：脚本先 `GET /v1/audio/voices` 检查音色是否存在，存在则跳过上传。
   音色名默认按音频内容 SHA1 生成，因此**同一音频文件跨多次运行、跨多个 agent 会话都自动复用**。

### `--mode inline`

- 参考音频只在本地编码一次 base64 data URL，每次请求携带**完全相同的字符串**。
- 服务端按该字符串 sha1 缓存解码结果，且首次请求后模型侧参考特征标记 ready，后续请求跳过重算。
- 适合不想在服务端留下音色记录的场景；代价是每次请求重复传输 base64。

> 注意：inline 模式依赖服务端 LRU 缓存（默认 256 条 / 256MB），服务重启或缓存淘汰后首句会重新计算。upload 模式的音色上传后持久保存在服务端（默认 `~/.cache/vllm-omni/speakers`），更可靠。

## 音色管理（可选）

```bash
# 查看已上传音色
curl http://localhost:8091/v1/audio/voices

# 删除某个音色
curl -X DELETE http://localhost:8091/v1/audio/voices/<voice_name>
```

## 常见错误排查

| 现象 | 原因与处理 |
|---|---|
| `ICL 克隆模式需要 --ref-text` | 提供 `--ref-text`，或改用 `--x-vector-only` |
| `Reference audio too short/long` | 参考音频需 1~30 秒，换/裁剪音频 |
| 连接拒绝 / 超时 | 确认服务已启动且 `--api-base` 端口正确 |
| `Model mismatch: request specifies ...` | 去掉 `--model` 参数（推荐），或改成 `curl <api-base>/v1/models` 返回的实际模型名 |
| `Base task requires 'ref_audio' ...` | upload 模式下音色名未命中（如服务端音色被删），加 `--force-upload` 重新上传 |
| 换了 ref_text 但音色没变化 | 音色名相同则复用旧上传，需 `--force-upload` 覆盖 |

## 参考资料

- vllm-omni TTS 在线服务文档：vllm-omni 仓库 `examples/online_serving/text_to_speech/README.md`（Qwen3-TTS 章节；位于 TTS 服务部署机器的 vllm-omni 源码目录，本仓库不包含）
- Qwen3-TTS 官方 README（`create_voice_clone_prompt` 提示复用的等价说明）：https://github.com/QwenLM/Qwen3-TTS
