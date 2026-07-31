// 模型切换下拉（spec design-agent-video：OpenHarness 主 agent 切模，双通道）。
// - 无会话/新会话前：仅持久化选中值（da.model），建会话时注入 --model（通道①）
// - 会话空闲态：经 WS submit 提交 `/model <name>`（通道②），回执在消息流中展示，
//   前端乐观更新下拉显示态
// - busy（轮次进行中）：入口禁用

import { useEffect, useRef, useState } from 'react';
import { useUiStore } from '../../store/uiStore';
import { DEFAULT_MODEL_LABEL, OH_MODEL_OPTIONS } from '../../utils/model';

export interface ModelSelectorProps {
  /** busy / 只读时禁用切换入口。 */
  disabled: boolean;
  /**
   * 运行时切模回调（通道②）：返回是否已受理；未受理时不更新显示态。
   * 未选中会话时传 undefined，仅本地持久化。
   */
  onRuntimeSwitch?: (model: string) => boolean;
}

export function ModelSelector({ disabled, onRuntimeSwitch }: ModelSelectorProps) {
  const selectedModel = useUiStore((s) => s.selectedModel);
  const setSelectedModel = useUiStore((s) => s.setSelectedModel);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭下拉（demo 同款行为）
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const currentLabel =
    OH_MODEL_OPTIONS.find((o) => o.value === selectedModel)?.label ??
    selectedModel ??
    DEFAULT_MODEL_LABEL;

  const handleSelect = (value: string | null) => {
    setOpen(false);
    if (value === selectedModel) return;
    // 通道②：会话内切换到具体模型需先经 WS 受理（乐观更新，回执见消息流）；
    // 切回「默认模型」仅影响后续新建会话（运行中会话无对应命令语义）
    if (value && onRuntimeSwitch && !onRuntimeSwitch(value)) return;
    setSelectedModel(value);
  };

  return (
    <div ref={rootRef} style={{ display: 'inline-flex' }}>
      <button
        type="button"
        className={`btn-toolbar btn-model${open ? ' active' : ''}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="模型切换"
        title={disabled ? '轮次执行中，暂不可切换模型' : 'OpenHarness 主 agent 模型'}
        onClick={() => setOpen((v) => !v)}
        style={disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 2a4 4 0 0 1 4 4v1h1a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-7a3 3 0 0 1 3-3h1V6a4 4 0 0 1 4-4z" />
          <circle cx="9" cy="13" r="1" />
          <circle cx="15" cy="13" r="1" />
        </svg>
        {currentLabel}
        {open && (
          <div className="model-dropdown show" role="listbox" aria-label="模型候选">
            {OH_MODEL_OPTIONS.map((option) => (
              <div
                key={option.value ?? 'default'}
                role="option"
                aria-selected={option.value === selectedModel}
                className={`model-option${option.value === selectedModel ? ' active' : ''}`}
                title={option.description}
                onClick={(e) => {
                  e.stopPropagation();
                  handleSelect(option.value);
                }}
              >
                <span className="model-option-dot" />
                {option.label}
              </div>
            ))}
          </div>
        )}
      </button>
    </div>
  );
}
