// 健康检查 API：/healthz、/readyz（无需 API Key，直接用 fetch 风格 ky 实例）。

import ky from 'ky';
import type { HealthResponse, ReadyResponse } from '../types/api';

// 健康端点不带认证头（后端 healthz 免认证），独立轻量实例
const healthClient = ky.create({ timeout: 5_000, retry: 0 });

export async function fetchHealth(): Promise<HealthResponse> {
  return healthClient.get('/healthz').json<HealthResponse>();
}

export async function fetchReady(): Promise<ReadyResponse> {
  return healthClient.get('/readyz').json<ReadyResponse>();
}
