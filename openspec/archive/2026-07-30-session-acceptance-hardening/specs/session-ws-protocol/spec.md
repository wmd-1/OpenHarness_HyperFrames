# Delta: session-ws-protocol

## ADDED Requirements

### Requirement: assistant 事件网关映射语义
网关 SHALL 按以下契约映射 oh 后端 assistant 事件：`assistant_delta.message` 为增量文本，追加进本轮助手文本缓冲并转发为 `delta` 帧；`assistant_complete.message` 为权威最终全文，语义是**最终覆盖（overwrite）**，SHALL **整体替换**（而非追加）本轮助手文本缓冲，并转发为 `{"type": "delta", "text": "", "final": true, "full_text": <全文>, "turn_index": N}` 帧。该 `delta+final+full_text` 帧仅是覆盖语义的**传输层兼容 envelope**，实现 MUST NOT 据帧型把 complete 理解为又一条增量。持久化的 `assistant_text` SHALL 等于最终全文且不得包含重复内容。stub（`oh_backend_stub.py`）的事件序列行为 SHALL 与生产（真 `oh --backend-only`）保持一致（同样 delta 流 + 携全文的 complete），协议演进时同步跟进。

#### Scenario: delta 与 complete 全文覆盖
- **WHEN** 后端依次发出 `assistant_delta("a")`、`assistant_delta("b")`、`assistant_complete("ab")`
- **THEN** 该轮持久化 `assistant_text == "ab"`（恰好一份），WS 侧最后一帧为 `text: ""`、`final: true`、`full_text: "ab"`

#### Scenario: stub 式同文双发不重复
- **WHEN** 后端发出 `assistant_delta("X")` 后紧跟 `assistant_complete("X")`（stub 与真 oh 的实际行为）
- **THEN** 持久化 `assistant_text == "X"`，`"X"` 不出现两次

## MODIFIED Requirements

### Requirement: 服务端帧分发处理
系统 SHALL 对接收到的服务端帧按类型分发到对应的状态更新和 UI 渲染逻辑。`turn_complete` 帧 SHALL 携带可选的 `has_artifact: bool` 字段标记该轮次是否注册了产物（由后端在产物注册成功后置 `true`），前端 SHALL 将其透传到消息状态以驱动产物预览/下载组件渲染，字段缺失时按 `false` 处理。`turn_error` 帧 SHALL 携带可选的结构化 `code` 字段（首个取值 `approval_timeout`），前端 SHALL 优先按 `code` 分发处理逻辑；`code` 缺失时允许按错误文案匹配作为过渡期回退。`delta` 帧 SHALL 支持可选的 `final: bool` 与 `full_text: string` 字段：`final` 帧标记本轮助手文本流结束并触发 flush；携带 `full_text` 时 Chat 前端 SHALL 用其**整体替换**该轮流缓冲后再 flush，不携带时维持追加语义（旧后端兼容）。Terminal 模式 SHALL **同样支持 full_text 替换**以防 WS 丢帧导致终端内容不完整：维护本轮已流式输出的累计文本，若其为 `full_text` 前缀则仅补写缺失尾部，否则换行后标注重放全文；final 处理后重置累计文本。

#### Scenario: 处理 delta 帧
- **WHEN** 收到 `{"type": "delta", "text": "...", "turn_index": N}` 帧
- **THEN** 将文本追加到当前轮次的助手消息缓冲区，更新流式渲染

#### Scenario: 处理携带 full_text 的 final delta 帧
- **WHEN** 收到 `{"type": "delta", "text": "", "final": true, "full_text": "...", "turn_index": N}` 帧
- **THEN** 用 `full_text` 整体替换第 N 轮的流缓冲内容并立即 flush，最终显示文本等于 `full_text` 单份全文

#### Scenario: 处理不含 full_text 的 final delta 帧（旧后端兼容）
- **WHEN** 收到 `{"type": "delta", "text": "...", "final": true, "turn_index": N}` 帧且无 `full_text` 字段
- **THEN** 按追加语义处理 `text` 并 flush，不报错

#### Scenario: Terminal 模式无丢帧时零重复
- **WHEN** Terminal 模式完整收到全部 delta 后收到携带 `full_text` 的 final delta 帧（累计输出 == full_text）
- **THEN** 不补写任何内容，终端不出现重复文本

#### Scenario: Terminal 模式丢帧后用 full_text 补齐
- **WHEN** Terminal 模式部分 delta 丢失（已输出累计文本是 `full_text` 的真前缀）后收到 final 帧
- **THEN** 仅补写缺失的尾部文本，最终终端内容完整等于 `full_text`

#### Scenario: Terminal 模式乱序时重放全文
- **WHEN** Terminal 模式已输出累计文本不是 `full_text` 的前缀（乱序/损坏）时收到 final 帧
- **THEN** 换行并以标注（如 dim `[resync]`）重放 `full_text` 全文，保证用户可获得完整回复

#### Scenario: 处理 turn_complete 帧
- **WHEN** 收到 `{"type": "turn_complete", "turn_index": N, "has_artifact": true/false}` 帧
- **THEN** 标记当前轮次为完成状态，flush 剩余缓冲区，启用输入栏，并把 `has_artifact` 写入该轮次助手消息；`has_artifact` 为 `true` 时消息气泡渲染视频预览与下载入口

#### Scenario: turn_complete 帧缺失 has_artifact 字段（旧后端兼容）
- **WHEN** 收到不含 `has_artifact` 字段的 `turn_complete` 帧
- **THEN** 前端按 `has_artifact = false` 处理，正常完成轮次，不渲染产物组件，不报错

#### Scenario: 处理 approval_request 帧
- **WHEN** 收到 `{"type": "approval_request", ...}` 帧且会话策略为 interactive
- **THEN** 弹出审批模态框，等待用户响应

#### Scenario: 处理带结构化 code 的 turn_error 帧（审批超时）
- **WHEN** 收到 `{"type": "turn_error", "code": "approval_timeout", "message": "..."}` 帧
- **THEN** 前端按 `code` 判定为审批超时，自动关闭审批弹窗并在对话区域显示超时提示，不依赖 `message` 文案内容

#### Scenario: turn_error 帧缺失 code 时的文案回退
- **WHEN** 收到不含 `code` 字段的 `turn_error` 帧且 `message` 含审批相关文案
- **THEN** 前端按过渡期回退逻辑关闭审批弹窗（该回退在后端 `code` 字段全量上线后移除）

#### Scenario: 处理 busy 帧
- **WHEN** 收到 `{"type": "busy"}` 帧
- **THEN** 显示提示"当前有轮次正在执行，请等待完成"

#### Scenario: 处理 error 帧
- **WHEN** 收到 `{"type": "error", "message": "..."}` 帧
- **THEN** 在对话区域显示错误消息
