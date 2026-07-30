<!-- 最后更新：2026-07-30 -->

# hyperframes_github_skills — HyperFrames Skill 集合

构建主镜像时 `COPY` 进镜像的 HyperFrames Agent Skills 集合（见仓库根
`Dockerfile`）。每个子目录是一个独立 skill，入口为其中的 `SKILL.md`
（frontmatter 含 `name` / `description`，agent 据此路由）。

本目录**随仓库版本化**（不在 .gitignore 中）；`hyperframes_github_skills_latest/`
是上游 `heygen-com/hyperframes` 仓库的最新对照快照，由仓库根
`sync_hyperframes_skills.sh` 拉取（先删后拷，保证上游删除的文件不残留）；
本目录则是在快照基础上叠加了本地补丁的工作版本。

## Skill 清单

### 核心 / 基础设施

| Skill | 说明 |
| --- | --- |
| `hyperframes` | 总路由入口：不确定用哪个 skill 时从这里进 |
| `hyperframes-core` | 合成（composition）契约：`data-*` 时序属性、`class="clip"`、tracks、子合成、确定性渲染规则、STORYBOARD/SCRIPT 计划格式 |
| `hyperframes-cli` | HyperFrames CLI 用法 |
| `hyperframes-animation` | 全部动画知识：原子运动规则、多阶段场景蓝图、转场、7 个运行时适配器（GSAP 默认，另有 Lottie/Three.js/Anime.js/CSS/WAAPI/TypeGPU） |
| `hyperframes-creative` | 非动画创意方向：design spec、配色、排版、旁白、节拍规划、品牌决策 |
| `hyperframes-keyframes` | 关键帧相关 |
| `hyperframes-registry` | registry blocks/components 的发现、安装与接线（`hyperframes add` / `catalog`） |
| `media-use` | Agent Media OS：BGM/SFX/图像/图标/voice/LUT 的 resolve 与生成；TTS 多 provider（**QwenTTS 本地** / HeyGen / ElevenLabs / Kokoro）、转写、字幕、抠图 |

### 视频类型（按输入路由）

| Skill | 输入 → 输出 |
| --- | --- |
| `general-video` | 通用视频构建 |
| `product-launch-video` | 产品/营销 URL、脚本或 brief → 产品发布/促销视频 |
| `pr-to-video` | GitHub PR → 代码变更讲解视频 |
| `faceless-explainer` | 任意文本/主题 → 无真人出镜讲解视频 |
| `music-to-video` | 音乐轨 → 节拍同步视频（歌词/幻灯/促销） |
| `slideshow` | 幻灯片式视频 |
| `motion-graphics` | 动态图形 |
| `embedded-captions` | 内嵌字幕（含主题/电影模式） |
| `talking-head-recut` | 已有口播/访谈视频 + 图形叠层包装 |
| `remotion-to-hyperframes` | Remotion (React) 合成源码 → HyperFrames HTML（仅显式移植请求） |
| `figma` | Figma 链接/设计 → 合成资产、品牌 token、重建动效 |

## 与镜像的关系

- 构建期：`Dockerfile` 把本目录 COPY 到镜像内 skill 查找路径；
  `pptx2html_github_skills/`（pptx→html）同理。
- 运行期：容器内已带全量 skill，`HYPERFRAMES_NO_AUTO_INSTALL=1` /
  `HYPERFRAMES_NO_UPDATE_CHECK=1` 禁用自动安装与更新检查（见 compose）。
- 修改 skill 后需重建镜像层（或用 `Dockerfile.fix` 打补丁层）才能进入容器；
  与 `src/ohmo` 源码挂载不同，skill 不走 volume。

## 修改约定

- 单个 skill 内改动保持 `SKILL.md` frontmatter（`name`/`description`）与目录名一致；
- 与上游同步时用 `sync_hyperframes_skills.sh` 刷新 `_latest` 快照后再对比合入，不要手工增量拷贝；
- 对 skill 打的本地补丁记录在 `docs/hyperframes-skill-openharness-patches.md`。
