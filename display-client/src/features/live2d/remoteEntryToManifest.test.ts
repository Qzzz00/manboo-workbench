// remoteEntryToManifest 透传后台三套页面构图（loginFraming/homeFraming/djFraming）到 manifest。
import { afterEach, describe, expect, it, vi } from 'vitest';

// live2dEngine 顶层依赖 pixi（node 测试环境加载不了），本文件只用其纯函数，打桩掉。
vi.mock('pixi.js', () => ({}));
vi.mock('pixi-live2d-display/cubism4', () => ({ Live2DModel: class {} }));

import { applyRemoteOverrides, clearRemoteOverrides, getAvatarById } from './avatarManifest.ts';

const ENTRY = {
  id: 'remote-custom',
  model_entry: 'model.model3.json',
  localDir: 'avatars/remote-custom/v1',
  transform: {
    loginFraming: { scale: 0.9, offsetX: -0.2, offsetY: -0.7 },
    homeFraming: { scale: 0.7, offsetX: 0.1, offsetY: -0.98 },
    djFraming: { scale: 0.6, offsetX: 0, offsetY: -1.15 },
  },
} as const;

afterEach(() => {
  clearRemoteOverrides();
});

describe('remoteEntryToManifest：远端下载角色透传三套页面构图', () => {
  it('transform 中的 loginFraming/homeFraming/djFraming 进入 manifest', () => {
    applyRemoteOverrides([ENTRY]);
    const avatar = getAvatarById('remote-custom');
    expect(avatar).toBeDefined();
    expect(avatar!.loginFraming).toEqual({ scale: 0.9, offsetX: -0.2, offsetY: -0.7 });
    expect(avatar!.homeFraming).toEqual({ scale: 0.7, offsetX: 0.1, offsetY: -0.98 });
    expect(avatar!.djFraming).toEqual({ scale: 0.6, offsetX: 0, offsetY: -1.15 });
  });

  it('transform 缺构图时透传 undefined，不引入脏值', () => {
    applyRemoteOverrides([{ id: 'remote-min', model_entry: 'm.model3.json', localDir: 'avatars/remote-min/v1' }]);
    const avatar = getAvatarById('remote-min');
    expect(avatar!.loginFraming).toBeUndefined();
    expect(avatar!.homeFraming).toBeUndefined();
    expect(avatar!.djFraming).toBeUndefined();
  });
});
