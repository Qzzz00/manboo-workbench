/**
 * 「房间凭证从中转领」(2026-09-21)。这是「手机出门随时进房」那条功能缺的最后一环。
 *
 * 以前只有一条路:局域网里向电脑上的 8791 要(`POST /channel/token`)。
 * 于是 ——「第一次出门之前必须回过一次家」,而且 7 天到期时人在外面就续不上了。
 *
 * 现在多了这一条:手机拿自己的设备令牌直接向中转要。两条路**同时留着**,顺序是
 * **中转优先、8791 兜底**:
 *
 * - 中转优先,是因为它在任何网络下都成立,而 8791 只在同一个局域网里成立;
 * - 8791 兜底,是因为老手机包(0.2.51 之前)与还没登录账号的手机只有这一条路,
 *   而且开发机上起着本机 livekit-server 时,8791 签的那张才指向本机那一间
 *   (与电脑端 channel.ts「本机那份优先」同一个道理的反面:手机这边没有本机那份)。
 *
 * ## 身份必须与电脑端拼得一模一样
 *
 * `wb-phone-<清洗过的 device_id>` + 属性 `wb_device_id: <原样 device_id>`。
 * 电脑上的工人正是靠那条属性决定"用谁的权限去调 8791"(workbench-plugin/src/server/channel.ts
 * 的 channelIdentityOf 与 CHANNEL_DEVICE_ATTRIBUTE)。拼错一个字符,进得了房但什么都干不了。
 */
import type { WbchCredential } from '../channel/credentialStore.ts';
import { relayChannelCredentials, relayChannelToken, type RelayResult } from './relayApi.ts';
import type { AccountStore } from './accountStore.ts';

/** 与 workbench-plugin/src/server/channel.ts 的 CHANNEL_PHONE_PREFIX 同一个值。 */
export const PHONE_IDENTITY_PREFIX = 'wb-phone-';
/** 与 workbench-plugin/src/server/channel.ts 的 CHANNEL_DEVICE_ATTRIBUTE 同一个值。 */
export const DEVICE_ID_ATTRIBUTE = 'wb_device_id';

/** identity 要进房间列表与日志,所以只留一眼看得懂的那几类字符(与电脑端那份 clean 一致)。 */
export function phoneIdentityOf(deviceId: string): string {
  return `${PHONE_IDENTITY_PREFIX}${deviceId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 48)}`;
}

/** 中转说这台手机的设备令牌不认了(401)时那句话。 */
export const RELAY_DEVICE_REVOKED_TEXT = '这台手机已经从账号里移除了。重新用账号登录一次就能回来。';

export interface RelayRoomSource {
  /**
   * 向中转领一张进房凭证。**没登录账号 / 没有设备令牌时回 `null`** ——
   * 那不是错误,那是"这台手机还没走这条路",调用方该去走 8791 那条。
   */
  credential(): Promise<{ ok: true; credential: WbchCredential } | { ok: false; error: string; revoked?: true } | null>;
}

export interface RelayRoomSourceDeps {
  store: AccountStore;
  /** 房里显示的名字(手机型号之类)。可有可无。 */
  name?: string;
  fetchImpl?: typeof fetch;
  /**
   * 这一次配对的 device_id(2026-09-23 第二轮从零重装)。给了就**只认同一台设备的账号记录**:
   * 账号记录是上一次配对留下的(重新扫码时电脑没替它重领 —— 电脑还没登录账号、或者领失败了),
   * 拿它去中转领,领到的是**上一个账号那间房**,手机就又回到了一间没有电脑的房里。
   * 对不上就当没登录(回 null),让 8791 那条去领。不给就不核对(老调用方)。
   */
  deviceId?: string;
}

export function createRelayRoomSource(deps: RelayRoomSourceDeps): RelayRoomSource {
  return {
    async credential() {
      const account = await deps.store.load();
      if (account === null || account.deviceToken === undefined) return null;
      if (deps.deviceId !== undefined && deps.deviceId !== '' && account.deviceId !== deps.deviceId) return null;

      const fetchImpl = deps.fetchImpl;
      const base = {
        relayUrl: account.relayUrl,
        deviceToken: account.deviceToken,
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
      };

      // 先问"房间叫什么、服务器在哪"。房间名由中转按账号算,手机从来不自己拼。
      const where = await relayChannelCredentials(base);
      if (!where.ok) return unauthorizedOr(where);

      const signed = await relayChannelToken({
        ...base,
        identity: phoneIdentityOf(account.deviceId),
        room: where.value.room,
        // **原样的** device_id(不做 identity 那种字符清洗):工人拿它去 8791 查设备,
        // 清洗过反而对不上(与电脑端 channel.ts 那一段同一条规矩)。
        attributes: { [DEVICE_ID_ATTRIBUTE]: account.deviceId },
        ...(deps.name === undefined ? {} : { name: deps.name }),
      });
      if (!signed.ok) return unauthorizedOr(signed);

      return {
        ok: true,
        credential: {
          url: signed.value.url,
          room: signed.value.room,
          identity: signed.value.identity,
          token: signed.value.token,
          expires_at: signed.value.expires_at,
        },
      };
    },
  };

  /**
   * 401 有特别的意思:**这台手机的设备令牌被撤了**(在电脑的「我的设备」里移除了,
   * 或者账号那边登出了)。说清楚,别让人对着"连不上"猜半天。
   */
  function unauthorizedOr<T>(result: Extract<RelayResult<T>, { ok: false }>): { ok: false; error: string; revoked?: true } {
    if (result.status === 401) {
      // `revoked` 是给首页那条「电脑认不认我」的判断用的(2026-09-23 第二轮从零重装):
      // 这是**确定**的「不认」,不是连不上 —— 首页据此直接给「重新扫码配对」,不再猜。
      return { ok: false, error: RELAY_DEVICE_REVOKED_TEXT, revoked: true };
    }
    return { ok: false, error: result.error };
  }
}
