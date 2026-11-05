import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');

/** 字号规矩(2026-09-16 Ben:手机上文字不明显):正文 16、次要 14、最小 13(只给时间戳一类);全部用 rem 以便「大字」整体缩放。 */
describe('styles.css 字号', () => {
  it('html 基准 16px,大字开关 = 1.15 倍', () => {
    expect(css).toMatch(/html\s*\{[^}]*font-size:\s*16px/);
    expect(css).toMatch(/html\[data-ba-text="large"\]\s*\{[^}]*font-size:\s*18\.4px/);
  });
  it('body 行高 ≥ 1.45', () => {
    const m = /body\s*\{[^}]*font:\s*1rem\/([\d.]+)/.exec(css);
    expect(m, 'body font 简写').not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(1.45);
  });
  it('样式里不再出现 px 字号(时间戳一类的最小值也用 rem 变量)', () => {
    const pxFont = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => m[0]);
    // 只允许 html 基准与大字那两条
    expect(pxFont.filter((s) => !/16px|18\.4px/.test(s))).toEqual([]);
  });
  it('rem 字号没有小于 .8125rem(13px)的', () => {
    const rems = [...css.matchAll(/font-size:\s*(\.\d+|\d+\.?\d*)rem/g)].map((m) => Number(m[1]));
    expect(rems.length).toBeGreaterThan(0);
    expect(Math.min(...rems)).toBeGreaterThanOrEqual(0.8125);
  });
  it('字号档位变量齐全:正文 / 次要 / 最小 / 标题', () => {
    expect(css).toMatch(/--ba-fs-body:\s*1rem/);
    expect(css).toMatch(/--ba-fs-sub:\s*\.875rem/);
    expect(css).toMatch(/--ba-fs-min:\s*\.8125rem/);
    expect(css).toMatch(/--ba-fs-title:\s*1\.125rem/);
  });
});
