/**
 * 手机自己跟着搬进账号那间房(2026-09-28,卡 PH)。
 *
 * 现场:Air 升级后带账号重领机器令牌,工人搬进账号房间 `wb-66d1…`;配对过的小米随后一直显示
 * 「电脑上的工作台没在运行」,中转日志里它**一次都没来领过进房凭证**。死结在两处:
 *   ① 手机问「电脑在哪一间房」(`/channel/status`)走的正是**旧房间里的代理** ——
 *      电脑已经搬走,那间房里没人应,于是永远问不到房间名,卡 RM ③ 那条「房间名不一样就搬」
 *      永远触发不了;
 *   ② 问不到的时候手机什么都不做。
 *
 * 所以这一份钉三件事:
 *   1. 问不到 status 时**也去核对房间**(`channelShouldRecheckRoom`);
 *   2. 核对走的是「中转优先」—— 手机拿**自己挂在账号下的设备令牌**直接问账号那间房,
 *      跟旧房间里那台走没走没有关系;拿到的房间不同就连着搬过去;
 *   3. **没有账号令牌**的那一台(老的纯扫码配对)如实说「电脑换了连接方式,重新扫一次码」,
 *      不许说成「电脑上的工作台没在运行」—— 电脑好好的。
 */
import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../src/api/client';
import { channelShouldRecheckRoom } from '../src/api/call';
import {
  WBCH_NO_ACCOUNT_ROOM_TEXT,
  createWbchChannel,
  type WbchChannel,
} from '../src/channel/channel';
import { WBCH_CREDENTIAL_KEY, createWbchCredentialStore, type WbchCredential } from '../src/channel/credentialStore';
import type { RelayRoomSource } from '../src/account/roomFromRelay';
import { RELINK_ACTION_LABEL, RELINK_NO_ACCOUNT_TITLE, RELINK_QUIT_TITLE, relinkNotice } from '../src/stage/linkHealth';
import { createFakeLink, memoryStore } from './wbchFakes';

/** 手上那张:电脑经 8791 代签的 legacy 房间。 */
const OLD: WbchCredential = { url: 'wss://lk.test', room: 'workbench-air', identity: 'wb-phone-mi', token: 'jwt-old', expires_at: 2_000_000_000 };
/** 中转按账号算出来的那一间(电脑搬过去了)。 */
const ACCOUNT_ROOM: WbchCredential = { url: 'wss://lk.test', room: 'wb-66d1f29951443b3e', identity: 'wb-phone-mi', token: 'jwt-acct', expires_at: 2_000_000_000 };

/** 8791:出了局域网(或电脑睡着)一律不通。 */
function deadLan(): ApiClient & { calls: number } {
  const client = {
    calls: 0,
    baseUrl: 'http://10.0.0.9:8791',
    async json() { client.calls += 1; return { ok: false as const, status: 0, kind: 'network' as const, error: '连不上工作台' }; },
    async blob() { return { ok: false as const, status: 0, kind: 'network' as const, error: '连不上工作台' }; },
  };
  return client;
}

/** 中转那条路。`null` = 这台手机没有挂在账号下的设备令牌。 */
function relayOf(answer: () => Awaited<ReturnType<RelayRoomSource['credential']>>): RelayRoomSource & { calls: number } {
  const source = { calls: 0, async credential() { source.calls += 1; return answer(); } };
  return source;
}

function wire(relay: RelayRoomSource | undefined): {
  channel: WbchChannel;
  link: ReturnType<typeof createFakeLink>;
  switched: WbchCredential[];
  lan: ApiClient & { calls: number };
} {
  const kv = memoryStore({ [WBCH_CREDENTIAL_KEY]: JSON.stringify(OLD) });
  const link = createFakeLink();
  const switched: WbchCredential[] = [];
  link.switchRoom = async (credential) => { switched.push(credential); };
  // 房里没有电脑,而且它是「自己退了」那一种走法(工人搬房时正是这样离开旧房间的)。
  link.workerPresent = () => false;
  link.workerDeparture = () => 'closed';
  const lan = deadLan();
  const channel = createWbchChannel({
    direct: lan,
    store: createWbchCredentialStore(kv),
    onUnauthorized: () => {},
    link,
    now: () => 1_000_000,
    // 用例里不等那三秒:等不等与这张卡要钉的事无关。
    workerGraceMs: 0,
    ...(relay === undefined ? {} : { relay }),
  });
  return { channel, link, switched, lan };
}

describe('①「问不到电脑在哪一间房」时也要去核对', () => {
  it('压根没问到(旧房间里没人应)→ 去核对', () => {
    expect(channelShouldRecheckRoom({ checked: false }, 'workbench-air')).toBe(true);
  });

  it('问到了、房间不一样 → 去核对(卡 RM ③ 那条原样留着)', () => {
    expect(channelShouldRecheckRoom({ checked: true, room: 'wb-66d1' }, 'workbench-air')).toBe(true);
  });

  it('问到了、就是这一间 → 什么都不做', () => {
    expect(channelShouldRecheckRoom({ checked: true, room: 'workbench-air' }, 'workbench-air')).toBe(false);
  });

  it('手上压根没有凭证 → 不判搬家(凭空搬一次会把一条好连接踢掉)', () => {
    expect(channelShouldRecheckRoom({ checked: true, room: 'wb-66d1' }, undefined)).toBe(false);
  });
});

describe('② 电脑搬走了:手机拿自己的账号令牌直接向中转要新房间', () => {
  it('中转给了另一间房 → 换上新凭证、持有一起搬过去(不用重新扫码)', async () => {
    const relay = relayOf(() => ({ ok: true, credential: ACCOUNT_ROOM }));
    const { channel, switched } = wire(relay);
    await channel.acquireCall();

    expect(await channel.recheckRoom?.()).toEqual({ kind: 'moved', from: 'workbench-air', to: 'wb-66d1f29951443b3e' });
    expect(relay.calls).toBe(1);
    expect(switched.map((c) => c.room)).toEqual(['wb-66d1f29951443b3e']);
    expect(channel.credential()?.token).toBe('jwt-acct');
  });

  it('电脑在房里消失之后那条请求自己就走了这条路:8791 不通也照样搬得过去', async () => {
    const relay = relayOf(() => ({ ok: true, credential: ACCOUNT_ROOM }));
    const { channel, switched, lan } = wire(relay);
    // 远程那条路:进房 → 等不到电脑 → 核对房间 → 搬过去。
    await channel.remote();
    expect(switched.map((c) => c.room)).toEqual(['wb-66d1f29951443b3e']);
    // 中转在前、8791 只是兜底:中转给出答案时压根不问 8791。
    expect(relay.calls).toBe(1);
    expect(lan.calls).toBe(0);
  });

  it('中转说还是这一间 → 不换房(电脑是真的不在,照 departure 说人话)', async () => {
    const relay = relayOf(() => ({ ok: true, credential: { ...OLD, token: 'jwt-2' } }));
    const { channel, switched } = wire(relay);
    await channel.acquireCall();
    expect(await channel.recheckRoom?.()).toEqual({ kind: 'same' });
    expect(switched).toEqual([]);
  });
});

describe('③ 没有账号令牌的那一台:说人话,不说「工作台没在运行」', () => {
  it('中转那条路走不了 + 8791 也不通 → no_account,而不是「问不到」', async () => {
    const relay = relayOf(() => null);
    const { channel, lan } = wire(relay);
    await channel.acquireCall();
    expect(await channel.recheckRoom?.()).toEqual({ kind: 'no_account', error: '连不上工作台' });
    // 兜底那条确实试过了(在局域网里它能救回来)。
    expect(lan.calls).toBe(1);
  });

  it('那条请求回的是「重新扫一次码」,presence 里记着 no_account', async () => {
    const { channel } = wire(relayOf(() => null));
    const result = await channel.remote();
    expect(result).toEqual({ ok: false, error: WBCH_NO_ACCOUNT_ROOM_TEXT });
    const presence = channel.presence?.();
    expect(presence?.kind).toBe('absent');
    expect(presence?.kind === 'absent' ? presence.check : undefined).toBe('no_account');
    // 缓存期内的下一条请求说的是同一句话(不许退回「工作台没在运行」那一套)。
    expect(await channel.remote()).toEqual({ ok: false, error: WBCH_NO_ACCOUNT_ROOM_TEXT });
  });

  it('压根没有中转那条路的老调用方:口径一个字不动,还是「问不到」', async () => {
    const { channel } = wire(undefined);
    await channel.acquireCall();
    expect(await channel.recheckRoom?.()).toEqual({ kind: 'unknown', error: '连不上工作台' });
  });
});

describe('④ 首页那句话', () => {
  it('no_account 压过 departure:说「电脑换了连接方式」+ 重新扫码,不说「工作台没在运行」', () => {
    const notice = relinkNotice({ connected: false, presence: 'absent', departure: 'closed', check: 'no_account' });
    expect(notice?.title).toBe(RELINK_NO_ACCOUNT_TITLE);
    expect(notice?.action).toBe(RELINK_ACTION_LABEL);
  });

  it('核对结果不是 no_account 时,卡 AW 那三路一个字没动', () => {
    expect(relinkNotice({ connected: false, presence: 'absent', departure: 'closed', check: 'same' })?.title).toBe(RELINK_QUIT_TITLE);
    expect(relinkNotice({ connected: false, presence: 'absent', departure: 'closed' })?.title).toBe(RELINK_QUIT_TITLE);
  });
});
