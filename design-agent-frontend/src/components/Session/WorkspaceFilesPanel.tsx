// 工作区文件面板（F5）：右侧抽屉（移动端全屏覆盖），平铺列表 + prefix 过滤；
// 双源角标（live 实时 / archive 归档快照 + stale 提示 / none 空态）；
// <a download> 直链下载（?api_key=，浏览器跟随 presigned 302）。

import { Download, FolderOpen, Loader2, RefreshCw, X } from 'lucide-react';
import { useRef } from 'react';
import { workspaceFileUrl } from '../../api/sessions';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useWorkspaceFiles } from '../../hooks/useWorkspaceFiles';
import type { Session } from '../../types/session';
import { formatBytes, formatRelativeTime } from '../../utils/format';

export function WorkspaceFilesPanel({
  session,
  onClose,
}: {
  session: Session;
  onClose: () => void;
}) {
  const sid = session.session_id;
  const wf = useWorkspaceFiles(sid);
  const panelRef = useRef<HTMLDivElement>(null);

  useFocusTrap(panelRef, { active: true, onEscape: onClose });

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/40"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="工作区文件"
        onClick={(e) => e.stopPropagation()}
        className="bg-surface border-line flex h-full w-full flex-col border-l shadow-xl sm:w-96"
      >
        {/* 头部：标题 + 双源角标 + 刷新/关闭 */}
        <div className="border-line flex items-center gap-2 border-b px-4 py-3">
          <FolderOpen size={16} className="text-muted" />
          <h2 className="text-fg text-sm font-semibold">工作区文件</h2>
          {wf.source === 'live' && (
            <span className="bg-ok/15 text-ok rounded px-1.5 py-0.5 text-xs">实时</span>
          )}
          {wf.source === 'archive' && (
            <span className="bg-warn/15 text-warn rounded px-1.5 py-0.5 text-xs">
              归档快照{wf.lastSyncedAt ? ` · ${formatRelativeTime(wf.lastSyncedAt)}` : ''}
            </span>
          )}
          <button
            type="button"
            onClick={wf.refresh}
            disabled={wf.loading}
            aria-label="刷新文件列表"
            className="text-muted hover:text-fg ml-auto rounded p-1 disabled:opacity-50"
          >
            <RefreshCw size={14} className={wf.loading ? 'animate-spin' : undefined} />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭文件面板"
            className="text-muted hover:text-fg rounded p-1"
          >
            <X size={16} />
          </button>
        </div>

        {/* stale 提示（F5.3）：跨节点归档快照至多落后一个 turn */}
        {wf.source === 'archive' && wf.stale && (
          <p className="text-warn bg-warn/10 px-4 py-2 text-xs" role="status">
            文件为最近归档快照，可能落后最新一轮
          </p>
        )}

        {/* prefix 前缀过滤 */}
        <div className="border-line border-b px-4 py-2">
          <input
            type="text"
            value={wf.prefix}
            onChange={(e) => wf.setPrefix(e.target.value)}
            placeholder="按路径前缀过滤，如 output/"
            aria-label="路径前缀过滤"
            className="bg-base border-line focus:border-accent w-full rounded border px-2.5 py-1.5 font-mono text-xs outline-none"
          />
        </div>

        {/* 列表主体 */}
        <div className="flex-1 overflow-y-auto">
          {wf.error && (
            <div className="text-err flex items-center justify-between gap-2 px-4 py-3 text-xs">
              <span role="alert">{wf.error}</span>
              <button
                type="button"
                onClick={wf.refresh}
                className="border-line hover:bg-raised shrink-0 rounded border px-2 py-1"
              >
                重试
              </button>
            </div>
          )}
          {!wf.error && wf.source === 'none' && (
            <div className="text-muted flex flex-col items-center gap-2 px-4 py-10 text-xs">
              <FolderOpen size={24} />
              暂无文件归档
            </div>
          )}
          {!wf.error && wf.source !== null && wf.source !== 'none' && wf.files.length === 0 && !wf.loading && (
            <p className="text-muted px-4 py-6 text-center text-xs">无匹配文件</p>
          )}
          <ul>
            {wf.files.map((file) => (
              <li
                key={file.path}
              className="border-line hover:bg-raised flex items-center gap-2 border-b px-4 py-2.5"
            >
              <span className="min-w-0 flex-1">
                <span className="text-fg block truncate font-mono text-xs leading-snug" title={file.path}>
                  {file.path}
                </span>
                <span className="text-muted block mt-0.5 text-xs leading-snug">
                    {formatBytes(file.size)} · {formatRelativeTime(file.mtime)}
                  </span>
                </span>
                <a
                  href={workspaceFileUrl(sid, file.path)}
                  download
                  aria-label={`下载 ${file.path}`}
                  className="text-muted hover:text-accent shrink-0 rounded p-1"
                >
                  <Download size={14} />
                </a>
              </li>
            ))}
          </ul>
          {wf.loading && (
            <div className="text-muted flex items-center justify-center gap-2 py-4 text-xs" role="status">
              <Loader2 size={13} className="animate-spin" />
              正在加载…
            </div>
          )}
          {wf.hasMore && !wf.loading && (
            <div className="flex justify-center py-3">
              <button
                type="button"
                onClick={wf.loadMore}
                className="border-line text-fg hover:bg-raised rounded border px-3 py-1.5 text-xs"
              >
                加载更多（已载入 {wf.files.length}/{wf.total}）
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
