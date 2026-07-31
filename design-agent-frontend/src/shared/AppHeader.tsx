// 平台顶栏（demo app-header 1:1）：返回键 / logo / 面包屑 + 健康徽标 / 设置 / 用户。
// 面包屑模块名派生自 AgentRegistry（/space 为平台页，单独映射）。

import { Settings } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { HealthBadge } from '../components/Common/HealthBadge';
import { useHealth } from '../hooks/useHealth';
import { getAgentByRoute } from '../platform/registry';
import { useUiStore } from '../store/uiStore';
import { BackIcon, LogoIcon } from './icons';

/** 平台级页面（非能力域）的面包屑名。 */
const PLATFORM_PAGE_NAMES: Record<string, string> = {
  '/space': '个人空间',
};

export function AppHeader() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const { health } = useHealth();

  const isHome = pathname === '/';
  const moduleName = getAgentByRoute(pathname)?.title ?? PLATFORM_PAGE_NAMES[pathname];

  return (
    <header className="app-header">
      <div className="header-left">
        <button
          type="button"
          className={`header-back${isHome ? '' : ' visible'}`}
          aria-label="返回主页"
          onClick={() => navigate('/')}
        >
          <BackIcon width={16} height={16} />
        </button>
        <div
          className="header-logo"
          style={{ cursor: 'pointer' }}
          onClick={() => navigate('/')}
        >
          <div className="header-logo-icon">
            <LogoIcon />
          </div>
          设计智能体
        </div>
        <div className={`header-title-current${moduleName ? ' visible' : ''}`}>
          <span>/</span>
          <span>{moduleName}</span>
        </div>
      </div>
      <div className="header-right">
        <HealthBadge health={health} />
        <button
          type="button"
          className="header-back visible"
          aria-label="设置"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings size={16} />
        </button>
        <div className="header-user">U</div>
      </div>
    </header>
  );
}
