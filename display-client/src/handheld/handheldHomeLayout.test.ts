import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('./HandheldApp.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('./handheld.css', import.meta.url), 'utf8');

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  return match?.[1] ?? '';
}

describe('掌机主页布局', () => {
  it('将日期与天气合并为时间下方的一行信息', () => {
    expect(app).toMatch(/<div className="hh-home-info">[\s\S]*hh-home-date[\s\S]*<HandheldWeather \/>[\s\S]*<\/div>/);
    expect(ruleBody('.hh-home-info')).toMatch(/display\s*:\s*flex/);
  });

  it('将时间信息固定在顶部居中并使用单行时间', () => {
    const clock = ruleBody('.hh-home-clock');
    expect(clock).toMatch(/left\s*:\s*50%/);
    expect(clock).toMatch(/transform\s*:\s*translateX\(-50%\)/);
    expect(ruleBody('.hh-home-time')).toMatch(/display\s*:\s*flex/);
    expect(ruleBody('.hh-home-time span')).not.toMatch(/display\s*:\s*block/);
  });

  it('将设置置于左下角、游戏置于右下角', () => {
    expect(app.indexOf('alt="" />\n                  <span>设置</span>')).toBeLessThan(
      app.indexOf('alt="" />\n                  <span>游戏</span>'),
    );
    const actions = ruleBody('.hh-home-actions');
    expect(actions).toMatch(/left\s*:\s*20px/);
    expect(actions).toMatch(/right\s*:\s*20px/);
    expect(actions).toMatch(/bottom\s*:/);
    expect(actions).toMatch(/flex-direction\s*:\s*row/);
    expect(actions).toMatch(/justify-content\s*:\s*space-between/);
    // 底部电话区覆盖整条横向区域；入口必须高于它，否则只有电话能点。
    expect(actions).toMatch(/z-index\s*:\s*3/);
    expect(ruleBody('.hh-home-callbar')).toMatch(/z-index\s*:\s*2/);
  });
});
