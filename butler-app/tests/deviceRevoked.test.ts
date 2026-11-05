/**
 * 「这台手机已经被移出账号」—— 收到之后手机该停手(2026-10-03,卡 claude/device-revoke-complete;
 * 审计附证 A,docs/审计材料/2026-10-03/devices.md 第 39 行起)。
 *
 * 审计查实的那一条:`fetchCredential` 在中转明说 `revoked` 之后,**仍然无条件去试 8791**,
 * 局域网一通就当成功、还把新房票存了下来。于是「被移除的手机回到家里照样能用」。
 *
 * 这一份盯四件事,全部用真的 `createWbchChannel`:
 *   ① 中转说 revoked → **不再试另一边**(8791 零调用)、不保存房票;
 *   ② 局域网 401 → 同样算「不认这台手机」(没登录账号的老手机只有这一条路);
 *   ③ 判过一次之后 **停止自动重试**:refresh / renewNow / recheckRoom / remote 一条都不再打,
 *      而且 renewNow 回的 `revoked` 让续期那个循环停下来(useChannel 据此不再排下一次);
 *   ④ 界面那一句与那颗键:`relinkNotice` 给的是「电脑不认这台手机了」+「重新扫码配对」,
 *      **不编别的原因**。
 */
import { describe, expect, it } from 'vitest';
import type { ApiClient, ApiResult } from '../src/api/client';
import { createWbchChannel } from '../src/channel/channel';
import { wbchShouldRetryRenew } from '../src/channel/useChannel';
import { WBCH_CREDENTIAL_KEY, createWbchCredentialStore, type WbchCredential } from '../src/channel/credentialStore';
import { RELAY_DEVICE_REVOKED_TEXT } from '../src/account/roomFromRelay';
import {
  RELINK_ACTION_LABEL, RELINK_REVOKED_DETAIL, RELINK_REVOKED_TITLE, relinkNotice,
} from '../src/stage/linkHealth';
import { createFakeLink, memoryStore } from './wbchFakes';

const CREDENTIAL: WbchCredential = {
  url: 'wss://lk.test', room: 'wb-abc', identity: 'wb-phone-dev-1', token: 'jwt-1', expires_at: 9_000_000,
};

/** 电脑在局域网里的那条路。`answer` 决定它这一次回什么,`calls` 看它被打过几次。 */
function direct(answer: () => ApiResult<unknown>): ApiClient & { calls: number } {
  const client = {
    calls: 0,
    baseUrl: 'http://192.168.1.9:8791',
    async json() { client.calls += 1; return answer() as ApiResult<never>; },
    async blob() { return { ok: false as const, status: 0, kind: 'network' as const, error: 'x' }; },
  };
  return client;
}

/**
 * 8791 在设备被撤之后回的那一条(workbench-plugin 那边:401 + 一句人话)。
 * 这句话在这儿**只是夹具**:手机这一侧验的是「401 就停手、并把服务端那句话原样带上去」,
 * 不是逐字比对电脑那边的文案(那条在插件的 `server-device-revoke.test.ts` 里用导出的常量钉)。
 */
const LAN_REVOKED: ApiResult<never> = {
  ok: false, status: 401, kind: 'unauthorized',
  error: '这台设备已经从账号里移除了:要再用它,在电脑上打开配对二维码,重新扫一次。',
};

function wire(options: {
  lan: () => ApiResult<unknown>
  relay?: () => Promise<{ ok: true; credential: WbchCredential } | { ok: false; error: string; revoked?: true } | null>
  stored?: WbchCredential
}) {
  const kv = memoryStore(options.stored === undefined ? {} : { [WBCH_CREDENTIAL_KEY]: JSON.stringify(options.stored) });
  const lan = direct(options.lan);
  const relayCalls = { n: 0 };
  const channel = createWbchChannel({
    direct: lan,
    store: createWbchCredentialStore(kv),
    link: createFakeLink(),
    onUnauthorized: () => {},
    now: () => 1_000_000,
    ...(options.relay === undefined
      ? {}
      : { relay: { credential: async () => { relayCalls.n += 1; return options.relay!(); } } }),
  });
  return { channel, lan, kv, relayCalls };
}

describe('① 中转说 revoked:不再试另一边,也不刷新房票', () => {
  it('8791 一次都不打,存着的那张房票一个字没动', async () => {
    const { channel, lan, kv } = wire({
      // 这条路**本来是通的**(人在家里)—— 正是审计里「回到同一个 Wi-Fi 还能用」那一下。
      lan: () => ({ ok: true, status: 200, data: { ...CREDENTIAL, room: 'wb-new', token: 'jwt-new' } }),
      relay: async () => ({ ok: false, error: RELAY_DEVICE_REVOKED_TEXT, revoked: true }),
      stored: CREDENTIAL,
    });
    const got = await channel.refresh();
    expect(got).toEqual({ ok: false, error: RELAY_DEVICE_REVOKED_TEXT, revoked: true });
    expect(lan.calls).toBe(0);
    expect(channel.credential()).toEqual(CREDENTIAL);
    expect(JSON.parse(kv.map.get(WBCH_CREDENTIAL_KEY) ?? '{}').token).toBe('jwt-1');
  });

  it('presence 当场变成 revoked —— 首页不用等进房就说得出那一句', async () => {
    const { channel } = wire({
      lan: () => ({ ok: true, status: 200, data: CREDENTIAL }),
      relay: async () => ({ ok: false, error: RELAY_DEVICE_REVOKED_TEXT, revoked: true }),
    });
    await channel.refresh();
    expect(channel.presence?.()).toMatchObject({ kind: 'revoked', error: RELAY_DEVICE_REVOKED_TEXT });
  });

  it('中转只是「连不上」(不是 revoked)时照旧退回 8791 —— 老行为一个字没改', async () => {
    const { channel, lan } = wire({
      lan: () => ({ ok: true, status: 200, data: CREDENTIAL }),
      relay: async () => ({ ok: false, error: '连不上账号服务' }),
    });
    expect(await channel.refresh()).toEqual({ ok: true });
    expect(lan.calls).toBe(1);
    expect(channel.credential()).toEqual(CREDENTIAL);
  });
});

describe('② 局域网 401 也算「不认这台手机」', () => {
  it('没有中转那条路的手机:8791 回 401 → revoked,带的是服务端那句话', async () => {
    const { channel } = wire({ lan: () => LAN_REVOKED });
    const got = await channel.refresh();
    expect(got).toEqual({ ok: false, error: LAN_REVOKED.error, revoked: true });
    expect(channel.presence?.()).toMatchObject({ kind: 'revoked' });
  });

  it('两条路都有、中转连不上而 8791 回 401:也判成 revoked,不说成「等会儿再试」', async () => {
    const { channel } = wire({
      lan: () => LAN_REVOKED,
      relay: async () => ({ ok: false, error: '连不上账号服务' }),
    });
    const got = await channel.refresh();
    expect(got).toMatchObject({ revoked: true });
    expect(got.ok).toBe(false);
  });

  it('普通的「连不上工作台」照旧不是 revoked', async () => {
    const { channel } = wire({ lan: () => ({ ok: false, status: 0, kind: 'network', error: '连不上工作台' }) });
    const got = await channel.refresh();
    expect(got).toEqual({ ok: false, error: '连不上工作台' });
    expect(channel.presence?.()).toEqual({ kind: 'unknown' });
  });
});

describe('③ 判过一次之后停止自动重试', () => {
  it('refresh / renewNow / recheckRoom / remote 一条都不再打两条路', async () => {
    const { channel, lan, relayCalls } = wire({
      lan: () => ({ ok: true, status: 200, data: CREDENTIAL }),
      relay: async () => ({ ok: false, error: RELAY_DEVICE_REVOKED_TEXT, revoked: true }),
    });
    await channel.refresh();
    expect(relayCalls.n).toBe(1);

    expect(await channel.refresh()).toMatchObject({ revoked: true });
    expect(await channel.renewNow()).toMatchObject({ revoked: true });
    expect(await channel.recheckRoom?.()).toEqual({ kind: 'revoked', error: RELAY_DEVICE_REVOKED_TEXT });
    expect(await channel.remote()).toEqual({ ok: false, error: RELAY_DEVICE_REVOKED_TEXT });
    // 两条路一次都没再打:不是「少打几次」,是**一次都不打**。
    expect(relayCalls.n).toBe(1);
    expect(lan.calls).toBe(0);
  });

  it('renewNow 回的那一格让续期循环停下来(useChannel 据此不再排下一次)', async () => {
    const { channel } = wire({ lan: () => LAN_REVOKED, stored: CREDENTIAL });
    const renewed = await channel.renewNow();
    expect(renewed.ok).toBe(false);
    expect(renewed).toMatchObject({ revoked: true });
    // 那个循环的判断本身(它在一个 effect 里,所以判断单独拿出来钉)。
    expect(wbchShouldRetryRenew(renewed)).toBe(false);
    expect(wbchShouldRetryRenew({ ok: false, error: '连不上工作台' } as never)).toBe(true);
    expect(wbchShouldRetryRenew({ ok: true } as never)).toBe(false);
  });
});

describe('兄弟路:座机常驻与通话', () => {
  it('座机常驻(holdForRing)也停手,而且说的是那一句 —— 不是「回局域网连一次」', async () => {
    const { channel, lan } = wire({ lan: () => LAN_REVOKED });
    const held = await channel.holdForRing();
    expect(held).toEqual({ ok: false, error: LAN_REVOKED.error });
    expect(channel.presence?.()).toMatchObject({ kind: 'revoked' });
    // 它本来是个一直重试的循环:第二次连门都不敲了。
    expect(await channel.holdForRing()).toEqual({ ok: false, error: LAN_REVOKED.error });
    expect(lan.calls).toBe(1);
  });

  it('打电话(acquireCall)抛的也是那一句', async () => {
    const { channel, lan } = wire({
      lan: () => ({ ok: true, status: 200, data: CREDENTIAL }),
      relay: async () => ({ ok: false, error: RELAY_DEVICE_REVOKED_TEXT, revoked: true }),
    });
    await expect(channel.acquireCall()).rejects.toThrow(RELAY_DEVICE_REVOKED_TEXT);
    expect(lan.calls).toBe(0);
  });
});

describe('④ 界面那一句与那颗键', () => {
  it('presence=revoked → 「电脑不认这台手机了」+「重新扫码配对」', () => {
    const notice = relinkNotice({ connected: false, presence: 'revoked' });
    expect(notice).toEqual({
      kind: 'revoked', title: RELINK_REVOKED_TITLE, detail: RELINK_REVOKED_DETAIL, action: RELINK_ACTION_LABEL,
    });
    // 那句话里要说得出「在电脑上移除了这台手机」这件事,也要说得出下一步。
    expect(RELINK_REVOKED_DETAIL).toContain('移除');
    expect(RELINK_ACTION_LABEL).toBe('重新扫码配对');
  });
});
