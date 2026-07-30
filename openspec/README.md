<!-- 最后更新：2026-07-30 -->

# openspec — 规格与变更提案

本仓库采用 [OpenSpec](https://github.com/openspec) 规格驱动开发（schema:
`spec-driven`，见 `config.yaml`）。

## 目录约定

```
openspec/
├── specs/       # 主规格（当前有效的能力契约，按能力一文件）
├── changes/     # 进行中的变更提案（proposal / design / specs delta / tasks）
├── archive/     # 已完成归档的变更（含 changes/archive/ 下的历史归档）
└── config.yaml  # OpenSpec 配置
```

## 主规格清单（specs/）

- **视频服务**：`video-service-hardening`、`video-tenant-storage`、`web-front-end`
- **会话服务（后端）**：`interactive-session`、`session-rest-api`、`session-ws-protocol`、
  `session-auth`、`session-approval`、`session-tenant-isolation`、
  `session-container-runtime`、`session-pool-scheduling`、`session-workspace-archive`、
  `session-history-switch`、`session-deployment-config`、`session-live-acceptance`
- **会话前端**：`session-ui-shell`、`session-chat-mode`、`session-terminal-mode`、
  `session-frontend-history-switch`、`session-frontend-workspace-files`
- **其他**：`media-use-tts`（QwenTTS provider）、`unified-backend-image`

## 工作流

1. 提案：`/openspec-propose`（生成 proposal / design / specs delta / tasks）；
2. 实施：`/openspec-apply-change` 按 tasks 执行；
3. 同步：`/openspec-sync-specs` 把 delta 合入主规格；
4. 归档：`/openspec-archive-change`，归档目录为 `openspec/archive/`。
