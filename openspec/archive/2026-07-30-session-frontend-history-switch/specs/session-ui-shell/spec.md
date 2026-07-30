# session-ui-shell Delta Spec

**Component:** `session-frontend/`

## MODIFIED Requirements

### Requirement: 会话列表侧栏
系统 SHALL 在侧栏中展示**服务端权威**的会话列表（`GET /v1/sessions` 分页），每个会话以卡片形式显示标题、状态、业务字段驱动的可达性与最近活跃时间；关闭的会话保留在列表中为只读态。

#### Scenario: 会话卡片展示
- **WHEN** 侧栏加载会话列表
- **THEN** 每个会话卡片第一行显示 `title`（null 回退 sid 前 8 位），第二行显示：状态徽章（颜色编码，含「只读」「不可恢复」变体）、轮次数、相对时间

#### Scenario: 卡片三态可达性
- **WHEN** 会话业务字段分别为 `resumable=true` / `read_only=true` / 两者皆 false
- **THEN** 卡片分别呈现：可点击建连 / 可点击只读回看（只读徽标）/ 置灰 + 不可恢复提示（点击仅回显历史）

#### Scenario: 选中会话
- **WHEN** 用户点击会话卡片
- **THEN** 卡片高亮，主区域切换到该会话的对话视图（含历史回显）

#### Scenario: 分页加载更多
- **WHEN** 列表存在更多分页（已加载数 < total）
- **THEN** 侧栏底部显示「加载更多」按钮，点击后追加下一页并保序

#### Scenario: 新建会话按钮
- **WHEN** 用户点击侧栏顶部的 "+ 新会话" 按钮
- **THEN** 弹出创建会话对话框

#### Scenario: 关闭会话保留只读
- **WHEN** 用户从侧栏关闭一个会话且后端返回成功
- **THEN** 会话不从列表移除，更新为 closed 只读态（关闭确认文案说明「关闭后不可再对话，历史消息与文件仍可查看」）
