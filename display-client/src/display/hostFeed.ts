/**
 * 手机横屏里:展示台的状态由手机壳递进来(2026-09-30)。
 *
 * 维护者看着手机横屏:「Agent 显示都是下线状态」。展示台原来在 iframe 里**自己另开一条**
 * `ws://<电脑局域网地址>:8791/live`;手机不在同一个 Wi-Fi、走房间、或只用账号登录过时那条连不上,
 * 会话区就是一排灰灯 + 「Agent 掉线」—— 而手机壳手上明明有一份新鲜的 /state
 * (butler-app 的 routedClient 局域网直连或经房间,自己挑路)。
 *
 * 所以手机壳嵌展示台时带 `?feed=host`:展示台**不再自己连**,只收父窗口 postMessage 来的
 *   · `snapshot`:整份 /state(与 /live 的 snapshot 同形);
 *   · `appearance`:Mac 那份粒子参数(手机壳已经拉好、按 appearance_version 刷新过)。
 * 展示台一挂上先发一句 `ready`,手机壳听到就把手上那两份当场递一次(免得 iframe 比壳慢、错过第一拍)。
 *
 * 那台 1200×800 的展示台(没有父窗口、kiosk 启动)不带这个参数,老路一字不变。
 * 只收**父窗口、同源**发来的、形状对得上的消息 —— 别的页面的 postMessage 改不了这块屏。
 */
import type { WorkbenchState } from './workbenchProtocol';
import type { Box } from './avatarFraming';

/**
 * 队列里的一个形象(2026-10-01;10-21 起只有一种来源:电脑上 butler-server 上传过、手机下载到本机的那些)。
 * `base` 是形象包解开后所在的地址(`Capacitor.convertFileSrc` 出来的本机地址),`entry` 是包里的 model3.json。
 * 粒子球不在 items 里,它的 id 是 `particles`(avatarQueue.ts)。与 butler-app/src/avatars/library.ts 的 `StageItem` 同形。
 */
export interface HostAvatarItem {
  id: string;
  name: string;
  base: string;
  entry: string;
  /** 角色本体框(按模型包围盒归一化到 0..1,avatarFraming.ts);上传的包不知道,给整框。 */
  subject: Box;
  /** 背景框(带场景的模型);纯角色为 null。 */
  backdrop: { phone: Box; desk: Box } | null;
  /** 待机循环 / 随机插播(路径相对 entry 所在目录);都空 = 用模型自己登记的动作。 */
  idle: { loop: string[]; beats: string[]; muteMouth: boolean };
  zoom?: number;
  nudge?: { x: number; y: number };
  legCrop?: number;
  scene?: { background: string; foreground: string | null };
  thumb?: string;
}

export const HOST_MESSAGE_TYPE = 'butler-display';

export type HostMessage =
  | { type: typeof HOST_MESSAGE_TYPE; kind: 'snapshot'; state: WorkbenchState }
  | { type: typeof HOST_MESSAGE_TYPE; kind: 'appearance'; settings: Record<string, number> }
  /** 形象队列 + 当前选择(粒子球的 id 是 `particles`)。 */
  | { type: typeof HOST_MESSAGE_TYPE; kind: 'avatars'; items: HostAvatarItem[]; current: string }
  /**
   * 各家 logo(2026-10-01):登记表 id → `data:image/…`。图要带设备令牌取,iframe 里没有令牌,
   * 所以由壳把它手上那份(agents/agentIcons.ts 的缓存)递进来;没有的那家画色点。
   */
  | { type: typeof HOST_MESSAGE_TYPE; kind: 'icons'; icons: Record<string, string> };

/** 展示台回给壳:用户左右滑到 / 在快速选择条里点了哪个。壳存设置、再广播 `avatars`。 */
export function avatarSelectMessage(id: string): { type: typeof HOST_MESSAGE_TYPE; kind: 'avatar-select'; id: string } {
  return { type: HOST_MESSAGE_TYPE, kind: 'avatar-select', id };
}

function isAvatarItem(v: unknown): v is HostAvatarItem {
  if (!isRecord(v)) return false;
  return typeof v.id === 'string' && typeof v.name === 'string' && typeof v.base === 'string' && typeof v.entry === 'string'
    && isRecord(v.subject) && isRecord(v.idle);
}

/** 发给父窗口(同源)。没有父窗口时什么都不做。 */
export function postToHost(message: unknown): void {
  if (typeof window === 'undefined' || window.parent === window) return;
  try { window.parent.postMessage(message, window.location.origin); } catch { /* 父窗口不收就算了 */ }
}

/** 展示台挂上之后发给父窗口的那一句。 */
export const HOST_READY = { type: HOST_MESSAGE_TYPE, kind: 'ready' } as const;

export function isHostFeed(search: string): boolean {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  return params.get('feed') === 'host';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseHostMessage(data: unknown): HostMessage | null {
  if (!isRecord(data) || data.type !== HOST_MESSAGE_TYPE) return null;
  if (data.kind === 'snapshot') {
    const state = data.state;
    if (!isRecord(state) || !Array.isArray(state.agents) || !Array.isArray(state.sessions) || typeof state.stale !== 'boolean') return null;
    return { type: HOST_MESSAGE_TYPE, kind: 'snapshot', state: state as unknown as WorkbenchState };
  }
  if (data.kind === 'appearance') {
    const settings = data.settings;
    if (!isRecord(settings)) return null;
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(settings)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      out[key] = value;
    }
    return { type: HOST_MESSAGE_TYPE, kind: 'appearance', settings: out };
  }
  if (data.kind === 'avatars') {
    if (!Array.isArray(data.items) || typeof data.current !== 'string') return null;
    return { type: HOST_MESSAGE_TYPE, kind: 'avatars', items: data.items.filter(isAvatarItem), current: data.current };
  }
  if (data.kind === 'icons') {
    if (!isRecord(data.icons)) return null;
    const icons: Record<string, string> = {};
    // 只收内联的图:展示台不替壳去取任何网络地址。
    for (const [id, url] of Object.entries(data.icons)) if (typeof url === 'string' && url.startsWith('data:image/')) icons[id] = url;
    return { type: HOST_MESSAGE_TYPE, kind: 'icons', icons };
  }
  return null;
}

export interface HostEventLike {
  source: unknown;
  origin: string;
  data: unknown;
}

/** 只收父窗口、同源发来的。 */
export function acceptHostEvent(event: HostEventLike, env: { parent: unknown; origin: string }): HostMessage | null {
  if (event.source !== env.parent || event.origin !== env.origin) return null;
  return parseHostMessage(event.data);
}

/**
 * 挂上监听并告诉父窗口「我好了」。回一个撤掉监听的函数。
 * 没有父窗口(直接打开这一页)时照样挂着,只是永远收不到 —— 快照一直是空的、`stale` 说实话。
 */
export function listenHost(onMessage: (message: HostMessage) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (event: MessageEvent) => {
    const message = acceptHostEvent(event, { parent: window.parent, origin: window.location.origin });
    if (message !== null) onMessage(message);
  };
  window.addEventListener('message', handler);
  try {
    if (window.parent !== window) window.parent.postMessage(HOST_READY, window.location.origin);
  } catch { /* 父窗口不收就算了:它挂上 iframe 时自己也会先递一次 */ }
  return () => window.removeEventListener('message', handler);
}
