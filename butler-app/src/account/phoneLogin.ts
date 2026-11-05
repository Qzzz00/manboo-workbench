/**
 * 手机上的「登录」,两条路(2026-09-21)。
 *
 * 在这张卡之前,手机上的登录 = 扫电脑上的二维码配对,没有第二条路;
 * 于是「换手机」「重装」「电脑不在手边」这三件事都做不了,而它们都很常见。
 *
 * 现在:
 *
 * | 路 | 用户做什么 | 拿到什么 | 什么时候用 |
 * |---|---|---|---|
 * | **账号登录** | 输邮箱/手机号 + 密码 | 账号会话 + 这台手机的设备令牌 | 新手机、重装、电脑不在手边 |
 * | **扫码配对(快捷方式)** | 扫电脑上的码 | 设备令牌(电脑替它去领的) | 电脑就在跟前,懒得在小屏上打密码 |
 *
 * 两条殊途同归:手机手上有一把**自己的设备令牌**,之后它就能自己向中转领房间凭证,
 * 再也不需要那台电脑在同一个局域网里(roomFromRelay.ts)。
 *
 * 密码**从不存**。登录那一次请求之后,这台手机上不该再有它的任何形式。
 */
import type { ApiClient } from '../api/client';
import type { AccountRecord, AccountStore } from './accountStore';
import { relayLogin, relayLogout, relayRegister, relayRegisterDevice } from './relayApi';

export type PhoneLoginResult =
  | { ok: true; account: AccountRecord }
  | { ok: false; error: string };

export interface PhoneLoginInput {
  relayUrl: string;
  identifier: string;
  password: string;
  /** 登录还是注册。注册的文案与登录页那两个页签一一对应。 */
  mode: 'login' | 'register';
  /** 这台手机的 id。配过对就用配对那一份;没配过就现生成一个(newPhoneDeviceId)。 */
  deviceId: string;
  /** 显示在电脑「我的设备」里的名字。 */
  deviceName?: string;
  store: AccountStore;
  fetchImpl?: typeof fetch;
}

/**
 * 一台从没配过对的手机,自己的 id 从哪儿来。
 * 随机 16 字节十六进制 —— 不掺任何设备指纹:它只要"同一台手机每次是同一个",
 * 不需要"能认出这是哪一台真机"。
 */
export function newPhoneDeviceId(random: (n: number) => Uint8Array = defaultRandom): string {
  return [...random(16)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function defaultRandom(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

/**
 * 账号登录/注册,然后顺手把这台手机挂到账号下。
 *
 * **两步之间失败怎么办**:会话已经拿到、设备令牌没领到 —— 这时候**把会话存下来**再报错。
 * 不存的话,人得把密码再输一遍才能重试,而失败原因多半是一次网络抖动。
 */
export async function phoneAccountLogin(input: PhoneLoginInput): Promise<PhoneLoginResult> {
  const identifier = input.identifier.trim();
  if (identifier === '') return { ok: false, error: '请填登录用的邮箱或手机号' };
  if (input.password === '') return { ok: false, error: '请填密码' };

  const base = {
    relayUrl: input.relayUrl,
    identifier,
    password: input.password,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  };
  const signed = input.mode === 'register' ? await relayRegister(base) : await relayLogin(base);
  if (!signed.ok) return { ok: false, error: signed.error };

  const partial: AccountRecord = {
    relayUrl: input.relayUrl,
    deviceId: input.deviceId,
    identifier: signed.value.account.email_or_phone,
    accountId: signed.value.account.id,
    sessionToken: signed.value.session_token,
  };
  await input.store.save(partial);

  const device = await relayRegisterDevice({
    relayUrl: input.relayUrl,
    session: signed.value.session_token,
    deviceId: input.deviceId,
    ...(input.deviceName === undefined ? {} : { name: input.deviceName }),
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  });
  if (!device.ok) return { ok: false, error: device.error };

  const account: AccountRecord = { ...partial, deviceToken: device.value.token };
  await input.store.save(account);
  return { ok: true, account };
}

/** 手机上的退出登录:吊销服务器那张会话,清掉本地那份。吊销失败也照样本地下线。 */
export async function phoneAccountLogout(store: AccountStore, fetchImpl?: typeof fetch): Promise<void> {
  const account = await store.load();
  if (account?.sessionToken !== undefined) {
    await relayLogout({
      relayUrl: account.relayUrl,
      session: account.sessionToken,
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });
  }
  await store.clear();
}

/**
 * 扫码配对那条**快捷方式**:配对成功之后,让电脑替这台手机去中转领一把设备令牌。
 *
 * 为什么由电脑代领:领它要账号会话,而账号会话是密码换来的,一个字节都不该进手机。
 * 电脑那头的路由是 `POST /channel/relay-device`(workbench-plugin/src/server/http.ts),
 * 门与取进房凭证同一道 —— 只有已配对的手机进得来。
 *
 * **失败一律不吵**:电脑上还没登录账号、还是老版本的工作台、账号功能没部署,
 * 都会走到这里,而它们都不影响"手机在局域网里照常能用"。
 * 影响的只是"出门还能不能进房",那件事在设置页里另说。
 */
export async function linkPairedPhone(input: {
  direct: ApiClient;
  store: AccountStore;
  deviceId: string;
  deviceName?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await input.direct.json<{ relay_url?: unknown; token?: unknown }>('/channel/relay-device', {
    method: 'POST',
    body: input.deviceName === undefined ? {} : { name: input.deviceName },
  });
  if (!result.ok) return { ok: false, error: result.error };
  const relayUrl = typeof result.data.relay_url === 'string' ? result.data.relay_url.trim() : '';
  const token = typeof result.data.token === 'string' ? result.data.token.trim() : '';
  if (relayUrl === '' || token === '') return { ok: false, error: '电脑回的内容缺字段,没拿到令牌' };
  await input.store.link({ relayUrl, deviceId: input.deviceId, deviceToken: token });
  return { ok: true };
}
