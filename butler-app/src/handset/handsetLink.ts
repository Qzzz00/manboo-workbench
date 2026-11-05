/**
 * 「添加座机」最后一步:**给座机换一把中转设备令牌**(2026-09-27,卡 HS)。
 *
 * 09-22 那一版只有一条路:手机拿**自己的账号会话**去中转领。可扫码配对进来的手机
 * 按设计**根本没有账号会话**(密码只在电脑上,见 account/accountStore.ts),
 * 于是维护者 09-27 走到这一步时蓝牙、Wi-Fi 全通了,屏上却是「这台手机还没登录账号」。
 *
 * 所以现在两条路,顺序固定:
 *
 *   ① 手机自己登录过账号 → 自己去中转领(和以前一模一样);
 *   ② 没登录 → **请电脑代办**:`POST /channel/relay-handset`,电脑拿它自己的账号会话
 *      替这台座机去中转领(workbench-plugin/src/server/http.ts 那一条),回一把令牌。
 *      走的是 session 那个选好路的客户端,和别的 8791 请求同一条 —— 出了局域网经房间代理
 *      (channel-worker/src/rpc.ts 的白名单里有它)。
 *
 * **令牌只在返回值里经手**:不进 state、不进日志、不进任何界面文案(同 accountStore.ts 的老规矩)。
 * 失败时的话**说清卡在哪一步**(电脑没登录 / 联系不上电脑 / 中转拒了),因为这三件的下一步完全不同。
 */
import type { ApiClient } from '../api/client';
import type { AccountStore } from '../account/accountStore';
import { relayRegisterDevice } from '../account/relayApi';
import { TEXT } from './provisionProtocol';

/**
 * **记到了谁名下**(2026-09-27,卡 RM ②)。电脑代办那条路会回这两样,手机原样显示在
 * 成功那一屏 —— 「已经记到你的账号下」太含糊:比赛现场那只座机记到的是**另一台电脑**的
 * 账号,而屏上那句话照样是绿的。手机自己领的那条路上没有这两样(那就是它自己的账号),
 * 取不到就缺席,**不编**。
 */
export interface HandsetBoundTo {
  computer?: string;
  account?: string;
}

export type HandsetTokenResult =
  | { ok: true; relayUrl: string; token: string; boundTo?: HandsetBoundTo }
  | { ok: false; error: string };

/** 「记到了 <电脑名> · <账号名> 下」。两样都没有就回 undefined —— 那一行整句不出。 */
export function handsetBoundText(boundTo: HandsetBoundTo | undefined): string | undefined {
  const parts = [boundTo?.computer, boundTo?.account].filter(
    (one): one is string => typeof one === 'string' && one.trim() !== '',
  );
  return parts.length === 0 ? undefined : `记到了 ${parts.join(' · ')} 下。`;
}

export interface HandsetTokenInput {
  /** 手机自己的账号(有会话令牌就自己领)。可缺。 */
  store?: AccountStore;
  /** 选好路的那个客户端(局域网直连 / 经房间代理)。可缺:老的假 Session 没有它。 */
  client?: Pick<ApiClient, 'json'>;
  /** 座机自己报上来的那个编号(`handset-…`)。 */
  deviceId: string;
  /** 显示用的名字。 */
  name: string;
  fetchImpl?: typeof fetch;
}

/** 电脑回来的那一份长得对不对。**少一样就当没拿到** —— 半把钥匙交下去比不交更糟。 */
function pick(data: { relay_url?: unknown; token?: unknown; computer?: unknown; account?: unknown }): HandsetTokenResult {
  const relayUrl = typeof data.relay_url === 'string' ? data.relay_url.trim() : '';
  const token = typeof data.token === 'string' ? data.token.trim() : '';
  if (relayUrl === '' || token === '') return { ok: false, error: TEXT.linkRelayBad };
  const one = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 64) : undefined;
  const boundTo: HandsetBoundTo = {
    ...(one(data.computer) === undefined ? {} : { computer: one(data.computer) as string }),
    ...(one(data.account) === undefined ? {} : { account: one(data.account) as string }),
  };
  return {
    ok: true,
    relayUrl,
    token,
    ...(Object.keys(boundTo).length === 0 ? {} : { boundTo }),
  };
}

export async function issueHandsetToken(input: HandsetTokenInput): Promise<HandsetTokenResult> {
  const account = input.store === undefined ? null : await input.store.load();
  // ① 这台手机自己登录过账号:自己领(老路,一个字没改)。
  if (account !== null && account.sessionToken !== undefined) {
    const issued = await relayRegisterDevice({
      relayUrl: account.relayUrl,
      session: account.sessionToken,
      deviceId: input.deviceId,
      name: input.name,
      /**
       * **报 `handset`**(2026-09-23)。中转按注册时这一列签进房凭证的 `wb_kind`,
       * 报 `other` 的它一个字不动 —— 于是这只话筒经中转进房时工人当它是手机,声音走错端。
       */
      kind: 'handset',
      ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    });
    if (!issued.ok) return { ok: false, error: issued.error };
    return { ok: true, relayUrl: account.relayUrl, token: issued.value.token };
  }

  // ② 没登录:请电脑代办。**这才是扫码配对那台手机的常态**。
  if (input.client === undefined) return { ok: false, error: TEXT.needAccount };
  const asked = await input.client.json<{ relay_url?: unknown; token?: unknown }>('/channel/relay-handset', {
    method: 'POST',
    body: { device_id: input.deviceId, name: input.name },
  });
  if (asked.ok) return pick(asked.data);
  // 三种失败,三句不同的话 —— 下一步做什么完全不一样。
  if (asked.kind === 'network') return { ok: false, error: TEXT.linkNoComputer };
  if (asked.kind === 'unauthorized') return { ok: false, error: TEXT.linkNotPaired };
  // 电脑没登录账号(409)、中转拒了(503)、这台电脑还是老版本(404):
  // 电脑那边的话已经写好了(含「去电脑上登录一次」),**原样带上来**,只补一句「网不用重配」。
  return { ok: false, error: `${asked.error}(座机的网已经配好了,不用重配)` };
}
