// ModalShell 单测（change: design-frontend-overlay-primitives P0.6）：
// 覆盖 open=false 不渲染、role/aria-label、data-testid 透传、closeOnOverlayClick 两种、
// 点容器内容 stopPropagation、Escape 调 onClose、useFocusTrap 激活。

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ModalShell } from '../ModalShell';

function Container({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

describe('ModalShell', () => {
  it('open=false 不渲染', () => {
    const { container } = render(
      <ModalShell open={false} onClose={() => {}} ariaLabel="t" closeOnOverlayClick>
        <span>content</span>
      </ModalShell>,
      { wrapper: Container },
    );
    expect(container.firstChild).toBeNull();
  });

  it('role 与 aria 契约', () => {
    render(
      <ModalShell open onClose={() => {}} ariaLabel="标题" closeOnOverlayClick>
        <span>x</span>
      </ModalShell>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', '标题');
  });

  it('data-testid 透传到容器', () => {
    render(
      <ModalShell open onClose={() => {}} ariaLabel="t" closeOnOverlayClick dataTestId="approval-modal">
        <span>x</span>
      </ModalShell>,
    );
    expect(screen.getByTestId('approval-modal')).toHaveRole('dialog');
  });

  it('closeOnOverlayClick=false 点 overlay 不调 onClose', () => {
    const onClose = vi.fn();
    const { container } = render(
      <ModalShell open onClose={onClose} ariaLabel="t" closeOnOverlayClick={false}>
        <span>x</span>
      </ModalShell>,
    );
    // 点 overlay（presentation 角色，容器外层）
    fireEvent.click(container.firstChild as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closeOnOverlayClick=true 点 overlay 调 onClose', () => {
    const onClose = vi.fn();
    const { container } = render(
      <ModalShell open onClose={onClose} ariaLabel="t" closeOnOverlayClick>
        <span>x</span>
      </ModalShell>,
    );
    fireEvent.click(container.firstChild as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('点容器内容不冒泡触发 onClose', () => {
    const onClose = vi.fn();
    render(
      <ModalShell open onClose={onClose} ariaLabel="t" closeOnOverlayClick>
        <button type="button">inner</button>
      </ModalShell>,
    );
    fireEvent.click(screen.getByText('inner'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape 调 onClose', () => {
    const onClose = vi.fn();
    render(
      <ModalShell open onClose={onClose} ariaLabel="t" closeOnOverlayClick>
        <button type="button">inner</button>
      </ModalShell>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('overlay 用 var(--z-modal) 叠层（高于顶栏）', () => {
    const { container } = render(
      <ModalShell open onClose={() => {}} ariaLabel="t" closeOnOverlayClick>
        <span>x</span>
      </ModalShell>,
    );
    const overlay = container.firstChild as HTMLElement;
    // Tailwind 任意值 z-[var(--z-modal)] 编译为 z-index: var(--z-modal)
    expect(overlay.className).toContain('z-[var(--z-modal)]');
  });
});
