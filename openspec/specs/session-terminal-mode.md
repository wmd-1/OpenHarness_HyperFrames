# Session Terminal Mode Specification

**Component:** `session-frontend/`（Session Service 专用 React 前端）
**Established by change:** `session-service-frontend` (2026-07-27)

Terminal 模式：xterm.js 终端渲染、键盘快捷键、状态栏、主题映射、按需加载。

---

## Requirements

### Requirement: Terminal Mode 终端渲染
系统 SHALL 提供基于 xterm.js 的终端模拟视图，以等宽字体和暗色背景呈现对话交互，信息密度高于 Chat Mode。

#### Scenario: 终端视图初始化
- **WHEN** 用户切换到 Terminal Mode
- **THEN** 主区域渲染 xterm.js 终端实例，显示欢迎横幅和会话信息，光标闪烁等待输入

#### Scenario: 终端输出渲染
- **WHEN** WebSocket 接收到助手回复、工具调用等事件
- **THEN** TerminalBridge 将事件转换为终端文本输出，支持 ANSI 转义序列（颜色、粗体等）

### Requirement: 键盘快捷键
系统 SHALL 在 Terminal Mode 下支持以下键盘快捷键：Ctrl+C 中断/退出、Escape 运行中中断、上下箭头历史导航、Tab 命令补全、Shift+Enter 换行。

#### Scenario: Ctrl+C 中断
- **WHEN** 用户在终端中按 Ctrl+C
- **THEN** 若轮次正在执行，发送 `interrupt` 帧中断当前轮次；若空闲，退出当前会话

#### Scenario: 历史命令导航
- **WHEN** 用户在终端输入区按上箭头
- **THEN** 显示上一条发送的消息，继续按上箭头可浏览更早的消息

#### Scenario: 命令补全
- **WHEN** 用户输入 `/` 后按 Tab
- **THEN** 显示可用命令列表，支持选择确认

### Requirement: Terminal Mode 状态栏
系统 SHALL 在终端底部显示状态栏，包含模型名称、token 用量、权限模式和会话状态。

#### Scenario: 状态栏实时更新
- **WHEN** 会话状态或 token 用量发生变化
- **THEN** 终端底部状态栏实时更新对应字段

### Requirement: Terminal Mode 主题映射
系统 SHALL 将 5 个内置主题映射为 xterm.js 主题配置，确保终端模式与 Chat Mode 主题视觉一致。

#### Scenario: 切换主题影响终端
- **WHEN** 用户在 Terminal Mode 下切换主题（如从 dark 切换到 cyberpunk）
- **THEN** xterm.js 终端的 foreground、background、cursor 和 ANSI 颜色立即更新

### Requirement: Terminal Mode 按需加载
系统 SHALL 对 Terminal Mode 相关代码（xterm.js 及其插件）进行动态 import，仅在用户切换到 Terminal Mode 时加载。

#### Scenario: Chat Mode 不加载终端依赖
- **WHEN** 用户始终使用 Chat Mode
- **THEN** xterm.js 相关代码（~300KB gzipped）不被下载

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
