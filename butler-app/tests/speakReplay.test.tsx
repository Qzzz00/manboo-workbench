/**
 * 「重听」没念成要说为什么(2026-09-25,卡 S「手机在哪都能用」)。
 *
 * 在外面朗读回复还不走房间(远程对等表里声明了只在跟电脑连同一个 Wi-Fi 时有)。自动朗读新回复时不念就不念、不打扰;
 * 可他自己点了 🔊「重听」却什么都没发生,那一下就像没按着 —— 那时要把表里那句话摆出来。
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../src/api/client';
import { VOICE_UNAVAILABLE_TEXT } from '../src/api/voice';
import { useSpeak } from '../src/chat/useSpeak';
import { lanOnlyReason } from '../src/channel/remoteParity';
import type { Session } from '../src/session';

vi.mock('../src/aiboo/lipsyncPlayer', () => ({
  playAudioBlob: async (_b: Blob, _m: () => void, onEnded?: () => void) => { onEnded?.(); },
  stopSpeaking: () => {},
  isSpeaking: () => false,
}));

function sessionWith(mode: 'direct' | 'remote', tts: ApiResult<Blob>): Session {
  return { client: { mode: () => mode }, voice: { tts: async () => tts } } as unknown as Session;
}

describe('重听:没念成说一句为什么', () => {
  it('在外面:回远程对等表里那一句;不把语音判成不可用(麦克风键不灰)', async () => {
    const reason = lanOnlyReason('POST', '/butler/proxy/api/tts') ?? '';
    const session = sessionWith('remote', { ok: false, status: 0, kind: 'unavailable', error: reason });
    const { result } = renderHook(() => useSpeak(session, true, undefined, { current: 0 }));
    let why: string | undefined;
    await act(async () => { why = await result.current.speakText('t-1:好', '好'); });
    expect(why).toBe(reason);
    expect(reason).toMatch(/在外面/);
    expect(result.current.availability).toBe('unknown');
  });

  it('在家、电脑那边没开通(503):回麦克风键下面那一行;之后语音判成不可用', async () => {
    const session = sessionWith('direct', { ok: false, status: 503, kind: 'unavailable', error: '未配置语音供应商密钥' });
    const { result } = renderHook(() => useSpeak(session, true, undefined, { current: 0 }));
    let why: string | undefined;
    await act(async () => { why = await result.current.speakText('t-1:好', '好'); });
    expect(why).toBe(VOICE_UNAVAILABLE_TEXT);
    expect(result.current.availability).toMatchObject({ available: false });
    // 判成不可用之后再点:不去打接口,照样说那一句。
    await act(async () => { why = await result.current.speakText('t-2:嗯', '嗯'); });
    expect(why).toBe(VOICE_UNAVAILABLE_TEXT);
  });

  it('念成了:不说话', async () => {
    const session = sessionWith('direct', { ok: true, status: 200, data: new Blob([new Uint8Array([1])]) });
    const { result } = renderHook(() => useSpeak(session, true, undefined, { current: 0 }));
    let why: string | undefined = 'x';
    await act(async () => { why = await result.current.speakText('t-1:好', '好'); });
    expect(why).toBeUndefined();
  });
});
