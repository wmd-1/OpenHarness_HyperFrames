// demo 能力域静态数据（与 demo/设计智能体平台.html 的历史列表 / spaceRecords 一致）。

import type { DemoArtifactSeed, DemoSessionSeed } from './demoAdapter';

/** 原型页面设计：12 条静态历史会话（demo historyList）。 */
export const UI_DEMO_SESSIONS: DemoSessionSeed[] = [
  {
    title: '银行内部管理系统首页',
    time: '今天 14:32',
    turns: [
      {
        user: '请帮我设计一个银行内部管理系统的首页，要求灰白背景，模块卡片式布局，左侧导航栏，右侧数据展示区。',
        assistant:
          '好的，我已为您生成银行内部管理系统首页的原型页面设计方案。主要特点：\n\n' +
          '1. 灰白色背景 (#eef1f5) 配白色模块盒子，层次感突出\n' +
          '2. 左侧 240px 固定导航栏\n' +
          '3. 右侧数据卡片区域，支持网格自适应\n' +
          '4. 深蓝主色调 (#1a56db)，符合银行风格\n\n' +
          '您可以在右侧预览面板中查看实际效果，点击"预览"按钮展开。',
      },
    ],
  },
  { title: '企业创新积分名单页', time: '昨天 16:45' },
  { title: '数据报表Dashboard', time: '7月25日 10:18' },
  { title: '客户风险评估面板', time: '7月22日 09:30' },
  { title: '信贷审批流程界面', time: '7月20日 15:22' },
  { title: '资产配置建议页', time: '7月18日 11:05' },
  { title: '合规检查报告生成器', time: '7月15日 14:50' },
  { title: '在线开户流程设计', time: '7月12日 09:40' },
  { title: '员工绩效考核系统', time: '7月10日 16:15' },
  { title: '反洗钱监测预警界面', time: '7月8日 13:28' },
  { title: '数字人民币钱包页面', time: '7月5日 10:55' },
  { title: '智能客服对话界面', time: '7月3日 08:20' },
];

/** Drawio 设计：12 条静态历史会话（名称对齐 spaceRecords.drawio）。 */
export const DRAWIO_DEMO_SESSIONS: DemoSessionSeed[] = [
  {
    title: '信贷审批流程图',
    time: '7月28日 10:18',
    turns: [
      {
        user: '请帮我绘制一张信贷审批业务的流程图，包含申请、初审、风控评估、终审、放款等环节。',
        assistant:
          '已为您生成信贷审批流程图，包含以下环节：\n\n' +
          '1. 客户提交申请 → 2. 客户经理初审 → 3. 风控系统评估 → 4. 审批委员会终审 → 5. 放款执行\n\n' +
          '图中使用菱形节点表示决策分支（通过/驳回），您可以在右侧画布中缩放查看，或下载 SVG 文件。',
      },
    ],
  },
  { title: '微服务架构设计图', time: '7月26日 14:30' },
  { title: '用户行为流程图', time: '7月24日 16:15' },
  { title: '系统集成拓扑图', time: '7月21日 11:42' },
  { title: '数据库ER模型图', time: '7月19日 09:28' },
  { title: '业务流程优化图', time: '7月17日 13:55' },
  { title: 'API调用时序图', time: '7月14日 15:20' },
  { title: '部署架构拓扑图', time: '7月11日 10:35' },
  { title: '权限模型关系图', time: '7月9日 14:18' },
  { title: '数据流转处理图', time: '7月6日 11:45' },
  { title: '风控决策流程图', time: '7月4日 09:30' },
  { title: '容灾恢复流程图', time: '7月1日 15:12' },
];

/** 个人空间演示产物（spaceRecords.ui / spaceRecords.drawio；video tab 走真实聚合）。 */
export const UI_DEMO_ARTIFACTS: DemoArtifactSeed[] = [
  { name: '银行内部管理系统首页.html', time: '2026-07-30 14:32', type: 'HTML' },
  { name: '企业创新积分名单页.html', time: '2026-07-29 16:45', type: 'HTML' },
  { name: '数据报表Dashboard.html', time: '2026-07-25 10:18', type: 'HTML' },
  { name: '客户风险评估面板.html', time: '2026-07-22 09:30', type: 'HTML' },
  { name: '信贷审批流程界面.html', time: '2026-07-20 15:22', type: 'HTML' },
  { name: '资产配置建议页.html', time: '2026-07-18 11:05', type: 'HTML' },
  { name: '合规检查报告生成器.html', time: '2026-07-15 14:50', type: 'HTML' },
  { name: '在线开户流程设计.html', time: '2026-07-12 09:40', type: 'HTML' },
  { name: '员工绩效考核系统.html', time: '2026-07-10 16:15', type: 'HTML' },
  { name: '反洗钱监测预警界面.html', time: '2026-07-08 13:28', type: 'HTML' },
  { name: '数字人民币钱包页面.html', time: '2026-07-05 10:55', type: 'HTML' },
  { name: '智能客服对话界面.html', time: '2026-07-03 08:20', type: 'HTML' },
];

export const DRAWIO_DEMO_ARTIFACTS: DemoArtifactSeed[] = [
  { name: '信贷审批流程图.drawio', time: '2026-07-28 10:18', type: 'SVG' },
  { name: '微服务架构设计图.drawio', time: '2026-07-26 14:30', type: 'SVG' },
  { name: '用户行为流程图.drawio', time: '2026-07-24 16:15', type: 'SVG' },
  { name: '系统集成拓扑图.drawio', time: '2026-07-21 11:42', type: 'SVG' },
  { name: '数据库ER模型图.drawio', time: '2026-07-19 09:28', type: 'SVG' },
  { name: '业务流程优化图.drawio', time: '2026-07-17 13:55', type: 'SVG' },
  { name: 'API调用时序图.drawio', time: '2026-07-14 15:20', type: 'SVG' },
  { name: '部署架构拓扑图.drawio', time: '2026-07-11 10:35', type: 'SVG' },
  { name: '权限模型关系图.drawio', time: '2026-07-09 14:18', type: 'SVG' },
  { name: '数据流转处理图.drawio', time: '2026-07-06 11:45', type: 'SVG' },
  { name: '风控决策流程图.drawio', time: '2026-07-04 09:30', type: 'SVG' },
  { name: '容灾恢复流程图.drawio', time: '2026-07-01 15:12', type: 'SVG' },
];

/** ui 模块模拟回复（demo sendMessage 的 800ms 回复文案风格）。 */
export function uiDemoReply(userText: string): string {
  return (
    '已根据您的需求生成原型页面设计方案（演示数据）：\n\n' +
    `需求摘要：${userText.slice(0, 60)}${userText.length > 60 ? '…' : ''}\n\n` +
    '1. 灰白色背景配白色模块盒子，层次感突出\n' +
    '2. 深蓝主色调 (#1a56db)，符合企业风格\n' +
    '3. 支持网页 / 手机 / 平板三端预览\n\n' +
    '您可以点击右上角"预览"按钮在预览面板中查看效果。'
  );
}

/** drawio 模块模拟回复。 */
export function drawioDemoReply(userText: string): string {
  return (
    '已根据您的描述生成图表（演示数据）：\n\n' +
    `需求摘要：${userText.slice(0, 60)}${userText.length > 60 ? '…' : ''}\n\n` +
    '图表已渲染到右侧画布，支持缩放（30%–300%）、适应窗口、下载 SVG 与全屏查看。'
  );
}
