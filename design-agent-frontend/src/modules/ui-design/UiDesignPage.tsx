// 原型页面设计模块页（demo 三栏布局：历史 240px + 对话 + 预览面板可展开）。
// spec design-agent-demo-modules：模拟对话经 DemoAdapter TurnStream，禁止组件内直连造消息。

import { useState } from 'react';
import { getAgent } from '../../platform/registry';
import { DemoChat } from '../demo-shared/DemoChat';
import { DemoHistoryPanel } from '../demo-shared/DemoHistoryPanel';
import { useDemoSession } from '../demo-shared/useDemoSession';
import { UiPreviewPanel } from './UiPreviewPanel';

const agent = getAgent('ui-prototype')!;

export function UiDesignPage() {
  const { sessions, currentId, currentSession, messages, busy, ready, select, create, submit } =
    useDemoSession(agent.providers.session);
  const [previewOpen, setPreviewOpen] = useState(false);

  return (
    <section
      className={`page-detail visible view-fade-in${previewOpen ? ' preview-open' : ''}`}
    >
      <DemoHistoryPanel
        sessions={sessions}
        currentId={currentId}
        onSelect={select}
        onCreate={create}
      />

      <div className="panel-chat">
        <div className="chat-header">
          <div className="chat-header-title">
            {currentSession?.title ?? agent.title}
            <span className="demo-badge" style={{ marginLeft: 8 }}>
              演示
            </span>
          </div>
          <div className="chat-header-right">
            <button
              type="button"
              className={`btn-preview-toggle${previewOpen ? ' active' : ''}`}
              onClick={() => setPreviewOpen((v) => !v)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
              预览
            </button>
          </div>
        </div>
        <DemoChat
          messages={messages}
          busy={busy}
          ready={ready}
          onSubmit={submit}
          agentLabel="设计智能体"
          placeholder="输入您的设计需求，按 Enter 发送..."
        />
      </div>

      <UiPreviewPanel expanded={previewOpen} />
    </section>
  );
}
