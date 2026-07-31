// 视频预览面板（spec design-agent-video）：默认收起（宽 0）、展开至 50%（min 360px），
// turn_complete.has_artifact 自动展开由上层 VideoModulePage 控制；
// 一个会话多轮产物时提供轮次切换条。

import { artifactStreamUrl, downloadArtifact } from '../../api/sessions';
import { VideoModuleIcon } from '../../shared/icons';
import { CustomVideoPlayer } from './CustomVideoPlayer';

export interface VideoPreviewPanelProps {
  open: boolean;
  onClose: () => void;
  sid: string | null;
  /** 当前会话携带产物的轮次索引（升序）。 */
  artifactTurns: number[];
  /** 预览面板正在播放的轮次；null 时展示占位。 */
  activeTurn: number | null;
  onSelectTurn: (turnIndex: number) => void;
}

function Placeholder() {
  return (
    <div className="video-placeholder">
      <div className="video-placeholder-icon">
        <VideoModuleIcon />
      </div>
      <div className="video-placeholder-title">暂无视频产物</div>
      <div className="video-placeholder-text">
        在左侧对话中描述你想生成的视频，轮次完成且携带产物时会自动在此播放
      </div>
    </div>
  );
}

export function VideoPreviewPanel({
  open,
  onClose,
  sid,
  artifactTurns,
  activeTurn,
  onSelectTurn,
}: VideoPreviewPanelProps) {
  const playable = open && sid !== null && activeTurn !== null;

  return (
    <aside className={`panel-preview${open ? ' expanded' : ''}`} aria-label="视频预览面板">
      <div className="video-preview">
        <div className="video-preview-header">
          <div className="video-preview-title">
            <VideoModuleIcon />
            视频预览
            {activeTurn !== null && (
              <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-tertiary)' }}>
                第 {activeTurn + 1} 轮产物
              </span>
            )}
          </div>
          <div className="video-preview-toolbar">
            {playable && (
              <button
                type="button"
                className="btn-video-action"
                onClick={() => downloadArtifact(sid, activeTurn)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                <span className="action-text">下载</span>
              </button>
            )}
            <button type="button" className="btn-video-action" onClick={onClose} aria-label="收起预览">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
              <span className="action-text">收起</span>
            </button>
          </div>
        </div>

        {/* 多轮产物切换条（spec：一个会话多轮产物时提供轮次切换） */}
        {artifactTurns.length > 1 && (
          <div
            role="tablist"
            aria-label="产物轮次切换"
            style={{
              display: 'flex',
              gap: 6,
              padding: '8px 16px',
              borderBottom: '1px solid var(--border-light)',
              background: 'var(--bg-module)',
              overflowX: 'auto',
            }}
          >
            {artifactTurns.map((turn) => (
              <button
                key={turn}
                type="button"
                role="tab"
                aria-selected={turn === activeTurn}
                className="btn-video-action"
                onClick={() => onSelectTurn(turn)}
                style={
                  turn === activeTurn
                    ? {
                        background: 'var(--accent-light)',
                        color: 'var(--accent)',
                        borderColor: 'var(--accent)',
                      }
                    : undefined
                }
              >
                第 {turn + 1} 轮
              </button>
            ))}
          </div>
        )}

        <div className="video-preview-body">
          {playable ? (
            <CustomVideoPlayer
              // key 保证切轮次/切会话时重建播放器状态
              key={`${sid}:${activeTurn}`}
              src={artifactStreamUrl(sid, activeTurn)}
              onDownload={() => downloadArtifact(sid, activeTurn)}
            />
          ) : (
            <Placeholder />
          )}
        </div>
      </div>
    </aside>
  );
}
