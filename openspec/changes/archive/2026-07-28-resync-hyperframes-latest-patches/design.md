# Design: resync-hyperframes-latest-patches

## Context

- 基线：`hyperframes_github_skills_latest/`（上游快照，已完成拉取，只读）；现役 `hyperframes_github_skills/`（打过 v1.4 QwenTTS 补丁，qwentts 计数 31）。
- 差异勘察结论（2026-07-28）：
  - 185 个文件内容差异，大量新增文件（media-use luts/grading/recipes/telemetry、hyperframes-animation 新 blueprints/rules、多数 skill 新增 `*.test.mjs`）。
  - 现役独有：`website-to-video/`（整个 skill 上游已移除）、`embedded-captions/assets/brand`、`embedded-captions/themes/nightcity.json`、`hyperframes-animation/examples/assets`、`hyperframes-creative/frame-presets/claude`——均无 `qwen`/QwenTTS 标记、无 Dockerfile/Dockerfile.fix/docker-compose.yml 引用，判定为纯上游漂移。
  - OpenHarness 定制仅存在于 4 个文件：`media-use/SKILL.md`、`media-use/audio/references/tts.md`、`media-use/audio/scripts/audio.mjs`、`media-use/audio/scripts/lib/tts.mjs`。
  - 上游新版 `tts.mjs` 锚点完好：`pickProvider` / `resolveVoiceId` / `synthesizeOne` / `transcodeToWav` / `heygenAvailable` / `elevenlabsAvailable` / `pythonInvocation` 及命名导入（`spawnSync`/`mkdtempSync`/`readFileSync`/`rmSync`/`existsSync`/`tmpdir`/`join`）均存在，§3.3 六处注入点可逐字重放。
- 约束：补丁工作流以 `docs/hyperframes-skill-openharness-patches.md` 为单一事实来源（§2 工作流、§3 补丁终态、§6 验证、§7 勿手动重复上游自带内容）。

## Goals / Non-Goals

**Goals:**
- `hyperframes_github_skills/` 与 latest 基线完全一致 + 仅叠加 §3 的 QwenTTS 补丁（v1.4 终态）。
- 静态验证全过（`node --check` ×2、qwentts 计数、SKILL.md/tts.md 文档点）。
- 主 spec `media-use-tts` 对齐 v1.4 语义（经本变更 delta 归档合入）。
- 补丁文档 §9 记录本次同步。

**Non-Goals:**
- 不升级 HyperFrames npm 版本（`Dockerfile.fix` 的 `HYPERFRAMES_VERSION`）、不改镜像 tag——本次仅 skill 内容同步，重建走既有 `Dockerfile.fix` skills COPY 层。
- 不动 `Qwen3-TTS-Script/`、`pptx2html_github_skills/`（非 HyperFrames skill 同步范围）。
- 容器侧验证（§6.2）不在本变更内完成（依赖镜像重建，作为后续步骤记录）。

## Decisions

1. **先删后拷的精确镜像覆盖**（`rm -rf` 目标目录内容 + `cp -a` latest → 现役），而非 `cp -a` 直接覆盖：保证上游已删除文件（`website-to-video/` 等 5 项）不残留，与 2026-07-08 同步（§10.2）做法一致。备份 `hyperframes_github_skills.bak.<timestamp>` 作为回滚点（`.gitignore` 已忽略 `*.bak.*`），归档前删除。
2. **补丁逐字重放而非 diff 移植**：§3.3/§3.4/§3.5/§3.6 的注入片段已是 v1.4 落地版（§14 回写），直接按"意图 + 锚点"插入新基线；不从旧现役文件 diff 搬运，避免把旧基线噪声带进来。
3. **文档补丁（SKILL.md / tts.md）按 §3.5/§3.6 内容点核对插入**：上游这两个文件本次也有变化，以新上游内容为底、只插 QwenTTS 文档点；若上游表格结构变化，按"QwenTTS 第 1 行 + 优先级例外说明"意图适配。
4. **spec delta 用 MODIFIED + ADDED**：`resolveVoiceId` 行为变化用 MODIFIED（全量复制原 requirement 后改写）；克隆脚本合成、fail-fast 为新增关注点用 ADDED。主 spec 现为单文件 `openspec/specs/media-use-tts.md`，delta 放 `specs/media-use-tts/spec.md`，归档时对齐。
5. **git 提交粒度**：覆盖 + 重打补丁一次性完成后整体 review（git 天然记录覆盖差异），不做中间提交；是否提交由用户决定。

## Risks / Trade-offs

- [上游文档结构漂移导致 §3.5/§3.6 插入点不精确] → 按意图适配（第 1 行 / HeyGen 节后插入），完成后用 grep 文档点验证。
- [website-to-video 有未发现的使用方] → 已 grep 构建文件无引用；备份保留至归档前，可随时回补。
- [覆盖引入上游新 bug] → 非本变更责任范围；`node --check` 保证补丁文件语法，其余上游文件原样信任（与历次同步一致）。
- [qwentts 计数基准漂移] → 以补丁文档 §14 的计数 31 为期望值；若插入后不等，逐注入点核对而非硬凑。

## Migration Plan

1. 备份现役目录 → 2. 精确镜像覆盖 → 3. 重放 6+2+3+3 处补丁 → 4. §6.1 静态验证 → 5. 构建配置核对（只读）→ 6. 补丁文档 §9 追加记录 → 7. 用户确认后按 §5.1 重建镜像 + §6.2 容器侧验证 → 8. 归档变更（delta 合入主 spec）。
回滚：`rm -rf hyperframes_github_skills && mv hyperframes_github_skills.bak.<ts> hyperframes_github_skills`（或 git checkout）。

## Open Questions

- 无（镜像 tag / npm 版本本次明确不动；如后续要求升级，另开变更按 §5 处理）。
