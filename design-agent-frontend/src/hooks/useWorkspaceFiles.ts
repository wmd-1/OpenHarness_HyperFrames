// 工作区文件列表编排（F5.2/F5.5/F5.6）：
// 拉取 + page_token 续拉 + prefix 前缀过滤；turn_complete（经 useWebSocket
// patch turn_count）触发自动刷新；400（page_token 非法）重置分页重拉，
// 404 横幅提示并回落第一页。

import { useCallback, useEffect, useRef, useState } from 'react';
import { listWorkspaceFiles } from '../api/sessions';
import { errorStatus, extractErrorDetail } from '../api/client';
import { useSessionStore } from '../store/sessionStore';
import { useUiStore } from '../store/uiStore';
import type { WorkspaceFileEntry, WorkspaceFileSource } from '../types/api';

/** 单页上限（对齐后端 workspace files limit 上限）。 */
const FILES_PAGE_LIMIT = 200;
/** prefix 输入防抖，避免逐字符打请求。 */
const PREFIX_DEBOUNCE_MS = 300;

export interface UseWorkspaceFilesResult {
  files: WorkspaceFileEntry[];
  /** null = 尚未加载完成首个响应。 */
  source: WorkspaceFileSource | null;
  stale: boolean;
  lastSyncedAt: string | null;
  total: number;
  /** next_page_token 非空 → 可「加载更多」。 */
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  prefix: string;
  setPrefix: (value: string) => void;
  /** 重置分页重新拉取第一页（手动刷新按钮）。 */
  refresh: () => void;
  loadMore: () => void;
}

export function useWorkspaceFiles(sessionId: string | null): UseWorkspaceFilesResult {
  const [files, setFiles] = useState<WorkspaceFileEntry[]>([]);
  const [source, setSource] = useState<WorkspaceFileSource | null>(null);
  const [stale, setStale] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prefix, setPrefix] = useState('');
  // 竞态防护：仅最新一次请求可写入状态（切会话/快速改 prefix）
  const seqRef = useRef(0);

  // F5.5 自动刷新触发器：turn_complete 帧会 patch turn_count（useWebSocket），
  // 面板打开期间该值变化 → 重拉（归档为异步 best-effort，可能有延迟）
  const turnCount = useSessionStore((s) =>
    sessionId ? (s.sessions[sessionId]?.turn_count ?? 0) : 0,
  );

  const fetchPage = useCallback(
    async (sid: string, opts: { pageToken?: string; prefix: string }): Promise<void> => {
      const seq = ++seqRef.current;
      setLoading(true);
      setError(null);
      try {
        const resp = await listWorkspaceFiles(sid, {
          limit: FILES_PAGE_LIMIT,
          page_token: opts.pageToken,
          prefix: opts.prefix || undefined,
        });
        if (seq !== seqRef.current) return;
        setSource(resp.source);
        setStale(resp.stale);
        setLastSyncedAt(resp.last_synced_at);
        setTotal(resp.total);
        setNextPageToken(resp.next_page_token);
        setFiles((prev) => (opts.pageToken ? [...prev, ...resp.files] : resp.files));
      } catch (err) {
        if (seq !== seqRef.current) return;
        const status = errorStatus(err);
        if (status === 400 && opts.pageToken) {
          // page_token 非法/过期：重置分页重拉第一页（F5.6，自愈）
          void fetchPage(sid, { prefix: opts.prefix });
          return;
        }
        if (status === 404) {
          // 文件/会话已不存在：横幅提示；续拉场景回落第一页刷新
          useUiStore.getState().showBanner('warning', '文件已不存在，列表已刷新');
          if (opts.pageToken) {
            void fetchPage(sid, { prefix: opts.prefix });
            return;
          }
        }
        setError((await extractErrorDetail(err)) ?? '文件列表加载失败');
      } finally {
        // 递归重拉已刷新 seq，此处不覆盖新请求的 loading
        if (seq === seqRef.current) setLoading(false);
      }
    },
    [],
  );

  // 打开（挂载）/切会话/prefix 变化/轮次完成 → 拉取第一页
  useEffect(() => {
    if (!sessionId) {
      setFiles([]);
      setSource(null);
      setNextPageToken(null);
      return;
    }
    const sid = sessionId;
    const timer = window.setTimeout(
      () => void fetchPage(sid, { prefix }),
      prefix ? PREFIX_DEBOUNCE_MS : 0,
    );
    return () => window.clearTimeout(timer);
  }, [sessionId, prefix, turnCount, fetchPage]);

  const refresh = useCallback(() => {
    if (sessionId) void fetchPage(sessionId, { prefix });
  }, [sessionId, prefix, fetchPage]);

  const loadMore = useCallback(() => {
    if (sessionId && nextPageToken) {
      void fetchPage(sessionId, { pageToken: nextPageToken, prefix });
    }
  }, [sessionId, nextPageToken, prefix, fetchPage]);

  return {
    files,
    source,
    stale,
    lastSyncedAt,
    total,
    hasMore: nextPageToken !== null,
    loading,
    error,
    prefix,
    setPrefix,
    refresh,
    loadMore,
  };
}
