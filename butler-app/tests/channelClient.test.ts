import { describe, expect, it, vi } from 'vitest';
import { WBCH_ASR_OUTDATED_TEXT, WBCH_ASR_SLOW_TEXT, WBCH_BLOB_UNSUPPORTED_TEXT, createWbchChannelClient } from '../src/channel/channelClient';
import { WBCH_ASR_ID_ATTRIBUTE, WBCH_ASR_TOPIC, WBCH_MEETING_ID_ATTRIBUTE, WBCH_MEETING_TOPIC, WBCH_RPC_TOPIC, WBCH_WORKER_IDENTITY } from '../src/channel/channelProtocol';
import { lanOnlyReason } from '../src/channel/remoteParity';
import { WBCH_RPC_NOT_PAIRED_TEXT, WBCH_WORKER_NOT_PAIRED_TEXT, createWbchRpc } from '../src/channel/rpc';
import { createFakeLink, lastSent } from './wbchFakes';

function wire(onUnauthorized = () => {}) {
  const link = createFakeLink();
  let n = 0;
  const rpc = createWbchRpc({ link, newId: () => `id-${++n}`, timeoutMs: 50 });
  return { link, client: createWbchChannelClient({ rpc, onUnauthorized }) };
}

describe('房间那条路的 ApiClient:和直连同一套口径', () => {
  it('200 → ok,body 原样当 data', async () => {
    const { link, client } = wire();
    const promise = client.json<{ tasks: unknown[] }>('/state');
    link.deliver({ id: 'id-1', type: 'http', status: 200, body: { tasks: [] } });
    await expect(promise).resolves.toEqual({ ok: true, status: 200, data: { tasks: [] } });
  });

  it('POST 的 body 与 method 照发', async () => {
    const { link, client } = wire();
    void client.json('/butler/item', { method: 'POST', body: { text: '订会议室' } });
    expect(lastSent(link)).toMatchObject({ method: 'POST', path: '/butler/item', body: { text: '订会议室' } });
  });

  it('401 → unauthorized,并且只喊一次回配对页', async () => {
    const onUnauthorized = vi.fn();
    const { link, client } = wire(onUnauthorized);
    const a = client.json('/state');
    link.deliver({ id: 'id-1', type: 'http', status: 401, body: { error: '设备令牌已失效' } });
    await expect(a).resolves.toEqual({ ok: false, status: 401, kind: 'unauthorized', error: '设备令牌已失效' });
    const b = client.json('/state');
    link.deliver({ id: 'id-2', type: 'http', status: 401, body: {} });
    await b;
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('503 → unavailable,原话转达', async () => {
    const { link, client } = wire();
    const promise = client.json('/butler/proxy/api/tts');
    link.deliver({ id: 'id-1', type: 'http', status: 503, body: { error: '本机没配语音' } });
    await expect(promise).resolves.toEqual({ ok: false, status: 503, kind: 'unavailable', error: '本机没配语音' });
  });

  it('别的状态码 → http;服务端没给话时自己拼一句带状态码的', async () => {
    const { link, client } = wire();
    const promise = client.json('/butler/item/x');
    link.deliver({ id: 'id-1', type: 'http', status: 404, body: null });
    await expect(promise).resolves.toEqual({ ok: false, status: 404, kind: 'http', error: '请求失败(404)' });
  });

  it('没人答 → kind=network(界面照掉线处理,好切回直连)', async () => {
    vi.useFakeTimers();
    try {
      const { client } = wire();
      const promise = client.json('/state');
      await vi.advanceTimersByTimeAsync(60);
      const result = await promise;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.kind).toBe('network');
    } finally {
      vi.useRealTimers();
    }
  });

  // 协议里没给二进制留位置(设计 §二:大文件先不做)。做不到就说做不到,不假装成功 —— 说的是表里给他看的那一句。
  it('blob 如实说在外面取不到:说 remoteParity.ts 里那一句(在外面怎么办),不往房间里白跑', async () => {
    const { client, link } = wire();
    await expect(client.blob('/butler/proxy/api/avatars/a/bundle.zip')).resolves.toEqual({
      ok: false, status: 0, kind: 'unavailable', error: lanOnlyReason('GET', '/butler/proxy/api/avatars/a/bundle.zip'),
    });
    await expect(client.blob('/没登记的/x')).resolves.toMatchObject({ error: WBCH_BLOB_UNSUPPORTED_TEXT });
    expect(link.sent).toEqual([]);
  });

  it('body 是 Blob 的请求(识别以外)也走不了这条路', async () => {
    const { client } = wire();
    const result = await client.json('/x', { method: 'POST', body: new Blob(['x']) });
    expect(result).toEqual({ ok: false, status: 0, kind: 'unavailable', error: WBCH_BLOB_UNSUPPORTED_TEXT });
  });

  // 2026-09-25(卡 S):声明了只在局域网的那几条,当场说那句给人看的话,不发、不露「白名单」。
  it('只在局域网的那几条:当场回表里那句,一条都不往房间里发', async () => {
    const { client, link } = wire();
    const result = await client.json('/feed/run', { method: 'POST' });
    expect(result).toEqual({ ok: false, status: 0, kind: 'unavailable', error: lanOnlyReason('POST', '/feed/run') });
    expect(result.ok ? '' : result.error).not.toMatch(/白名单|\//);
    expect(link.sent).toEqual([]);
  });

  it('工人白名单不放(403,原话带「白名单」):换成一句他看得懂的,不露原话', async () => {
    const { link, client } = wire();
    const promise = client.json('/questions/answer', { method: 'POST', body: { id: 'q' } });
    link.deliver({ id: 'id-1', type: 'http', status: 403, body: { error: 'POST /questions/answer 不在房间代理的白名单里' } });
    const result = await promise;
    expect(result).toEqual({ ok: false, status: 403, kind: 'unavailable', error: WBCH_BLOB_UNSUPPORTED_TEXT });
    expect(result.ok ? '' : result.error).not.toMatch(/白名单|\//);
  });

  it('工人说「不认这台手机」(403):换成能照着做的那句', async () => {
    const { link, client } = wire();
    const promise = client.json('/state');
    link.deliver({ id: 'id-1', type: 'http', status: 403, body: { error: WBCH_WORKER_NOT_PAIRED_TEXT } });
    await expect(promise).resolves.toEqual({ ok: false, status: 403, kind: 'unavailable', error: WBCH_RPC_NOT_PAIRED_TEXT });
  });
});

/**
 * 出了局域网也能按住说话(2026-09-25,卡 S)。`POST /butler/proxy/api/asr` 带着一段 WAV 来:
 * `wb.rpc` 上一条 `{id, type:'asr'}`(只发工人)+ `wb.asr` 字节流(只发工人,属性带同一个 id);
 * 回包与直连同形状(status + body),房间那一侧的几种没办成折成 status。
 */
describe('房间那条路 · 识别', () => {
  const wav = () => new Blob([new Uint8Array([82, 73, 70, 70, 1, 2, 3])], { type: 'audio/wav' });

  it('一行宣告 + 一条字节流,都只发工人;编号对得上;回包原样', async () => {
    const { link, client } = wire();
    const promise = client.json<{ text: string }>('/butler/proxy/api/asr', { method: 'POST', body: wav(), headers: { 'content-type': 'audio/wav' } });
    await vi.waitFor(() => expect(link.bytes).toHaveLength(1), { timeout: 5000 });
    expect(lastSent(link)).toEqual({ id: 'id-1', type: 'asr' });
    expect(link.sent[0]).toMatchObject({ topic: WBCH_RPC_TOPIC, to: WBCH_WORKER_IDENTITY });
    expect(link.bytes[0]).toMatchObject({ topic: WBCH_ASR_TOPIC, to: WBCH_WORKER_IDENTITY, mimeType: 'audio/wav', attributes: { [WBCH_ASR_ID_ATTRIBUTE]: 'id-1' } });
    expect([...link.bytes[0]!.data]).toEqual([82, 73, 70, 70, 1, 2, 3]);
    link.deliver({ id: 'id-1', type: 'http', status: 200, body: { text: '明天九点开会' } });
    await expect(promise).resolves.toEqual({ ok: true, status: 200, data: { text: '明天九点开会' } });
  });

  it('电脑上的识别回的状态原样带回(422 没听清 / 503 没配 / 413 太长)', async () => {
    for (const [status, body] of [[422, { error: '没听清,请再说一遍' }], [503, { error: '未配置语音供应商密钥' }], [413, { code: 'audio_too_long', error: '超过 20 秒' }]] as const) {
      const { link, client } = wire();
      const promise = client.json('/butler/proxy/api/asr', { method: 'POST', body: wav() });
      await vi.waitFor(() => expect(link.sent).toHaveLength(1), { timeout: 5000 });
      link.deliver({ id: 'id-1', type: 'http', status, body });
      await expect(promise).resolves.toMatchObject({ ok: false, status });
    }
  });

  it('等到上限没回:504(voice.ts 说「等太久」),不是「连不上」—— 模式留在远程', async () => {
    vi.useFakeTimers();
    try {
      const link = createFakeLink();
      const rpc = createWbchRpc({ link, newId: () => 'a1', asrTimeoutMs: 100 });
      const client = createWbchChannelClient({ rpc, onUnauthorized: () => {} });
      const promise = client.json('/butler/proxy/api/asr', { method: 'POST', body: wav() });
      await vi.advanceTimersByTimeAsync(150);
      await expect(promise).resolves.toEqual({ ok: false, status: 504, kind: 'http', error: WBCH_ASR_SLOW_TEXT });
    } finally {
      vi.useRealTimers();
    }
  });

  it('老工人不认这种请求:501(voice.ts 说「电脑上的事务官要更新」),当场收场不干等', async () => {
    const { link, client } = wire();
    const promise = client.json('/butler/proxy/api/asr', { method: 'POST', body: wav() });
    await vi.waitFor(() => expect(link.sent).toHaveLength(1), { timeout: 5000 });
    link.deliver({ id: 'id-1', type: 'error', error: '不认识这种请求:asr' });
    await expect(promise).resolves.toEqual({ ok: false, status: 501, kind: 'http', error: WBCH_ASR_OUTDATED_TEXT });
  });

  it('房间断了:network(两条路都不通时 voice.ts 说「连不上」那一句)', async () => {
    const { link, client } = wire();
    link.setState('connected');
    const promise = client.json('/butler/proxy/api/asr', { method: 'POST', body: wav() });
    await vi.waitFor(() => expect(link.sent).toHaveLength(1), { timeout: 5000 });
    link.setState('closed');
    await expect(promise).resolves.toMatchObject({ ok: false, status: 0, kind: 'network' });
  });

  it('发不出去(sendBytes 抛):当场收场,不等 35 秒', async () => {
    const { link, client } = wire();
    link.sendBytes = async () => { throw new Error('还没进房'); };
    await expect(client.json('/butler/proxy/api/asr', { method: 'POST', body: wav() })).resolves.toEqual({ ok: false, status: 0, kind: 'network', error: '还没进房' });
  });
});

/**
 * 出了局域网的会议分段(2026-10-09,卡「会后真机走通」)。`POST /meeting/segment?id&seq&ms` 带着一段 m4a 来:
 * `wb.rpc` 上一条 `{id, type:'meeting_segment', meeting_id, seq, ms}`(只发工人)+ `wb.meeting` 字节流(只发工人,
 * 属性带同一个 id);回包与直连同形状。**这条只在她这一场点过「经服务器传」时才被调**(meetingApi.ts 管)。
 */
describe('房间那条路 · 会议分段', () => {
  const m4a = () => new Blob([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], { type: 'audio/mp4' });

  it('一行宣告 + 一条字节流,都只发工人;哪一场、第几段、多长都带上;回包原样', async () => {
    const { link, client } = wire();
    const promise = client.json('/meeting/segment?id=m%201&seq=3&ms=600000', { method: 'POST', body: m4a(), headers: { 'content-type': 'audio/mp4' } });
    await vi.waitFor(() => expect(link.bytes).toHaveLength(1), { timeout: 5000 });
    expect(lastSent(link)).toEqual({ id: 'id-1', type: 'meeting_segment', meeting_id: 'm 1', seq: 3, ms: 600000 });
    expect(link.sent[0]).toMatchObject({ topic: WBCH_RPC_TOPIC, to: WBCH_WORKER_IDENTITY });
    expect(link.bytes[0]).toMatchObject({ topic: WBCH_MEETING_TOPIC, to: WBCH_WORKER_IDENTITY, mimeType: 'audio/mp4', attributes: { [WBCH_MEETING_ID_ATTRIBUTE]: 'id-1' } });
    link.deliver({ id: 'id-1', type: 'http', status: 200, body: { ok: true } });
    await expect(promise).resolves.toEqual({ ok: true, status: 200, data: { ok: true } });
  });

  it('老工人不认这种请求:501 + 「电脑上的事务官要更新」,当场收场', async () => {
    const { link, client } = wire();
    const promise = client.json('/meeting/segment?id=m1&seq=1', { method: 'POST', body: m4a() });
    await vi.waitFor(() => expect(link.sent).toHaveLength(1), { timeout: 5000 });
    link.deliver({ id: 'id-1', type: 'error', error: '不认识这种请求:meeting_segment' });
    await expect(promise).resolves.toMatchObject({ ok: false, status: 501, kind: 'http' });
  });

  it('没带哪一场 / 段号:当场 400,不往房里发', async () => {
    const { link, client } = wire();
    await expect(client.json('/meeting/segment?seq=1', { method: 'POST', body: m4a() })).resolves.toMatchObject({ ok: false, status: 400 });
    expect(link.sent).toHaveLength(0);
  });
});
