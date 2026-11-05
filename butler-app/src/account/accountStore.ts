/**
 * 手机上的账号登录态(2026-09-21)。两把令牌 + 一个地址,存在 Capacitor Preferences
 * (安卓那边落在 SharedPreferences,与设备令牌 api/tokenStore.ts 同一处)。
 *
 * 纪律与设备令牌一模一样,而且这两把更要紧:
 *   - **只在这里和请求头里出现**:不打日志、不进 URL、不进任何界面文案、不进错误消息;
 *   - 密码**从不存**。登录那一次请求之后它就不该在这台手机上以任何形式存在;
 *   - 读坏了当成"没登录"而不是抛 —— 坏文件不该把人锁在门外(同工作台那边的口径)。
 *
 * 为什么会话令牌与设备令牌分开存两个字段:它们的寿命不一样。
 * 会话令牌是"这台手机上还登着"(长期,自己登出或在「我的设备」里被移除才没);
 * 设备令牌是"这台设备的钥匙"(重领会换一把)。混成一个字段,换钥匙时会把登录态一起弄丢。
 */
import type { KeyValueStore } from '../api/tokenStore.ts';

declare const __WORKBENCH_BUILD_RELAY_URL__: unknown;

/**
 * 中转的缺省地址 = 这份手机包构建时带的那一个(vite.config.ts 经 scripts/build-relay.mjs 注入,2026-10-21 局域网 M7):
 * 我们的包是我们那台(与电脑端 modelConfig.ts 的 DEFAULT_RELAY_URL 同一个值),**开源构建是空** = 这份手机包没接中转。
 * 没注入到(用例)就是空。
 */
export const DEFAULT_RELAY_URL: string = typeof __WORKBENCH_BUILD_RELAY_URL__ === 'string' ? __WORKBENCH_BUILD_RELAY_URL__ : '';

export const ACCOUNT_KEY = 'butler.account';

export interface AccountRecord {
  /** 中转地址。存下来是因为灰度实例要指到别处去,而它不该每次都靠猜。 */
  relayUrl: string;
  /** 这台手机在账号里的 id(与局域网配对那份 deviceId 同一个值,不另起一个)。 */
  deviceId: string;
  /**
   * 这台手机的设备令牌 `wb_…`。**领房间凭证用的就是它**,也是这份记录里唯一真正必需的钥匙。
   *
   * 两条路都能拿到它,所以它和下面那三样是可以分开出现的:
   * ① 在手机上用账号密码登录 → 有 identifier / sessionToken,也有它;
   * ② 扫码配对的快捷方式(POST /channel/relay-device)→ 电脑替它领的,
   *    **手机上没有账号会话**(那是密码换来的,一个字节都不该进手机)。
   */
  deviceToken?: string;
  /** 登录用的邮箱/手机号。**不是秘密**:设置页要显示"登录为 xxx"。走快捷方式时缺席。 */
  identifier?: string;
  accountId?: string;
  /** 账号会话令牌 `wbs_…`。**永远不出这个文件与请求头**。走快捷方式时缺席。 */
  sessionToken?: string;
}

export interface AccountStore {
  load(): Promise<AccountRecord | null>;
  save(record: AccountRecord): Promise<void>;
  /** 只换设备令牌,不动登录态(重领钥匙时用)。没有记录就什么也不做。 */
  setDeviceToken(token: string): Promise<void>;
  /** 扫码配对那条快捷方式用:写入地址 + 设备 id + 设备令牌,已有的账号会话原样留着。 */
  link(record: Pick<AccountRecord, 'relayUrl' | 'deviceId' | 'deviceToken'>): Promise<void>;
  clear(): Promise<void>;
}

function isRecord(value: unknown): value is AccountRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.relayUrl === 'string' && v.relayUrl !== ''
    && typeof v.deviceId === 'string' && v.deviceId !== '';
}

/** 存坏的可选字段丢掉就好,不为它把整份记录判废(那等于无故把人踢下线)。 */
function normalize(record: AccountRecord): AccountRecord {
  const keep = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
  const deviceToken = keep(record.deviceToken);
  const identifier = keep(record.identifier);
  const accountId = keep(record.accountId);
  const sessionToken = keep(record.sessionToken);
  return {
    relayUrl: record.relayUrl,
    deviceId: record.deviceId,
    ...(deviceToken === undefined ? {} : { deviceToken }),
    ...(identifier === undefined ? {} : { identifier }),
    ...(accountId === undefined ? {} : { accountId }),
    ...(sessionToken === undefined ? {} : { sessionToken }),
  };
}

export function createAccountStore(kv: KeyValueStore): AccountStore {
  return {
    async load() {
      try {
        const raw = await kv.get(ACCOUNT_KEY);
        if (raw === null || raw === '') return null;
        const parsed: unknown = JSON.parse(raw);
        return isRecord(parsed) ? normalize(parsed) : null;
      } catch {
        return null;
      }
    },
    async save(record) {
      try { await kv.set(ACCOUNT_KEY, JSON.stringify(normalize(record))); } catch { /* 存不了下次重登 */ }
    },
    async setDeviceToken(token) {
      try {
        const raw = await kv.get(ACCOUNT_KEY);
        if (raw === null || raw === '') return;
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed)) return;
        await kv.set(ACCOUNT_KEY, JSON.stringify(normalize({ ...parsed, deviceToken: token })));
      } catch { /* 同上 */ }
    },
    async link(record) {
      // 快捷方式那条路:只写地址、设备 id 与设备令牌,**不碰已有的账号会话**
      // (那台手机可能刚用密码登录过,别把它挤掉)。
      try {
        const raw = await kv.get(ACCOUNT_KEY);
        let previous: AccountRecord | null = null;
        if (raw !== null && raw !== '') {
          const parsed: unknown = JSON.parse(raw);
          if (isRecord(parsed)) previous = normalize(parsed);
        }
        await kv.set(ACCOUNT_KEY, JSON.stringify(normalize({ ...(previous ?? {}), ...record })));
      } catch { /* 存不了下次重来 */ }
    },
    async clear() {
      try { await kv.remove(ACCOUNT_KEY); } catch { /* 同上 */ }
    },
  };
}
