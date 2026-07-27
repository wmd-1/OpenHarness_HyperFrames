## ADDED Requirements

### Requirement: Chat Mode 对话视图渲染
系统 SHALL 在 Chat Mode 下提供完整的对话视图，渲染用户消息、助手回复、工具调用和系统消息四种角色。消息 SHALL 按时间顺序排列，用户消息右对齐，助手消息左对齐。

#### Scenario: 渲染用户发送的消息
- **WHEN** 用户通过输入栏发送一条消息
- **THEN** 消息立即以右对齐气泡形式出现在消息列表底部，显示用户头像和时间戳

#### Scenario: 渲染流式助手回复
- **WHEN** 服务端通过 WebSocket 发送 `delta` 帧
- **THEN** 助手消息气泡实时更新追加文本内容，显示打字光标动画，直到收到 `final: true` 的 delta 帧或 `turn_complete` 帧

#### Scenario: 渲染工具调用
- **WHEN** 服务端发送 `tool_start` 和 `tool_end` 帧
- **THEN** 在对话流中显示折叠式工具调用卡片，包含工具名称、输入参数摘要、执行状态（运行中/成功/失败），点击可展开查看完整输入输出

### Requirement: 流式文本批量渲染
系统 SHALL 采用批量 flush 策略渲染流式文本，阈值为 50ms 或累积 384 字符，以先到者为准，避免逐 token 重渲染导致性能劣化。

#### Scenario: 高频 delta 帧批量渲染
- **WHEN** 服务端在 10ms 间隔内连续发送多个 delta 帧
- **THEN** 前端将多个 delta 累积在缓冲区中，每 50ms 或达到 384 字符时统一 flush 到 DOM，而非每个 delta 触发一次重渲染

### Requirement: TODO 面板实时展示
系统 SHALL 在对话视图中提供可折叠的 TODO 面板，当收到 `todo` 帧时实时更新任务清单。

#### Scenario: TODO 列表更新
- **WHEN** 服务端发送 `todo` 帧，包含 `todo_markdown` 字段
- **THEN** TODO 面板解析 markdown 内容并渲染任务列表，已完成项显示删除线，当前项高亮

#### Scenario: TODO 面板折叠/展开
- **WHEN** 用户点击 TODO 面板标题
- **THEN** 面板在展开和折叠状态之间切换，折叠时仅显示标题和完成进度（如 2/5）

### Requirement: 输入栏交互
系统 SHALL 提供多行文本输入栏，支持 Enter 发送、Shift+Enter 换行、`/` 命令补全。

#### Scenario: 发送消息
- **WHEN** 用户在输入栏输入文本并按 Enter
- **THEN** 文本通过 WebSocket 以 `submit` 帧发送，输入栏清空

#### Scenario: 多行输入
- **WHEN** 用户在输入栏按 Shift+Enter
- **THEN** 输入栏插入换行符，不发送消息

#### Scenario: 命令补全
- **WHEN** 用户输入 `/` 前缀
- **THEN** 显示命令补全下拉列表，支持上下箭头选择和 Tab 确认

### Requirement: 视频产物预览和下载
系统 SHALL 在对话中内嵌视频产物预览卡片，提供播放和下载功能。

#### Scenario: 视频预览
- **WHEN** 轮次完成且该轮次有产物
- **THEN** 在助手回复下方显示视频播放器卡片，支持播放/暂停/进度条/全屏

#### Scenario: 产物下载
- **WHEN** 用户点击下载按钮
- **THEN** 通过 `GET /v1/sessions/{sid}/turns/{idx}/artifact` 下载文件，跟随 S3 302 重定向

### Requirement: 消息列表虚拟滚动
系统 SHALL 使用虚拟滚动渲染消息列表，仅渲染可见区域的消息，支持向上滚动加载历史消息。

#### Scenario: 大量消息性能
- **WHEN** 对话包含 500+ 条消息
- **THEN** 消息列表仅渲染可视区域内的消息节点，滚动流畅无卡顿

#### Scenario: 向上滚动加载历史
- **WHEN** 用户滚动到消息列表顶部
- **THEN** 触发加载更早的历史消息（如有）
