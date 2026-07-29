# Tasks: resync-hyperframes-latest-patches

## 1. 同步基线（补丁文档 §2 第 2 步）

- [x] 1.1 备份现役目录为 `hyperframes_github_skills.bak.<timestamp>`（回滚点，`.gitignore` 已忽略）
- [x] 1.2 先删后拷精确镜像：清空 `hyperframes_github_skills/` 内容，`cp -a` `hyperframes_github_skills_latest/.` 覆入
- [x] 1.3 核对镜像结果：`diff -rq` 两目录应零差异；确认 `website-to-video/` 等 5 项现役独有内容已移除；`grep -c qwentts media-use/audio/scripts/lib/tts.mjs` 应为 0（干净基线）

## 2. 重打 QwenTTS 补丁（补丁文档 §3，v1.4 终态）

- [x] 2.1 `media-use/audio/scripts/lib/tts.mjs`：按 §3.3 重放 6 处注入（①provider chain 注释 ②`qwenttsAvailable()` ③`pickProvider` 链首+校验 ④`resolveVoiceId` qwentts 分支 ⑤`synthesizeOne` 分发 ⑥`synthesizeQwenTTS` 实现 + `QWENTTS_LANG_FULL_NAME` + `QWENTTS_CLONE_SCRIPT_DEFAULT`）；确认命名导入齐备（缺则按名补）
- [x] 2.2 `media-use/audio/scripts/audio.mjs`：按 §3.4 重放 2 处注释标注（TTS exception + chain 首位）
- [x] 2.3 `media-use/SKILL.md`：按 §3.5 核对/插入文档点（上游已重构：audio engine 详情移至 `references/audio.md`、provider 表移至 `references/setup-providers.md`，按意图适配为 4 处，§3.5 已同步更新）
- [x] 2.4 `media-use/audio/references/tts.md`：按 §3.6 插入 3 处（provider chain 表第 1 行、`## QwenTTS (local deployment)` 整节于 HeyGen 节后、`When to use which provider` 表加行）

## 3. 静态验证（补丁文档 §6.1）

- [x] 3.1 `node --check` tts.mjs 与 audio.mjs 均通过
- [x] 3.2 `grep -c -i qwentts tts.mjs` = 31，达标
- [x] 3.3 grep 验证文档点：SKILL.md 含 `QwenTTS local` / 优先级例外；tts.md 含 `## QwenTTS (local deployment)` 与 4 个 `QWENTTS_*` 环境变量

## 4. 构建配置核对（补丁文档 §5，只读）

- [x] 4.1 核对 `Dockerfile.fix`（BASE_IMAGE tag、克隆脚本 COPY、httpx 安装、browser ensure 兜底）、`.env.example`（`OH_VERSION_HYPERFRAMES_VERSION`）、`docker-compose.yml`（QWENTTS 环境变量 + `/opt/tts-ref` 挂载）均未受影响、彼此一致

## 5. 文档与收尾

- [x] 5.1 `docs/hyperframes-skill-openharness-patches.md` §9 变更历史追加本次同步记录（含 website-to-video 移除、qwentts 计数）
- [x] 5.2 git status 汇总改动供用户 review；提示后续步骤：按 §5.1 重建镜像 → §6.2 容器侧验证 → 删除备份 → 归档变更
