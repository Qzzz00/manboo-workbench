/**
 * 「接通了,可是一直没声音」这件事手机上要说人话(2026-09-27,卡 fix/voice-onboarding-latency)。
 *
 * 现场:全新 Air、新账号,手机进「语音引导」等了 34 秒才听见第一句,
 * 这 34 秒里屏幕上只有「通话中」—— 人不知道是自己没听见、还是手机坏了、还是该重打。
 * 所以:接通之后到点还没听见她开口,就说一句「事务官在准备第一句,稍等」;
 * 再等到 15 秒还没有,就说清可能卡在哪(电脑那头的合成 / 屋里太吵),并给下一步。
 *
 * 「听见她开口」认三样里的任一样(livekitCall.ts 都会报上来):远端音轨起声、
 * 工人推的字幕、或者她那一句进了字幕列表。
 */
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { CallOverlay } from '../src/call/CallOverlay';
import {
  CALL_NO_VOICE_MS,
  CALL_NO_VOICE_STUCK_MS,
  CALL_NO_VOICE_STUCK_TEXT,
  CALL_NO_VOICE_TEXT,
  useCall,
} from '../src/call/useCall';
import type { CallClient, CallEvents, CallResult } from '../src/call/rtcCall';
import { SessionContext, type Session } from '../src/session';
import type { CallApi } from '../src/api/call';
import { fakeChannel } from './wbchFakes';

function fakeSession(): Session {
  return {
    pairing: { token: 'T', host: 'h', port: 8791, deviceId: 'd' },
    client: {
      json: async () => ({ ok: true, status: 200, data: { ok: true, leader: 'phone' } }),
    } as unknown as Session['client'],
    direct: {} as Session['direct'],
    feed: {} as Session['feed'],
    voice: {} as Session['voice'],
    channel: fakeChannel(),
    call: {
      status: async () => ({ configured: true, checked: true }),
      channelStatus: async () => ({ configured: true, checked: true }),
      record: async () => ({ ok: true, status: 200, data: { id: 't-9' } }),
    } as unknown as CallApi,
    appearance: {} as Session['appearance'],
    settings: {} as Session['settings'],
    unpair: async () => {},
  };
}

function fakeClient(result: CallResult = { transcript: [] }) {
  let events: CallEvents | null = null;
  const client: CallClient = {
    async start(_options, on) { events = on; on.onPhase('connecting'); },
    hangup: vi.fn(async () => result),
    setMuted: vi.fn(async () => {}),
  };
  return { client, emit: (fn: (on: CallEvents) => void) => { if (events !== null) fn(events); } };
}

function Harness({ client }: { client: CallClient }) {
  const call = useCall({ active: true, createClient: () => client, tickMs: 10, onEnded: () => {}, onboarding: { resume: false } });
  return <CallOverlay call={call} />;
}

function mount(client: CallClient) {
  return render(
    <SessionContext.Provider value={fakeSession()}>
      <Harness client={client} />
    </SessionContext.Provider>,
  );
}

describe('接通了还没听见她开口', () => {
  it('到点先说一句「在准备第一句」,再等到 15 秒说清卡在哪', () => {
    vi.useFakeTimers();
    try {
      const fake = fakeClient();
      mount(fake.client);
      act(() => { fake.emit(on => on.onPhase('connected')); });
      // 刚接通:不吓人,什么都不说。
      expect(screen.queryByText(CALL_NO_VOICE_TEXT)).toBeNull();

      act(() => { vi.advanceTimersByTime(CALL_NO_VOICE_MS + 50); });
      expect(screen.getByText(CALL_NO_VOICE_TEXT)).toBeTruthy();

      act(() => { vi.advanceTimersByTime(CALL_NO_VOICE_STUCK_MS - CALL_NO_VOICE_MS + 50); });
      expect(screen.getByText(CALL_NO_VOICE_STUCK_TEXT)).toBeTruthy();
      expect(screen.queryByText(CALL_NO_VOICE_TEXT)).toBeNull();
    }
    finally { vi.useRealTimers(); }
  });

  it('她开口了(远端音轨起声)就收回那句提示,之后也不再冒出来', () => {
    vi.useFakeTimers();
    try {
      const fake = fakeClient();
      mount(fake.client);
      act(() => { fake.emit(on => on.onPhase('connected')); });
      act(() => { vi.advanceTimersByTime(CALL_NO_VOICE_MS + 50); });
      expect(screen.getByText(CALL_NO_VOICE_TEXT)).toBeTruthy();

      act(() => { fake.emit(on => on.onBotSpeaking(true)); });
      expect(screen.queryByText(CALL_NO_VOICE_TEXT)).toBeNull();

      // 她说完一句停下来,提示不许再回来(她已经证明自己出得了声)。
      act(() => { fake.emit(on => on.onBotSpeaking(false)); });
      act(() => { vi.advanceTimersByTime(CALL_NO_VOICE_STUCK_MS + 500); });
      expect(screen.queryByText(CALL_NO_VOICE_TEXT)).toBeNull();
      expect(screen.queryByText(CALL_NO_VOICE_STUCK_TEXT)).toBeNull();
    }
    finally { vi.useRealTimers(); }
  });

  it('工人推来的字幕也算「她开口了」(字幕比真声早一百来毫秒)', () => {
    vi.useFakeTimers();
    try {
      const fake = fakeClient();
      mount(fake.client);
      act(() => { fake.emit(on => on.onPhase('connected')); });
      act(() => { vi.advanceTimersByTime(CALL_NO_VOICE_MS + 50); });
      expect(screen.getByText(CALL_NO_VOICE_TEXT)).toBeTruthy();
      act(() => { fake.emit(on => on.onButlerSpeech?.()); });
      expect(screen.queryByText(CALL_NO_VOICE_TEXT)).toBeNull();
    }
    finally { vi.useRealTimers(); }
  });

  it('还在接通(没通)时不说这句 —— 那一段有它自己的超时与原话', () => {
    vi.useFakeTimers();
    try {
      const fake = fakeClient();
      mount(fake.client);
      act(() => { vi.advanceTimersByTime(CALL_NO_VOICE_STUCK_MS + 500); });
      expect(screen.queryByText(CALL_NO_VOICE_TEXT)).toBeNull();
      expect(screen.queryByText(CALL_NO_VOICE_STUCK_TEXT)).toBeNull();
    }
    finally { vi.useRealTimers(); }
  });

  it('那两句都说清了下一步,不是「出错了」三个字', () => {
    expect(CALL_NO_VOICE_TEXT).toContain('稍等');
    expect(CALL_NO_VOICE_STUCK_TEXT).toContain('电脑');
    expect(CALL_NO_VOICE_STUCK_TEXT).toContain('挂断');
  });
});
