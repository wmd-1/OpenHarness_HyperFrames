// DrawerShell 单测（change: design-frontend-overlay-primitives P1.4）：
// 覆盖 open=false 不渲染、overlay-click 调 onClose、aside role/aria-label、
// side=right 定位、Escape 调 onClose、data-testid 透传。

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DrawerShell } from '../DrawerShell';

describe('DrawerShell', () => {
  it('open=false 不渲染', () => {
    const { container } = render(
      <DrawerShell open={false} onClose={() => {}} ariaLabel="t">
        <span>x</span>
      </DrawerShell>,
    );
    expect(container.firstChild).toBeNull();
  });

  it('aside role 与 aria 契约', () => {
    render(
      <DrawerShell open onClose={() => {}} ariaLabel="设置">
        <span>x</span>
      </DrawerShell>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.tagName).toBe('ASIDE');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', '设置');
  });

  it('overlay 点击调 onClose', () => {
    const onClose = vi.fn();
    const { container } = render(
      <DrawerShell open onClose={onClose} ariaLabel="t">
        <span>x</span>
      </DrawerShell>,
    );
    fireEvent.click(container.firstChild as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('点 aside 内容不冒泡触发 onClose', () => {
    const onClose = vi.fn();
    render(
      <DrawerShell open onClose={onClose} ariaLabel="t">
        <button type="button">inner</button>
      </DrawerShell>,
    );
    fireEvent.click(screen.getByText('inner'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape 调 onClose', () => {
    const onClose = vi.fn();
    render(
      <DrawerShell open onClose={onClose} ariaLabel="t">
        <button type="button">inner</button>
      </DrawerShell>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('data-testid 透传到 aside', () => {
    render(
      <DrawerShell open onClose={() => {}} ariaLabel="t" dataTestId="settings-panel">
        <span>x</span>
      </DrawerShell>,
    );
    expect(screen.getByTestId('settings-panel')).toHaveRole('dialog');
  });

  it('overlay 用 var(--z-modal) 叠层', () => {
    const { container } = render(
      <DrawerShell open onClose={() => {}} ariaLabel="t">
        <span>x</span>
      </DrawerShell>,
    );
    expect((container.firstChild as HTMLElement).className).toContain('z-[var(--z-modal)]');
  });

  it('side=right 定位到右上角全高', () => {
    render(
      <DrawerShell open onClose={() => {}} ariaLabel="t">
        <span>x</span>
      </DrawerShell>,
    );
    const aside = screen.getByRole('dialog');
    expect(aside.className).toContain('top-0 right-0 h-full');
  });
});
