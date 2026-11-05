/**
 * 设备令牌与配对地址的存取。底层是 Capacitor Preferences(安卓 SharedPreferences),
 * 抽成 KeyValueStore 接口是为了测试能塞一个内存实现。
 *
 * 令牌只在这里和请求头里出现:不打日志、不进 URL(唯一例外是 /live 的 ?token=,浏览器 WebSocket 设不了请求头)。
 */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface Pairing {
  token: string;
  host: string;
  port: number;
  deviceId: string;
  /**
   * 配对那一刻工作台在 mDNS 里报的名字(`工作台 · <主机名>`),给「已登录:工作台 · xxx」用。
   * 可有可无:扫码进来、或者当时没广播就没有,界面退回显示地址(见 login/loginModel.ts 的 workbenchLabel)。
   */
  workbenchName?: string;
  /**
   * 配对的那台 Mac 的机器 id(局域网 M2 起 `/pair/claim` 回 `mac_id`)。在家的判据之一是「答话的就是这一台」;
   * 同一个局域网里有好几台工作台时,只认它。老配对没有:路线驱动另有办法认回来(routeDriver.ts)。
   */
  macId?: string;
}

export interface TokenStore {
  load(): Promise<Pairing | null>;
  save(pairing: Pairing): Promise<void>;
  clear(): Promise<void>;
}

export const PAIRING_KEY = 'butler.pairing';

function isPairing(value: unknown): value is Pairing {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.token === 'string' && v.token !== ''
    && typeof v.host === 'string' && v.host !== ''
    && typeof v.port === 'number' && Number.isInteger(v.port)
    && typeof v.deviceId === 'string';
}

/** 显示用的名字存坏了就丢掉它——不为一个显示字段把整份令牌判废(那等于无故把人踢下线)。 */
function normalize(pairing: Pairing): Pairing {
  const { workbenchName, macId, ...core } = pairing;
  return {
    ...core,
    ...(typeof workbenchName === 'string' && workbenchName !== '' ? { workbenchName } : {}),
    ...(typeof macId === 'string' && macId !== '' ? { macId } : {}),
  };
}

export function createTokenStore(kv: KeyValueStore): TokenStore {
  return {
    async load() {
      try {
        const raw = await kv.get(PAIRING_KEY);
        if (raw === null || raw === '') return null;
        const parsed: unknown = JSON.parse(raw);
        return isPairing(parsed) ? normalize(parsed) : null;
      } catch {
        return null;
      }
    },
    async save(pairing) {
      try { await kv.set(PAIRING_KEY, JSON.stringify(normalize(pairing))); } catch { /* 存不了下次重配 */ }
    },
    async clear() {
      try { await kv.remove(PAIRING_KEY); } catch { /* 同上 */ }
    },
  };
}

/** Capacitor Preferences 适配。放在函数里懒加载,测试环境不碰原生桥。 */
export function preferencesStore(): KeyValueStore {
  return {
    async get(key) {
      const { Preferences } = await import('@capacitor/preferences');
      const { value } = await Preferences.get({ key });
      return value;
    },
    async set(key, value) {
      const { Preferences } = await import('@capacitor/preferences');
      await Preferences.set({ key, value });
    },
    async remove(key) {
      const { Preferences } = await import('@capacitor/preferences');
      await Preferences.remove({ key });
    },
  };
}
