import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getNativeScreensaverAvatarId } from './nativeBridge.ts';

type MutableGlobal = { window?: unknown };
const g = globalThis as MutableGlobal;
const hadWindow = typeof g.window !== 'undefined';
const originalWindow = g.window;

describe('getNativeScreensaverAvatarId', () => {
  beforeEach(() => {
    g.window = {};
  });
  afterEach(() => {
    if (hadWindow) g.window = originalWindow;
    else delete g.window;
  });

  it('无原生桥返回空串', () => {
    expect(getNativeScreensaverAvatarId()).toBe('');
  });

  it('返回原生值', () => {
    g.window = { AibooNative: { getScreensaverAvatarId: () => 'yumi' } };
    expect(getNativeScreensaverAvatarId()).toBe('yumi');
  });

  it('原生抛异常回空串', () => {
    g.window = {
      AibooNative: {
        getScreensaverAvatarId: () => {
          throw new Error('boom');
        },
      },
    };
    expect(getNativeScreensaverAvatarId()).toBe('');
  });
});
