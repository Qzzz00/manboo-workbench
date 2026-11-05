import { describe, expect, it } from 'vitest';
import { computeAlmanac, trimList } from './holoAlmanac';

describe('computeAlmanac', () => {
  it('2026-07-22 返回农历六月初九·丙午马年,非节气日 jieqi=null', () => {
    const a = computeAlmanac(new Date(2026, 6, 22));
    expect(a.lunarDate).toBe('六月初九');
    expect(a.ganzhiYear).toBe('丙午马年');
    expect(a.jieqi).toBeNull();
  });
  it('宜/忌各截前3条且来自老黄历(2026-07-22 实测锚点)', () => {
    const a = computeAlmanac(new Date(2026, 6, 22));
    expect(a.yi).toEqual(['嫁娶', '纳采', '订盟']);
    expect(a.ji).toEqual(['上梁', '入宅', '修造']);
  });
  it('节气日返回节气名(2026-02-04 立春)', () => {
    expect(computeAlmanac(new Date(2026, 1, 4)).jieqi).toBe('立春');
  });
});

describe('trimList', () => {
  it('超3条截前3', () => {
    expect(trimList(['a', 'b', 'c', 'd'])).toEqual(['a', 'b', 'c']);
  });
  it('空数组兜底为—', () => {
    expect(trimList([])).toEqual(['—']);
  });
});
