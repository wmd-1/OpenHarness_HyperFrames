<!-- 最后更新：2026-07-30 -->

# docs — 项目文档与报告

跨模块的补丁说明、测试报告与审查记录。子项目自身的文档放各自目录
（`service/API_DOCUMENTATION.md`、`session-service/API_DOCUMENTATION.md` 等）。

## 文档索引

| 文件 | 说明 |
| --- | --- |
| `hyperframes-skill-openharness-patches.md` | HyperFrames skill 的本地补丁分层记录（基线 = `hyperframes_github_skills_latest/`，补丁落在 `hyperframes_github_skills/`） |
| `service-web-test-report-2026-07-30.md` | service + web 测试报告 |
| `session-code-review-2026-07-30.md` | session 相关代码审查记录 |
| `session-e2e-test-report-2026-07-30.md` | session E2E 测试报告 |
| `api-key-sidebar-verify.png` | 前端 API Key 侧栏验证截图 |

## 约定

- 报告类文档带日期后缀（`*-YYYY-MM-DD.md`），作为历史快照不回改，只追加更正；
- 补丁文档按「基线 → 补丁 → 验证」分层结构书写。
