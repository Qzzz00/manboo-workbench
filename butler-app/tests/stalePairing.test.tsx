/**
 * 手机拿着上一台安装的配对(2026-09-23 第二轮从零重装)。电脑整个重装、换了账号,手机没重新扫码。
 * 要守住的:
 *
 *   1. 远程那条路进了房**先看电脑在不在**,几秒内给结论(presence),不让每条请求在空房里各等 15 秒;
 *      同账号新安装(换了房间)能自动搬就自动搬;中转明说不认 → `revoked`;
 *   2. 账号记录是上一次配对的(device_id 对不上)→ 不拿它去中转领旧账号那间房;
 *   3. 手机只有 LTE 时,试探局域网那一下不许挂几十秒(GET 到点就转房间;POST 不掐);
 *   4. 首页:没连上 + 判出「不认 / 房里没有电脑」→ 一句话 + 「重新扫码配对」,点了直接进扫码;
 *      上次的数据收起并标明;「工人可能没在跑」不再在没确认电脑在线时说;
 *   5. 登录页 `startScan`:跳过欢迎屏直接开相机。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ApiClient, ApiResult, RequestOptions } from '../src/api/client';
import {
  WBCH_DESKTOP_NOT_IN_ROOM_TEXT, WBCH_WORKER_GRACE_MS, createWbchChannel, type WbchPresence,
} from '../src/channel/channel';
import { WBCH_CREDENTIAL_KEY, createWbchCredentialStore, type WbchCredential } from '../src/channel/credentialStore';
import { WBCH_RPC_TIMEOUT_TEXT } from '../src/channel/rpc';
import { createWbchRoutedClient } from '../src/channel/routedClient';
import { RELAY_DEVICE_REVOKED_TEXT, createRelayRoomSource, type RelayRoomSource } from '../src/account/roomFromRelay';
import { createAccountStore } from '../src/account/accountStore';
import {
  RELINK_ABSENT_TITLE, RELINK_ACTION_LABEL, RELINK_REVOKED_TITLE, cardsViewOf, relinkNotice, staleCardsLabel,
} from '../src/stage/linkHealth';
import { noWorkerText, WBCH_CALL_NO_WORKER_TEXT } from '../src/call/livekitCall';
import { WBCH_ROOM_STALE_TEXT } from '../src/channel/channel';
import { LoginPage } from '../src/login/LoginPage';
import type { DiscoveryCallbacks, DiscoveryHandle } from '../src/pairing/discovery';
import type { QrScannerProps } from '../src/pairing/QrScanner';
import { StageCards } from '../src/stage/StageCards';
import { emptyState } from '../src/api/protocol';
import { createFakeLink, memoryStore } from './wbchFakes';

const OLD: WbchCredential = { url: 'wss://lk.test', room: 'acct-old', identity: 'wb-phone-old', token: 'jwt-old', expires_at: 2_000_000_000 };
const NEW: WbchCredential = { url: 'wss://lk.test', room: 'acct-new', identity: 'wb-phone-old', token: 'jwt-new', expires_at: 2_000_000_000 };

const offline = (): ApiClient => ({
  baseUrl: 'http://10.0.0.9:8791',
  async json() { return { ok: false as const, status: 0, kind: 'network' as const, error: '连不上工作台' }; },
  async blob() { return { ok: false as const, status: 0, kind: 'network' as const, error: '连不上工作台' }; },
});

function relayAnswering(answer: () => Awaited<ReturnType<RelayRoomSource['credential']>>): RelayRoomSource & { calls: number } {
  const source = { calls: 0, async credential() { source.calls += 1; return answer(); } };
  return source;
}

function wire(relay: RelayRoomSource, options: { clock?: { t: number } } = {}) {
  const kv = memoryStore({ [WBCH_CREDENTIAL_KEY]: JSON.stringify(OLD) });
  const link = createFakeLink();
  let present = false;
  link.workerPresent = () => present;
  const switched: WbchCredential[] = [];
  link.switchRoom = async (credential) => { switched.push(credential); };
  const clock = options.clock ?? { t: 1_000_000 };
  const channel = createWbchChannel({
    direct: offline(), store: createWbchCredentialStore(kv), onUnauthorized: () => {}, link, relay,
    now: () => clock.t, workerGraceMs: 10, absentRecheckMs: 60_000,
  });
  const changes: (WbchPresence | undefined)[] = [];
  channel.subscribe(() => changes.push(channel.presence?.()));
  return { channel, link, switched, clock, setPresent: (v: boolean) => { present = v; } };
}

describe('① 进了房先看电脑在不在(presence)', () => {
  it('等电脑露面最多几秒(缺省 3 秒),不是 15 秒的请求超时', () => {
    expect(WBCH_WORKER_GRACE_MS).toBeLessThanOrEqual(3000);
  });

  it('★ 换了账号(中转给的还是旧账号那一间,房里没有电脑):当场说「房里没有电脑」,presence=absent', async () => {
    const relay = relayAnswering(() => ({ ok: true, credential: { ...OLD, token: 'jwt-2' } }));
    const { channel } = wire(relay);
    expect(channel.presence?.()).toEqual({ kind: 'unknown' });
    const got = await channel.remote();
    expect(got).toEqual({ ok: false, error: WBCH_DESKTOP_NOT_IN_ROOM_TEXT });
    expect(channel.presence?.()).toMatchObject({ kind: 'absent', check: 'same' });
    // 这句不猜「工人没在跑」,也把「重新扫码配对」那条路说出来。
    expect(WBCH_DESKTOP_NOT_IN_ROOM_TEXT).not.toContain('工人');
    expect(WBCH_DESKTOP_NOT_IN_ROOM_TEXT).toContain('重新扫码配对');
  });

  it('判过「不在」之后一分钟内的请求当场回,不再每条都等、都去问中转;过了一分钟再核对一次', async () => {
    const relay = relayAnswering(() => ({ ok: true, credential: OLD }));
    const { channel, clock } = wire(relay);
    await channel.remote();
    const asked = relay.calls;
    const started = Date.now();
    expect(await channel.remote()).toEqual({ ok: false, error: WBCH_DESKTOP_NOT_IN_ROOM_TEXT });
    expect(Date.now() - started).toBeLessThan(10);
    expect(relay.calls).toBe(asked);
    clock.t += 60_001;
    await channel.remote();
    expect(relay.calls).toBe(asked + 1);
  });

  it('电脑开机进了房:presence 变 present,请求照走', async () => {
    const relay = relayAnswering(() => ({ ok: true, credential: OLD }));
    const { channel, link, setPresent } = wire(relay);
    await channel.remote();
    setPresent(true);
    link.deliverWorker(true);
    expect(channel.presence?.()).toEqual({ kind: 'present' });
    const got = await channel.remote();
    expect(got.ok).toBe(true);
  });

  it('★ 同账号的新安装换了房间:自动搬过去,电脑在新房里就照常通', async () => {
    const relay = relayAnswering(() => ({ ok: true, credential: NEW }));
    const { channel, link, switched, setPresent } = wire(relay);
    link.switchRoom = async (credential) => { switched.push(credential); setPresent(true); };
    const got = await channel.remote();
    expect(got.ok).toBe(true);
    expect(switched.map((c) => c.room)).toEqual(['acct-new']);
    expect(channel.presence?.()).toEqual({ kind: 'present' });
  });

  it('中转明说这台手机的令牌不认了(401):presence=revoked,原话转达', async () => {
    const relay = relayAnswering(() => ({ ok: false, error: RELAY_DEVICE_REVOKED_TEXT, revoked: true }));
    const { channel } = wire(relay);
    expect(await channel.remote()).toEqual({ ok: false, error: RELAY_DEVICE_REVOKED_TEXT });
    expect(channel.presence?.()).toMatchObject({ kind: 'revoked', error: RELAY_DEVICE_REVOKED_TEXT });
    expect(await channel.recheckRoom?.()).toEqual({ kind: 'revoked', error: RELAY_DEVICE_REVOKED_TEXT });
  });

  it('中转与 8791 都问不到:presence=absent(check=unknown),说的还是「房里没有电脑」那句', async () => {
    const relay = relayAnswering(() => ({ ok: false, error: '连不上中转' }));
    const { channel } = wire(relay);
    expect(await channel.remote()).toEqual({ ok: false, error: WBCH_DESKTOP_NOT_IN_ROOM_TEXT });
    expect(channel.presence?.()).toMatchObject({ kind: 'absent', check: 'unknown' });
  });

  it('同时来几条请求只核对一次', async () => {
    const relay = relayAnswering(() => ({ ok: true, credential: OLD }));
    const { channel } = wire(relay);
    await Promise.all([channel.remote(), channel.remote(), channel.remote()]);
    expect(relay.calls).toBe(1);
  });
});

describe('①′ 那几句话', () => {
  it('房里超时那句不再猜「工人可能没在跑」', () => {
    expect(WBCH_RPC_TIMEOUT_TEXT).not.toContain('没在跑');
  });
  it('通话里:中转说不认 → 同样引导重新扫码配对;核对过是同一间 → 老那句', () => {
    expect(noWorkerText({ kind: 'revoked', error: 'x' })).toBe(WBCH_ROOM_STALE_TEXT);
    expect(noWorkerText({ kind: 'unknown', error: 'x' })).toBe(WBCH_ROOM_STALE_TEXT);
    expect(noWorkerText({ kind: 'same' })).toBe(WBCH_CALL_NO_WORKER_TEXT);
    expect(WBCH_ROOM_STALE_TEXT).toContain('重新扫码');
  });
});

describe('② 账号记录是上一次配对的:不拿它领旧账号那间房', () => {
  it('device_id 对不上 → 当没登录(null),一次中转都不问', async () => {
    const store = createAccountStore(memoryStore());
    await store.save({ relayUrl: 'https://relay.test', deviceId: 'dev-old', deviceToken: 'wb_x' });
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const relay = createRelayRoomSource({ store, deviceId: 'dev-new', fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await relay.credential()).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('对得上 / 不核对(老调用方)→ 照去中转', async () => {
    const store = createAccountStore(memoryStore());
    await store.save({ relayUrl: 'https://relay.test', deviceId: 'dev-1', deviceToken: 'wb_x' });
    for (const deviceId of ['dev-1', undefined]) {
      const fetchImpl = vi.fn(async () => new Response('{"error":"x"}', { status: 401 }));
      const relay = createRelayRoomSource({ store, ...(deviceId === undefined ? {} : { deviceId }), fetchImpl: fetchImpl as unknown as typeof fetch });
      expect(await relay.credential()).toEqual({ ok: false, error: RELAY_DEVICE_REVOKED_TEXT, revoked: true });
      expect(fetchImpl).toHaveBeenCalled();
    }
  });
});

describe('③ 试探局域网不许挂几十秒', () => {
  function hangingDirect() {
    const seen: (AbortSignal | undefined)[] = [];
    const client: ApiClient = {
      baseUrl: 'http://10.0.0.9:8791',
      json<T>(_path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
        seen.push(options.signal);
        const signal = options.signal;
        // 只有被掐断才回(LTE 下连一个局域网地址就是这样挂着)。
        return new Promise((resolve) => {
          if (signal === undefined) { resolve({ ok: false, status: 0, kind: 'network', error: '连不上工作台' }); return; }
          signal.addEventListener('abort', () => resolve({ ok: false, status: 0, kind: 'network', error: '连不上工作台' }));
        });
      },
      async blob() { return { ok: false as const, status: 0, kind: 'network' as const, error: 'x' }; },
    };
    return { client, seen };
  }
  const room: ApiClient = {
    baseUrl: 'room',
    async json<T>() { return { ok: true as const, status: 200, data: 'room' as T }; },
    async blob() { return { ok: true as const, status: 200, data: new Blob() }; },
  };

  it('GET:到点就当连不上,转房间那条路', async () => {
    const { client } = hangingDirect();
    const routed = createWbchRoutedClient({ direct: client, remote: async () => ({ ok: true, client: room }), directProbeMs: 20 });
    const got = await routed.json<string>('/state');
    expect(got).toEqual({ ok: true, status: 200, data: 'room' });
    expect(routed.mode()).toBe('remote');
  });

  it('POST 不掐(被掐断再走房间可能办两遍)', async () => {
    const { client, seen } = hangingDirect();
    const routed = createWbchRoutedClient({ direct: client, remote: async () => ({ ok: true, client: room }), directProbeMs: 20 });
    await routed.json('/butler/item', { method: 'POST', body: { text: 'x' } });
    expect(seen).toEqual([undefined]);
  });

  it('直连通过之后,直连模式里的请求不掐(大文件、慢接口照常)', async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const ok: ApiClient = {
      baseUrl: 'lan',
      async json<T>(_p: string, o: RequestOptions = {}) { seen.push(o.signal); return { ok: true as const, status: 200, data: 'lan' as T }; },
      async blob() { return { ok: true as const, status: 200, data: new Blob() }; },
    };
    const routed = createWbchRoutedClient({ direct: ok, remote: async () => ({ ok: false, error: 'x' }), directProbeMs: 20 });
    await routed.json('/state');
    await routed.json('/state');
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(seen[1]).toBeUndefined();
  });
});

describe('④ 首页那一块(linkHealth)', () => {
  it('没连上 + 不认 / 房里没有电脑 → 一句话 + 「重新扫码配对」;连着或还不知道 → 不出', () => {
    expect(relinkNotice({ connected: false, presence: 'revoked' })).toMatchObject({ kind: 'revoked', title: RELINK_REVOKED_TITLE, action: RELINK_ACTION_LABEL });
    expect(relinkNotice({ connected: false, presence: 'absent' })).toMatchObject({ kind: 'absent', title: RELINK_ABSENT_TITLE, action: RELINK_ACTION_LABEL });
    expect(relinkNotice({ connected: true, presence: 'revoked' })).toBeNull();
    expect(relinkNotice({ connected: false, presence: 'unknown' })).toBeNull();
    expect(relinkNotice({ connected: false, presence: 'present' })).toBeNull();
    expect(relinkNotice({ connected: false, presence: undefined })).toBeNull();
  });

  it('卡片区:连着照常;没连上有旧数据 → 收起;一次都没拿到过 → 不画', () => {
    expect(cardsViewOf({ connected: true, now: '' })).toBe('live');
    expect(cardsViewOf({ connected: false, now: '2026-09-23T10:00:00Z' })).toBe('stale');
    expect(cardsViewOf({ connected: false, now: '' })).toBe('none');
    expect(staleCardsLabel('2026-09-23T10:05:00', false)).toBe('上次的数据(电脑没连上) · 9-23 10:05 · 展开');
    expect(staleCardsLabel('坏的', true)).toBe('上次的数据(电脑没连上) · 收起');
  });

  it('StageCards 收起时只有一行;点开后卡片都在、标着「上次的数据」', () => {
    const state = { ...emptyState(), now: '2026-09-23T10:05:00' };
    let open = false;
    const view = render(<StageCards state={state} stale={{ label: staleCardsLabel(state.now, open), open, onToggle: () => { open = !open; } }} />);
    expect(document.querySelector('.ba-cards[data-stale="collapsed"]')).toBeTruthy();
    expect(document.querySelectorAll('.ba-cards__card')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /上次的数据/ }));
    view.rerender(<StageCards state={state} stale={{ label: staleCardsLabel(state.now, open), open, onToggle: () => { open = !open; } }} />);
    expect(document.querySelector('.ba-cards[data-stale="open"]')).toBeTruthy();
    expect(document.querySelectorAll('.ba-cards__card').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /上次的数据.*收起/ })).toBeTruthy();
    view.unmount();
  });
});

describe('⑤ 登录页 startScan:直接开相机', () => {
  afterEach(() => { vi.useRealTimers(); });
  const discover = async (_cb: DiscoveryCallbacks): Promise<DiscoveryHandle> => ({ stop: async () => {} });
  function FakeScanner(_props: QrScannerProps) { return <div data-testid="scanner" />; }

  it('跳过欢迎屏,扫码页一出来就在扫', async () => {
    render(<LoginPage onPaired={() => {}} startScan notice="旧的配对已经清掉了" discover={discover} scanner={FakeScanner} />);
    await act(async () => {});
    expect(document.querySelector('[data-screen="pair"]')).toBeTruthy();
    expect(screen.getByTestId('scanner')).toBeTruthy();
    expect(screen.queryByText('电脑端装好了吗?')).toBeNull();
  });

  it('不给就照旧是欢迎屏', async () => {
    render(<LoginPage onPaired={() => {}} discover={discover} scanner={FakeScanner} />);
    await act(async () => {});
    expect(screen.getByText('电脑端装好了吗?')).toBeTruthy();
    expect(screen.queryByTestId('scanner')).toBeNull();
  });
});
