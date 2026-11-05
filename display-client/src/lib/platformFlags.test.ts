import { describe, it, expect } from 'vitest';
import { applyPlatformFlags } from './platformFlags.ts';

function fakeDoc(): Document {
  // 仅用到 documentElement.dataset；用最小 DOM 替身
  const el = { dataset: {} as Record<string, string> };
  return { documentElement: el } as unknown as Document;
}

describe('applyPlatformFlags', () => {
  it('原生平台打 data-native=1', () => {
    const doc = fakeDoc();
    applyPlatformFlags(doc, true);
    expect(doc.documentElement.dataset.native).toBe('1');
  });

  it('非原生平台不留 data-native 属性（避免 [data-native] 误命中）', () => {
    const doc = fakeDoc();
    doc.documentElement.dataset.native = '1';
    applyPlatformFlags(doc, false);
    expect(doc.documentElement.dataset.native).toBeUndefined();
  });
});
