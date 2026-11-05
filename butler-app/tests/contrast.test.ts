import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { contrastRatio, parseHex, readPalette } from '../src/theme/contrast';

const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');
const P = readPalette(css);
const BODY = 4.5; // WCAG AA 正文

describe('contrastRatio', () => {
  it('黑白 21:1,同色 1:1,短写法也认', () => {
    expect(contrastRatio('#000', '#fff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#12151c', '#12151c')).toBe(1);
    expect(parseHex('#abc')).toEqual([0xaa, 0xbb, 0xcc]);
    expect(() => parseHex('rgba(0,0,0,.5)')).toThrow();
  });
  it('与顺序无关', () => {
    expect(contrastRatio('#e8ebf1', '#12151c')).toBe(contrastRatio('#12151c', '#e8ebf1'));
  });
});

describe('色板(styles.css :root)', () => {
  const bgs = ['ba-bg', 'ba-bg-2', 'ba-bg-3'] as const;
  it('读到了全部三级底色与三级前景', () => {
    for (const k of [...bgs, 'ba-fg', 'ba-fg-2', 'ba-fg-3', 'ba-accent', 'ba-amber', 'ba-danger', 'ba-blue', 'ba-yellow']) expect(P[k], k).toMatch(/^#[0-9a-f]{6}$/);
  });
  it.each(bgs)('主文字 fg 在 %s 上 ≥ 12:1', (bg) => {
    expect(contrastRatio(P['ba-fg']!, P[bg]!)).toBeGreaterThanOrEqual(12);
  });
  it('次级 fg-2 在 bg / bg-2 上 ≥ 8:1,在 bg-3 上 ≥ 7:1', () => {
    expect(contrastRatio(P['ba-fg-2']!, P['ba-bg']!)).toBeGreaterThanOrEqual(8);
    expect(contrastRatio(P['ba-fg-2']!, P['ba-bg-2']!)).toBeGreaterThanOrEqual(8);
    expect(contrastRatio(P['ba-fg-2']!, P['ba-bg-3']!)).toBeGreaterThanOrEqual(7);
  });
  it.each(bgs)('三级 fg-3 在 %s 上 ≥ 4.5:1(不再发虚)', (bg) => {
    expect(contrastRatio(P['ba-fg-3']!, P[bg]!)).toBeGreaterThanOrEqual(BODY);
  });
  it.each(bgs)('业务色 琥珀 / 蓝 / 红 / 黄 / 强调 作为文字在 %s 上 ≥ 4.5:1', (bg) => {
    for (const k of ['ba-amber', 'ba-blue', 'ba-danger', 'ba-yellow', 'ba-accent']) expect(contrastRatio(P[k]!, P[bg]!), k).toBeGreaterThanOrEqual(BODY);
  });
  it('按钮上的深色字:强调底与红底都 ≥ 4.5:1', () => {
    expect(P['ba-btn-fg']).toMatch(/^#[0-9a-f]{6}$/);
    expect(contrastRatio(P['ba-btn-fg']!, P['ba-accent']!)).toBeGreaterThanOrEqual(BODY);
    expect(contrastRatio(P['ba-btn-fg']!, P['ba-danger']!)).toBeGreaterThanOrEqual(BODY);
    expect(contrastRatio(P['ba-btn-fg']!, P['ba-amber']!)).toBeGreaterThanOrEqual(BODY);
  });
  it('我的气泡里的时间戳(深字在强调底上)≥ 4.5:1', () => {
    expect(contrastRatio(P['ba-bubble-me-time']!, P['ba-accent']!)).toBeGreaterThanOrEqual(BODY);
  });
  it('强调色是中性白、主按钮白底黑字(2026-09-24 维护者:「改成白色底黑字吧,中性一点,这是全局的」)', () => {
    for (const k of ['ba-accent', 'ba-accent-press', 'ba-blue', 'ba-bubble-me-time']) {
      const [r, g, b] = parseHex(P[k]!);
      expect([r, g, b], k).toEqual([r, r, r]);
    }
    expect(P['ba-accent']).toBe('#ffffff');
    expect(contrastRatio(P['ba-btn-fg']!, P['ba-accent']!)).toBeGreaterThanOrEqual(15);
    expect(contrastRatio(P['ba-btn-fg']!, P['ba-accent-press']!)).toBeGreaterThanOrEqual(BODY);
  });
  it('样式表里不再有 09-23 之前那几种蓝', () => {
    expect(css).not.toMatch(/#7aa2ff|#5b9dff|#1c2a52|#cfe0ff|#2a3f7a|122,\s*162,\s*255/i);
  });
  it('底色、分割线与三级灰阶都是中性灰(R=G=B,不带蓝),与 Mac 工作台纯黑对齐', () => {
    for (const k of ['ba-bg', 'ba-bg-2', 'ba-bg-3', 'ba-line', 'ba-fg', 'ba-fg-2', 'ba-fg-3', 'ba-gray', 'ba-btn-fg']) {
      const [r, g, b] = parseHex(P[k]!);
      expect([r, g, b], k).toEqual([r, r, r]);
    }
  });
  it('底色够黑:bg 亮度不超过 #101010', () => {
    expect(parseHex(P['ba-bg']!)[0]).toBeLessThanOrEqual(0x10);
  });
  it('状态点的灰(ba-gray)不是文字色,与 fg-3 分开', () => {
    expect(P['ba-gray']).not.toBe(P['ba-fg-3']);
  });
});
