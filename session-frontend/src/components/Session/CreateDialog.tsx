// 创建会话对话框（task 7.7）：权限策略选择 + 高级参数（白名单前端校验）。
// 焦点圈定 + Escape 关闭统一走 useFocusTrap（task 5.10 D5）。

import { useEffect, useRef, useState } from 'react';
import { Bot, Loader2, ShieldCheck, X } from 'lucide-react';
import { createSession } from '../../api/sessions';
import {
  errorStatus,
  extractErrorCode,
  extractErrorDetail,
  extractRetryAfter,
} from '../../api/client';
import { useSessionStore } from '../../store/sessionStore';
import { useUiStore } from '../../store/uiStore';
import type { PermissionPolicy } from '../../types/session';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { requestSessionListRefresh } from '../../hooks/useSessionList';
import { tokenizeArgs, validateExtraArgs } from '../../utils/sanitize';

const POLICIES: {
  policy: PermissionPolicy;
  label: string;
  description: string;
  Icon: typeof Bot;
}[] = [
  {
    policy: 'full_auto',
    label: '全自动',
    description: '工具调用自动放行，无需人工审批',
    Icon: Bot,
  },
  {
    policy: 'interactive',
    label: '交互审批',
    description: '敏感操作（写文件 / 执行命令）需要确认',
    Icon: ShieldCheck,
  },
];

export function CreateDialog() {
  const open = useUiStore((s) => s.createDialogOpen);
  const setOpen = useUiStore((s) => s.setCreateDialogOpen);
  const addSession = useSessionStore((s) => s.addSession);
  const selectSession = useSessionStore((s) => s.selectSession);

  const [policy, setPolicy] = useState<PermissionPolicy>('full_auto');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [rawArgs, setRawArgs] = useState('');
  const [argError, setArgError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // 503 容量满：Retry-After 倒计时，归零后重试按钮自动可点（F4）
  const [retryCountdown, setRetryCountdown] = useState<number | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (retryCountdown === null || retryCountdown <= 0) return;
    const timer = window.setTimeout(
      () => setRetryCountdown((v) => (v === null ? null : v - 1)),
      1000,
    );
    return () => window.clearTimeout(timer);
  }, [retryCountdown]);

  const close = () => {
    if (submitting) return;
    setOpen(false);
    setSubmitError(null);
    setArgError(null);
    setRetryCountdown(null);
  };

  // 焦点圈定 + Escape 关闭（D5）
  useFocusTrap(dialogRef, { active: open, onEscape: close });

  if (!open) return null;

  const handleArgsChange = (value: string) => {
    setRawArgs(value);
    const tokens = tokenizeArgs(value);
    if (tokens.length === 0) {
      setArgError(null);
      return;
    }
    const result = validateExtraArgs(tokens);
    setArgError(result.ok ? null : (result.error ?? null));
  };

  const handleSubmit = async () => {
    const tokens = tokenizeArgs(rawArgs);
    const result = validateExtraArgs(tokens);
    if (!result.ok) {
      setArgError(result.error ?? '参数校验失败');
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    setRetryCountdown(null);
    try {
      const session = await createSession({
        permission_policy: policy,
        extra_oh_args: result.args ?? [],
      });
      addSession(session);
      selectSession(session.session_id);
      setOpen(false);
      setRawArgs('');
      // 刷新触发②：创建成功后同步服务端权威列表（F1.3）
      requestSessionListRefresh();
    } catch (err) {
      // 容器池四类错误映射（F4）；429/503 全局横幅已在 client.ts 拦截器中抑制，对话框就地提示
      const status = errorStatus(err);
      if (status === 429) {
        // 双语义：频率限流 vs 并发会话配额（detail 文本判定，计划 F4 明确允许）
        const detail = (await extractErrorDetail(err)) ?? '';
        setSubmitError(
          detail.includes('Rate limit')
            ? '请求过于频繁，请稍后再试'
            : '并发会话已达上限：当前会话正在执行任务时无法新建，请等待完成或关闭它',
        );
      } else if (status === 403 && (await extractErrorCode(err)) === 'daily_quota_exceeded') {
        setSubmitError('今日会话创建次数已用完（UTC 日重置）');
      } else if (status === 503) {
        setSubmitError('服务容量已满');
        // 无 Retry-After 头时不倒计时，重试按钮立即可点
        setRetryCountdown(extractRetryAfter(err));
      } else {
        setSubmitError(await extractErrorDetail(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={close}
      onKeyDown={(e) => e.key === 'Escape' && close()}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="创建会话"
        onClick={(e) => e.stopPropagation()}
        className="bg-surface border-line w-full max-w-md rounded-xl border p-5 shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-fg text-base font-semibold">创建会话</h2>
          <button
            type="button"
            onClick={close}
            aria-label="关闭"
            className="text-muted hover:text-fg rounded p-1"
          >
            <X size={16} />
          </button>
        </div>

        {/* 权限策略选择 */}
        <div role="radiogroup" aria-label="权限策略" className="flex flex-col gap-2">
          {POLICIES.map(({ policy: p, label, description, Icon }) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={policy === p}
              onClick={() => setPolicy(p)}
              className={`flex items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                policy === p ? 'border-accent bg-accent/5' : 'border-line hover:border-muted'
              }`}
            >
              <Icon size={18} className={policy === p ? 'text-accent' : 'text-muted'} />
              <span>
                <span className="text-fg block text-sm font-medium">{label}</span>
                <span className="text-muted block text-xs">{description}</span>
              </span>
            </button>
          ))}
        </div>

        {/* 高级参数 */}
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="text-muted hover:text-fg text-xs underline"
          >
            {showAdvanced ? '收起高级参数' : '高级参数（可选）'}
          </button>
          {showAdvanced && (
            <div className="mt-2">
              <input
                type="text"
                value={rawArgs}
                onChange={(e) => handleArgsChange(e.target.value)}
                placeholder="--temperature 0.7 --max-turns 20"
                aria-label="额外参数"
                aria-invalid={!!argError}
                className={`bg-base w-full rounded border px-3 py-2 font-mono text-sm outline-none ${
                  argError ? 'border-err' : 'border-line focus:border-accent'
                }`}
              />
              {argError ? (
                <p className="text-err mt-1 text-xs" role="alert">
                  {argError}
                </p>
              ) : (
                <p className="text-muted mt-1 text-xs">
                  仅允许：--temperature / --max-turns / --model / --effort / --no-cache /
                  --verbose
                </p>
              )}
            </div>
          )}
        </div>

        {submitError && (
          <p className="text-err mt-3 text-sm" role="alert">
            {submitError}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={close}
            disabled={submitting}
            className="border-line text-fg hover:bg-raised rounded-lg border px-4 py-2 text-sm"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={submitting || !!argError || (retryCountdown !== null && retryCountdown > 0)}
            className="bg-accent text-accent-fg flex items-center gap-2 rounded-lg px-4 py-2 text-sm disabled:opacity-50"
          >
            {submitting && <Loader2 size={14} className="animate-spin" />}
            {retryCountdown !== null
              ? retryCountdown > 0
                ? `重试（${retryCountdown}s）`
                : '重试'
              : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}
