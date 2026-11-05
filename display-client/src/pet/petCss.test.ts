import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./pet.css', import.meta.url), 'utf8');

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  return match?.[1] ?? '';
}

describe('pet strip CSS', () => {
  it('原生 Live2D 左侧窗口必须保持透明，不能被 WebView 黑底盖住', () => {
    const rootRule = ruleBody('.pet-strip');

    expect(rootRule).not.toMatch(/background\\s*:\\s*#000/i);
    expect(css).toMatch(/\.pet-strip::before\s*\{/);
    expect(ruleBody('.pet-strip::before')).toMatch(/left\s*:\s*192\.667px/);
  });

  it('删除延迟数据后，时间与电量状态组贴右侧 16px 对齐', () => {
    const status = ruleBody('.pet-strip-statusbar');

    expect(status).toMatch(/left\s*:\s*auto/);
    expect(status).toMatch(/right\s*:\s*16px/);
  });
});
