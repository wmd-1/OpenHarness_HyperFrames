// 输入清理与校验：控制字符剥离、shell 元字符检测、
// extra_oh_args 白名单校验（镜像后端 app/security.py::vet_extra_oh_args）。
// 注：不做 HTML 标签剥离——用户输入是发给 agent 的文本而非 HTML，
// 渲染侧由 react-markdown（不启用 raw HTML）负责 XSS 防护（B1）。

import { ALLOWED_OH_FLAGS, SHELL_METACHARS, TYPED_FLAGS } from './constants';

/** 剥离 C0/C1 控制字符（保留 \n 和 \t）。 */
export function stripControlChars(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
}

/** 发送前的用户输入清理：仅剥离控制字符并 trim，尖括号等原样保留。 */
export function sanitizeUserInput(input: string): string {
  return stripControlChars(input).trim();
}

/**
 * 终端输出清理（B2）：剥离 OSC/DCS/APC/PM（标题篡改、OSC 52 剪贴板写入）
 * 与非 SGR 的 CSI 序列（光标操控/清屏/模式切换），仅保留颜色/样式
 * （`ESC[...m`），防止服务端文本注入终端控制序列。
 */
export function sanitizeAnsi(text: string): string {
  return (
    text
      // OSC / DCS / APC / PM / SOS：ESC 后跟 ] P _ ^ X，直到 BEL 或 ST（ESC\）终止
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b[\]P_^X][\s\S]*?(?:\u0007|\u001b\\)/g, '')
      // CSI：仅保留终止符为 m 的 SGR，其余剥离
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, (seq) => (seq.endsWith('m') ? seq : ''))
      // 其余单字符转义（Fe/Fs，如 RIS `ESC c`）
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b(?!\[)[@-~]/g, '')
  );
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
