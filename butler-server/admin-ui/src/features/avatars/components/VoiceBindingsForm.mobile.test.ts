// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/components/VoiceBindingsForm.mobile.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// 移动端布局检查（ALL-609 验收项：至少一个移动端布局检查）。
// 音色槽位 Provider/音色 双栏网格在窄屏（≤640px）回退单列，避免横向溢出（ALL-608）。
// 这里是纯 CSS 契约断言：读取真实的 index.css，验证窄屏媒体查询确实定义在
// VoiceBindingsForm 使用的 .voice-slot-grid 类上，防止重构/删改把响应式丢掉。
const cssPath = join(process.cwd(), 'src', 'index.css');
const css = readFileSync(cssPath, 'utf8');

const MEDIA_QUERY = /@media\s*\(max-width:\s*640px\)\s*\{([^}]*)\}/g;

function gridRuleInsideMedia(): string | null {
  for (const m of css.matchAll(MEDIA_QUERY)) {
    if (m[1].includes('.voice-slot-grid')) {
      return m[1];
    }
  }
  return null;
}

describe('音色槽位移动端布局（index.css）', () => {
  it('桌面端 .voice-slot-grid 是双栏（1fr 1fr）', () => {
    const rule = css.match(/\.voice-slot-grid\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toContain('1fr 1fr');
  });

  it('窄屏 @media(max-width:640px) 内 .voice-slot-grid 回退单列（1fr）', () => {
    const inside = gridRuleInsideMedia();
    expect(inside).not.toBeNull();
    expect(inside!).toContain('1fr');
    // 单列=不保留两列，杜绝窄屏横向溢出
    expect(inside!).not.toContain('1fr 1fr');
  });

  it('只读横幅文案允许自动换行，避免长 provider/voice_id 挤出屏幕', () => {
    const rule = css.match(/\.readonly-banner-text\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/overflow-wrap\s*:\s*break-word/);
    expect(rule).toMatch(/word-break\s*:\s*break-word/);
  });
});
