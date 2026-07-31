// 能力域 id → 模块图标映射（从 icons.tsx 拆出，满足 react-refresh：
// icons.tsx 仅导出图标组件，本文件承载派生函数）。

import type { ComponentType, SVGProps } from 'react';
import {
  DrawioModuleIcon,
  SpaceModuleIcon,
  UiModuleIcon,
  VideoModuleIcon,
} from './icons';

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

/** 能力域 id → 模块图标（注册表派生渲染用）。 */
export function moduleIconFor(agentId: string): IconComponent {
  switch (agentId) {
    case 'ui-prototype':
      return UiModuleIcon;
    case 'drawio-diagram':
      return DrawioModuleIcon;
    case 'video-generation':
      return VideoModuleIcon;
    default:
      return SpaceModuleIcon;
  }
}
