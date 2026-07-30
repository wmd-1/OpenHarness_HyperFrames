<!-- 最后更新：2026-07-30 -->

# assets — 运行时资源

宿主机侧的运行时资源目录（区别于构建期资源 `docker/`）。

## tts-ref/ — QwenTTS 参考音频

QwenTTS 声音克隆的参考音频存放目录，经 compose 只读挂载进容器：

- 挂载关系：`${QWENTTS_REF_AUDIO_HOST_DIR:-./assets/tts-ref}` → 容器内 `/opt/tts-ref`（ro）；
- `.env` 中 `QWENTTS_REF_AUDIO` 填**容器内路径**（如 `/opt/tts-ref/reference.wav`）；
- 音频要求：wav/mp3/flac/ogg，时长 1~30 秒（服务端硬校验），
  并需配套转写文本 `QWENTTS_REF_TEXT`；
- 目录内容不入 git（按需自备参考音频）。

详见 [.env.example](../.env.example) 的 QwenTTS 分组与
[Qwen3-TTS-Script/README.md](../Qwen3-TTS-Script/README.md)。
