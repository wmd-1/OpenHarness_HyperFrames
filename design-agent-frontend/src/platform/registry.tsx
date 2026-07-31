// AgentRegistry（spec: design-agent-platform §AgentRegistry 驱动的能力域清单）：
// 唯一的能力域清单。主页模块卡片、路由表、个人空间 tab MUST 派生自本注册表，
// 禁止在模块内硬编码兄弟模块的存在。

import { lazy } from 'react';
import { createDemoAdapter } from './demoAdapter';
import {
  DRAWIO_DEMO_ARTIFACTS,
  DRAWIO_DEMO_SESSIONS,
  UI_DEMO_ARTIFACTS,
  UI_DEMO_SESSIONS,
  drawioDemoReply,
  uiDemoReply,
} from './demoData';
import { createSessionServiceAdapter } from './sessionServiceAdapter';
import type { AgentDescriptor } from './types';

const VideoModulePage = lazy(() =>
  import('../modules/video/VideoModulePage').then((m) => ({ default: m.VideoModulePage })),
);
const UiDesignPage = lazy(() =>
  import('../modules/ui-design/UiDesignPage').then((m) => ({ default: m.UiDesignPage })),
);
const DrawioPage = lazy(() =>
  import('../modules/drawio/DrawioPage').then((m) => ({ default: m.DrawioPage })),
);

const uiAdapter = createDemoAdapter({
  agentId: 'ui-prototype',
  sessions: UI_DEMO_SESSIONS,
  artifacts: UI_DEMO_ARTIFACTS,
  artifactMediaType: 'text/html',
  reply: uiDemoReply,
});

const drawioAdapter = createDemoAdapter({
  agentId: 'drawio-diagram',
  sessions: DRAWIO_DEMO_SESSIONS,
  artifacts: DRAWIO_DEMO_ARTIFACTS,
  artifactMediaType: 'image/svg+xml',
  reply: drawioDemoReply,
});

const videoAdapter = createSessionServiceAdapter({ artifactMediaType: 'video/mp4' });

/** 注册顺序即主页卡片 / 个人空间 tab 顺序（demo：ui → drawio → video）。 */
const AGENTS: AgentDescriptor[] = [
  {
    id: 'ui-prototype',
    title: '原型页面设计',
    subtitle: '交互式网页界面生成',
    description: '通过对话描述您的需求，AI智能生成网页UI界面，支持实时预览和多端适配。',
    maturity: 'demo',
    route: '/ui',
    theme: { iconClass: 'icon-ui' },
    artifactMediaTypes: ['text/html'],
    capabilities: { modelSwitch: false, terminalMode: false, approvals: false, upload: false },
    providers: { session: uiAdapter.session, artifacts: uiAdapter.artifacts },
    page: UiDesignPage,
    spaceTabLabel: '原型页面设计',
  },
  {
    id: 'drawio-diagram',
    title: 'Drawio设计',
    subtitle: '流程图与架构图生成',
    description: 'AI辅助绘制流程图、架构图、思维导图等可视化图表，提升文档表达力。',
    maturity: 'demo',
    route: '/drawio',
    theme: { iconClass: 'icon-drawio' },
    artifactMediaTypes: ['image/svg+xml'],
    capabilities: { modelSwitch: false, terminalMode: false, approvals: false, upload: false },
    providers: { session: drawioAdapter.session, artifacts: drawioAdapter.artifacts },
    page: DrawioPage,
    spaceTabLabel: 'Drawio设计',
  },
  {
    id: 'video-generation',
    title: '文本生成视频',
    subtitle: 'AI视频内容创作',
    description: '输入文本描述即可生成视频内容，支持多种风格与场景，快速产出创意视频。',
    maturity: 'ga',
    route: '/video',
    theme: { iconClass: 'icon-video' },
    artifactMediaTypes: ['video/mp4'],
    capabilities: { modelSwitch: true, terminalMode: true, approvals: true, upload: false },
    providers: {
      session: videoAdapter.session,
      artifacts: videoAdapter.artifacts,
      workspace: videoAdapter.workspace,
    },
    page: VideoModulePage,
    spaceTabLabel: '文本生成视频',
  },
];

const byId = new Map(AGENTS.map((a) => [a.id, a]));
const byRoute = new Map(AGENTS.map((a) => [a.route, a]));

export function listAgents(): readonly AgentDescriptor[] {
  return AGENTS;
}

export function getAgent(id: string): AgentDescriptor | undefined {
  return byId.get(id);
}

export function getAgentByRoute(route: string): AgentDescriptor | undefined {
  return byRoute.get(route);
}

/** 数据是否需要「演示数据」角标（maturity!==ga MUST 标识）。 */
export function isDemoAgent(agent: AgentDescriptor): boolean {
  return agent.maturity !== 'ga';
}
