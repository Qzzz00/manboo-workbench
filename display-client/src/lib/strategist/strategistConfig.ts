// 军师服务端地址与设备 token 的本地配置。
//
// ★存在**桌面这一侧**（主 App 源），底条 WebView（pet.localhost）不同源读不到，
// 由 handheldStrip 折进 petQuery / Intent extra 下发——与底条取景走的是同一条路。
// ★token 不进 petQuery（URL 会被 loadUrl 与 PetOverlayWeb console 打进 logcat），
// 走 Intent extra 的 token 通道注入，见 overlayPlugin.overlayStart 的 ctx.token。

import { AIBOO_DEFAULT_BASE_URL } from '../aibooDefault';

const KEY = 'aiboo:strategist-config';

export type StrategistConfig = {
  /**
   * 军师服务端根地址，无末尾斜杠。默认是阿里云上的公网部署（Caddy 反代 → 本机 8080，
   * 见 strategist/deploy-server.sh）—— 掌机连的是 VR_GUEST 访客网，有客户端隔离，
   * ping 不到 Mac，局域网那条路走不通，所以默认就该是公网而不是 `adb reverse`。
   * 本地开发要连 Mac 上的 docker compose，在设置页手填 `http://127.0.0.1:8080` 并
   * `adb reverse tcp:8080 tcp:8080`。
   */
  baseUrl: string;
  deviceToken: string;
  /**
   * Aiboo 后台（阿里云）根地址 —— **语音**走它，不是军师服务端。
   * 公网可达，所以语音这条即使掌机没插 USB 也能用。
   */
  aibooBaseUrl: string;
  /** Aiboo 后台的设备 token（deviceOrUserAuth 中间件认它；掌机是启动器没有用户 JWT）。 */
  aibooDeviceToken: string;
};

export const DEFAULT_STRATEGIST_CONFIG: StrategistConfig = {
  baseUrl: 'https://js.aibooo.cn',
  deviceToken: '',
  aibooBaseUrl: AIBOO_DEFAULT_BASE_URL,
  aibooDeviceToken: '',
};

/** 合法就返回去掉末尾斜杠的地址，否则 null。要求 scheme + 非空 host。 */
function validBaseUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/\/+$/, '');
  // 至少 http(s)://x.y 或 http://host:port —— 只写 "http://1" 这种半截地址不收
  if (!/^https?:\/\/[^\s/:]+(\.[^\s/:]+|:\d+)/.test(s)) return null;
  return s;
}

export function normalizeStrategistConfig(
  raw: Partial<StrategistConfig> | null | undefined,
): StrategistConfig {
  return {
    baseUrl: validBaseUrl(raw?.baseUrl) ?? DEFAULT_STRATEGIST_CONFIG.baseUrl,
    // 手输 token 很容易带前后空格，带了就 401，这里剪掉。
    deviceToken: typeof raw?.deviceToken === 'string' ? raw.deviceToken.trim() : '',
    aibooBaseUrl: validBaseUrl(raw?.aibooBaseUrl) ?? DEFAULT_STRATEGIST_CONFIG.aibooBaseUrl,
    aibooDeviceToken:
      typeof raw?.aibooDeviceToken === 'string' ? raw.aibooDeviceToken.trim() : '',
  };
}

export function loadStrategistConfig(): StrategistConfig {
  try {
    const raw = localStorage.getItem(KEY);
    return normalizeStrategistConfig(raw ? (JSON.parse(raw) as Partial<StrategistConfig>) : null);
  } catch {
    // 存储不可用 / JSON 坏了：回默认。桌面绝不能因为读设置失败而起不来。
    return { ...DEFAULT_STRATEGIST_CONFIG };
  }
}

export function saveStrategistConfig(next: Partial<StrategistConfig>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(normalizeStrategistConfig(next)));
  } catch {
    /* 存不进去本次会话内仍生效 */
  }
}
