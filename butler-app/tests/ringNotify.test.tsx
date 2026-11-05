/**
 * 后台来电要在系统顶部弹出来(2026-10-04,维护者:「现在 APP 解决后台也能响铃的方式,是直接出声音和震动,
 * 好歹在系统顶部弹个通知也行啊」)。
 *
 * 原因:Android 13+ 的通知权限只在「有事的时候主动打电话给我」**被拨开**那一下才要 ——
 * 那一格服务端缺省就开着,她从没拨过,于是权限一次都没要过,原生那条来电通知发不出去,只剩铃声和震动。
 * 设置页那一行还说的是「去打开全屏通知」,而那颗键在没通知权限时藏着。
 *
 * 四节:①状态如实(弹不弹得出顶部横幅);②设置页那一行说对的事、带对的键;
 * ③App 一打开就要一次权限;④原生源码的契约。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_SETTINGS } from '../src/settings/settingsStore';
import { useIncoming } from '../src/call/useIncoming';
import { SessionContext, type Session } from '../src/session';
import { createFakeLink, fakeChannel, fakeRouted } from './wbchFakes';
import type { ApiClient } from '../src/api/client';
import type { DeskPhoneStatus } from '../src/deskphone/deskPhone';

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

afterEach(() => { native.impl = null; cleanup(); });

const OK: DeskPhoneStatus = {
  notifications: true, banner: true, fullScreen: true, deskPhone: false,
  standby: true, batteryUnrestricted: true, vendor: null, absent: false,
};

describe('① 状态如实', () => {
  it('弹不弹得出顶部横幅由原生说;没给就不编成能', async () => {
    const { deskPhoneStatus } = await import('../src/deskphone/deskPhone');
    native.impl = { status: async () => ({ notifications: true, banner: false }) };
    expect(await deskPhoneStatus()).toMatchObject({ notifications: true, banner: false });
    native.impl = { status: async () => ({ notifications: true }) };
    expect((await deskPhoneStatus()).banner).toBe(false);
    native.impl = null;
    expect((await deskPhoneStatus()).banner).toBe(false);
  });

  it('提醒那一行:先说最要紧的那一件,一次只说一件', async () => {
    const { alertHints, NO_NOTIFY_TEXT, NO_BANNER_TEXT, NO_FULL_SCREEN_TEXT } = await import('../src/deskphone/deskPhone');
    expect(alertHints(OK)).toEqual([]);
    // 没通知权限:什么都弹不出来,先说这一件(以前这里说的是「去打开全屏通知」,键还藏着)。
    expect(alertHints({ ...OK, notifications: false, banner: false, fullScreen: false })).toEqual([{ text: NO_NOTIFY_TEXT, action: 'notify' }]);
    expect(alertHints({ ...OK, banner: false, fullScreen: false })).toEqual([{ text: NO_BANNER_TEXT, action: 'banner' }]);
    expect(alertHints({ ...OK, fullScreen: false })).toEqual([{ text: NO_FULL_SCREEN_TEXT, action: 'fullScreen' }]);
    expect(alertHints({ ...OK, absent: true })).toEqual([]);
  });

  it('要权限:给了就完;没给(多半是以前拒过、系统不再弹框)就直接把通知设置打开', async () => {
    const { ensureNotifications } = await import('../src/deskphone/deskPhone');
    const calls: string[] = [];
    native.impl = {
      requestNotifications: async () => { calls.push('ask'); return { granted: true }; },
      openNotificationSettings: async () => { calls.push('settings'); },
    };
    expect(await ensureNotifications()).toBe(true);
    expect(calls).toEqual(['ask']);
    calls.length = 0;
    native.impl.requestNotifications = async () => { calls.push('ask'); return { granted: false }; };
    expect(await ensureNotifications()).toBe(false);
    expect(calls).toEqual(['ask', 'settings']);
  });
});

describe('② 设置页 · 提醒那一行', () => {
  async function mount(status: Record<string, unknown>) {
    const { CallAlertsSection, HINT_ACTION_LABELS } = await import('../src/settings/DeskPhoneSection');
    const { SettingsContext } = await import('../src/settings/SettingsContext');
    const calls: string[] = [];
    native.impl = {
      status: async () => status,
      setStandby: async (input) => ({ on: (input as { on: boolean }).on }),
      requestNotifications: async () => { calls.push('ask'); return { granted: false }; },
      openNotificationSettings: async () => { calls.push('settings'); },
      openFullScreenSettings: async () => { calls.push('fullScreen'); },
    };
    const json = async () => ({ ok: true as const, status: 200, data: { enabled: true, quiet_from: '23:00', quiet_to: '08:00', done_call: false } });
    const session = { client: { json } } as unknown as Session;
    render(
      <SessionContext.Provider value={session}>
        <SettingsContext.Provider value={{ settings: { ...DEFAULT_SETTINGS }, update: async () => {} }}>
          <CallAlertsSection />
        </SettingsContext.Provider>
      </SessionContext.Provider>,
    );
    return { calls, HINT_ACTION_LABELS };
  }

  it('★ 没通知权限:说的是通知权限,键点了先要权限、要不到打开通知设置', async () => {
    const { NO_NOTIFY_TEXT, NO_FULL_SCREEN_TEXT } = await import('../src/deskphone/deskPhone');
    const m = await mount({ notifications: false, fullScreen: false, standby: true, batteryUnrestricted: true });
    await screen.findByText(NO_NOTIFY_TEXT);
    expect(screen.queryByText(NO_FULL_SCREEN_TEXT)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: m.HINT_ACTION_LABELS.notify }));
    await waitFor(() => expect(m.calls).toEqual(['ask', 'settings']));
  });

  it('有权限但横幅被关了:键直接打开来电那个频道的设置', async () => {
    const { NO_BANNER_TEXT } = await import('../src/deskphone/deskPhone');
    const m = await mount({ notifications: true, banner: false, fullScreen: true, standby: true, batteryUnrestricted: true });
    await screen.findByText(NO_BANNER_TEXT);
    fireEvent.click(screen.getByRole('button', { name: m.HINT_ACTION_LABELS.banner }));
    await waitFor(() => expect(m.calls).toEqual(['settings']));
  });
});

describe('③ App 一打开就要一次通知权限(后台待机开着时)', () => {
  function harness(standby: boolean) {
    const link = createFakeLink();
    const channel = fakeChannel({
      link,
      onRing: () => () => {},
      holdForRing: async () => { link.setState('connected'); return { ok: true as const }; },
      releaseRing: async () => {},
    });
    const json = async () => ({ ok: true as const, status: 200, data: { entries: [], missed: 0 } });
    const client = fakeRouted({ baseUrl: 'http://x', json, blob: async () => ({ ok: false, status: 0, kind: 'network', error: '' }) } as unknown as ApiClient);
    const session = { channel, client } as unknown as Session;
    const asked: number[] = [];
    function Probe() {
      useIncoming(session, {
        standby,
        setStandby: async () => ({ ok: true }),
        askNotify: async () => { asked.push(1); return true; },
        makeRingtone: () => ({ start: async () => ({ ok: true }), stop: () => {}, dispose: () => {} }),
        ring: async () => ({ ok: true, fullScreen: true }),
        stopRing: async () => {},
      });
      return null;
    }
    render(<SessionContext.Provider value={session}><Probe /></SessionContext.Provider>);
    return { asked };
  }

  it('★ 开着待机:打开就要一次(只要一次,不跟着回前台反复弹)', async () => {
    const h = harness(true);
    await waitFor(() => expect(h.asked).toEqual([1]));
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise(r => setTimeout(r, 20));
    expect(h.asked).toEqual([1]);
  });

  it('关着待机:不要', async () => {
    const h = harness(false);
    await new Promise(r => setTimeout(r, 20));
    expect(h.asked).toEqual([]);
  });
});

describe('④ 原生源码的契约', () => {
  const plugin = readFileSync(resolve(__dirname, '../android/app/src/main/java/ai/ben/butler/DeskPhonePlugin.java'), 'utf8');

  it('status 回 banner;有打开通知设置那一项;「能发通知」认系统总开关', () => {
    expect(plugin).toMatch(/result\.put\("banner"/);
    expect(plugin).toContain('public void openNotificationSettings(');
    expect(plugin).toContain('ACTION_CHANNEL_NOTIFICATION_SETTINGS');
    expect(plugin).toContain('areNotificationsEnabled()');
  });
});
