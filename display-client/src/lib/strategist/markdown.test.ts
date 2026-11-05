import { describe, expect, it } from 'vitest';

import { stripMarkdown } from './markdown.ts';

describe('stripMarkdown', () => {
  it('★成对加粗剥掉——TTS 会把星号念成「星星」（Ben 实报）', () => {
    expect(stripMarkdown('傲骨燕 **22级** 进化')).toBe('傲骨燕 22级 进化');
  });

  it('流式边界劈开的孤星也不留', () => {
    expect(stripMarkdown('去**道路 E')).toBe('去道路 E');
    expect(stripMarkdown('那边*')).toBe('那边');
  });

  it('列表横线与井号标题剥掉（TTS 念成「杠」）', () => {
    expect(stripMarkdown('- 先去佩雷市\n# 标题')).toBe('先去佩雷市\n标题');
  });

  it('正常中文与破折号不误伤', () => {
    const t = '入口在通往道路 E 的过道里——得从那边绕进来。';
    expect(stripMarkdown(t)).toBe(t);
  });
});
