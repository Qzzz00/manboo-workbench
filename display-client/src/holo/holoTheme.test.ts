import { afterEach, describe, expect, it } from 'vitest';
import {
  NIGHT_COSTUME_OVERRIDES,
  loadHoloTheme,
  resolveThemeApparel,
  saveHoloTheme,
  toggleTheme,
} from './holoTheme.ts';
import type { ParameterOverride } from '../features/live2d/avatarManifest.ts';

// node 环境无 localStorage：用最小内存桩替身，测完摘掉。
function stubLocalStorage(): void {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
}
afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('toggleTheme', () => {
  it('昼夜互切', () => {
    expect(toggleTheme('day')).toBe('night');
    expect(toggleTheme('night')).toBe('day');
  });
});

describe('load / save', () => {
  it('无 localStorage 时回 day、save 不抛', () => {
    expect(loadHoloTheme()).toBe('day');
    expect(() => saveHoloTheme('night')).not.toThrow();
  });

  it('save 后 load 读回 night', () => {
    stubLocalStorage();
    saveHoloTheme('night');
    expect(loadHoloTheme()).toBe('night');
  });

  it('save day 后 load 读回 day', () => {
    stubLocalStorage();
    saveHoloTheme('day');
    expect(loadHoloTheme()).toBe('day');
  });

  it('storage 里是非法值时回 day', () => {
    stubLocalStorage();
    globalThis.localStorage.setItem('holo:theme', 'garbage');
    expect(loadHoloTheme()).toBe('day');
  });
});

describe('resolveThemeApparel', () => {
  const dj: ParameterOverride[] = [{ id: 'Param67', value: 1 }];

  it('黑夜：挂夜间换装、移除 DJ', () => {
    expect(resolveThemeApparel('night', dj)).toEqual({ dj: null, night: NIGHT_COSTUME_OVERRIDES });
  });

  it('夜间换装含 Param67=0（脱 DJ 装回初始）+ 外套', () => {
    expect(NIGHT_COSTUME_OVERRIDES).toContainEqual({ id: 'Param67', value: 0 });
    expect(NIGHT_COSTUME_OVERRIDES.some((o) => o.id === 'Param57')).toBe(true);
  });

  it('白天有 DJ ramp：挂 DJ、移除夜间', () => {
    expect(resolveThemeApparel('day', dj)).toEqual({ dj, night: null });
  });

  it('白天但 DJ ramp 为空：两层都不挂', () => {
    expect(resolveThemeApparel('day', [])).toEqual({ dj: null, night: null });
  });
});
