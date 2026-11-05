/**
 * 展示台那颗粒子球的外观参数从哪来(2026-09-22)。
 *
 * **照抄手机端那条路**(butler-app/src/swarm/appearance.ts,2026-09-16 决策记录第 1 条:
 * 「可不是两套不一样的东西」):参数的真相源是 Mac 上那份 `~/.dsh/workbench/appearance.json`,
 * 由工作台 `GET /butler/appearance` 下发;`/state.appearance_version` 变了就重新拉。
 * 展示台跟手机一样**只继承、不调参**——要改就在 Mac 上改,两边同时变。
 *
 * 与手机端的两处不同,都是环境逼的:
 *  1. 手机有 `ApiClient`(每条请求带 `Authorization: Bearer <设备令牌>`);展示台没有,
 *     它手上只有 `/live` 那个 ws 地址和同一把令牌(workbenchToken.ts),所以这里自己拼 HTTP 地址
 *     并自己带那个头。令牌只出现在请求头里,**不进 URL、不打日志**(与 workbenchToken.ts 同一条规矩)。
 *  2. 拿不到就用核心默认值(TUNING_DEFAULTS),球照样转 —— 展示台不能因为一条 HTTP 失败就白屏。
 *     拿不到的情形是真实存在的:工作台是老版本(没有这条接口)、从没在 Mac 上调过外观(404)、
 *     跨源被浏览器拦下(只有回环来源拿得到 CORS 头)。
 */
import { TUNING_DEFAULTS, normalizeTuning, parseTuningPreset, type Tuning } from '../swarm/core.js';

export interface AppearanceResult {
  /** 'synced' = 真的从 Mac 拿到了;'default' = 用核心默认值(原因见 note)。 */
  status: 'synced' | 'default';
  settings: Tuning;
  version?: number;
  note?: string;
}

export const APPEARANCE_DEFAULT_NOTE = '没拿到 Mac 上那份外观,用的是核心默认值';

/** 核心默认参数。任何一条路走不通都落到这里。 */
export function defaultSettings(): Tuning {
  return { ...TUNING_DEFAULTS };
}

/**
 * `/live` 的 ws 地址 → 同一台工作台的 HTTP 根。
 * ws→http、wss→https,端口原样;认不出来就 null(那就不拉外观,用默认值)。
 */
export function workbenchHttpBase(wsUrl: string): string | null {
  try {
    const url = new URL(wsUrl);
    if (url.protocol === 'ws:') url.protocol = 'http:';
    else if (url.protocol === 'wss:') url.protocol = 'https:';
    else if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/** 服务端文档 → 可用的参数。形状不对就 null(当没拿到)。与手机端 presetFromDoc 同一套判定。 */
export function settingsFromDoc(doc: unknown): { settings: Tuning; version: number } | null {
  if (typeof doc !== 'object' || doc === null) return null;
  const record = doc as { version?: unknown; preset?: unknown };
  if (typeof record.version !== 'number') return null;
  try {
    // 展示台不画自定义图标,只要参数;preset.svg 原样丢掉(那是 Mac 调试台里选的图标)。
    const preset = parseTuningPreset(JSON.stringify(record.preset));
    return { settings: normalizeTuning(preset.settings), version: record.version };
  } catch {
    return null;
  }
}

export interface FetchAppearanceOptions {
  /** `/live` 的地址(带不带 token 都行,这里只取主机与端口)。 */
  wsUrl: string;
  /** 设备令牌;本机回环来源可以没有。 */
  token: string | null;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/** 拉一次外观。**永不抛**:任何一条走不通都回默认值 + 一句实话。 */
export async function fetchAppearance(options: FetchAppearanceOptions): Promise<AppearanceResult> {
  const base = workbenchHttpBase(options.wsUrl);
  if (base === null) return { status: 'default', settings: defaultSettings(), note: APPEARANCE_DEFAULT_NOTE };
  const call = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  try {
    const headers: Record<string, string> = {};
    if (options.token !== null && options.token !== '') headers.authorization = `Bearer ${options.token}`;
    const res = await call(`${base}/butler/appearance`, {
      headers,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!res.ok) return { status: 'default', settings: defaultSettings(), note: APPEARANCE_DEFAULT_NOTE };
    const parsed = settingsFromDoc(await res.json());
    if (parsed === null) return { status: 'default', settings: defaultSettings(), note: APPEARANCE_DEFAULT_NOTE };
    return { status: 'synced', settings: parsed.settings, version: parsed.version };
  } catch {
    return { status: 'default', settings: defaultSettings(), note: APPEARANCE_DEFAULT_NOTE };
  }
}
