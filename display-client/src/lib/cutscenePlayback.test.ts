import { describe, expect, it } from 'vitest';
import { normalizeStoryboard, panelDurationMs, isLastPanel } from './cutscenePlayback.ts';

describe('normalizeStoryboard（条漫格子归一化）', () => {
  it('补默认：缺失字段填 panel_index/aspect/reveal/dialogue', () => {
    const out = normalizeStoryboard([{ image_url: '/a.png' }]);
    expect(out).toHaveLength(1);
    expect(out[0].panel_index).toBe(0);
    expect(out[0].aspect).toBe('wide');
    expect(out[0].reveal).toBe('slide-up');
    expect(Array.isArray(out[0].dialogue)).toBe(true);
    expect(out[0].narration).toBe('');
  });

  it('非法 aspect 回落 wide；fade 保留', () => {
    const out = normalizeStoryboard([{ aspect: 'bogus', reveal: 'fade' }, { aspect: 'splash' }]);
    expect(out[0].aspect).toBe('wide');
    expect(out[0].reveal).toBe('fade');
    expect(out[1].aspect).toBe('splash');
  });

  it('过滤脏 dialogue（无 text 的丢弃）', () => {
    const out = normalizeStoryboard([{ dialogue: [{ text: 'hi' }, { speaker: 'x' }, null] }]);
    expect(out[0].dialogue).toHaveLength(1);
    expect(out[0].dialogue[0].text).toBe('hi');
  });

  it('非数组输入 → 空数组', () => {
    expect(normalizeStoryboard(null)).toEqual([]);
    expect(normalizeStoryboard(undefined)).toEqual([]);
    expect(normalizeStoryboard('x')).toEqual([]);
  });
});

describe('panelDurationMs（一格停留时长随文字量）', () => {
  it('文字越多停越久，夹在 [min,max]', () => {
    const short = panelDurationMs({ panel_index: 0, image_url: '', aspect: 'wide', reveal: 'fade', narration: '', dialogue: [] });
    const long = panelDurationMs({ panel_index: 1, image_url: '', aspect: 'wide', reveal: 'fade', narration: '很长'.repeat(100), dialogue: [] });
    expect(long).toBeGreaterThan(short);
    expect(short).toBeGreaterThanOrEqual(1200);
    expect(long).toBeLessThanOrEqual(8000);
  });

  it('算上 dialogue 的字数', () => {
    const withDialogue = panelDurationMs({ panel_index: 0, image_url: '', aspect: 'wide', reveal: 'fade', narration: '', dialogue: [{ text: '一二三四五六七八九十' }] });
    const empty = panelDurationMs({ panel_index: 0, image_url: '', aspect: 'wide', reveal: 'fade', narration: '', dialogue: [] });
    expect(withDialogue).toBeGreaterThan(empty);
  });
});

describe('isLastPanel', () => {
  it('末格为 true，其余 false', () => {
    expect(isLastPanel(2, 3)).toBe(true);
    expect(isLastPanel(1, 3)).toBe(false);
    expect(isLastPanel(0, 1)).toBe(true);
  });
});
