/**
 * 形象队列与左右滑(2026-10-01,docs/设计-形象切换与形象包-2026-10-01.md 第一节)。
 */
import { describe, expect, it } from 'vitest';
import { PARTICLES, buildQueue, stepQueue, swipeDirection, queueLabel } from './avatarQueue';

const catalog = [
  { id: 'moxi', name: '九尾狐' },
  { id: 'hailunna_4', name: '海边阳台' },
  { id: 'sanhuamao', name: '三花猫' },
  { id: 'ougen_5', name: '赛车场' },
];

describe('形象队列', () => {
  it('★粒子球永远在第一位;后面是这台手机上已有的,按目录顺序;没下载的不进', () => {
    const q = buildQueue(catalog, new Set(['ougen_5', 'moxi']));
    expect(q.map((i) => i.id)).toEqual([PARTICLES, 'moxi', 'ougen_5']);
    expect(q[0].name).toBe('粒子球');
  });
  it('一个都没有也至少有粒子球', () => {
    expect(buildQueue(catalog, new Set()).map((i) => i.id)).toEqual([PARTICLES]);
  });
});

describe('左右滑', () => {
  const q = [PARTICLES, 'moxi', 'ougen_5'];
  it('向左滑 = 下一个,向右滑 = 上一个,首尾相接', () => {
    expect(stepQueue(q, 'moxi', 'next')).toBe('ougen_5');
    expect(stepQueue(q, 'ougen_5', 'next')).toBe(PARTICLES);
    expect(stepQueue(q, PARTICLES, 'prev')).toBe('ougen_5');
  });
  it('★当前那个不在队列里(被删了 / 还没装好)从粒子球算起', () => {
    expect(stepQueue(q, 'gone', 'next')).toBe('moxi');
  });
  it('★横向位移 ≥ 40 且明显大于纵向才算滑动(竖屏首页还要能上下滚)', () => {
    expect(swipeDirection(-60, 5)).toBe('next');
    expect(swipeDirection(60, 5)).toBe('prev');
    expect(swipeDirection(30, 0)).toBeNull();
    expect(swipeDirection(-60, 50)).toBeNull();
  });
  it('名字条:「赛车场 · 3/3」', () => {
    expect(queueLabel([{ id: PARTICLES, name: '粒子球' }, { id: 'moxi', name: '九尾狐' }, { id: 'ougen_5', name: '赛车场' }], 'ougen_5')).toBe('赛车场 · 3/3');
  });
});
