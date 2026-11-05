/**
 * 后台 / 锁屏也能来电(2026-10-03,维护者:「起码做到保持 APP 存活在后台,在锁屏情况下和
 * 其他 APP 使用的时候还是要能响铃或通知」;默认开,设置里留开关)。
 *
 * 四节:①开关存在设置里、缺省开;②原生那一层的包装(待机服务、谁放铃声、电池优化如实回报);
 * ③接线(useIncoming 开 / 关待机,铃声原生与网页二选一 —— 不双响);④原生源码的契约
 * (清单里声明了服务与权限,插件回 tone)。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSettingsStore, DEFAULT_SETTINGS } from '../src/settings/settingsStore';
import type { KeyValueStore } from '../src/api/tokenStore';
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

function memory(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, async get(k) { return data.get(k) ?? null; }, async set(k, v) { data.set(k, v); }, async remove(k) { data.delete(k); } };
}

describe('① 开关:设置里,缺省开', () => {
  it('缺省开着;存了 false 就读回 false;认不出来的值回缺省', async () => {
    expect(DEFAULT_SETTINGS.ringStandby).toBe(true);
    const kv = memory();
    const store = createSettingsStore(kv);
    expect((await store.load()).ringStandby).toBe(true);
    await store.update({ ringStandby: false });
    expect((await store.load()).ringStandby).toBe(false);
    kv.data.set('butler.settings', JSON.stringify({ ringStandby: 'off' }));
    expect((await store.load()).ringStandby).toBe(true);
  });
});

describe('② 原生那一层的包装', () => {
  it('谁放铃声由原生说了算:原生回 native 就是 native;没有插件退回网页', async () => {
    const { startRinging } = await import('../src/deskphone/deskPhone');
    native.impl = { startRinging: async () => ({ started: true, fullScreen: true, tone: 'native' }) };
    expect(await startRinging({ callId: 'c', title: 't', text: '', silent: false })).toMatchObject({ tone: 'native' });
    native.impl = { startRinging: async () => ({ started: true, fullScreen: true }) };
    expect(await startRinging({ callId: 'c', title: 't', text: '', silent: false })).toMatchObject({ tone: 'web' });
    native.impl = null;
    expect(await startRinging({ callId: 'c', title: 't', text: '', silent: false })).toMatchObject({ tone: 'web' });
  });

  it('待机开 / 关:原生回什么就是什么;没有插件如实说做不到', async () => {
    const { setRingStandby } = await import('../src/deskphone/deskPhone');
    const calls: unknown[] = [];
    native.impl = { setStandby: async (input) => { calls.push(input); return { on: true }; } };
    expect(await setRingStandby(true)).toEqual({ ok: true });
    expect(calls).toEqual([{ on: true }]);
    native.impl = { setStandby: async () => ({ on: false, note: '前台服务起不来:x' }) };
    expect(await setRingStandby(true)).toEqual({ ok: false, note: '前台服务起不来:x' });
    native.impl = null;
    expect((await setRingStandby(true)).ok).toBe(false);
  });

  it('状态如实:电池优化豁免了没有、待机在不在、厂商那一句;原生没给的格子不编成 true', async () => {
    const { deskPhoneStatus } = await import('../src/deskphone/deskPhone');
    native.impl = { status: async () => ({ notifications: true, fullScreen: true, standby: true, batteryUnrestricted: false, vendor: 'xiaomi' }) };
    expect(await deskPhoneStatus()).toMatchObject({ standby: true, batteryUnrestricted: false, vendor: 'xiaomi', absent: false });
    native.impl = { status: async () => ({ notifications: true, fullScreen: true }) };
    expect(await deskPhoneStatus()).toMatchObject({ standby: false, batteryUnrestricted: false, vendor: null });
  });

  it('设置页那几行:做不到哪一样就说哪一样,全做到了一行都不出', async () => {
    const { standbyHints, BATTERY_HINT_TEXT, XIAOMI_HINT_TEXT, STANDBY_OFF_TEXT } = await import('../src/deskphone/deskPhone');
    const ok: DeskPhoneStatus = { notifications: true, banner: true, fullScreen: true, deskPhone: false, standby: true, batteryUnrestricted: true, vendor: null, absent: false };
    expect(standbyHints(ok, true)).toEqual([]);
    expect(standbyHints({ ...ok, batteryUnrestricted: false }, true)).toEqual([{ text: BATTERY_HINT_TEXT, action: 'battery' }]);
    // 小米:自启动 / 省电策略没有接口查得到开没开,所以只要是小米就一直挂一句,不装作查过。
    expect(standbyHints({ ...ok, vendor: 'xiaomi' }, true)).toEqual([{ text: XIAOMI_HINT_TEXT, action: 'vendor' }]);
    // 开关开着、服务却没起来:说出来。
    expect(standbyHints({ ...ok, standby: false }, true)).toEqual([{ text: STANDBY_OFF_TEXT }]);
    // 开关关着:电池那几句不说(不待机,豁免不豁免都叫不醒)。
    expect(standbyHints({ ...ok, standby: false, batteryUnrestricted: false, vendor: 'xiaomi' }, false)).toEqual([]);
    expect(standbyHints({ ...ok, absent: true }, true)).toEqual([]);
  });
});

describe('③ 接线(useIncoming)', () => {
  function harness(opts: { standby?: boolean; tone?: 'native' | 'web' }) {
    const listeners: ((message: unknown) => void)[] = [];
    const link = createFakeLink();
    const channel = fakeChannel({
      link,
      onRing: (listener) => { listeners.push(listener as (message: unknown) => void); return () => {}; },
      answerCall: async () => ({ ok: true as const }),
      laterCall: async () => ({ ok: true as const }),
      holdForRing: async () => { link.setState('connected'); return { ok: true as const }; },
      releaseRing: async () => {},
    });
    const json = async () => ({ ok: true as const, status: 200, data: { entries: [], missed: 0 } });
    const client = fakeRouted({ baseUrl: 'http://x', json, blob: async () => ({ ok: false, status: 0, kind: 'network', error: '' }) } as unknown as ApiClient);
    const session = { channel, client } as unknown as Session;
    const tonePlays: number[] = [];
    const standbyCalls: boolean[] = [];
    function Probe({ standby }: { standby: boolean | undefined }) {
      useIncoming(session, {
        ...(standby === undefined ? {} : { standby }),
        setStandby: async (on) => { standbyCalls.push(on); return { ok: true }; },
        makeRingtone: () => ({ start: async () => { tonePlays.push(1); return { ok: true }; }, stop: () => {}, dispose: () => {} }),
        ring: async () => ({ ok: true, fullScreen: true, ...(opts.tone === undefined ? {} : { tone: opts.tone }) }),
        stopRing: async () => {},
      });
      return null;
    }
    const view = render(<SessionContext.Provider value={session}><Probe standby={opts.standby} /></SessionContext.Provider>);
    return {
      push: (message: unknown) => act(() => { for (const l of listeners) l(message); }),
      rerender: (standby: boolean) => view.rerender(<SessionContext.Provider value={session}><Probe standby={standby} /></SessionContext.Provider>),
      tonePlays,
      standbyCalls,
    };
  }
  const RING = { type: 'ring', call_id: 'c1', reason: 'confirm', item_id: 'i1', title: '改首页文案', silent: false, until: Date.now() + 60_000 };

  it('★ 缺省就开待机;关掉开关当场收掉', async () => {
    const h = harness({});
    await waitFor(() => expect(h.standbyCalls).toEqual([true]));
    h.rerender(false);
    await waitFor(() => expect(h.standbyCalls).toEqual([true, false]));
  });

  it('★ 不双响:原生放了铃声,网页那段 <audio> 一次都不放', async () => {
    const h = harness({ tone: 'native' });
    h.push(RING);
    await new Promise(r => setTimeout(r, 20));
    expect(h.tonePlays).toEqual([]);
  });

  it('★ 原生没放(没插件 / 老包),网页那段照放 —— 不能一声都没有', async () => {
    const h = harness({ tone: 'web' });
    h.push(RING);
    await waitFor(() => expect(h.tonePlays).toEqual([1]));
    const old = harness({});
    old.push(RING);
    await waitFor(() => expect(old.tonePlays).toEqual([1]));
  });
});

describe('设置页 · 提醒那一组', () => {
  async function mount(status: Record<string, unknown>, ringStandby = true) {
    const { CallAlertsSection, STANDBY_LABEL, HINT_ACTION_LABELS } = await import('../src/settings/DeskPhoneSection');
    const { SettingsContext } = await import('../src/settings/SettingsContext');
    const calls: string[] = [];
    native.impl = {
      status: async () => status,
      setStandby: async (input) => { calls.push(`standby:${(input as { on: boolean }).on}`); return { on: (input as { on: boolean }).on }; },
      requestBatteryUnrestricted: async () => { calls.push('battery'); },
      openVendorSettings: async () => { calls.push('vendor'); },
    };
    const updates: unknown[] = [];
    const json = async () => ({ ok: true as const, status: 200, data: { enabled: true, quiet_from: '23:00', quiet_to: '08:00', done_call: false } });
    const session = { client: { json } } as unknown as Session;
    render(
      <SessionContext.Provider value={session}>
        <SettingsContext.Provider value={{ settings: { ...DEFAULT_SETTINGS, ringStandby }, update: async (patch) => { updates.push(patch); } }}>
          <CallAlertsSection />
        </SettingsContext.Provider>
      </SessionContext.Provider>,
    );
    return { calls, updates, STANDBY_LABEL, HINT_ACTION_LABELS };
  }

  it('开关缺省勾着;小米 + 没豁免电池优化:两句各带一颗键,点了去对的地方', async () => {
    const m = await mount({ notifications: true, fullScreen: true, standby: true, batteryUnrestricted: false, vendor: 'xiaomi' });
    const box = await screen.findByLabelText(m.STANDBY_LABEL) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: m.HINT_ACTION_LABELS.battery }));
    fireEvent.click(screen.getByRole('button', { name: m.HINT_ACTION_LABELS.vendor }));
    await waitFor(() => expect(m.calls).toEqual(['battery', 'vendor']));
  });

  it('关掉:存进设置、原生收掉', async () => {
    const m = await mount({ notifications: true, fullScreen: true, standby: true, batteryUnrestricted: true });
    fireEvent.click(await screen.findByLabelText(m.STANDBY_LABEL));
    await waitFor(() => expect(m.updates).toEqual([{ ringStandby: false }]));
    await waitFor(() => expect(m.calls).toContain('standby:false'));
  });

  it('没有原生插件(浏览器里):开关不出,不装作能待机', async () => {
    const { STANDBY_LABEL } = await import('../src/settings/DeskPhoneSection');
    const { CallAlertsSection } = await import('../src/settings/DeskPhoneSection');
    native.impl = null;
    const session = { client: { json: async () => ({ ok: false, error: 'x' }) } } as unknown as Session;
    render(<SessionContext.Provider value={session}><CallAlertsSection /></SessionContext.Provider>);
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByLabelText(STANDBY_LABEL)).toBeNull();
  });
});

describe('④ 原生源码的契约', () => {
  const root = resolve(__dirname, '../android/app/src/main');
  const manifest = readFileSync(resolve(root, 'AndroidManifest.xml'), 'utf8');
  const plugin = readFileSync(resolve(root, 'java/ai/ben/butler/DeskPhonePlugin.java'), 'utf8');
  const service = readFileSync(resolve(root, 'java/ai/ben/butler/RingStandbyService.java'), 'utf8');

  it('清单:待机服务是 specialUse 前台服务,带上它要的几条权限', () => {
    expect(manifest).toMatch(/android:name="\.RingStandbyService"[\s\S]*?android:foregroundServiceType="specialUse"/);
    expect(manifest).toContain('android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE');
    for (const permission of ['FOREGROUND_SERVICE_SPECIAL_USE', 'WAKE_LOCK', 'REQUEST_IGNORE_BATTERY_OPTIMIZATIONS']) {
      expect(manifest).toContain(`android.permission.${permission}`);
    }
  });

  it('插件回 tone、有 setStandby;服务用 specialUse 起前台、划掉任务时如实改口', () => {
    expect(plugin).toMatch(/result\.put\("tone"/);
    expect(plugin).toContain('public void setStandby(');
    expect(service).toContain('FOREGROUND_SERVICE_TYPE_SPECIAL_USE');
    expect(service).toContain('onTaskRemoved');
  });

  it('网页那边认的 tone 值与原生写的一致', async () => {
    const { NATIVE_TONE } = await import('../src/deskphone/deskPhone');
    expect(plugin).toContain(`"${NATIVE_TONE}"`);
  });
});
