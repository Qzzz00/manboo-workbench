/**
 * 登录(2026-09-17,Ben 原话:「手机上也需要有登录」)。
 *
 * **现在没有账号体系**,所以手机上的「登录」= 三件事连起来:
 *   确认电脑端就绪 → 配对(扫电脑上的码)→ 引导。
 * 依据:docs/设计-电脑端登录台梳理-2026-09-17.md 第八节「双端入口流程」、docs/设计-引导流程.md 第二节。
 * 以后真有账号了,这一层的三屏不用动:换的是「怎么拿到令牌」,不是「先确认另一端在不在」。
 *
 * 这个文件只放纯函数与常量:几句人话、那盏「电脑」灯、工作台叫什么。界面是它的投影。
 */
import type { WbchMode } from '../channel/channelProtocol';

/**
 * 电脑端从哪儿拿。**现在是占位**:指着仓库的说明页,以后换成安装包地址
 * (Mac 侧登录台那张卡的 `GET /setup/apk` 是反过来的方向——电脑上给手机 APK)。
 * 改这一个常量就够,两处界面(指引屏的链接与二维码)都读它。
 */
export const DESKTOP_DOWNLOAD_URL = 'https://github.com/BeeeeeeeeeeeeeeenY/workbench#readme';

/**
 * 登录的几屏。已登录(配过对、或者用账号登录过)就不进这套,直接舞台页。
 *
 * 2026-09-21 多了 `account`:手机也能直接向中转登录了,不再只靠扫码配对
 * (换手机、重装、电脑不在手边这三件常见的事,以前一件都做不了)。
 * 扫码那条**没动**,它现在的身份是「把这台手机加到这个账号」的快捷方式。
 */
export type LoginScreen = 'welcome' | 'guide' | 'pair' | 'account';

/**
 * 「电脑」那盏灯。未配对时看局域网里找没找到;配对之后看这条路通不通、走的哪条。
 * 配对之后电脑关机 **不掉登录**——灯说「不在线」,不说「没登录」(卡 3)。
 */
export type DesktopPresence =
  | { kind: 'searching' }
  | { kind: 'found' }
  | { kind: 'missing' }
  | { kind: 'linked'; mode: WbchMode; connected: boolean };

/** 顶部横幅那句短的(舞台页用);灯那一行是「电脑:不在线」。 */
export const DESKTOP_OFFLINE_BANNER = '电脑不在线';
/** 还在连(一打开 / 切回前台 / 失败还没满 10 秒)时那一行(2026-09-30)。 */
export const DESKTOP_CONNECTING_BANNER = '正在连接电脑…';

export function desktopStatusText(presence: DesktopPresence): string {
  switch (presence.kind) {
    case 'searching': return '电脑:还在找…';
    case 'found': return '电脑:找到了';
    case 'missing': return '电脑:没找到';
    case 'linked':
      if (!presence.connected || presence.mode === 'offline') return '电脑:不在线';
      return presence.mode === 'remote' ? '电脑:已连接(远程)' : '电脑:已连接(直连)';
  }
}

/** 指引屏底下那一句:找到了哪一台、下一步去电脑上做什么。 */
export function foundDesktopLine(name: string): string {
  return `找到「${name}」,去电脑上生成配对码`;
}

/**
 * 工作台叫什么。三个来源,由准到糙:
 *   1. `/state.workbench.name` —— **Mac 侧还没给**(见交接第四节的请求),给了就用它,换电脑名当场就对;
 *   2. 配对那一刻 mDNS 广播里的名字(`工作台 · <主机名>`,workbench-plugin/src/index.ts 拼的),扫码进来时可能没有;
 *   3. 都没有就退回地址 —— 不猜主机名。
 */
export function workbenchLabel(
  pairing: { host: string; workbenchName?: string },
  state?: { workbench?: { name?: string } },
): string {
  const fromState = state?.workbench?.name;
  if (typeof fromState === 'string' && fromState.trim() !== '') return fromState.trim();
  const remembered = pairing.workbenchName;
  if (typeof remembered === 'string' && remembered.trim() !== '') return remembered.trim();
  return `工作台 · ${pairing.host}`;
}

/**
 * 设置页上写的那个名字(2026-09-27,卡 SZ2)。和上面那一份的唯一区别:**名字拿不到时不退回地址** ——
 * 设置页里一律不露地址、端口、设备号(维护者的硬规矩「不露内部的东西」;地址在「高级 → 连接详情」里)。
 */
export function workbenchLabelOnScreen(
  pairing: { host: string; workbenchName?: string },
  state?: { workbench?: { name?: string } },
): string {
  const label = workbenchLabel(pairing, state);
  return label === `工作台 · ${pairing.host}` ? '你的电脑' : label;
}

export function loggedInLine(label: string): string {
  return `已登录:${label}`;
}

/** 账号登录成功、但这台手机还没连过任何一台电脑时说的那句。 */
export const ACCOUNT_LINKED_NO_DESKTOP
  = '账号登好了。电脑上的工作台登录同一个账号之后,这里就能连上它。';

/** 自己点「退出登录」之后回欢迎屏说的那句。 */
export const SIGNED_OUT_NOTICE = '已退出登录。要再用的时候,扫一次电脑上的配对码就行。';

/**
 * 首页点了「重新扫码配对」之后,扫码页上那句(2026-09-23 第二轮从零重装)。
 * 旧的配对已经丢掉了,这一屏直接开相机。
 */
export const REPAIR_NOTICE = '旧的配对已经清掉了。在电脑上打开工作台,扫它给的二维码,这台手机就重新连上。';

/** 令牌被撤销(401)之后回欢迎屏说的那句:说人话,不摆状态码。 */
export const REVOKED_NOTICE = '登录失效了——多半是在电脑上解除了这台手机,或者令牌过期了。重新扫一次配对码就能回来。';
