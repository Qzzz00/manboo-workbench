import { describe, it, expect, vi } from 'vitest';

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => false },
  registerPlugin: () => ({}),
}));

import {
  normalizeScreensaverState,
  getScreensaverState,
  applyScreensaver,
  DEFAULT_SCREENSAVER_STATE,
} from './screensaverPlugin.ts';

describe('normalizeScreensaverState', () => {
  it('空对象回默认值', () => {
    expect(normalizeScreensaverState({})).toEqual(DEFAULT_SCREENSAVER_STATE);
  });

  it('null/非对象回默认值', () => {
    expect(normalizeScreensaverState(null)).toEqual(DEFAULT_SCREENSAVER_STATE);
    expect(normalizeScreensaverState('junk')).toEqual(DEFAULT_SCREENSAVER_STATE);
  });

  it('合法值透传', () => {
    const s = normalizeScreensaverState({
      applied: true,
      secureGranted: true,
      notifAccess: true,
      calendarGranted: true,
      locationGranted: true,
      avatarId: 'yumi',
      brightness: 80,
      fps: 30,
      server: 'http://x:3456',
      city: '上海',
    });
    expect(s.applied).toBe(true);
    expect(s.avatarId).toBe('yumi');
    expect(s.brightness).toBe(80);
    expect(s.fps).toBe(30);
  });

  it('数值夹取值域：brightness 10–100，fps 10–60', () => {
    expect(normalizeScreensaverState({ brightness: 5 }).brightness).toBe(10);
    expect(normalizeScreensaverState({ brightness: 500 }).brightness).toBe(100);
    expect(normalizeScreensaverState({ fps: 1 }).fps).toBe(10);
    expect(normalizeScreensaverState({ fps: 120 }).fps).toBe(60);
  });

  it('脏类型回默认：字符串数字/布尔字符串不透传', () => {
    const s = normalizeScreensaverState({ brightness: '80', applied: 'true', avatarId: 42 });
    expect(s.brightness).toBe(DEFAULT_SCREENSAVER_STATE.brightness);
    expect(s.applied).toBe(false);
    expect(s.avatarId).toBe('');
  });
});

describe('非原生平台短路', () => {
  it('getScreensaverState 回默认值', async () => {
    expect(await getScreensaverState()).toEqual(DEFAULT_SCREENSAVER_STATE);
  });

  it('applyScreensaver 回 needManual', async () => {
    expect(await applyScreensaver()).toEqual({ applied: false, needManual: true });
  });
});
