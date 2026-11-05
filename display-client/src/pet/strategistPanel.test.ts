import { describe, expect, it } from 'vitest';

import { spokenCursor } from './StrategistPanel.tsx';
import { stripFallbackPrefix } from './handheldStripUi.ts';

describe('stripFallbackPrefix', () => {
  it('★把兜底声明从正文剥掉——它占 22 字，在 320px 宽的面板上等于吃掉 31% 可视面积', () => {
    const r = stripFallbackPrefix('攻略库里没找到，下面是我网上搜到的，不保证对：往左走。');
    expect(r.fallback).toBe(true);
    expect(r.body).toBe('往左走。');
  });

  it('没有那个前缀就原样返回，也不标 fallback', () => {
    const r = stripFallbackPrefix('你现在在道馆里。');
    expect(r.fallback).toBe(false);
    expect(r.body).toBe('你现在在道馆里。');
  });

  it('流式出字时前缀可能只出来一半，这时不能误剥', () => {
    const r = stripFallbackPrefix('攻略库里没找');
    expect(r.fallback).toBe(false);
    expect(r.body).toBe('攻略库里没找');
  });

  it('前导空白不影响判定（模型偶尔会先吐一个空格）', () => {
    expect(stripFallbackPrefix('  攻略库里没找到，下面是我网上搜到的，不保证对：走右边').fallback).toBe(true);
  });
});

describe('spokenCursor（跟着朗读滚的位置）', () => {
  it('没有兜底声明时，念到第几个字就是正文第几个字', () => {
    const raw = '先往西走。再骑车过滑坡。';
    expect(spokenCursor(raw, raw, 5)).toBe(5);
  });

  it('★兜底声明被剥掉之后要把偏移减回去，否则整篇都会滚过头 22 个字', () => {
    const prefix = '攻略库里没找到，下面是我网上搜到的，不保证对：';
    const body = '先往西走。再骑车过滑坡。';
    // speaker 数的是流里的字数（含声明），面板显示的是剥掉声明的正文
    expect(spokenCursor(prefix + body, body, prefix.length + 5)).toBe(5);
  });

  it('夹在 [0, 正文长度] 内——speaker 的计数与流里的偏移可能差几个字', () => {
    const body = '短';
    expect(spokenCursor(body, body, 999)).toBe(1);
    expect(spokenCursor(body, body, -3)).toBe(0);
  });

  it('还没开口时是 0（此时面板退回「流式贴底」的老行为）', () => {
    expect(spokenCursor('一段答案', '一段答案', 0)).toBe(0);
  });
});
