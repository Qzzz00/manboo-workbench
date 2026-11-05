import { describe, expect, it } from 'vitest';
import { formatMemoriesForPrompt } from './cutsceneMemory.ts';

describe('formatMemoriesForPrompt', () => {
  it('空 → 空串', () => {
    expect(formatMemoriesForPrompt([])).toBe('');
    expect(formatMemoriesForPrompt(undefined as never)).toBe('');
  });

  it('拼出带标题的经历块', () => {
    const out = formatMemoriesForPrompt([
      { title: '雨夜', summary: '你陪我熬夜改方案' },
      { title: '', summary: '只有梗概' },
    ]);
    expect(out).toContain('近期共同经历');
    expect(out).toContain('- 雨夜：你陪我熬夜改方案');
    expect(out).toContain('- 只有梗概');
  });

  it('过滤空事件，最多 5 条', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ title: `t${i}`, summary: `s${i}` }));
    const out = formatMemoriesForPrompt([{ title: '', summary: '' }, ...many]);
    const bullets = out.split('\n').filter((l) => l.startsWith('- '));
    expect(bullets.length).toBe(5);
  });
});
