import { describe, it, expect, vi } from 'vitest';

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => false },
  registerPlugin: () => ({}),
}));

import {
  normalizeWidgetState,
  getWidgetState,
  saveWidgetFrames,
  requestWidgetPin,
  DEFAULT_WIDGET_STATE,
} from './widgetPlugin.ts';

describe('normalizeWidgetState', () => {
  it('空/非对象回默认', () => {
    expect(normalizeWidgetState({})).toEqual(DEFAULT_WIDGET_STATE);
    expect(normalizeWidgetState(null)).toEqual(DEFAULT_WIDGET_STATE);
  });

  it('合法值透传，loops 过滤非法项', () => {
    const s = normalizeWidgetState({
      added: true,
      avatarId: 'yumi',
      activeLoop: 'idle',
      loops: [
        { key: 'idle', frames: 48, fps: 12 },
        { key: '', frames: 0, fps: 12 },
        'junk',
        { key: 'dance', frames: '48', fps: 12 },
      ],
    });
    expect(s.added).toBe(true);
    expect(s.avatarId).toBe('yumi');
    expect(s.activeLoop).toBe('idle');
    expect(s.loops).toEqual([{ key: 'idle', frames: 48, fps: 12 }]);
  });
});

describe('非原生短路', () => {
  it('getWidgetState 回默认', async () => {
    expect(await getWidgetState()).toEqual(DEFAULT_WIDGET_STATE);
  });
  it('saveWidgetFrames 回 0，requestWidgetPin 回 false', async () => {
    expect(await saveWidgetFrames({ avatarId: 'a', loopKey: 'k', fps: 12, frames: ['x'] })).toBe(0);
    expect(await requestWidgetPin()).toBe(false);
  });
});
