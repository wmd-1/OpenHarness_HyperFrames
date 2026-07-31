// Drawio 设计模块页（demo drawio-layout 三栏：历史 295px + 图表预览常显 + 对话区）。
// spec design-agent-demo-modules：模拟对话经 DemoAdapter TurnStream。

import { getAgent } from '../../platform/registry';
import { DemoChat } from '../demo-shared/DemoChat';
import { DemoHistoryPanel } from '../demo-shared/DemoHistoryPanel';
import { useDemoSession } from '../demo-shared/useDemoSession';
import { DiagramCanvas } from './DiagramCanvas';

const agent = getAgent('drawio-diagram')!;

export function DrawioPage() {
  const { sessions, currentId, currentSession, messages, busy, ready, select, create, submit } =
    useDemoSession(agent.providers.session);

  return (
    <section className="page-detail visible drawio-layout view-fade-in">
      <DemoHistoryPanel
        sessions={sessions}
        currentId={currentId}
        onSelect={select}
        onCreate={create}
      />

      <div className="panel-preview">
        <DiagramCanvas />
      </div>

      <div className="panel-chat">
        <div className="chat-header">
          <div className="chat-header-title">
            {currentSession?.title ?? agent.title}
            <span className="demo-badge" style={{ marginLeft: 8 }}>
              演示
            </span>
          </div>
          <div className="chat-header-right" />
        </div>
        <DemoChat
          messages={messages}
          busy={busy}
          ready={ready}
          onSubmit={submit}
          agentLabel="设计智能体"
          placeholder="描述您要绘制的流程图、架构图需求，按 Enter 发送..."
        />
      </div>
    </section>
  );
}
