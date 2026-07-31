// 个人空间产物聚合 hook：封装 ArtifactProvider.aggregate（spec design-agent-space：
// 聚合逻辑 MUST 经 provider 契约，切 tab 即换 provider，UI 零感知真实/演示来源）。

import { useEffect, useState } from 'react';
import type { AgentDescriptor, ArtifactRef } from '../../platform/types';
import { getAgent } from '../../platform/registry';

export interface AgentAssetsState {
  refs: ArtifactRef[];
  loading: boolean;
  error: string | null;
}

export function useAgentAssets(agent: AgentDescriptor): AgentAssetsState {
  const [state, setState] = useState<AgentAssetsState>({ refs: [], loading: true, error: null });

  useEffect(() => {
    const controller = new AbortController();
    setState({ refs: [], loading: true, error: null });
    agent.providers.artifacts
      .aggregate({ concurrency: 4, signal: controller.signal })
      .then((refs) => {
        if (!controller.signal.aborted) setState({ refs, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setState({ refs: [], loading: false, error: err instanceof Error ? err.message : '加载失败' });
        }
      });
    return () => controller.abort();
  }, [agent]);

  return state;
}

/** 视频 tab 快捷入口（真实 session-service 聚合）。 */
export function useVideoAssets(): AgentAssetsState {
  return useAgentAssets(getAgent('video-generation')!);
}
