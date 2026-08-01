// 个人空间（spec design-agent-space）：tab 派生自 AgentRegistry，
// 数据一律经 ArtifactProvider.aggregate 聚合；真实/演示来源对 UI 零感知，
// demo 域产物 MUST 呈现「演示数据」角标与占位下载。

import { useCallback, useEffect, useMemo, useState } from 'react';
import { isDemoAgent, listAgents } from '../../platform/registry';
import type { AgentDescriptor, ArtifactRef } from '../../platform/types';
import { moduleIconFor } from '../../shared/moduleIcon';
import { CustomVideoPlayer } from '../video/CustomVideoPlayer';
import { displaySessionTime } from '../demo-shared/demoTime';
import { pageCount, pageSlice } from './paging';
import { thumbTypeLabel } from './spaceLabels';
import { useAgentAssets } from './useVideoAssets';

/** agent.id → 缩略图渐变类（demo thumb-ui/thumb-drawio/thumb-video）。 */
const THUMB_CLASS: Record<string, string> = {
  'ui-prototype': 'thumb-ui',
  'drawio-diagram': 'thumb-drawio',
  'video-generation': 'thumb-video',
};

/** demo 域占位下载（demo spaceDownload：data URL 文本文件）。 */
function placeholderDownload(name: string): void {
  const a = document.createElement('a');
  a.href = `data:text/plain;charset=utf-8,${encodeURIComponent(`Download: ${name}（演示数据占位）`)}`;
  a.download = `${name}.txt`;
  a.click();
}

const DownloadGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

function AssetCard({
  agent,
  refItem,
  index,
  onPreview,
}: {
  agent: AgentDescriptor;
  refItem: ArtifactRef;
  index: number;
  onPreview: (ref: ArtifactRef) => void;
}) {
  const demo = isDemoAgent(agent) || refItem.demo === true;
  const downloadUrl = agent.providers.artifacts.downloadUrl(refItem);
  const streamUrl = agent.providers.artifacts.streamUrl(refItem);
  const ThumbIcon = moduleIconFor(agent.id);

  return (
    <div className="space-card view-fade-in" style={{ animationDelay: `${index * 0.05}s` }}>
      <div
        className={`space-card-thumb ${THUMB_CLASS[agent.id] ?? 'thumb-video'}`}
        role={streamUrl ? 'button' : undefined}
        tabIndex={streamUrl ? 0 : undefined}
        style={streamUrl ? { cursor: 'pointer' } : undefined}
        onClick={() => {
          if (streamUrl) onPreview(refItem);
        }}
        onKeyDown={(e) => {
          if (streamUrl && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            onPreview(refItem);
          }
        }}
      >
        <div className="thumb-deco" />
        <div className="thumb-deco2" />
        <ThumbIcon />
        <span className="thumb-type">{thumbTypeLabel(refItem.mediaType)}</span>
      </div>
      <div className="space-card-body">
        <div className="space-card-name" title={refItem.name}>
          {refItem.name}
        </div>
        <div className="space-card-meta">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          {refItem.finishedAt ? displaySessionTime(refItem.finishedAt) : '—'}
          {demo && <span className="demo-badge">演示</span>}
        </div>
        <div className="space-card-footer">
          <span className="space-card-type">{agent.spaceTabLabel}</span>
          {downloadUrl ? (
            <a
              className="space-card-download"
              href={downloadUrl}
              download={refItem.name}
              aria-label={`下载 ${refItem.name}`}
            >
              {DownloadGlyph}
              <span className="dl-text">下载</span>
            </a>
          ) : (
            <button
              type="button"
              className="space-card-download"
              aria-label={`下载 ${refItem.name}（演示占位）`}
              onClick={() => placeholderDownload(refItem.name)}
            >
              {DownloadGlyph}
              <span className="dl-text">下载</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function AgentAssetsTab({
  agent,
  onCount,
}: {
  agent: AgentDescriptor;
  onCount?: (count: number) => void;
}) {
  const { refs, loading, error } = useAgentAssets(agent);
  const [page, setPage] = useState(1);
  const [previewRef, setPreviewRef] = useState<ArtifactRef | null>(null);

  // 聚合完成后回填 tab 计数徽章
  useEffect(() => {
    if (!loading && !error) onCount?.(refs.length);
  }, [loading, error, refs.length, onCount]);

  const totalPages = pageCount(refs.length);
  const safePage = Math.min(page, totalPages);
  const pageRefs = useMemo(() => pageSlice(refs, safePage), [refs, safePage]);
  const previewSrc = previewRef ? agent.providers.artifacts.streamUrl(previewRef) : null;

  if (loading) {
    return (
      <div className="space-empty" role="status">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
        <div className="space-empty-text">正在加载{agent.spaceTabLabel}历史记录…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-empty" role="alert">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <div className="space-empty-text">加载失败：{error}</div>
      </div>
    );
  }

  if (refs.length === 0) {
    return (
      <div className="space-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        <div className="space-empty-text">暂无{agent.spaceTabLabel}历史记录</div>
      </div>
    );
  }

  return (
    <>
      <div className="space-grid">
        {pageRefs.map((ref, i) => (
          <AssetCard
            key={`${ref.sessionId}-${ref.turnIndex}`}
            agent={agent}
            refItem={ref}
            index={i}
            onPreview={setPreviewRef}
          />
        ))}
      </div>

      {totalPages > 1 && (
        <div className="space-pagination">
          <button
            type="button"
            className="space-page-btn"
            aria-label="上一页"
            disabled={safePage <= 1}
            onClick={() => setPage(safePage - 1)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
            <button
              key={p}
              type="button"
              className={`space-page-btn${p === safePage ? ' active' : ''}`}
              onClick={() => setPage(p)}
            >
              {p}
            </button>
          ))}
          <button
            type="button"
            className="space-page-btn"
            aria-label="下一页"
            disabled={safePage >= totalPages}
            onClick={() => setPage(safePage + 1)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
          <span className="space-page-info">
            共 {refs.length} 条记录，第 {safePage}/{totalPages} 页
          </span>
        </div>
      )}

      {previewRef && previewSrc && (
        <div
          role="dialog"
          aria-label="视频预览"
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-8"
          onClick={() => setPreviewRef(null)}
        >
          <div
            style={{ width: 'min(960px, 100%)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <CustomVideoPlayer
              src={previewSrc}
              onDownload={() => {
                const url = agent.providers.artifacts.downloadUrl(previewRef);
                if (url) window.open(url, '_blank', 'noopener');
              }}
            />
            <button
              type="button"
              aria-label="关闭预览"
              onClick={() => setPreviewRef(null)}
              className="preview-modal-close mt-3 rounded-lg border border-white/40 px-4 py-1.5 text-sm text-white hover:bg-white/10"
            >
              关闭
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export function SpacePage() {
  const agents = listAgents();
  // 默认激活视频 tab（GA 能力域优先展示真实数据）
  const [activeId, setActiveId] = useState('video-generation');
  const activeAgent = agents.find((a) => a.id === activeId) ?? agents[0];
  // 已访问 tab 的计数徽章（聚合完成后回填）
  const [counts, setCounts] = useState<Record<string, number>>({});
  const activeAgentId = activeAgent.id;
  const handleCount = useCallback(
    (count: number) =>
      setCounts((prev) => (prev[activeAgentId] === count ? prev : { ...prev, [activeAgentId]: count })),
    [activeAgentId],
  );

  return (
    <section className="page-space visible view-fade-in">
      <div className="space-header">
        <h1 className="space-title">个人空间</h1>
        <div className="space-subtitle">您在各设计模块中的历史生成记录与产物文件</div>
      </div>

      <div className="space-tabs" role="tablist" aria-label="能力域切换">
        {agents.map((agent) => {
          const TabIcon = moduleIconFor(agent.id);
          return (
            <button
              key={agent.id}
              type="button"
              role="tab"
              aria-selected={agent.id === activeAgent.id}
              className={`space-tab${agent.id === activeAgent.id ? ' active' : ''}`}
              onClick={() => setActiveId(agent.id)}
            >
              <TabIcon />
              {agent.spaceTabLabel}
              {counts[agent.id] != null && <span className="tab-count">{counts[agent.id]}</span>}
            </button>
          );
        })}
      </div>

      <AgentAssetsTab key={activeAgent.id} agent={activeAgent} onCount={handleCount} />
    </section>
  );
}
