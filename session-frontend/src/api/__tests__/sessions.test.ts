// sessions API 单测：workspaceFileUrl 直链编码（F5.4）——path 逐段
// encodeURIComponent、保留 / 分隔，api_key 查询参数编码。

import { afterEach, describe, expect, it } from 'vitest';
import { workspaceFileUrl } from '../sessions';
import { useAuthStore } from '../../store/authStore';

afterEach(() => {
  useAuthStore.setState({ apiKey: null, authExpired: false });
});

describe('workspaceFileUrl（F5.4）', () => {
  it('普通路径：保留 / 分隔，携带 api_key', () => {
    useAuthStore.setState({ apiKey: 'k1' });
    expect(workspaceFileUrl('s1', 'output/final.mp4')).toBe(
      '/v1/sessions/s1/workspace/files/output/final.mp4?api_key=k1',
    );
  });

  it('中文与空格：逐段 encodeURIComponent，/ 不被编码', () => {
    useAuthStore.setState({ apiKey: 'k1' });
    const url = workspaceFileUrl('s1', 'output/最终 视频.mp4');
    expect(url).toBe(
      `/v1/sessions/s1/workspace/files/output/${encodeURIComponent('最终 视频.mp4')}?api_key=k1`,
    );
    // 目录分隔保留原样（仅段内编码）
    expect(url).toContain('/output/');
  });

  it('特殊字符段（# ? &）：段内完全编码，不破坏查询串', () => {
    useAuthStore.setState({ apiKey: 'k1' });
    const url = workspaceFileUrl('s1', 'a#b/c?d&e.txt');
    expect(url).toBe('/v1/sessions/s1/workspace/files/a%23b/c%3Fd%26e.txt?api_key=k1');
  });

  it('api_key 缺失：回退空串；api_key 特殊字符被编码', () => {
    useAuthStore.setState({ apiKey: null });
    expect(workspaceFileUrl('s1', 'a.txt')).toBe('/v1/sessions/s1/workspace/files/a.txt?api_key=');
    useAuthStore.setState({ apiKey: 'k+/=' });
    expect(workspaceFileUrl('s1', 'a.txt')).toBe(
      `/v1/sessions/s1/workspace/files/a.txt?api_key=${encodeURIComponent('k+/=')}`,
    );
  });
});
