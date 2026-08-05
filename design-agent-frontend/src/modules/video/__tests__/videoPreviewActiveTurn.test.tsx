// 多轮产物预览轮次一致性回归（change 2026-08-05-video-artifact-active-turn-consistency）：
// 锁定「activeTurn 与预览视频源一致 / 多轮默认最新轮 / tab selected↔video src 一致」契约，
// 并覆盖「turn_complete 与 artifactTurns 更新乱序时 activeTurn 仍收敛到最新 artifact」失败路径。

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { VideoPreviewPanel } from '../VideoPreviewPanel';
import { resolveActiveTurn } from '../videoActiveTurn';

describe('resolveActiveTurn（派生状态单一权威）', () => {
  it('无产物轮 → null（预览占位）', () => {
    expect(resolveActiveTurn(null, [], false)).toBeNull();
    expect(resolveActiveTurn(0, [], false)).toBeNull();
  });

  it('未钉选 → 返回最新轮（artifactTurns 末位）', () => {
    expect(resolveActiveTurn(null, [0, 1], false)).toBe(1);
    expect(resolveActiveTurn(0, [0, 1, 2], false)).toBe(2);
  });

  it('用户钉选某历史轮 → 保持该轮（pinned 优先）', () => {
    expect(resolveActiveTurn(0, [0, 1], true)).toBe(0);
  });

  it('钉选轮已不存在（落出 artifact 集合）→ 回退最新轮', () => {
    expect(resolveActiveTurn(5, [0, 1], true)).toBe(1);
  });

  // 真实失败路径：原 defect 下，turn_complete 与 artifactTurns 乱序到达会使
  // activeTurn 停在首轮(0)；此处锁定「即使历史派生曾停在 0，只要最新 artifact 已就位
  // (artifactTurns=[0,1]) 且未钉选，resolveActiveTurn 必须收敛到最新轮 1」。
  it('乱序到达收敛：current=0、artifactTurns=[0,1]、未钉选 → 必须收敛到最新轮 1', () => {
    expect(resolveActiveTurn(0, [0, 1], false)).toBe(1);
  });
});

describe('VideoPreviewPanel（tab selected ↔ video src 同源 activeTurn）', () => {
  function renderPanel(artifactTurns: number[], activeTurn: number | null) {
    return render(
      <VideoPreviewPanel
        open
        onClose={() => {}}
        sid="sess-1"
        artifactTurns={artifactTurns}
        activeTurn={activeTurn}
        onSelectTurn={() => {}}
      />,
    );
  }

  function videoSrc(): string {
    const video = document.querySelector('video');
    return video ? (video.getAttribute('src') ?? '') : '';
  }

  it('activeTurn=1：第 2 轮 tab selected=true 且 video src 必须为 turns/1/artifact', () => {
    renderPanel([0, 1], 1);

    const tab2 = screen.getByRole('tab', { name: /第 2 轮/ });
    const tab1 = screen.getByRole('tab', { name: /第 1 轮/ });
    expect(tab2).toHaveAttribute('aria-selected', 'true');
    expect(tab1).toHaveAttribute('aria-selected', 'false');
    expect(videoSrc()).toContain('/turns/1/artifact');
  });

  it('activeTurn=0：第 1 轮 tab selected=true 且 video src 必须为 turns/0/artifact（sanity）', () => {
    renderPanel([0, 1], 0);

    const tab1 = screen.getByRole('tab', { name: /第 1 轮/ });
    const tab2 = screen.getByRole('tab', { name: /第 2 轮/ });
    expect(tab1).toHaveAttribute('aria-selected', 'true');
    expect(tab2).toHaveAttribute('aria-selected', 'false');
    expect(videoSrc()).toContain('/turns/0/artifact');
  });

  it('单轮（artifactTurns=[0]）不渲染切换条，video src 为 turns/0/artifact', () => {
    renderPanel([0], 0);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(videoSrc()).toContain('/turns/0/artifact');
  });
});
