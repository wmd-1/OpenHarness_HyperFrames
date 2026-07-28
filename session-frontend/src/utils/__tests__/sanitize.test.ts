// sanitize 单元测试（task 12.2）：输入清理、白名单参数校验。

import { describe, expect, it } from 'vitest';
import {
  containsShellMetachars,
  maskApiKey,
  sanitizeAnsi,
  sanitizeUserInput,
  stripControlChars,
  tokenizeArgs,
  validateExtraArgs,
} from '../sanitize';

describe('stripControlChars', () => {
  it('剥离 C0/C1 控制字符', () => {
    expect(stripControlChars('a\u0000b\u0007c\u001bd')).toBe('abcd');
  });

  it('保留换行和制表符', () => {
    expect(stripControlChars('a\nb\tc')).toBe('a\nb\tc');
  });
});

describe('sanitizeUserInput', () => {
  it('剥离控制字符并 trim', () => {
    expect(sanitizeUserInput('  hi\u0000 there  ')).toBe('hi there');
  });

  it('尖括号泛型原样保留（不再剥离 HTML 标签，B1）', () => {
    expect(sanitizeUserInput('Vec<T>')).toBe('Vec<T>');
  });

  it('比较表达式原样保留', () => {
    expect(sanitizeUserInput('a < b > c')).toBe('a < b > c');
  });

  it('代码片段中的标签文本原样发送（渲染侧负责防护）', () => {
    expect(sanitizeUserInput('<script>alert(1)</script>')).toBe('<script>alert(1)</script>');
  });
});

describe('sanitizeAnsi', () => {
  it('保留 SGR 颜色/样式序列', () => {
    expect(sanitizeAnsi('\u001b[32mok\u001b[0m \u001b[1;33mwarn\u001b[0m')).toBe(
      '\u001b[32mok\u001b[0m \u001b[1;33mwarn\u001b[0m',
    );
  });

  it('剥离 OSC（标题篡改 / OSC 52 剪贴板）', () => {
    expect(sanitizeAnsi('a\u001b]0;evil title\u0007b')).toBe('ab');
    expect(sanitizeAnsi('a\u001b]52;c;ZXZpbA==\u001b\\b')).toBe('ab');
  });

  it('剥离非 SGR 的 CSI（清屏/光标移动/模式切换）', () => {
    expect(sanitizeAnsi('x\u001b[2Jy')).toBe('xy');
    expect(sanitizeAnsi('x\u001b[10;10Hy')).toBe('xy');
    expect(sanitizeAnsi('x\u001b[?25ly')).toBe('xy');
  });

  it('剥离 DCS 与单字符 Fe 转义（RIS）', () => {
    expect(sanitizeAnsi('a\u001bPq payload\u001b\\b')).toBe('ab');
    expect(sanitizeAnsi('a\u001bcb')).toBe('ab');
  });

  it('普通文本与换行原样保留', () => {
    expect(sanitizeAnsi('hello\nworld')).toBe('hello\nworld');
  });
});

describe('containsShellMetachars', () => {
  it.each([';', '|', '`', '$', '>', '"'])('检出元字符 %s', (ch) => {
    expect(containsShellMetachars(`ab${ch}cd`)).toBe(true);
  });

  it('普通值不误判', () => {
    expect(containsShellMetachars('gpt-4o-mini_0.5')).toBe(false);
  });
});

describe('tokenizeArgs', () => {
  it('按空白切分并去空', () => {
    expect(tokenizeArgs('  --temperature  0.7   --verbose ')).toEqual([
      '--temperature',
      '0.7',
      '--verbose',
    ]);
  });

  it('空输入返回空数组', () => {
    expect(tokenizeArgs('   ')).toEqual([]);
  });
});

describe('validateExtraArgs（与后端 vet_extra_oh_args 同规则）', () => {
  it('接受合法参数组合', () => {
    const r = validateExtraArgs(['--temperature', '0.7', '--max-turns', '20', '--no-cache']);
    expect(r.ok).toBe(true);
    expect(r.args).toEqual(['--temperature', '0.7', '--max-turns', '20', '--no-cache']);
  });

  it('拒绝非白名单 flag', () => {
    expect(validateExtraArgs(['--rm']).ok).toBe(false);
  });

  it('拒绝非 -- 开头 token', () => {
    expect(validateExtraArgs(['rm', '-rf']).ok).toBe(false);
  });

  it('带值 flag 缺值报错', () => {
    expect(validateExtraArgs(['--model']).ok).toBe(false);
  });

  it('拒绝值中的 shell 元字符（注入防护）', () => {
    expect(validateExtraArgs(['--model', 'x;rm']).ok).toBe(false);
    expect(validateExtraArgs(['--model', '$(whoami)']).ok).toBe(false);
  });

  it('类型校验：--temperature 必须是数字', () => {
    expect(validateExtraArgs(['--temperature', 'abc']).ok).toBe(false);
    expect(validateExtraArgs(['--temperature', '0.5']).ok).toBe(true);
  });

  it('类型校验：--max-turns 必须是整数', () => {
    expect(validateExtraArgs(['--max-turns', '1.5']).ok).toBe(false);
    expect(validateExtraArgs(['--max-turns', '10']).ok).toBe(true);
  });

  it('长度上限：--effort 最长 16', () => {
    expect(validateExtraArgs(['--effort', 'x'.repeat(17)]).ok).toBe(false);
  });
});

describe('maskApiKey', () => {
  it('仅首尾各 2 字符可见', () => {
    expect(maskApiKey('sk-abcdef123456')).toBe('sk****56');
  });

  it('短 Key 全脱敏', () => {
    expect(maskApiKey('abc')).toBe('****');
  });
});
