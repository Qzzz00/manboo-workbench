/**
 * 手机自己向中转登录、领房间凭证(2026-09-21)。这一层要解决的是功能盘点里那条
 * 「手机出门随时进房」——以前房间凭证只能在局域网里从电脑上领,于是
 * 「第一次出门之前必须回过一次家」,7 天到期时人在外面就续不上。
 *
 * 盯四件事:
 *   1. 登录 → 会话 → 设备令牌,三步都成才算登录成功;中间断了要**把会话留着**
 *      (不然得把密码再输一遍,而失败多半只是一次网络抖动);
 *   2. 领房间凭证**中转优先、8791 兜底**;两条都不通时说的是中转那句(它更准);
 *   3. 401 有特别的意思:这台手机被从账号里移除了。说人话,别让人对着"连不上"猜;
 *   4. **密码与两把令牌都不出安全存储**:不进任何回包、任何错误消息。
 */
import { describe, expect, it, vi } from 'vitest';

import { createAccountStore, type AccountRecord } from '../src/account/accountStore';
import type { KeyValueStore } from '../src/api/tokenStore';
import { newPhoneDeviceId, phoneAccountLogin, phoneAccountLogout, linkPairedPhone } from '../src/account/phoneLogin';
import { relayRegisterDevice } from '../src/account/relayApi';
import { createRelayRoomSource, phoneIdentityOf } from '../src/account/roomFromRelay';
import { createWbchChannel } from '../src/channel/channel';
import { createWbchCredentialStore } from '../src/channel/credentialStore';
import type { ApiClient, ApiResult } from '../src/api/client';

function memoryKv(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    async get(key) { return map.get(key) ?? null; },
    async set(key, value) { map.set(key, value); },
    async remove(key) { map.delete(key); },
  };
}

const RELAY = 'https://relay.test';

/** 一个只认这几条路的假中转。`calls` 让用例看得到发生过什么、带了什么头。 */
function fakeRelay(overrides: Record<string, [number, unknown]> = {}) {
  const calls: { path: string; auth?: string; body?: unknown }[] = [];
  const routes: Record<string, [number, unknown]> = {
    '/v1/account/login': [200, {
      session_token: 'wbs_session-1',
      account: { id: 'acct-1', email_or_phone: 'ben@x.com', created_at: '2026-09-21T00:00:00.000Z' },
    }],
    '/v1/account/register': [201, {
      session_token: 'wbs_session-1',
      account: { id: 'acct-1', email_or_phone: 'ben@x.com', created_at: '2026-09-21T00:00:00.000Z' },
    }],
    '/v1/account/logout': [200, { ok: true }],
    '/register-device': [201, { token: 'wb_phone-device-1' }],
    '/v1/channel-credentials': [200, {
      livekit: { configured: true, url: 'wss://lk.test', room: 'wb-abcdef0123456789', token_endpoint: '/v1/channel-token' },
      expires_at: '2026-09-21T04:00:00.000Z',
      store: 'memory-only',
    }],
    '/v1/channel-token': [200, {
      url: 'wss://lk.test',
      room: 'wb-abcdef0123456789',
      identity: 'wb-phone-dev-1',
      token: 'livekit-join-token',
      expires_at: 2_000_000,
    }],
    ...overrides,
  };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).slice(RELAY.length);
    const auth = new Headers(init?.headers).get('authorization') ?? undefined;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
    calls.push({ path, ...(auth === null || auth === undefined ? {} : { auth }), ...(body === undefined ? {} : { body }) });
    const route = routes[path];
    if (route === undefined) return new Response(JSON.stringify({ error: { message: '没有这个路径' } }), { status: 404 });
    return new Response(JSON.stringify(route[1]), { status: route[0], headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('手机账号登录', () => {
  it('登录 → 领设备令牌,两把都存进安全存储', async () => {
    const { fetchImpl, calls } = fakeRelay();
    const store = createAccountStore(memoryKv());
    const result = await phoneAccountLogin({
      relayUrl: RELAY, identifier: 'ben@x.com', password: 'hunter22', mode: 'login',
      deviceId: 'dev-1', deviceName: '我的手机', store, fetchImpl,
    });
    expect(result.ok).toBe(true);
    const saved = await store.load();
    expect(saved).toMatchObject({
      relayUrl: RELAY, deviceId: 'dev-1', identifier: 'ben@x.com',
      sessionToken: 'wbs_session-1', deviceToken: 'wb_phone-device-1',
    });
    // 领设备令牌那一次带的是**账号会话**,而且报了类型与名字。
    const register = calls.find(c => c.path === '/register-device');
    expect(register?.auth).toBe('Bearer wbs_session-1');
    expect(register?.body).toMatchObject({ device_id: 'dev-1', kind: 'phone', name: '我的手机' });
  });

  /**
   * ——— 中转认得「话筒」这一类了(2026-09-23) ———
   *
   * 交接-0922-铃由手机出话筒对话 第九节:中转现在**按注册时这一列签进房凭证的 `wb_kind`**。
   * 所以替座机领令牌时报什么,直接决定它经中转进房之后工人把它当成什么。
   */
  it('★ 替座机领令牌时报 handset —— 中转按这一列签 wb_kind', async () => {
    const { fetchImpl, calls } = fakeRelay();
    const issued = await relayRegisterDevice({
      relayUrl: RELAY, session: 'wbs_session-1', deviceId: 'handset-1', name: '座机话筒',
      kind: 'handset', fetchImpl,
    });
    expect(issued.ok).toBe(true);
    expect(calls.find(c => c.path === '/register-device')?.body)
      .toMatchObject({ device_id: 'handset-1', kind: 'handset', name: '座机话筒' });
  });

  it('不说类型照旧是 phone(原来那几处调用一个字没改)', async () => {
    const { fetchImpl, calls } = fakeRelay();
    await relayRegisterDevice({ relayUrl: RELAY, session: 'wbs_session-1', deviceId: 'dev-1', fetchImpl });
    expect(calls.find(c => c.path === '/register-device')?.body).toMatchObject({ kind: 'phone' });
  });

  it('注册那一支打的是 register,不是 login', async () => {
    const { fetchImpl, calls } = fakeRelay();
    await phoneAccountLogin({
      relayUrl: RELAY, identifier: 'ben@x.com', password: 'hunter22', mode: 'register',
      deviceId: 'dev-1', store: createAccountStore(memoryKv()), fetchImpl,
    });
    expect(calls.map(c => c.path)).toEqual(['/v1/account/register', '/register-device']);
  });

  it('密码不对:原样把服务器那句话交出来,什么都不存', async () => {
    const { fetchImpl } = fakeRelay({
      '/v1/account/login': [401, { error: { message: '邮箱/手机号或密码不对。', code: 'bad_credentials' } }],
    });
    const store = createAccountStore(memoryKv());
    const result = await phoneAccountLogin({
      relayUrl: RELAY, identifier: 'ben@x.com', password: 'wrong', mode: 'login',
      deviceId: 'dev-1', store, fetchImpl,
    });
    expect(result).toEqual({ ok: false, error: '邮箱/手机号或密码不对。' });
    expect(await store.load()).toBeNull();
  });

  it('会话拿到了、设备令牌没领到:**会话留着**,重试不用再输一次密码', async () => {
    const { fetchImpl } = fakeRelay({
      '/register-device': [503, { error: { message: '账号服务这会儿有点问题' } }],
    });
    const store = createAccountStore(memoryKv());
    const result = await phoneAccountLogin({
      relayUrl: RELAY, identifier: 'ben@x.com', password: 'hunter22', mode: 'login',
      deviceId: 'dev-1', store, fetchImpl,
    });
    expect(result.ok).toBe(false);
    const saved = await store.load();
    expect(saved?.sessionToken).toBe('wbs_session-1');
    expect(saved?.deviceToken).toBeUndefined();
  });

  it('连不上时那句话里没有地址、没有底层报错', async () => {
    const fetchImpl = (async () => { throw new TypeError('fetch failed: connect ECONNREFUSED 10.0.0.1:8795'); }) as typeof fetch;
    const result = await phoneAccountLogin({
      relayUrl: RELAY, identifier: 'ben@x.com', password: 'hunter22', mode: 'login',
      deviceId: 'dev-1', store: createAccountStore(memoryKv()), fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toContain('10.0.0.1');
    expect(result.error).not.toContain('ECONNREFUSED');
  });

  it('退出登录:吊销服务器那张会话,本地清干净', async () => {
    const { fetchImpl, calls } = fakeRelay();
    const store = createAccountStore(memoryKv());
    await phoneAccountLogin({
      relayUrl: RELAY, identifier: 'ben@x.com', password: 'hunter22', mode: 'login',
      deviceId: 'dev-1', store, fetchImpl,
    });
    await phoneAccountLogout(store, fetchImpl);
    expect(calls.some(c => c.path === '/v1/account/logout' && c.auth === 'Bearer wbs_session-1')).toBe(true);
    expect(await store.load()).toBeNull();
  });

  it('设备 id 每次生成的都不一样,而且是 32 个十六进制字符', () => {
    const a = newPhoneDeviceId();
    const b = newPhoneDeviceId();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe('扫码配对那条快捷方式', () => {
  /** 一个只回 /channel/relay-device 的假 8791。 */
  function fakeDirect(reply: ApiResult<{ relay_url?: unknown; token?: unknown }>): ApiClient {
    return {
      baseUrl: 'http://192.168.1.9:8791',
      json: (async () => reply) as ApiClient['json'],
      blob: (async () => ({ ok: false, status: 0, kind: 'network', error: '' })) as ApiClient['blob'],
    };
  }

  it('电脑替它领到了令牌 → 存下来,而且**不碰已有的账号会话**', async () => {
    const store = createAccountStore(memoryKv());
    await store.save({ relayUrl: RELAY, deviceId: 'dev-1', identifier: 'ben@x.com', sessionToken: 'wbs_session-1' });
    const result = await linkPairedPhone({
      direct: fakeDirect({ ok: true, status: 200, data: { relay_url: RELAY, token: 'wb_from-desktop' } }),
      store,
      deviceId: 'dev-1',
    });
    expect(result.ok).toBe(true);
    const saved = await store.load();
    expect(saved?.deviceToken).toBe('wb_from-desktop');
    expect(saved?.sessionToken).toBe('wbs_session-1');
  });

  it('电脑上还没登录账号 / 还是老版本 → 回一句话,**什么都不存**(局域网照常能用)', async () => {
    const store = createAccountStore(memoryKv());
    const result = await linkPairedPhone({
      direct: fakeDirect({ ok: false, status: 404, kind: 'http', error: '账号还在这台电脑上,手机暂时只能走局域网' }),
      store,
      deviceId: 'dev-1',
    });
    expect(result).toEqual({ ok: false, error: '账号还在这台电脑上,手机暂时只能走局域网' });
    expect(await store.load()).toBeNull();
  });

  it('回包缺字段就当没拿到', async () => {
    const store = createAccountStore(memoryKv());
    const result = await linkPairedPhone({
      direct: fakeDirect({ ok: true, status: 200, data: { relay_url: RELAY } }),
      store,
      deviceId: 'dev-1',
    });
    expect(result.ok).toBe(false);
    expect(await store.load()).toBeNull();
  });
});

describe('从中转领房间凭证', () => {
  async function loggedInStore() {
    const store = createAccountStore(memoryKv());
    await store.save({
      relayUrl: RELAY, deviceId: 'dev-1', identifier: 'ben@x.com',
      sessionToken: 'wbs_session-1', deviceToken: 'wb_phone-device-1',
    });
    return store;
  }

  it('先问房间名、再签凭证;身份是 wb-phone-<device_id>', async () => {
    const { fetchImpl, calls } = fakeRelay();
    const source = createRelayRoomSource({ store: await loggedInStore(), fetchImpl });
    const result = await source.credential();
    expect(result).toMatchObject({ ok: true });
    if (result === null || !result.ok) return;
    expect(result.credential).toMatchObject({ url: 'wss://lk.test', room: 'wb-abcdef0123456789', token: 'livekit-join-token' });
    expect(calls.map(c => c.path)).toEqual(['/v1/channel-credentials', '/v1/channel-token']);
    // 两次都带的是**设备令牌**,不是账号会话。
    expect(calls.every(c => c.auth === 'Bearer wb_phone-device-1')).toBe(true);
    expect(calls[1]?.body).toMatchObject({ identity: phoneIdentityOf('dev-1'), room: 'wb-abcdef0123456789' });
  });

  it('还没登录账号 → 回 null(不是错误:那是"该走 8791 那条")', async () => {
    const { fetchImpl, calls } = fakeRelay();
    const source = createRelayRoomSource({ store: createAccountStore(memoryKv()), fetchImpl });
    expect(await source.credential()).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('401 说的是「这台手机被移除了」,不是「连不上」', async () => {
    const { fetchImpl } = fakeRelay({
      '/v1/channel-credentials': [401, { error: { message: '这台设备的凭证不认识或已失效。', code: 'invalid_relay_token' } }],
    });
    const source = createRelayRoomSource({ store: await loggedInStore(), fetchImpl });
    const result = await source.credential();
    expect(result).toMatchObject({ ok: false });
    if (result === null || result.ok) return;
    expect(result.error).toContain('移除');
  });

  it('服务器上还没配 LiveKit → 原样说那句,不说"手机错了"', async () => {
    const { fetchImpl } = fakeRelay({
      '/v1/channel-credentials': [200, {
        livekit: { configured: false },
        notes: ['服务器上还没配 LiveKit(地址 / api key / secret 三样缺一不可),这台设备暂时通不了话。'],
      }],
    });
    const source = createRelayRoomSource({ store: await loggedInStore(), fetchImpl });
    const result = await source.credential();
    if (result === null || result.ok) { expect.unreachable(); return; }
    expect(result.error).toContain('还没配 LiveKit');
  });

  it('凭证缺字段就当没领到 —— 地址猜错会连到别人的服务器上去', async () => {
    const { fetchImpl } = fakeRelay({
      '/v1/channel-token': [200, { url: 'wss://lk.test', room: 'wb-x', token: 'tok' }],
    });
    const source = createRelayRoomSource({ store: await loggedInStore(), fetchImpl });
    const result = await source.credential();
    expect(result).toMatchObject({ ok: false });
  });
});

describe('通道层:中转优先,8791 兜底', () => {
  /** 一个永远说"连不上"的 8791 —— 这正是"人在外面"的样子。 */
  function offlineDirect(): ApiClient {
    return {
      baseUrl: 'http://192.168.1.9:8791',
      json: (async () => ({ ok: false, status: 0, kind: 'network', error: '连不上工作台' })) as ApiClient['json'],
      blob: (async () => ({ ok: false, status: 0, kind: 'network', error: '连不上工作台' })) as ApiClient['blob'],
    };
  }

  const CREDENTIAL = {
    url: 'wss://lk.test', room: 'wb-abc', identity: 'wb-phone-dev-1', token: 'tok', expires_at: 9_000_000,
  };

  it('8791 够不到时照样领得到 —— 这就是「出门随时进房」', async () => {
    const channel = createWbchChannel({
      direct: offlineDirect(),
      store: createWbchCredentialStore(memoryKv()),
      relay: { credential: async () => ({ ok: true, credential: CREDENTIAL }) },
      onUnauthorized: () => {},
      now: () => 1_000_000,
    });
    expect(await channel.refresh()).toEqual({ ok: true });
    expect(channel.credential()).toEqual(CREDENTIAL);
  });

  it('中转不行时退回 8791(局域网里、或者还没登录账号的老手机)', async () => {
    const direct: ApiClient = {
      baseUrl: 'http://192.168.1.9:8791',
      json: (async () => ({ ok: true, status: 200, data: CREDENTIAL })) as ApiClient['json'],
      blob: (async () => ({ ok: false, status: 0, kind: 'network', error: '' })) as ApiClient['blob'],
    };
    const channel = createWbchChannel({
      direct,
      store: createWbchCredentialStore(memoryKv()),
      relay: { credential: async () => ({ ok: false, error: '连不上账号服务' }) },
      onUnauthorized: () => {},
      now: () => 1_000_000,
    });
    expect(await channel.refresh()).toEqual({ ok: true });
    expect(channel.credential()).toEqual(CREDENTIAL);
  });

  it('两条都不通时说的是**中转那句**(它更准)', async () => {
    const channel = createWbchChannel({
      direct: offlineDirect(),
      store: createWbchCredentialStore(memoryKv()),
      relay: { credential: async () => ({ ok: false, error: '这台手机已经从账号里移除了。重新用账号登录一次就能回来。' }) },
      onUnauthorized: () => {},
      now: () => 1_000_000,
    });
    const result = await channel.refresh();
    expect(result).toEqual({ ok: false, error: '这台手机已经从账号里移除了。重新用账号登录一次就能回来。' });
  });

  it('没接中转那条路时,行为与这张卡之前一模一样(老手机包)', async () => {
    const json = vi.fn(async () => ({ ok: true, status: 200, data: CREDENTIAL }));
    const channel = createWbchChannel({
      direct: {
        baseUrl: 'http://192.168.1.9:8791',
        json: json as unknown as ApiClient['json'],
        blob: (async () => ({ ok: false, status: 0, kind: 'network', error: '' })) as ApiClient['blob'],
      },
      store: createWbchCredentialStore(memoryKv()),
      onUnauthorized: () => {},
      now: () => 1_000_000,
    });
    expect(await channel.refresh()).toEqual({ ok: true });
    expect(json).toHaveBeenCalledWith('/channel/token', expect.objectContaining({ method: 'POST' }));
  });

  it('凭证过期了、又在外面 → 中转续上,不用回局域网', async () => {
    const expired = { ...CREDENTIAL, expires_at: 1_000 };
    const kv = memoryKv();
    await kv.set('butler.channel', JSON.stringify(expired));
    let issued = 0;
    const channel = createWbchChannel({
      direct: offlineDirect(),
      store: createWbchCredentialStore(kv),
      relay: {
        credential: async () => { issued += 1; return { ok: true, credential: { ...CREDENTIAL, token: `tok-${issued}` } }; },
      },
      onUnauthorized: () => {},
      now: () => 1_000_000,
    });
    const result = await channel.renewNow();
    expect(result).toEqual({ ok: true });
    expect(channel.credential()?.token).toBe('tok-1');
  });
});

describe('存储那一层', () => {
  it('只写设备令牌时不碰账号会话', async () => {
    const store = createAccountStore(memoryKv());
    await store.save({ relayUrl: RELAY, deviceId: 'dev-1', identifier: 'ben@x.com', sessionToken: 'wbs_1' });
    await store.setDeviceToken('wb_new');
    expect(await store.load()).toMatchObject({ sessionToken: 'wbs_1', deviceToken: 'wb_new' });
  });

  it('存坏了当成没登录,而不是抛 —— 坏文件不该把人锁在门外', async () => {
    const kv = memoryKv();
    await kv.set('butler.account', '{不是 JSON');
    expect(await createAccountStore(kv).load()).toBeNull();
    await kv.set('butler.account', JSON.stringify({ relayUrl: RELAY }));
    expect(await createAccountStore(kv).load()).toBeNull();
  });

  it('只有设备令牌、没有账号会话也算数(扫码那条快捷方式的样子)', async () => {
    const kv = memoryKv();
    const store = createAccountStore(kv);
    await store.link({ relayUrl: RELAY, deviceId: 'dev-1', deviceToken: 'wb_from-desktop' });
    const saved = await store.load() as AccountRecord;
    expect(saved.deviceToken).toBe('wb_from-desktop');
    expect(saved.sessionToken).toBeUndefined();
  });
});
