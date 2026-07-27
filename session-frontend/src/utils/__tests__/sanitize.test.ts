// sanitize 单元测试（task 12.2）：输入清理、XSS 防护、白名单参数校验。

import { describe, expect, it } from 'vitest';
import {
  containsShellMetachars,
  maskApiKey,
  sanitizeUserInput,
  stripControlChars,
  stripHtmlTags,
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

describe('stripHtmlTags（XSS 防护）', () => {
  it('移除 script 标签', () => {
    expect(stripHtmlTags('<script>alert(1)</script>hello')).toBe('alert(1)hello');
  });

  it('移除内联事件标签', () => {
    expect(stripHtmlTags('<img src=x onerror=alert(1)>text')).toBe('text');
  });

  it('普通文本原样保留', () => {
    expect(stripHtmlTags('a < b 且 b > 不是标签')).toBe('a  不是标签');
  });
});

describe('sanitizeUserInput', () => {
  it('组合清理并 trim', () => {
    expect(sanitizeUserInput('  <b>hi</b>\u0000 there  ')).toBe('hi there');
  });

  it('全非法输入返回空串', () => {
    expect(sanitizeUserInput('<script></script>')).toBe('');
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
