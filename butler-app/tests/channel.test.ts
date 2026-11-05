import { describe, expect, it, vi } from 'vitest';
import type { ApiClient, ApiResult, RequestOptions } from '../src/api/client';
import {
  WBCH_CREDENTIAL_EXPIRED_TEXT,
  WBCH_NO_CREDENTIAL_TEXT,
  WBCH_PULL_OLD_WORKER_TEXT,
  createWbchChannel,
} from '../src/channel/channel';
import { WBCH_CREDENTIAL_KEY, createWbchCredentialStore, parseWbchCredential } from '../src/channel/credentialStore';
import { WBCH_FILE_TOPIC } from '../src/channel/channelProtocol';
import { createFakeLink, lastSent, memoryStore } from './wbchFakes';

/** 假 8791:只认 POST /channel/token。 */
function fakeDirect(answer: () => ApiResult<unknown>): ApiClient & { calls: { path: string; options: RequestOptions }[] } {
  const calls: { path: string; options: RequestOptions }[] = [];
  return {
    calls,
    baseUrl: 'http://10.0.0.9:8791',
    async json(path, options = {}) { calls.push({ path, options }); return answer() as ApiResult<never>; },
    async blob() { return { ok: false, status: 0, kind: 'network', error: 'x' }; },
  };
}

const ISSUED = {
  url: 'wss://lk.aibooo.test',
  room: 'workbench',
  identity: 'wb-phone-d1',
  token: 'jwt-1',
  expires_at: 2_000_000_000,
};

function wire(options: {
  answer?: () => ApiResult<unknown>;
  stored?: Record<string, string>;
  now?: () => number;
} = {}) {
  const direct = fakeDirect(options.answer ?? (() => ({ ok: true, status: 200, data: ISSUED })));
  const kv = memoryStore(options.stored ?? {});
  const link = createFakeLink();
  const channel = createWbchChannel({
    direct,
    store: createWbchCredentialStore(kv),
    onUnauthorized: () => {},
    link,
    name: 'Ben 的手机',
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { direct, kv, link, channel };
}

describe('凭证存取', () => {
  it('缺一个字段就当没有(地址猜错了会连到别人的服务器上去)', () => {
    expect(parseWbchCredential({ ...ISSUED, url: '' })).toBeNull();
    expect(parseWbchCredential({ ...ISSUED, token: undefined })).toBeNull();
    expect(parseWbchCredential({ ...ISSUED, expires_at: '2000000000' })).toBeNull();
    expect(parseWbchCredential('nope')).toBeNull();
    expect(parseWbchCredential(ISSUED)).toEqual(ISSUED);
  });

  it('续期回来的只有 token 与 expires_at,地址房间身份从旧的补', () => {
    expect(parseWbchCredential({ token: 'jwt-2', expires_at: 9 }, ISSUED))
      .toEqual({ ...ISSUED, token: 'jwt-2', expires_at: 9 });
  });

  it('存坏了读回 null,不抛', async () => {
    const store = createWbchCredentialStore(memoryStore({ [WBCH_CREDENTIAL_KEY]: '{半句' }));
    await expect(store.load()).resolves.toBeNull();
  });
});

describe('第二套配对:向 8791 要一张房间凭证', () => {
  it('手上没有就去要,要到了存下来', async () => {
    const { channel, direct, kv } = wire();
    await expect(channel.refresh()).resolves.toEqual({ ok: true });
    expect(direct.calls[0]?.path).toBe('/channel/token');
    expect(direct.calls[0]?.options.method).toBe('POST');
    expect(direct.calls[0]?.options.body).toEqual({ name: 'Ben 的手机' });
    expect(channel.credential()).toEqual(ISSUED);
    expect(JSON.parse(kv.map.get(WBCH_CREDENTIAL_KEY)!)).toEqual(ISSUED);
  });

  it('工作台回的东西缺字段就当没取到,不留半张凭证', async () => {
    const { channel } = wire({ answer: () => ({ ok: true, status: 200, data: { url: 'wss://x' } }) });
    await expect(channel.refresh()).resolves.toEqual({ ok: false, error: '工作台回的房间凭证缺字段,没法用' });
    expect(channel.credential()).toBeNull();
  });

  it('取不到就原样转达工作台那句话', async () => {
    const { channel } = wire({ answer: () => ({ ok: false, status: 0, kind: 'network', error: '连不上工作台' }) });
    await expect(channel.refresh()).resolves.toEqual({ ok: false, error: '连不上工作台' });
  });

  it('开机时读本地那张,不再去要', async () => {
    const { channel, direct } = wire({ stored: { [WBCH_CREDENTIAL_KEY]: JSON.stringify(ISSUED) } });
    await channel.remote();
    expect(direct.calls).toHaveLength(0);
    expect(channel.credential()).toEqual(ISSUED);
  });
});

describe('remote():给 routedClient 的那条路', () => {
  it('有凭证 → 进房 → 回一个能用的客户端', async () => {
    const { channel, link } = wire({ stored: { [WBCH_CREDENTIAL_KEY]: JSON.stringify(ISSUED) } });
    const result = await channel.remote();
    expect(result.ok).toBe(true);
    expect(link.holders.has('rpc')).toBe(true);

    if (!result.ok) throw new Error('上一条断言已经挂了');
    const promise = result.client.json('/state');
    await vi.waitFor(() => expect(link.sent.length).toBeGreaterThan(0));
    const sent = lastSent(link);
    link.deliver({ id: sent.id, type: 'http', status: 200, body: { 好: true } });
    await expect(promise).resolves.toEqual({ ok: true, status: 200, data: { 好: true } });
  });

  it('压根没有凭证、又要不到 → 说清楚回局域网连一次就有', async () => {
    const { channel } = wire({ answer: () => ({ ok: false, status: 0, kind: 'network', error: '连不上' }) });
    await expect(channel.remote()).resolves.toEqual({ ok: false, error: WBCH_NO_CREDENTIAL_TEXT });
  });

  it('存着的那张过期了、又换不到新的 → 说的是「过期」那句', async () => {
    const expired = { ...ISSUED, expires_at: 1000 };
    const { channel } = wire({
      stored: { [WBCH_CREDENTIAL_KEY]: JSON.stringify(expired) },
      answer: () => ({ ok: false, status: 0, kind: 'network', error: '连不上' }),
      now: () => 2_000_000,
    });
    await expect(channel.remote()).resolves.toEqual({ ok: false, error: WBCH_CREDENTIAL_EXPIRED_TEXT });
  });

  it('进不了房就说进不了房(带上服务器那句原话)', async () => {
    const { channel, link } = wire({ stored: { [WBCH_CREDENTIAL_KEY]: JSON.stringify(ISSUED) } });
    link.failNextAcquire('服务器不理人');
    await expect(channel.remote()).resolves.toEqual({ ok: false, error: '进不了房间:服务器不理人' });
  });
});

describe('续期', () => {
  it('在房里 → 走数据通道换一张,存回本地', async () => {
    const { channel, link, kv } = wire({ stored: { [WBCH_CREDENTIAL_KEY]: JSON.stringify(ISSUED) } });
    await channel.remote();
    const promise = channel.renewNow();
    await vi.waitFor(() => expect(link.sent.length).toBeGreaterThan(0));
    const sent = lastSent(link);
    expect(sent).toMatchObject({ type: 'renew' });
    link.deliver({ id: sent.id, type: 'token', token: 'jwt-2', expires_at: 2_000_003_600 });
    await expect(promise).resolves.toEqual({ ok: true });
    expect(channel.credential()).toEqual({ ...ISSUED, token: 'jwt-2', expires_at: 2_000_003_600 });
    expect(JSON.parse(kv.map.get(WBCH_CREDENTIAL_KEY)!).token).toBe('jwt-2');
  });

  it('不在房里 → 直接向 8791 再要一张', async () => {
    const { channel, direct } = wire({ stored: { [WBCH_CREDENTIAL_KEY]: JSON.stringify(ISSUED) } });
    await expect(channel.renewNow()).resolves.toEqual({ ok: true });
    expect(direct.calls[0]?.path).toBe('/channel/token');
  });

  it('房里续不上就退回 8791;两条都不成才算没续上', async () => {
    const { channel, link } = wire({
      stored: { [WBCH_CREDENTIAL_KEY]: JSON.stringify(ISSUED) },
      answer: () => ({ ok: false, status: 0, kind: 'network', error: '连不上工作台' }),
    });
    await channel.remote();
    const promise = channel.renewNow();
    await vi.waitFor(() => expect(link.sent.length).toBeGreaterThan(0));
    // 房间断了 → 等着的那条立刻收场 → 退回 8791 → 也不成
    link.setState('closed');
    const result = await promise;
    expect(result.ok).toBe(false);
  });

  it('没有凭证时不谈续期', async () => {
    const { channel } = wire({ answer: () => ({ ok: false, status: 0, kind: 'network', error: 'x' }) });
    await channel.remote();
    await expect(channel.renewNow()).resolves.toEqual({ ok: false, error: WBCH_NO_CREDENTIAL_TEXT });
  });
});

describe('文件', () => {
  it('发一个文件:进房 → 走协议定的 wb.file → 发完把这一份持有放掉', async () => {
    const { channel, link } = wire({ stored: { [WBCH_CREDENTIAL_KEY]: JSON.stringify(ISSUED) } });
    await expect(channel.sendFile(new File(['x'], '一张图.png'))).resolves.toEqual({ ok: true });
    expect(link.files).toEqual([{ name: '一张图.png', topic: WBCH_FILE_TOPIC }]);
    expect(link.holders.has('file')).toBe(false);
  });

  // 发完文件把房间拆了 = 电话断了。这条钉住「发文件那一份持有和通话那一份是两回事」。
  it('通话中发文件,发完电话还在', async () => {
    const { channel, link } = wire({ stored: { [WBCH_CREDENTIAL_KEY]: JSON.stringify(ISSUED) } });
    await channel.acquireCall();
    await channel.sendFile(new File(['x'], 'a.txt'));
    expect(link.holders.has('call')).toBe(true);
    expect(link.state()).toBe('connected');
  });

  it('★ 一通电话收场(releaseCall)顺手把喇叭关回缺省:下一次话筒通话她的声音不从手机里漏出来(2026-10-13 晚)', async () => {
    const { channel, link } = wire({ stored: { [WBCH_CREDENTIAL_KEY]: JSON.stringify(ISSUED) } });
    await channel.acquireCall();
    link.setSpeakerEnabled(true);
    await channel.releaseCall();
    expect(link.speakerLog[link.speakerLog.length - 1]).toBe(false);
    expect(link.holders.has('call')).toBe(false);
  });

  it('没有凭证就发不出去,如实说', async () => {
    const { channel } = wire({ answer: () => ({ ok: false, status: 0, kind: 'network', error: 'x' }) });
    await channel.remote();
    await expect(channel.sendFile(new File(['x'], 'a.txt'))).resolves.toEqual({ ok: false, error: WBCH_NO_CREDENTIAL_TEXT });
  });

  it('工人发过来的文件转给上面那层', () => {
    const { channel, link } = wire();
    const got: { name: string; text: string }[] = [];
    channel.onFile((f) => got.push({ name: f.name, text: new TextDecoder().decode(f.bytes) }));
    link.deliverFile('电脑发来的.txt', '收到了吗');
    expect(got).toEqual([{ name: '电脑发来的.txt', text: '收到了吗' }]);
  });
});

describe('stop()', () => {
  it('停掉之后不再占着房间', async () => {
    const { channel, link } = wire({ stored: { [WBCH_CREDENTIAL_KEY]: JSON.stringify(ISSUED) } });
    await channel.remote();
    expect(link.state()).toBe('connected');
    channel.stop();
    await vi.waitFor(() => expect(link.state()).toBe('closed'));
  });
});

describe('在外面取文件(2026-09-25,卡 J)', () => {
  it('进房、发 file_pull、拿到「开始推了」;持有到收完才放(字节还在路上)', async () => {
    const { link, channel } = wire({ stored: { [WBCH_CREDENTIAL_KEY]: JSON.stringify(ISSUED) } });
    const started = channel.pullOffer!('offer-9');
    await vi.waitFor(() => expect(link.sent.length).toBeGreaterThan(0));
    const sent = JSON.parse(link.sent[link.sent.length - 1]!.text) as { id: string; type: string; offer: string };
    expect(sent).toMatchObject({ type: 'file_pull', offer: 'offer-9' });
    link.deliver({ id: sent.id, type: 'file_pull', ok: true, name: 'README.md', bytes: 12 });
    await expect(started).resolves.toEqual({ ok: true, name: 'README.md', bytes: 12 });
    expect(link.holders.has('pull')).toBe(true);
    await channel.releasePull!();
    expect(link.holders.has('pull')).toBe(false);
  });

  it('老工人不认 file_pull:说人话,并放掉持有', async () => {
    const { link, channel } = wire({ stored: { [WBCH_CREDENTIAL_KEY]: JSON.stringify(ISSUED) } });
    const started = channel.pullOffer!('offer-9');
    await vi.waitFor(() => expect(link.sent.length).toBeGreaterThan(0));
    const sent = JSON.parse(link.sent[link.sent.length - 1]!.text) as { id: string };
    link.deliver({ id: sent.id, type: 'error', error: '不认识这种请求:file_pull' });
    await expect(started).resolves.toEqual({ ok: false, error: WBCH_PULL_OLD_WORKER_TEXT });
    expect(link.holders.has('pull')).toBe(false);
  });
});
