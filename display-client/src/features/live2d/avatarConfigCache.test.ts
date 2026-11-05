// 轻量配置落盘缓存回归测试（「重启后构图回到没调的状态」修复）：
// applyRemoteConfig 落盘 → 冷启动 remoteEntryToManifest（经 applyRemoteOverrides）合缓存。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// live2dEngine 顶层依赖 pixi（node 测试环境加载不了），打桩掉。
vi.mock('pixi.js', () => ({}));
vi.mock('pixi-live2d-display/cubism4', () => ({ Live2DModel: class {} }));

import {
  applyRemoteConfig,
  applyRemoteOverrides,
  clearRemoteOverrides,
  getAvatarById,
} from './avatarManifest.ts';

const TEST_ID = 'test-remote-cache-x';
const BARE_ENTRY = {
  id: TEST_ID,
  name: '缓存测试角色',
  model_entry: 'm.model3.json',
  localDir: `avatars/${TEST_ID}/v1`,
} as const;

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  });
});

afterEach(() => {
  clearRemoteOverrides();
  vi.unstubAllGlobals();
});

describe('轻量配置落盘缓存（冷启动构图恢复）', () => {
  it('远端角色冷启动默认吃硬编码兜底（0.27 + 8×/1.3 模型变换）', () => {
    applyRemoteOverrides([{ ...BARE_ENTRY }]);
    const avatar = getAvatarById(TEST_ID)!;
    expect(avatar.scaleMultiplier).toBe(0.27);
    expect(avatar.modelTransform).toEqual({ scale: 8, offsetX: 0, offsetY: 1.3 });
    expect(avatar.homeFraming).toBeUndefined();
  });

  it('applyRemoteConfig 落盘 → 再次 applyRemoteOverrides（模拟冷启动）合入缓存构图', () => {
    applyRemoteOverrides([{ ...BARE_ENTRY }]);
    const cfg = {
      transform: {
        scaleMultiplier: 1,
        modelTransform: { scale: 1, offsetX: 0, offsetY: 0 },
        homeFraming: { scale: 0.9, offsetX: -0.23, offsetY: 0.2 },
      },
      defaultBackground: 'https://cdn.example.com/bg.jpg',
      portraitUrl: 'https://cdn.example.com/portrait.png',
    };
    expect(applyRemoteConfig(TEST_ID, cfg)).toBe(true);

    // 模拟冷启动：索引条目不带 transform，注册表条目应改从缓存恢复
    applyRemoteOverrides([{ ...BARE_ENTRY }]);
    const avatar = getAvatarById(TEST_ID)!;
    expect(avatar.scaleMultiplier).toBe(1);
    expect(avatar.modelTransform).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
    expect(avatar.homeFraming).toEqual({ scale: 0.9, offsetX: -0.23, offsetY: 0.2 });
    // camelCase 字段必须完整回环（不能再过 normalizeAvatarConfig 丢字段）
    expect(avatar.defaultBackground).toBe('https://cdn.example.com/bg.jpg');
    expect(avatar.portraitUrl).toBe('https://cdn.example.com/portrait.png');
  });

  it('缓存损坏（非法 JSON）时静默回退硬编码兜底', () => {
    store.set(`llm-live2d:avatar-config:${TEST_ID}`, '{not json');
    applyRemoteOverrides([{ ...BARE_ENTRY }]);
    const avatar = getAvatarById(TEST_ID)!;
    expect(avatar.scaleMultiplier).toBe(0.27);
    expect(avatar.homeFraming).toBeUndefined();
  });
});
