import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../src/api/client';
import {
  ASR_DESKTOP_OFFLINE_TEXT, ASR_EMPTY_TEXT, ASR_OFFLINE_TEXT, ASR_OUTDATED_TEXT, ASR_PHONE_OFFLINE_TEXT, ASR_SERVICE_TEXT, ASR_SLOW_TEXT,
  ASR_TOO_LONG_TEXT, ASR_UNCONFIGURED_TEXT, asrFailureOf, asrOfflineText, createVoiceApi, VOICE_UNAVAILABLE_TEXT, reduceVoiceAvailability, shouldTryVoice,
} from '../src/api/voice';

const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
function client(fetchImpl: typeof fetch) {
  return createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
}

describe('语音接口走 /butler/proxy/api/*', () => {
  it('tts:POST { text, avatarId? } → 音频 blob', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([9]), { status: 200, headers: { 'content-type': 'audio/mpeg' } }));
    const voice = createVoiceApi(client(fetchImpl));
    const r = await voice.tts('你好', 'ava-1');
    expect(r.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://h:8791/butler/proxy/api/tts');
    expect(JSON.parse(String(init.body))).toEqual({ text: '你好', avatarId: 'ava-1' });
  });
  // 2026-09-25(卡 S):录音原样以字节上路(butler-server 本来就收裸 WAV),不再转 base64 —— 少三分之一的字节。
  it('asr:一段 16k WAV 原样 POST(content-type audio/wav),回 { text }', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ text: ' 把版本号补上 ' }), { status: 200 }));
    const voice = createVoiceApi(client(fetchImpl));
    const wav = new Blob([new Uint8Array([82, 73, 70, 70])], { type: 'audio/wav' });
    const r = await voice.asr(wav);
    expect(r).toEqual({ ok: true, text: '把版本号补上' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://h:8791/butler/proxy/api/asr');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(wav);
    expect(new Headers(init.headers).get('content-type')).toBe('audio/wav');
  });
  it('asr:没带类型的 Blob 也按 audio/wav 发', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ text: '好' }), { status: 200 }));
    await createVoiceApi(client(fetchImpl)).asr(new Blob([new Uint8Array([1, 2])]));
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.body as Blob).type).toBe('audio/wav');
    expect(new Headers(init.headers).get('content-type')).toBe('audio/wav');
  });
  it('asr 回空文本 → ok:false,说没听清,不当成一句话发出去', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ text: '' }), { status: 200 }));
    const r = await createVoiceApi(client(fetchImpl)).asr(new Blob([new Uint8Array([1])]));
    expect(r).toEqual({ ok: false, kind: 'empty', error: '没听清,再说一遍?' });
  });
  it('识别服务说「没听清」(422 empty_transcript)→ 也归成 empty,和空文本同一句话', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ code: 'empty_transcript', error: '没听清,请再说一遍' }), { status: 422 }));
    const r = await createVoiceApi(client(fetchImpl)).asr(new Blob([new Uint8Array([1])]));
    expect(r).toEqual({ ok: false, kind: 'empty', error: ASR_EMPTY_TEXT });
  });
  it('503 → unavailable,文案「本机没有配语音」', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'no tts provider' }), { status: 503 }));
    const r = await createVoiceApi(client(fetchImpl)).tts('x');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('unavailable');
    }
  });
  it('avatars:接受 { avatars: [...] } 与裸数组两种形状;只留 published(没有 status 字段的视为已发布)', async () => {
    const list = [{ id: 'a', name: 'A', status: 'draft' }, { id: 'b', name: 'B', status: 'published' }, { id: 'c', name: 'C' }];
    const wrapped = vi.fn(async () => new Response(JSON.stringify({ avatars: list }), { status: 200 }));
    const bare = vi.fn(async () => new Response(JSON.stringify(list), { status: 200 }));
    const a = await createVoiceApi(client(wrapped)).listAvatars();
    const b = await createVoiceApi(client(bare)).listAvatars();
    expect(a.ok && a.avatars.map((x) => x.id)).toEqual(['b', 'c']);
    expect(b.ok && b.avatars.map((x) => x.id)).toEqual(['b', 'c']);
  });
  it('bundle:GET .../avatars/:id/bundle.zip 拿 blob', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([80, 75]), { status: 200, headers: { 'content-type': 'application/zip' } }));
    const r = await createVoiceApi(client(fetchImpl)).fetchBundle('ava 1');
    expect(r.ok).toBe(true);
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('http://h:8791/butler/proxy/api/avatars/ava%201/bundle.zip');
  });
});

describe('语音可用性归纳', () => {
  it('503 → 不可用并说明;网络错 → 保持原判断(掉线不等于没配);成功 → 可用', () => {
    expect(reduceVoiceAvailability('unknown', { ok: false, status: 503, kind: 'unavailable', error: 'x' }))
      .toEqual({ available: false, note: VOICE_UNAVAILABLE_TEXT, since: expect.any(Number) });
    expect(reduceVoiceAvailability('unknown', { ok: false, status: 0, kind: 'network', error: 'x' })).toBe('unknown');
    expect(reduceVoiceAvailability('unknown', { ok: true, status: 200, data: 1 })).toEqual({ available: true });
    expect(reduceVoiceAvailability({ available: true }, { ok: false, status: 0, kind: 'network', error: 'x' })).toEqual({ available: true });
  });
  it('404(工作台没接本机后端)也算不可用,文案照旧', () => {
    expect(reduceVoiceAvailability('unknown', { ok: false, status: 404, kind: 'http', error: '本机后端未接线' }))
      .toEqual({ available: false, note: VOICE_UNAVAILABLE_TEXT, since: expect.any(Number) });
  });
});

describe('语音可用性:503/404 之后过 60 秒再探一次', () => {
  it('reduceVoiceAvailability 记下判定时刻;shouldTryVoice 到点才再试;没判过 / 可用总是试', () => {
    const off = reduceVoiceAvailability('unknown', { ok: false, status: 503, kind: 'unavailable', error: 'x' }, 1000);
    expect(off).toEqual({ available: false, note: VOICE_UNAVAILABLE_TEXT, since: 1000 });
    expect(shouldTryVoice(off, 1000 + 59_000)).toBe(false);
    expect(shouldTryVoice(off, 1000 + 60_000)).toBe(true);
    expect(shouldTryVoice(off, 1000 + 10, 10)).toBe(true);
    expect(shouldTryVoice('unknown', 0)).toBe(true);
    expect(shouldTryVoice({ available: true }, 0)).toBe(true);
    // 老形状(没有 since)也当到点了:宁可多探一次。
    expect(shouldTryVoice({ available: false, note: 'x' }, 0)).toBe(true);
    // 掉线不改判断。
    expect(reduceVoiceAvailability(off, { ok: false, status: 0, kind: 'network', error: 'x' }, 5000)).toBe(off);
  });
});

/**
 * 按住说话识别没成时说哪句(2026-09-25,卡 S「手机在哪都能用」)。
 *
 * 09-24 那一版在外面只会说「不在同一个网络,这会儿转不了文字」—— 那是借口,不是原因:出了局域网本来就该能转。
 * 现在房间那条路通了(录音经 wb.asr 交给电脑上的识别),没成只剩几种真原因,**两条路同一套说法**,按 HTTP status 分,
 * 每一句都带一个能做的下一步。「不在同一个网络」这几个字再也不出现。
 */
describe('识别没成:说真实原因,给下一步', () => {
  const fail = (status: number, kind: 'network' | 'unavailable' | 'http' | 'unauthorized' = 'http', error = '原话') => ({ ok: false as const, status, kind, error });

  it('四种主要的:电脑不在线(连不上)/ 没听清 / 识别服务出错 / 等太久', () => {
    expect(asrFailureOf(fail(0, 'network'))).toEqual({ ok: false, kind: 'network', error: ASR_OFFLINE_TEXT });
    expect(asrFailureOf(fail(422))).toEqual({ ok: false, kind: 'empty', error: ASR_EMPTY_TEXT });
    expect(asrFailureOf(fail(502))).toEqual({ ok: false, kind: 'http', error: ASR_SERVICE_TEXT });
    expect(asrFailureOf(fail(500))).toEqual({ ok: false, kind: 'http', error: ASR_SERVICE_TEXT });
    expect(asrFailureOf(fail(504))).toEqual({ ok: false, kind: 'slow', error: ASR_SLOW_TEXT });
    expect(asrFailureOf(fail(408))).toEqual({ ok: false, kind: 'slow', error: ASR_SLOW_TEXT });
  });

  it('少见但真会有的:没配(503/404)、太长(413)、电脑上的事务官太旧(501)、不认这台手机(401/403 原话带出路)', () => {
    expect(asrFailureOf(fail(503, 'unavailable'))).toEqual({ ok: false, kind: 'unavailable', error: ASR_UNCONFIGURED_TEXT });
    expect(asrFailureOf(fail(404))).toEqual({ ok: false, kind: 'unavailable', error: ASR_UNCONFIGURED_TEXT });
    expect(asrFailureOf(fail(413))).toEqual({ ok: false, kind: 'too_long', error: ASR_TOO_LONG_TEXT });
    expect(asrFailureOf(fail(501))).toEqual({ ok: false, kind: 'outdated', error: ASR_OUTDATED_TEXT });
    expect(asrFailureOf(fail(403, 'unavailable', '到「设置」里退出登录,再扫码重新配对'))).toEqual({ ok: false, kind: 'unauthorized', error: '到「设置」里退出登录,再扫码重新配对' });
  });

  it('每一句都是人话,都给下一步;不出现「不在同一个网络」、路径、状态码', () => {
    const all = [ASR_OFFLINE_TEXT, ASR_DESKTOP_OFFLINE_TEXT, ASR_PHONE_OFFLINE_TEXT, ASR_EMPTY_TEXT, ASR_SERVICE_TEXT, ASR_SLOW_TEXT, ASR_UNCONFIGURED_TEXT, ASR_TOO_LONG_TEXT, ASR_OUTDATED_TEXT];
    for (const text of all) {
      // 不懂技术的人读:不出现这些词(维护者 09-25:从非专业用户第一次使用的角度想)。
      expect(text).not.toMatch(/同一个网络|局域网|\/|\d{3}|白名单|base64|识别服务|钥匙|版本号|代理|房间|工人|她/);
      expect(text).toMatch(/再|先|分两段|更新|让电脑|连上网/);
    }
  });

  it('「连不上」按此刻知道的说细一点:手机没网 / 电脑不在房里 / 中转不认这台手机(原话) / 说不清就不猜', () => {
    expect(asrOfflineText({ online: false, presence: { kind: 'absent' } })).toBe(ASR_PHONE_OFFLINE_TEXT);
    expect(asrOfflineText({ online: true, presence: { kind: 'absent' } })).toBe(ASR_DESKTOP_OFFLINE_TEXT);
    expect(asrOfflineText({ presence: { kind: 'revoked', error: '这台手机已经从账号里移除了:重新扫码配对' } })).toBe('这台手机已经从账号里移除了:重新扫码配对');
    expect(asrOfflineText({ online: true, presence: { kind: 'unknown' } })).toBe(ASR_OFFLINE_TEXT);
    expect(asrOfflineText()).toBe(ASR_OFFLINE_TEXT);
  });

  it('createVoiceApi 用调用方给的那句「连不上」', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const voice = createVoiceApi(client(fetchImpl as unknown as typeof fetch), { offlineText: () => ASR_DESKTOP_OFFLINE_TEXT });
    await expect(voice.asr(new Blob([new Uint8Array([1])], { type: 'audio/wav' }))).resolves.toEqual({ ok: false, kind: 'network', error: ASR_DESKTOP_OFFLINE_TEXT });
  });

  it('服务端回 503(电脑上没配):说没配好,先打字;回 502:识别服务出错', async () => {
    const r503 = await createVoiceApi(client(vi.fn(async () => new Response(JSON.stringify({ code: 'voice_not_configured', error: '未配置语音供应商密钥' }), { status: 503 })))).asr(new Blob([new Uint8Array([1])]));
    expect(r503).toEqual({ ok: false, kind: 'unavailable', error: ASR_UNCONFIGURED_TEXT });
    const r502 = await createVoiceApi(client(vi.fn(async () => new Response(JSON.stringify({ code: 'asr_failed', error: '语音识别失败,请稍后再试' }), { status: 502 })))).asr(new Blob([new Uint8Array([1])]));
    expect(r502).toEqual({ ok: false, kind: 'http', error: ASR_SERVICE_TEXT });
  });
});
