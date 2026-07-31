// 主页（demo page-home 1:1）：模块卡片派生自 AgentRegistry + 平台级「个人空间」卡片。
// 禁止硬编码能力域清单（spec: design-agent-platform）。

import { useNavigate } from 'react-router-dom';
import { isDemoAgent, listAgents } from '../../platform/registry';
import { ArrowRightIcon, SpaceModuleIcon } from '../../shared/icons';
import { moduleIconFor } from '../../shared/moduleIcon';

interface CardProps {
  iconClass: string;
  title: string;
  subtitle: string;
  description: string;
  demo?: boolean;
  onEnter: () => void;
  icon: React.ReactNode;
}

function ModuleCard({ iconClass, title, subtitle, description, demo, onEnter, icon }: CardProps) {
  return (
    <div className="module-card" onClick={onEnter} role="button" tabIndex={0}>
      <div className={`module-card-icon ${iconClass}`}>
        {icon}
        <div className="module-card-icon-title">{title}</div>
        <div className="module-card-icon-desc">{subtitle}</div>
        {demo && <span className="demo-badge">演示</span>}
      </div>
      <div className="module-card-body">
        <p className="module-card-desc">{description}</p>
        <div className="module-card-enter">
          进入模块
          <ArrowRightIcon />
        </div>
      </div>
    </div>
  );
}

export function HomePage() {
  const navigate = useNavigate();

  return (
    <section className="page-home view-fade-in">
      <h1 className="home-title">设计智能体工作台</h1>
      <p className="home-subtitle">选择一个设计模块，开始您的创作之旅</p>

      <div className="module-grid">
        {listAgents().map((agent) => {
          const Icon = moduleIconFor(agent.id);
          return (
            <ModuleCard
              key={agent.id}
              iconClass={agent.theme.iconClass}
              title={agent.title}
              subtitle={agent.subtitle}
              description={agent.description}
              demo={isDemoAgent(agent)}
              onEnter={() => navigate(agent.route)}
              icon={<Icon />}
            />
          );
        })}
        {/* 个人空间为平台级页面（非能力域），tab 内容仍由注册表派生 */}
        <ModuleCard
          iconClass="icon-space"
          title="个人空间"
          subtitle="作品管理与收藏"
          description="管理您的所有设计作品、历史会话与收藏资源，随时回溯创作历程。"
          onEnter={() => navigate('/space')}
          icon={<SpaceModuleIcon />}
        />
      </div>
    </section>
  );
}
