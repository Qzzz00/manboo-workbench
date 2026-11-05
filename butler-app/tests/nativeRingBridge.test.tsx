/**
 * 原生收铃(2026-10-20,卡 E)的接线:网页那几件包装、useIncoming 按来电 id 停铃、熄屏时经 useIncoming 交给原生。
 * 交接本身的先后在 tests/nativeRing.test.ts;这里只看线接对了没有。
 */
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useIncoming } from '../src/call/useIncoming';
import { SessionContext, type Session } from '../src/session';
import { createWbchRoomLink, type WbchLivekitSdk, type WbchRoomLink } from '../src/channel/roomLink';
import { WBCH_WORKER_IDENTITY } from '../src/channel/channelProtocol';
import type { WbchCredential } from '../src/channel/credentialStore';
import type { ApiClient } from '../src/api/client';
import { RING_HANDOFF_GRACE_MS } from '../src/call/ringHandoff';
import { createFakeLink, fakeChannel, fakeRouted } from './wbchFakes';

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

afterEach(() => { native.impl = null; cleanup(); vi.useRealTimers(); });

const CREDENTIAL: WbchCredential = {
  url: 'wss://lk.test', room: 'acct-1', identity: 'wb-phone-dev1', token: 'jwt-1', expires_at: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
};

describe('① 网页那几件包装', () => {
  it('停铃带 id 就只带那一通过桥;不带照旧全停', async () => {
    const { stopRinging } = await import('../src/deskphone/deskPhone');
    const calls: unknown[] = [];
    native.impl = { stopRinging: async (input) => { calls.push(input); } };
    await stopRinging('c1');
    await stopRinging();
    expect(calls).toEqual([{ callId: 'c1' }, undefined]);
  });

  it('原生听铃:凭证原样过桥;原生回 on 才算交上;老包如实说做不到', async () => {
    const { listenNativeRing, unlistenNativeRing, NATIVE_RING_ABSENT_TEXT } = await import('../src/deskphone/deskPhone');
    const got: unknown[] = [];
    native.impl = {
      listenRing: async (input) => { got.push(input); return { on: true }; },
      unlistenRing: async () => { got.push('off'); },
    };
    expect(await listenNativeRing(CREDENTIAL)).toEqual({ ok: true });
    await unlistenNativeRing();
    expect(got).toEqual([{ url: CREDENTIAL.url, room: CREDENTIAL.room, identity: CREDENTIAL.identity, token: CREDENTIAL.token, expires_at: CREDENTIAL.expires_at }, 'off']);
    native.impl = { listenRing: async () => ({ on: false, note: '后台待机没在跑' }) };
    expect(await listenNativeRing(CREDENTIAL)).toEqual({ ok: false, note: '后台待机没在跑' });
    native.impl = null;
    expect(await listenNativeRing(CREDENTIAL)).toEqual({ ok: false, note: NATIVE_RING_ABSENT_TEXT });
  });
});

function harness(link: WbchRoomLink = createFakeLink()) {
  const listeners: ((message: unknown) => void)[] = [];
  const channel = fakeChannel({
    link,
    credential: () => CREDENTIAL,
    onRing: (listener) => { listeners.push(listener as (message: unknown) => void); return () => {}; },
    answerCall: async () => ({ ok: true as const }),
    laterCall: async () => ({ ok: true as const }),
  });
  const json = async () => ({ ok: true as const, status: 200, data: { entries: [], missed: 0 } });
  const client = fakeRouted({ baseUrl: 'http://x', json, blob: async () => ({ ok: false, status: 0, kind: 'network', error: '' }) } as unknown as ApiClient);
  const session = { channel, client } as unknown as Session;
  const stops: (string | undefined)[] = [];
  const nativeLog: string[] = [];
  let handle: ReturnType<typeof useIncoming> | null = null;
  function Probe() {
    handle = useIncoming(session, {
      setStandby: async () => ({ ok: true }),
      askNotify: async () => true,
      makeRingtone: () => ({ start: async () => ({ ok: true }), stop: () => {}, dispose: () => {} }),
      ring: async () => ({ ok: true, fullScreen: true, tone: 'native' }),
      stopRing: async (callId) => { stops.push(callId); },
      nativeRing: {
        listen: async () => { nativeLog.push('listen'); return { ok: true }; },
        unlisten: async () => { nativeLog.push('unlisten'); },
      },
      handoffTickMs: 20,
    });
    return null;
  }
  render(<SessionContext.Provider value={session}><Probe /></SessionContext.Provider>);
  return {
    push: (message: unknown) => act(() => { for (const l of listeners) l(message); }),
    stops,
    nativeLog,
    handle: () => handle!,
  };
}

const RING = { type: 'ring', call_id: 'c1', reason: 'confirm', item_id: 'i1', title: '改首页文案', silent: false, until: Date.now() + 60_000 };

describe('①b 交之前问一句、交出去之后回查(核查 E1 / E2)', () => {
  it('做不做得到看待机服务在不在跑;原生此刻的状态原样回', async () => {
    const { nativeRingReady, nativeRingState, NATIVE_RING_NOT_RUNNING_TEXT, NATIVE_RING_ABSENT_TEXT } = await import('../src/deskphone/deskPhone');
    native.impl = { status: async () => ({ standby: true, nativeRing: 'listening' }) };
    expect(await nativeRingReady()).toEqual({ ok: true });
    expect(await nativeRingState()).toEqual({ state: 'listening' });
    native.impl = { status: async () => ({ standby: false, nativeRing: 'failed', nativeRingNote: '凭证到期' }) };
    expect(await nativeRingReady()).toEqual({ ok: false, note: NATIVE_RING_NOT_RUNNING_TEXT });
    expect(await nativeRingState()).toEqual({ state: 'failed', note: '凭证到期' });
    // 老包:status 里没有 nativeRing 这一格 —— 回 null(不回查),而不是编一个 off 把房间收回来又交出去。
    native.impl = { status: async () => ({ standby: true }) };
    expect(await nativeRingState()).toBeNull();
    native.impl = null;
    expect(await nativeRingReady()).toEqual({ ok: false, note: NATIVE_RING_ABSENT_TEXT });
    expect(await nativeRingState()).toBeNull();
  });
});

describe('② useIncoming 按来电 id 停铃', () => {
  it('★ 刚挂上(idle)不去全停:原生可能正响着它自己收到的那一通', async () => {
    const h = harness();
    await new Promise((r) => setTimeout(r, 30));
    expect(h.stops).toEqual([]);
  });

  it('接起 / 稍后:停的是这一通', async () => {
    const h = harness();
    h.push(RING);
    await waitFor(() => expect(h.handle().state.kind).toBe('ringing'));
    await act(async () => { await h.handle().answer(); });
    expect(h.stops.length).toBeGreaterThan(0);
    expect(h.stops.every((id) => id === 'c1')).toBe(true);
  });

  it('工人说这一通收场了(ring_end):停的也是这一通', async () => {
    const h = harness();
    h.push(RING);
    await waitFor(() => expect(h.handle().state.kind).toBe('ringing'));
    h.push({ type: 'ring_end', call_id: 'c1', outcome: 'missed' });
    await waitFor(() => expect(h.stops).toContain('c1'));
    expect(h.stops).not.toContain(undefined);
  });
});

describe('③ 熄屏够久:经 useIncoming 交给原生,亮屏收回', () => {
  it('真的房间那一层停靠了,原生收到 listen;亮屏回来先 unlisten 再进房', async () => {
    const rooms: { connects: number }[] = [];
    const sdk: WbchLivekitSdk = {
      Room: (function FakeRoom(this: unknown) {
        const room = {
          connects: 0,
          remoteParticipants: new Map<string, unknown>([[WBCH_WORKER_IDENTITY, {}]]),
          localParticipant: { identity: CREDENTIAL.identity, sendText: async () => {} },
          on() { return room; },
          async connect() { room.connects += 1; },
          async disconnect() {},
        };
        rooms.push(room);
        return room as never;
      }) as never,
      RoomEvent: {},
    };
    const link = createWbchRoomLink({ loadSdk: async () => sdk, attachAudio: () => {}, detachAudio: () => {} });
    await link.acquire('ring', CREDENTIAL);
    let visibility: DocumentVisibilityState = 'visible';
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const realNow = Date.now;
    let offset = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    try {
      const h = harness(link);
      await waitFor(() => expect(h.nativeLog).toEqual(['unlisten']));
      visibility = 'hidden';
      act(() => { document.dispatchEvent(new Event('visibilitychange')); });
      offset = RING_HANDOFF_GRACE_MS + 1;
      await waitFor(() => expect(h.nativeLog).toEqual(['unlisten', 'listen']));
      expect(link.parked!()).toBe(true);
      visibility = 'visible';
      act(() => { document.dispatchEvent(new Event('visibilitychange')); });
      await waitFor(() => expect(link.parked!()).toBe(false));
      expect(h.nativeLog).toEqual(['unlisten', 'listen', 'unlisten']);
      expect(link.state()).toBe('connected');
    } finally {
      spy.mockRestore();
      nowSpy.mockRestore();
    }
  });
});

describe('④ 原生那一套的契约(读源头文件比对)', () => {
  const dir = resolve(__dirname, '../android/app/src/main/java/ai/ben/butler');
  const ringer = readFileSync(resolve(dir, 'Ringer.kt'), 'utf8');
  const plugin = readFileSync(resolve(dir, 'DeskPhonePlugin.java'), 'utf8');

  it('震动节奏与网页那条退路同一份', async () => {
    const { RING_VIBRATE_PATTERN } = await import('../src/deskphone/deskPhone');
    expect(ringer).toContain(`longArrayOf(${RING_VIBRATE_PATTERN.join(', ')})`);
  });

  it('E4 ★ LiveKit SDK 自带的屏幕捕获(权限 + 服务)在清单里摘掉:我们只听铃,不录屏', () => {
    const manifest = readFileSync(resolve(dir, '../../../../AndroidManifest.xml'), 'utf8');
    expect(manifest).toContain('xmlns:tools="http://schemas.android.com/tools"');
    expect(manifest).toMatch(/android\.permission\.FOREGROUND_SERVICE_MEDIA_PROJECTION"\s+tools:node="remove"/);
    expect(manifest).toMatch(/io\.livekit\.android\.room\.track\.screencapture\.ScreenCaptureService"\s+tools:node="remove"/);
  });

  it('插件有 listenRing / unlistenRing,停铃认 callId', () => {
    expect(plugin).toContain('public void listenRing(PluginCall');
    expect(plugin).toContain('public void unlistenRing(PluginCall');
    expect(plugin).toMatch(/stopRinging[\s\S]*?getString\("callId"/);
  });
});
