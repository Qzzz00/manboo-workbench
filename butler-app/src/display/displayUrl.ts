import type { WorkbenchState } from '../api/protocol';
import type { Tuning } from '../swarm/core.js';
import type { DisplayStyle } from './displayStyle';

/**
 * ★展示台地址里的 `?avatar=`:空串 = 不带(2026-09-22,Ben:「把 Live2D 形象换成旋转的粒子吧」)。
 *
 * 10-01 起形象不靠这个参数了:手机壳把「这台手机上有的形象 + 当前选择」递进 iframe(`avatars` 消息),
 * 横屏左栏左右滑 / 点圆点换;10-21 起形象只从电脑上的 butler-server 上传、手机下载(仓库与 App 里一个模型都不带)。
 * 展示台那侧对 `?avatar=` 指名、这台机器上又没有的形象一律画粒子球(display-client displayStage.ts `resolveStageKind`)。
 */
// 显式写 `: string`:不这么写 TS 会把它收窄成字面量类型 `''`,下面那个 if 在类型上就成了不可能。
export const DISPLAY_AVATAR: string = '';

/**
 * 展示台那个 iframe 的地址(2026-09-30 起:`?feed=host`)。
 *
 * 09-22 那一版给的是 `?workbench=ws://<电脑>:8791/live&token=<设备令牌>`,让展示台在 iframe 里**自己另开一条** /live。
 * 维护者 09-30 看着手机横屏:「Agent 显示都是下线状态」—— 手机不在同一个 Wi-Fi、走房间、或只用账号登录过时,
 * 那条局域网 WS 连不上,会话区就是一排灰灯;而手机壳手上明明有一份新鲜的 /state(routedClient 自己挑路)。
 * 所以现在**手机壳把状态和外观 postMessage 进去**(DisplayPage.tsx),展示台一条连接都不开
 * (display-client/src/display/hostFeed.ts)。顺带:**令牌与电脑地址都不再进 iframe 的地址栏**,
 * 只用账号登录、没配过对的手机也有展示台了(09-22 那句「连不上」的实话随之退休)。
 *
 * `?avatar=` 选形象 —— **`DISPLAY_AVATAR` 是空串时这个参数根本不出现,展示台就画粒子球**(2026-09-22 Ben 拍板)。
 */
export function displayUrl(base = './display/display.html', style: DisplayStyle = 'classic'): string {
  const params = new URLSearchParams();
  params.set('feed', 'host');
  // 空串 = 粒子球:参数干脆不带,地址里看得出来「这次没选形象」。
  if (DISPLAY_AVATAR !== '') params.set('avatar', DISPLAY_AVATAR);
  // 展示台样式(2026-10-01,设置 › 声音与形象):原来那套不带参数,地址与改之前一字不差。
  if (style === 'orbit') params.set('layout', 'orbit');
  return `${base}?${params.toString()}`;
}

/** 与 display-client/src/display/hostFeed.ts 的 `HOST_MESSAGE_TYPE` 同一个字(两边不互相 import,仓库约定)。 */
export const HOST_MESSAGE_TYPE = 'butler-display';

/**
 * 递进 iframe 的那两句:整份 /state 快照 + Mac 那份粒子参数。
 * `connected` 为假(电脑这会儿没连上)时快照照递,但 `stale` 如实置真 —— 展示台据此写「和电脑断开了」,
 * 并照旧显示最后一次已知状态(C1)。
 */
export function hostMessages(state: WorkbenchState, settings: Tuning, connected = true): [unknown, unknown] {
  return [
    { type: HOST_MESSAGE_TYPE, kind: 'snapshot', state: connected ? state : { ...state, stale: true } },
    { type: HOST_MESSAGE_TYPE, kind: 'appearance', settings },
  ];
}

/** 展示台挂上之后说的那一句「我好了」。 */
export function readyFromDisplay(data: unknown): boolean {
  return typeof data === 'object' && data !== null
    && (data as { type?: unknown }).type === HOST_MESSAGE_TYPE && (data as { kind?: unknown }).kind === 'ready';
}

/**
 * 形象队列 + 当前选择(2026-10-01,docs/设计-形象切换与形象包-2026-10-01.md 2.4)。与 display-client hostFeed.ts 的
 * `avatars` 消息同形;粒子球不在 items 里,它的 id 是 `particles`。
 */
export function avatarsMessage(items: readonly unknown[], current: string): unknown {
  return { type: HOST_MESSAGE_TYPE, kind: 'avatars', items, current };
}

/** 展示台回过来的「滑到 / 点了哪个」。认不出回 null。 */
export function avatarSelectFromDisplay(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as { type?: unknown; kind?: unknown; id?: unknown };
  return d.type === HOST_MESSAGE_TYPE && d.kind === 'avatar-select' && typeof d.id === 'string' ? d.id : null;
}

/**
 * 各家 logo(2026-10-01,第二套展示台要真 logo):登记表 id → 手上已经取到的 `data:image`。
 * 图要带令牌取,iframe 里没有令牌,所以由壳递;还没取到的那几家不递,展示台画色点。与 display-client hostFeed.ts 的 `icons` 同形。
 */
export function iconsMessage(icons: Record<string, string | undefined>): unknown {
  const out: Record<string, string> = {};
  for (const [id, url] of Object.entries(icons)) if (url !== undefined && url.startsWith('data:image/')) out[id] = url;
  return { type: HOST_MESSAGE_TYPE, kind: 'icons', icons: out };
}
