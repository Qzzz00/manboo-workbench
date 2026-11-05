/**
 * 后台那几条通知各占各的一条(2026-10-09,卡「四件小事」第 2 件)。
 *
 * 从前「只发一条普通通知」走的是 `startRinging({ silent: true })`,原生那一支用固定的
 * `NOTIFICATION_DESK` 这一个 id:新答案盖掉上一条答案、盖掉夜间静默那条来电,
 * 还把座机模式那条常驻通知也盖掉。现在普通通知走原生 `postNotice`,按 key 当 tag 各发一条;
 * 来电那条(响铃、全屏)照旧自己一个 id。老手机包没有 `postNotice` → 退回老路,不坏。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const native = vi.hoisted(() => ({
  impl: null as null | Record<string, (...args: unknown[]) => Promise<unknown>>,
}));
vi.mock('@capacitor/core', async (importOriginal) => {
  const real = await importOriginal<typeof import('@capacitor/core')>();
  return {
    ...real,
    registerPlugin: (name: string) => (name === 'DeskPhone'
      ? new Proxy({}, {
        get: (_t, key: string) => (...args: unknown[]) => {
          const fn = native.impl?.[key];
          if (fn === undefined) return Promise.reject(new Error('not implemented'));
          return fn(...args);
        },
      })
      : real.registerPlugin(name)),
  };
});

afterEach(() => { native.impl = null; });

describe('① 只发通知的那几条走 postNotice,各带自己的 key', () => {
  it('★ 两条答案 + 一条静默来电:三次 postNotice,key 各不相同,不碰响铃那一路', async () => {
    const { startRinging } = await import('../src/deskphone/deskPhone');
    const posted: unknown[] = [];
    const rang: unknown[] = [];
    native.impl = {
      postNotice: async (input) => { posted.push(input); return { posted: true }; },
      startRinging: async (input) => { rang.push(input); return { started: true }; },
    };
    await startRinging({ callId: 'answer:a1', title: '问一', text: '答一', silent: true });
    await startRinging({ callId: 'answer:a2', title: '问二', text: '答二', silent: true });
    await startRinging({ callId: 'night-1', title: '等你确认 · 甲', text: '夜间静默时段,没有响铃', silent: true });
    expect(posted).toEqual([
      { key: 'answer:a1', title: '问一', text: '答一' },
      { key: 'answer:a2', title: '问二', text: '答二' },
      { key: 'night-1', title: '等你确认 · 甲', text: '夜间静默时段,没有响铃' },
    ]);
    expect(rang).toEqual([]);
  });

  it('真来电照旧走 startRinging(响铃、全屏那一路),不走 postNotice', async () => {
    const { startRinging } = await import('../src/deskphone/deskPhone');
    const posted: unknown[] = [];
    native.impl = {
      postNotice: async (input) => { posted.push(input); return { posted: true }; },
      startRinging: async () => ({ started: true, fullScreen: true, tone: 'native' }),
    };
    expect(await startRinging({ callId: 'c-1', title: 't', text: '', silent: false })).toMatchObject({ fullScreen: true, tone: 'native' });
    expect(posted).toEqual([]);
  });

  it('老手机包(原生没有 postNotice):退回老路 startRinging({ silent: true }),照样发得出去', async () => {
    const { startRinging } = await import('../src/deskphone/deskPhone');
    const rang: unknown[] = [];
    native.impl = { startRinging: async (input) => { rang.push(input); return { started: true }; } };
    expect(await startRinging({ callId: 'answer:a1', title: '问一', text: '答一', silent: true })).toMatchObject({ ok: true });
    expect(rang).toEqual([{ callId: 'answer:a1', title: '问一', text: '答一', silent: true }]);
  });
});

describe('② 原生源码的契约', () => {
  const dir = resolve(__dirname, '../android/app/src/main/java/ai/ben/butler');
  const plugin = readFileSync(resolve(dir, 'DeskPhonePlugin.java'), 'utf8');
  const standby = readFileSync(resolve(dir, 'RingStandbyService.java'), 'utf8');
  // 响铃与普通通知的那一套 2026-10-20(卡 E)从插件搬进了 Ringer.kt:网页与原生两路收铃共用一份。
  const ringer = readFileSync(resolve(dir, 'Ringer.kt'), 'utf8');
  const idOf = (source: string, name: string): number => Number(source.match(new RegExp(`${name}\\s*=\\s*(\\d+)`))?.[1]);

  it('有 postNotice;按 key 当 tag 发,id 是普通通知自己那一个', () => {
    expect(plugin).toContain('public void postNotice(PluginCall');
    expect(ringer).toMatch(/\.notify\(\s*tag\s*,\s*NOTIFICATION_NOTICE\s*,/);
  });

  it('★ 静默那一支不再用座机常驻通知那个 id', () => {
    expect(plugin).not.toMatch(/notify\(\s*silent\s*\?\s*NOTIFICATION_DESK/);
    expect(ringer).not.toMatch(/notify\(\s*silent\s*\?\s*NOTIFICATION_DESK/);
  });

  it('来电 / 座机常驻 / 普通通知 / 待机 / 已退出 五个 id 各不相同', () => {
    const ids = [
      idOf(ringer, 'NOTIFICATION_RING'), idOf(plugin, 'NOTIFICATION_DESK'), idOf(ringer, 'NOTIFICATION_NOTICE'),
      idOf(standby, 'NOTIFICATION_STANDBY'), idOf(standby, 'NOTIFICATION_GONE'),
    ];
    for (const id of ids) expect(Number.isInteger(id)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
