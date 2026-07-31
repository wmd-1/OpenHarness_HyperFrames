# Design Agent Demo Modules Specification

**Component:** `design-agent-frontend/src/modules/ui-design/` + `src/modules/drawio/`（原型页面设计 + Drawio 流程图设计，demo 成熟度）
**Established by change:** `add-design-agent-frontend` (2026-07-31)
**视觉基准：** `demo/设计智能体平台.html`
**平台约束：** `design-agent-platform`（DemoAdapter / TurnStream 同构 / 演示标识）

演示能力域以 React 组件复现 demo 全部交互，经 DemoAdapter 的 TurnStream 接口模拟对话，纯客户端运行无需后端。

---

## Requirements

### Requirement: demo 交互保全（原型页面设计）
原型页面设计模块（/ui）SHALL 以 React 组件复现 demo 的全部交互（不使用 DOM 直接操作）：三栏布局（历史 | 对话（10% 留白）| 预览 0↔50%）；静态历史会话与新建会话（插入置顶/清空消息区）；发送消息后模拟 AI 延迟回复；预览面板支持网页/手机（含刘海条）/平板三设备切换与源码视图（HTML/CSS tab、行号、简易语法高亮）。会话与消息为本地内存状态，刷新即重置。

#### Scenario: 设备切换与源码视图
- **WHEN** 在预览面板依次切换网页/手机/平板与源码视图
- **THEN** 各视图按 demo 行为正确呈现（设备边框、刘海条、HTML/CSS tab 与行号）

#### Scenario: 模拟对话
- **WHEN** 在对话区发送一条消息
- **THEN** 用户消息立即上屏，延迟后出现模拟 AI 回复

### Requirement: demo 交互保全（Drawio 设计）
Drawio 设计模块（/drawio）SHALL 以 React 组件复现 demo 的全部交互：三栏布局（历史 | 图表预览常显居中 | 对话）；示例 SVG 流程图渲染于网格背景画布；缩放（30%–300%）、适应屏幕（按容器/viewBox 计算）、下载 SVG（序列化为 Blob）、全屏；底部状态栏展示文件名/尺寸；对话区为本地模拟。

#### Scenario: SVG 缩放/适应/下载/全屏
- **WHEN** 依次操作缩放、适应屏幕、下载 SVG、全屏
- **THEN** 缩放限幅 30%–300%、适应后图表完整可见、下载得到合法 SVG 文件、全屏正常进入退出

### Requirement: API stub 预留
ui/drawio 模块 MUST 各自提供 `api.ts` 空 stub：接口签名对齐未来后端形态（listSessions/createSession/sendMessage/getPreview 等），实现为未接入占位并集中标注 TODO；页面代码 MUST 不依赖 stub 的真实返回。

#### Scenario: stub 形态审查
- **WHEN** 审查 ui/drawio 模块的 `api.ts`
- **THEN** 存在接口签名预留、集中 TODO 标注，且与演进路径（复用 session-service 协议形态）兼容

### Requirement: TurnStream 同构约束
demo 模块的模拟对话 MUST 经由 DemoAdapter 实现的 TurnStream 接口（与真实通道同一事件模型），禁止在页面组件内直接 setTimeout 拼装消息，保证后端就绪时仅替换 registry 中 providers 指向即可转 GA。

#### Scenario: 演进只换 provider
- **WHEN** 将 ui 模块 registry 条目的 providers 从 DemoAdapter 切换为同构真实适配器（契约测试模拟）
- **THEN** 对话呈现层无需修改即正常工作
