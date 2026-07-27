// 输入清理与校验：控制字符剥离、HTML 标签过滤、shell 元字符检测、
// extra_oh_args 白名单校验（镜像后端 app/security.py::vet_extra_oh_args）。

import { ALLOWED_OH_FLAGS, SHELL_METACHARS, TYPED_FLAGS } from './constants';

/** 剥离 C0/C1 控制字符（保留 \n 和 \t）。 */
export function stripControlChars(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
}

/** 过滤 HTML 标签（用户输入不允许携带任何标签）。 */
export function stripHtmlTags(input: string): string {
  return input.replace(/<[^>]*>/g, '');
}

/** 发送前的用户输入清理：控制字符 + HTML 标签。 */
export function sanitizeUserInput(input: string): string {
  return stripHtmlTags(stripControlChars(input)).trim();
}

/** 值中是否包含 shell 元字符。 */
export function containsShellMetachars(value: string): boolean {
  for (const ch of value) {
    if (SHELL_METACHARS.includes(ch)) return true;
  }
  return false;
}

export interface ArgValidationResult {
  ok: boolean;
  error?: string;
  /** 校验通过后的规范化 token 列表。 */
  args?: string[];
}

/** 把用户输入的一行参数拆分为 token（仅按空白切分，值不允许带引号/空格）。 */
export function tokenizeArgs(raw: string): string[] {
  return raw.trim().split(/\s+/).filter(Boolean);
}

/**
 * 前端白名单校验 extra_oh_args（与后端 vet_extra_oh_args 同规则）：
 * - 仅允许 6 个白名单 flag；
 * - 带值 flag 校验类型 / 长度 / shell 元字符。
 */
export function validateExtraArgs(tokens: string[]): ArgValidationResult {
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (!tok.startsWith('--')) {
      return { ok: false, error: `仅允许 -- 开头的参数，收到 "${tok}"` };
    }
    if (!(tok in ALLOWED_OH_FLAGS)) {
      return { ok: false, error: `参数 "${tok}" 不允许手动设置` };
    }
    out.push(tok);
    if (ALLOWED_OH_FLAGS[tok]) {
      const val = tokens[i + 1];
      if (val === undefined) {
        return { ok: false, error: `参数 "${tok}" 需要一个值` };
      }
      if (containsShellMetachars(val)) {
        return { ok: false, error: '参数值包含非法字符' };
      }
      const typed = TYPED_FLAGS[tok];
      if (typed) {
        const [type, maxLen] = typed;
        if (val.length > maxLen) {
          return { ok: false, error: `参数 "${tok}" 的值超过最大长度 ${maxLen}` };
        }
        if (type === 'float' && Number.isNaN(Number.parseFloat(val))) {
          return { ok: false, error: `参数 "${tok}" 的值必须是数字` };
        }
        if (type === 'int' && !/^-?\d+$/.test(val)) {
          return { ok: false, error: `参数 "${tok}" 的值必须是整数` };
        }
      }
      out.push(val);
      i += 2;
    } else {
      i += 1;
    }
  }
  return { ok: true, args: out };
}

/** API Key 脱敏：sk-****xxxx（仅首尾各 2 字符可见）。 */
export function maskApiKey(key: string): string {
  if (key.length <= 4) return '****';
  return `${key.slice(0, 2)}****${key.slice(-2)}`;
}
