import { describe, it, expect } from 'vitest';
import { deriveDepthUrl } from './deriveDepthUrl.ts';

describe('deriveDepthUrl', () => {
  it('本地背景 → 同目录 .depth.png', () => {
    expect(deriveDepthUrl('/backgrounds/home-bg.jpg')).toBe('/backgrounds/home-bg.depth.png');
  });

  it('远端上传背景 → 同目录 .depth.png', () => {
    expect(deriveDepthUrl('/uploads/backgrounds/abc123.png')).toBe('/uploads/backgrounds/abc123.depth.png');
  });

  it('忽略 query 与 hash', () => {
    expect(deriveDepthUrl('/backgrounds/home-bg.jpg?v=2#x')).toBe('/backgrounds/home-bg.depth.png');
  });

  it('blob/data/空/无扩展名 → null', () => {
    expect(deriveDepthUrl('blob:http://x/1')).toBeNull();
    expect(deriveDepthUrl('data:image/png;base64,AAAA')).toBeNull();
    expect(deriveDepthUrl('')).toBeNull();
    expect(deriveDepthUrl('/backgrounds/noext')).toBeNull();
  });
});
