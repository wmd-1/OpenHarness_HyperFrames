# Spec Delta: session-terminal-mode (harden-session-frontend)

**Baseline:** `openspec/specs/session-terminal-mode.md`（由 `session-service-frontend` 建立，2026-07-27）
**Change ID:** `harden-session-frontend`
**Affects:** `session-frontend/src/components/Terminal/TerminalBridge.ts`、`session-frontend/src/utils/sanitize.ts`

> 本 delta 新增「终端输出控制序列过滤」要求（B2）：服务端文本可能被注入 OSC/危险 CSI 序列制造 UI 欺骗（清屏、伪造提示符、WebLinksAddon 超链接欺骗），写入 xterm 前须清洗。来源：`session-frontend/CODE_REVIEW_REPORT.md`、`plans/Session_Frontend_Fix_Plan_2026-07-28.md`。其余要求（终端渲染、键盘快捷键、状态栏、主题映射、按需加载）不变。

---

## ADDED Requirements

### Requirement: 终端输出控制序列过滤
系统 SHALL 在将服务端下发的文本（`delta`、工具事件等帧内容）写入 xterm 终端前进行控制序列过滤：剥离 OSC 序列（`ESC ] ... BEL/ST`）与危险 CSI 子集（清屏、光标定位、终端模式切换等可伪造界面状态的序列），保留 SGR 颜色/样式序列（`ESC [ ... m`）以维持彩色输出体验。用户本地输入回显不受此过滤影响。

#### Scenario: OSC 序列被剥离
- **WHEN** 服务端 `delta` 帧文本包含 OSC 序列（如 `\x1b]8;;https://evil.example\x07` 超链接或 `\x1b]0;title\x07` 标题设置）
- **THEN** 该序列在写入终端前被剥离，终端不产生可点击欺骗链接、不改变标题，其余文本正常显示

#### Scenario: 危险 CSI 序列被剥离
- **WHEN** 服务端文本包含清屏（`\x1b[2J`）、光标定位（`\x1b[H`）等危险 CSI 序列
- **THEN** 该序列被剥离，终端已有内容与光标位置不被服务端文本篡改

#### Scenario: SGR 颜色序列保留
- **WHEN** 服务端文本包含 SGR 序列（如 `\x1b[31m` 红色、`\x1b[1m` 粗体、`\x1b[0m` 重置）
- **THEN** 该序列原样写入终端，彩色/样式输出正常渲染
