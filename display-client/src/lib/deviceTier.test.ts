import { describe, expect, it } from 'vitest';
import { resolveTexturePath } from './deviceTier';

const TEXTURE_4096 = 'public/live2D/shuangsheng-dj/shuangsheng.4096/texture_00.png';

describe('resolveTexturePath', () => {
  it('keeps full-resolution textures on regular devices', () => {
    expect(resolveTexturePath(TEXTURE_4096, false, null)).toBe(TEXTURE_4096);
  });

  it('uses the existing 2048 tier on low-end devices by default', () => {
    expect(resolveTexturePath(TEXTURE_4096, true, null))
      .toBe('public/live2D/shuangsheng-dj/shuangsheng.2048/texture_00.png');
  });

  it('honors the dedicated display 1024 override', () => {
    expect(resolveTexturePath(TEXTURE_4096, true, '1024'))
      .toBe('public/live2D/shuangsheng-dj/shuangsheng.1024/texture_00.png');
  });

  it('ignores unsupported overrides', () => {
    expect(resolveTexturePath(TEXTURE_4096, true, '512'))
      .toBe('public/live2D/shuangsheng-dj/shuangsheng.2048/texture_00.png');
  });
});
