# Proposal: resync-hyperframes-latest-patches

## Why

上游 heygen-com/hyperframes 发布了新版 skill 集合，`hyperframes_github_skills_latest/` 已完成拉取（§2 第 1 步）。现役 `hyperframes_github_skills/` 与 latest 存在 185 个文件差异 + 大量新增文件（media-use 新增 luts/grading/recipes、hyperframes-animation 新增 blueprints/rules、各 skill 新增测试等），需按 `docs/hyperframes-skill-openharness-patches.md` §2 工作流用 latest 覆盖现役目录，并重打 OpenHarness 的 QwenTTS 定制补丁（v1.4 克隆脚本版）。

同时，主 spec `openspec/specs/media-use-tts.md` 仍停留在 v1.3 语义（speech/chat 双模式、`resolveVoiceId` 回退 `"vivian"`），与 2026-07-27 已落地的 v1.4 克隆脚本行为不一致，本次一并对齐。

## What Changes

- **同步基线**：备份现役目录后，用 `hyperframes_github_skills_latest/` 精确镜像覆盖 `hyperframes_github_skills/`（先删后拷）。
  - **BREAKING（上游漂移）**：上游移除了 `website-to-video` skill（现役有、latest 无；已确认无 OpenHarness 定制标记、无 Dockerfile/compose 引用），随镜像覆盖一并移除。
  - 现役独有的上游遗留文件（`embedded-captions/assets/brand`、`themes/nightcity.json`、`hyperframes-animation/examples/assets`、`hyperframes-creative/frame-presets/claude`）同为纯上游漂移，随覆盖移除。
- **重打 QwenTTS 补丁（v1.4 终态，补丁文档 §3）**：
  - `media-use/audio/scripts/lib/tts.mjs`：6 处注入（provider chain 注释 / `qwenttsAvailable` / `pickProvider` 链首 / `resolveVoiceId` qwentts 分支 / `synthesizeOne` 分发 / `synthesizeQwenTTS` 克隆脚本实现 + `QWENTTS_LANG_FULL_NAME`）。已确认上游锚点函数与命名导入均存在，可按 §3.3 逐字重放。
  - `media-use/audio/scripts/audio.mjs`：2 处注释标注（§3.4）。
  - `media-use/SKILL.md`：provider 文档 3 处（§3.5）。
  - `media-use/audio/references/tts.md`：QwenTTS 参考节 3 处（§3.6）。
- **构建配置核对（§5）**：`Dockerfile.fix` / `.env.example` / `docker-compose.yml` 本次上游同步不涉及版本升级逻辑变化，仅核对；若决定升级 HYPERFRAMES npm 版本或镜像 tag，按 §5 同步（默认不动）。
- **spec 对齐 v1.4**：更新 `media-use-tts` 主 spec 的 voice 解析（`QWENTTS_VOICE || null`，克隆脚本按内容 hash 生成 `clone_<sha1>`）、新增克隆脚本合成与 REF_AUDIO/REF_TEXT fail-fast 要求，废弃 speech/chat 双模式描述。
- **补丁文档更新**：`docs/hyperframes-skill-openharness-patches.md` §9 变更历史追加本次同步记录。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `media-use-tts`：对齐 v1.4 克隆脚本语义——(1) `resolveVoiceId` qwentts 分支返回 `QWENTTS_VOICE || null`（替代 `"vivian"` 回退）；(2) 新增"合成经 qwen3_tts_clone.py 克隆脚本、参考音色幂等上传复用"要求；(3) 新增"缺 `QWENTTS_REF_AUDIO`/`QWENTTS_REF_TEXT` 配置即抛错（fail-fast），运行期失败仍 `{ok:false}` 优雅降级"要求；(4) 同步后的新上游基线上上述要求必须继续成立（重打补丁验证）。

## Impact

- **代码**：`hyperframes_github_skills/` 全目录（覆盖 + 4 个文件重打补丁）；`openspec/specs/media-use-tts.md`（经归档合入）；`docs/hyperframes-skill-openharness-patches.md`（§9 记录）。
- **不动**：`Qwen3-TTS-Script/`（非 skill 文件，不受同步影响）、`Dockerfile` / `Dockerfile.fix` / `docker-compose.yml` / `.env.example`（仅核对）、`hyperframes_github_skills_latest/`（只读基线）。
- **镜像**：补丁落地后需按 §5.1 用 `Dockerfile.fix` 重建镜像（skills COPY 层，<5s）方可在容器生效；本变更含静态验证，容器侧验证（§6.2）在重建后进行。
- **风险**：上游 `tts.mjs` 结构与 v0.7.42 一致（锚点已勘察确认），重放风险低；`website-to-video` 移除若有隐性使用方需回补（当前无引用证据）。
