import { describe, expect, it } from 'vitest';
import { parseLyric, currentLyricIndex, type LyricLine } from './holoLyric';

const LRC = [
  '[ti:Faded]',
  '[ar:Alan Walker]',
  '[by:someone]',
  '[00:00.00]You were the shadow to my light',
  '[00:06.20]Did you feel us',
  '[00:12.50]Another star',
  '',
].join('\n');

const TLYRIC = [
  '[00:00.00]你是我光芒之下的暗影',
  '[00:06.20]你是否能感受到我们',
  '[00:12.50]又一颗星辰陨落',
].join('\n');

describe('parseLyric', () => {
  it('解析时间标签 + 按时间排序，过滤元数据/空行', () => {
    const lines = parseLyric(LRC, '');
    expect(lines.map((l) => l.text)).toEqual([
      'You were the shadow to my light',
      'Did you feel us',
      'Another star',
    ]);
    expect(lines[1].t).toBe(6200);
    expect(lines[2].t).toBe(12500);
  });

  it('翻译按时间戳对齐并入 trans', () => {
    const lines = parseLyric(LRC, TLYRIC);
    expect(lines[0].trans).toBe('你是我光芒之下的暗影');
    expect(lines[2].trans).toBe('又一颗星辰陨落');
  });

  it('翻译缺某行 → 该行无 trans，不串位', () => {
    const partial = ['[00:06.20]你是否能感受到我们'].join('\n');
    const lines = parseLyric(LRC, partial);
    expect(lines[0].trans).toBeUndefined();
    expect(lines[1].trans).toBe('你是否能感受到我们');
    expect(lines[2].trans).toBeUndefined();
  });

  it('乱序时间戳 → 输出按时间升序', () => {
    const messy = ['[00:12.50]C', '[00:00.00]A', '[00:06.20]B'].join('\n');
    const lines = parseLyric(messy, '');
    expect(lines.map((l) => l.text)).toEqual(['A', 'B', 'C']);
  });

  it('一行多时间标签 → 展开成多行', () => {
    const multi = '[00:01.00][00:05.00]repeat';
    const lines = parseLyric(multi, '');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ t: 1000, text: 'repeat' });
    expect(lines[1]).toMatchObject({ t: 5000, text: 'repeat' });
  });

  it('毫秒两位/三位都能解析', () => {
    expect(parseLyric('[00:01.5]half', '')[0].t).toBe(1500);
    expect(parseLyric('[00:01.500]half', '')[0].t).toBe(1500);
  });

  it('纯音乐 → 空 lines', () => {
    expect(parseLyric('[00:00.00]纯音乐，请欣赏', '')).toEqual([]);
    expect(parseLyric('纯音乐，请欣赏\n', '')).toEqual([]);
  });

  it('空串 / null → 空数组', () => {
    expect(parseLyric('', '')).toEqual([]);
    expect(parseLyric(null as unknown as string, null as unknown as string)).toEqual([]);
  });
});

describe('currentLyricIndex', () => {
  const lines: LyricLine[] = [
    { t: 0, text: 'A' },
    { t: 6200, text: 'B' },
    { t: 12500, text: 'C' },
  ];

  it('位置在第一行之前 → -1', () => {
    expect(currentLyricIndex(lines, -1)).toBe(-1);
  });

  it('返回 t<=pos 的最后一行下标', () => {
    expect(currentLyricIndex(lines, 0)).toBe(0);
    expect(currentLyricIndex(lines, 6199)).toBe(0);
    expect(currentLyricIndex(lines, 6200)).toBe(1);
    expect(currentLyricIndex(lines, 99999)).toBe(2);
  });

  it('空 lines → -1', () => {
    expect(currentLyricIndex([], 5000)).toBe(-1);
  });
});
