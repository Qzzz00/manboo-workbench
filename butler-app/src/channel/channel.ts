/**
 * 通道层在手机这一侧的「总机」(2026-09-17)。把下面几件事拧成一个东西:
 *
 *   - **第二套配对**:局域网配对成功后立刻向 8791 要一张房间凭证存下来,之后出门就能用。
 *     没有它,出了局域网手机连不上任何东西 —— 8791 的地址是个局域网 IP。
 *   - **按需进房**:不通话、又在局域网里的时候**不进房**(省电、省流量;设计 §二没要求常驻)。
 *     出了局域网(直连失败)或者要打电话时才进;回到局域网(routedClient 切回直连那一下)就放掉,
 *     进去之后由引用计数决定什么时候真的离房(见 roomLink.ts)。
 *   - **续期**:凭证快到期(提前十分钟)换一张。在房里就走数据通道 `{type:'renew'}`;
 *     不在房里但直连得到 8791,就直接再要一张 —— 两条路续到的都存回本地。
 *   - **文件**:发一张图/一个文件给工人;收工人发来的文件(落在哪见 fileSink.ts 的文件头)。
 *   - **字幕**:工人推的转写与回复原样转给界面。
 *
 * 凭证里的 token 和设备令牌一样,**只在这里和进房那一下出现**:不打日志、不进 URL、不进任何出口。
 */
import type { ApiClient } from '../api/client';
import type { SayDecisionRoomEvent } from '../call/sayDecisionRoomEvent';
import {
  WBCH_FILE_TOPIC,
  wbchExpired,
  wbchNeedsRenew,
  wbchRenewDelayMs,
  type WbchCaption,
  type WbchBackchannel,
  type WbchFiller,
  type WbchFillerVoiceChanged,
  type WbchOnboardingAction,
  type WbchRing,
  type WbchRingEnd,
  type WbchCallState,
  type WbchFileStatus,
} from './channelProtocol';
import { createWbchChannelClient } from './channelClient';
import { createWbchRpc, type WbchRpc } from './rpc';
import { createWbchRoomLink, type WbchFileIn, type WbchFileProgress, type WbchRoomLink, type WbchWorkerDeparture } from './roomLink';
import { parseWbchCredential, wbchIsLanUrl, type WbchCredential, type WbchCredentialStore, type WbchRouteCredentialStore } from './credentialStore';
import type { RelayRoomSource } from '../account/roomFromRelay';
import type { RoomRoute, RouteTicket } from './routeSpec';
import type { RouteTicketFetch } from './routeDriver';

/**
 * 听铃交给了原生、这一页在后台时,远程那条路的那句话(2026-10-20,卡 E)。亮屏回来就自己收回。
 */
export const WBCH_PARKED_TEXT = '后台待机中:电话由系统那一侧守着,回到事务官再连电脑';

/** 还没要到过凭证时那句话。说清楚去哪儿补:回到局域网里连一次、或者用账号登录一次,就有了。 */
export const WBCH_NO_CREDENTIAL_TEXT = '还没有房间凭证,出了局域网连不上;用账号登录一次,或者回到家里的 Wi-Fi 连一次,就会自动取一张';
/** 存着的那张已经过期,而且现在也连不上 8791 换新的。 */
export const WBCH_CREDENTIAL_EXPIRED_TEXT = '房间凭证已过期,而且现在连不上工作台换一张;回到局域网里连一次就好';

/**
 * 房里等不到电脑上的工人、而且**问不到**电脑那边现在用的是哪一间房时那句话(2026-09-23 从零重装验收)。
 *
 * 以前这时候只说「Mac 上那个进程没跑起来」—— 验收那天电脑是好的,是**电脑重装过、换了一间房**,
 * 手机还拿着重装前的凭证守在旧房里。那句话让人以为电脑坏了。现在两种可能都说,并给出能走的那条路。
 */
export const WBCH_ROOM_STALE_TEXT = '这台手机的房间里没有电脑。电脑重装过或换了账号登录的话,它已经不认这台手机了:到「设置」里退出登录,再扫电脑上的二维码,重新扫码配对;电脑只是关着的话,开机后会自己连上';

/**
 * 首页与远程那条路在「房里没有电脑」时说的那句(2026-09-23 第二轮从零重装)。
 *
 * 真机那天:电脑整个重装、换了账号,新电脑的工人进的是**新账号那间房**;手机拿着旧账号的凭证守在旧房间里。
 * 手机能确定的只有「我的房间里没有电脑」,**确定不了**是电脑关着还是电脑已经换了人 ——
 * 所以两种都说,不再猜「工人可能没在跑」(那句话只在确实知道电脑在线时才说得出口)。
 */
export const WBCH_DESKTOP_NOT_IN_ROOM_TEXT = '这台手机的房间里没有电脑:电脑关着,或者电脑重装过、换了账号(那样它已经不认这台手机了,要重新扫码配对)';

/**
 * 房里没有电脑,而且**这台手机没有挂在账号下的设备令牌**(2026-09-28,卡 PH)。
 *
 * 现场:电脑升级后带账号重领了机器令牌,房间从 legacy 那一间换成账号那一间;手机手上那张凭证
 * 是电脑经 8791 代签的旧房间的,而它问「电脑在哪一间」走的**正是旧房间里的代理** ——
 * 电脑已经不在那儿了,于是永远问不到、也就永远搬不过去。有账号令牌的手机能自己向中转要
 * 账号那间房的凭证(`roomFromRelay.ts`),**没有的那一台只能重新扫一次码**。
 * 这句话不许说成「电脑上的工作台没在运行」—— 电脑好好的,是这台手机找不到它。
 */
export const WBCH_NO_ACCOUNT_ROOM_TEXT = '电脑换了连接方式,这台手机找不到它的新房间了:在电脑上打开配对二维码,重新扫一次就好';

/**
 * 房里等电脑露面等多久(2026-09-23)。与通话那一层的 WBCH_CALL_WORKER_WAIT_MS 同一个数、同一个理由:
 * `connect()` 刚落地那一下参与者表可能还没填上,问早了会把在的说成不在。
 */
export const WBCH_WORKER_GRACE_MS = 3000;
/** 判过「房里没有电脑」之后,隔多久再核对一次(期间的请求当场回,不再每条干等几秒)。 */
export const WBCH_ABSENT_RECHECK_MS = 60000;

/**
 * 「电脑在不在这台手机的房间里」(2026-09-23 第二轮从零重装)。首页据此决定说什么、给不给「重新扫码配对」。
 *
 *   - `unknown`:还没进过房 / 刚断开,不知道;
 *   - `present`:电脑上的工人在这间房里;
 *   - `absent`:进了房、等过、核对过房间,**房里就是没有电脑**(`check` 是核对的结果:
 *     `same` 中转说就是这一间 / `unknown` 问不到 / `no_account` 这台手机没有账号令牌,
 *     压根问不到账号那间房(2026-09-28,卡 PH);`departure` 是电脑那一方上一次**怎么走的**,
 *     2026-09-28 卡 AW 加的,首页据此分清「电脑睡着了」与「连不上、说不清」);
 *   - `revoked`:中转明说这台手机的设备令牌不认了 —— 这是**确定**的「不认」。
 */
export type WbchPresence =
  | { kind: 'unknown' }
  | { kind: 'present' }
  | { kind: 'absent'; check: 'same' | 'unknown' | 'moved' | 'no_account'; departure: WbchWorkerDeparture; at: number }
  | { kind: 'revoked'; error: string; at: number };

/** 重新核对房间的结果。见 {@link WbchChannel.recheckRoom}。 */
export type WbchRoomCheck =
  /** 电脑那边现在用的就是这一间:工人不在是真的不在(进程没跑)。 */
  | { kind: 'same' }
  /** 换了一间(电脑重装 / 换账号):已经换上新凭证、换进新房间。 */
  | { kind: 'moved'; from: string; to: string }
  /** 问不到(连不上电脑……)。`error` 是原话。 */
  | { kind: 'unknown'; error: string }
  /**
   * **这台手机没有挂在账号下的设备令牌**(2026-09-28,卡 PH)。
   *
   * 于是它只有一条问房间的路 —— 局域网里的 8791,而那条路此刻也走不通。
   * 电脑搬进账号房间之后,这台手机**永远自己找不回去**:它连「新房间叫什么」都问不到。
   * 这与「问不到」是两件事:那件事等一会儿可能就好了,这件事只能重新扫一次码。
   */
  | { kind: 'no_account'; error: string }
  /** 中转明说这台手机的设备令牌不认了(401):不是连不上,是**不认**(2026-09-23)。 */
  | { kind: 'revoked'; error: string };

/** 在外面取文件,而电脑上的工人还是老版本(不认 file_pull)时那句话。 */
export const WBCH_PULL_OLD_WORKER_TEXT = '电脑上的工人还是老版本,在外面取不了文件;电脑端升级一下,或者回到家里的 Wi-Fi 再取';

/** 谁持有房间连接。两个字符串而已,写成常量是为了两处不打错。 */
const HOLDER_RPC = 'rpc';
const HOLDER_CALL = 'call';
/** 发一个文件也要房间,但它不该顶掉通话那一份持有(不然发完文件电话就断了)。 */
const HOLDER_FILE = 'file';
/**
 * 在外面**取**一个文件那一份持有(2026-09-25,卡 J)。和发文件那份不一样:发完就能放手,
 * 取是要**等字节进来**的 —— 放早了,房间一关,推过来的那条流就断在半路。由取的那一层收完再放。
 */
const HOLDER_PULL = 'pull';
/**
 * 座机模式那一份持有(2026-09-21)。和通话那一份分开:座机一直握着房间,
 * 而一通电话打完要放掉它自己那一份 —— 两份用同一个名字的话,挂断就会把座机踢出房间,
 * 下一个电话再也打不进来。
 */
const HOLDER_RING = 'ring';
/**
 * 路线那一份持有(2026-10-21,局域网 M4):路线驱动判定「此刻在这条路的房里」。有它,不通话、不在外面代办时
 * 手机也在当前路线那间房里(电话才打得进来);换路线时持有不变、换房。名字与 roomLink.ts 的 WBCH_PARKABLE_HOLDERS 同一份。
 */
const HOLDER_ROUTE = 'route';

export interface WbchChannel {
  /** 给 routedClient 用:保证房间连着,回一个走房间的 ApiClient。 */
  remote(): Promise<{ ok: true; client: ApiClient } | { ok: false; error: string }>;
  /** 此刻手上这张凭证(设置页显示服务器地址与到期时间)。 */
  credential(): WbchCredential | null;
  /**
   * 要一张新的(中转优先,8791 兜底)。配对刚成功、账号刚登录、以及过期时调。
   *
   * `revoked` = 电脑/中转**明说**不认这台手机了(从账号里移除 / 本机解除配对)。
   * 调用方见到它就该**停手**:不再重试、不再试另一条路,去走「重新扫码配对」
   * (2026-10-03,卡 claude/device-revoke-complete)。
   */
  refresh(): Promise<{ ok: true } | { ok: false; error: string; revoked?: true }>;
  /**
   * **房里等不到工人时核对一次:电脑那边现在用的还是这一间吗**(2026-09-23 从零重装验收)。
   *
   * 现取一张凭证(中转优先,8791 兜底)。房间名或服务器地址变了 = 电脑重装过 / 换过账号,
   * 手上那张是旧房间的 —— **丢掉旧的、存下新的、正拿着房间的那几份持有一起换进新房间**。
   * 没变就是工人真的不在;取不到就如实回原话。
   */
  recheckRoom?(): Promise<WbchRoomCheck>;
  /**
   * 电脑在不在这台手机的房间里(2026-09-23)。**可缺**:老的假通道层没有它,首页那时就照旧只看连没连上。
   * 变了会走 {@link subscribe}。
   */
  presence?(): WbchPresence;
  /**
   * 到点了就换一张:在房里走数据通道,不在房里走 8791。
   * `revoked` 同 {@link refresh} —— 续期那个循环见到它就**不再排下一次**(useChannel.ts)。
   */
  renewNow(): Promise<{ ok: true } | { ok: false; error: string; revoked?: true }>;
  /** 距离「该续了」还有多少毫秒。 */
  renewDelayMs(): number;
  /** 回到局域网了:把「远程代理」那一份持有放掉(通话那一份不受影响)。 */
  releaseRemote(): Promise<void>;
  /**
   * 路线驱动说「电脑明说不认这台手机了」(配对过的那台对 `/channel/route` 回 401,2026-10-21 局域网 M4):
   * 落下同一个闸(之后一条网络都不再打),首页据此出「重新扫码配对」。可缺。
   */
  markRevoked?(error: string): void;
  /**
   * 引导那条消息(2026-09-18):告诉房里的工人「我在做引导」/「我打了一句字」/「挂断了」。
   * 走的是同一条 `wb.rpc`,所以要房间连着(通话时本来就连着)。
   */
  onboarding(action: WbchOnboardingAction, text?: string): Promise<{ ok: true; stage?: string; leader?: string } | { ok: false; error: string }>;
  /**
   * 「这是一通普通电话,打个招呼吧」(2026-09-18)。引导那一通**不发**这条 ——
   * 招呼与开场白互斥,那正是 Ben 在真机上「接通的瞬间它说『你说』」的来由。
   * `callId`:这一通的编号(见 rpc.ts 那一条)。
   */
  callStart(callId?: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * 座机主动来电那三条(2026-09-21)。见 channelProtocol.ts 的 WbchCallAction。
   * **要房间连着** —— 座机模式下它本来就一直连着(那正是收得到来电的前提)。
   */
  answerCall(callId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  laterCall(callId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  hangupCall(): Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * 「**我这边真的开始出声了**」(2026-09-28,卡 CF 第 4 条;判据 2026-09-28 卡 OP 换成
   * 「同一个输出真的在消化音频」,见 src/call/outputWarm.ts)。
   * 工人的开场白等这一条(上限 2.5s)—— 「订上音轨」救不了第一个字,真的出声才算。
   * `warmMs` = 烘热那一下等了多久,只给工人记进日志。
   */
  playingCall(warmMs?: number): Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * **常驻房间**(2026-09-21,座机模式)。一台装在外壳里的座机必须一直在房里,
   * 否则工人那条 `ring` 发进一个没有它的房间 —— 电话永远打不进来。
   * 平时(不是座机)不持有:省电、省流量,与 09-17「按需进房」那条不冲突。
   */
  holdForRing(): Promise<{ ok: true } | { ok: false; error: string }>;
  releaseRing(): Promise<void>;
  /** 通话要用房间。 */
  acquireCall(): Promise<void>;
  releaseCall(): Promise<void>;
  link: WbchRoomLink;
  /** 发一个文件给工人。没进房会先进房。 */
  /**
   * 发一个文件给工人。`to` 给了就**只发那一台设备**(2026-09-21):
   * 房里现在可能有好几台(他的两台电脑、另一台手机),发之前得挑一台。
   */
  sendFile(file: File, to?: string, attributes?: Record<string, string>): Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * 在外面取打字要的那个文件(2026-09-25,卡 J):进房、让工人把这张取件单上的文件推过来。
   * 回的是**开始推了没有**;字节随后从 onFile 到,进度从 onFileProgress 到。收完(或放弃)记得 releasePull。
   * **可缺**:老的假通道层没有它,取文件那一层会如实说在外面取不了。
   */
  pullOffer?(offer: string): Promise<{ ok: true; name?: string; bytes?: number } | { ok: false; error: string }>;
  /** 取完了 / 不等了:放掉取文件那一份持有。 */
  releasePull?(): Promise<void>;
  /** 正在收的文件收到哪儿了(2026-09-25)。可缺(老的假通道层)。 */
  onFileProgress?(listener: (progress: WbchFileProgress) => void): () => void;
  /** 一个文件没推过来,工人说了为什么(2026-09-25)。可缺。 */
  onFileStatus?(listener: (status: WbchFileStatus) => void): () => void;
  onCaption(listener: (caption: WbchCaption) => void): () => void;
  /** 1b 实时推送的 /say 决定卡；事件只更新显示，用户动作仍走 /butler/say。 */
  onSayDecision?(listener: (event: SayDecisionRoomEvent) => void): () => void;
  /** 缓冲语信号(2026-09-20)。收了怎么办见 call/fillerAudio.ts。 */
  onFiller(listener: (filler: WbchFiller) => void): () => void;
  /**
   * 应声信号(2026-10-02):他说得久了该插一声「嗯」。收了怎么办见 call/ackAudio.ts。
   * **可缺**(同 `onFileProgress` / `onFileStatus` 那条:老的假通道层没有它)——
   * 调用方照 `channel.onBackchannel?.(…)` 的写法去接,缺了就只是没有应声。
   */
  onBackchannel?(listener: (signal: WbchBackchannel) => void): () => void;
  /**
   * 事务官的音色换了(2026-09-22)。收了怎么办见 call/fillerVoiceCache.ts:
   * **只记一笔,下次进房再按新音色取那七句**,通话中一个字都不重新合成。
   */
  onFillerVoice(listener: (changed: WbchFillerVoiceChanged) => void): () => void;
  /** 座机响了 / 这一通完了(2026-09-21)。收了怎么办见 call/incomingModel.ts。 */
  onRing(listener: (ring: WbchRing | WbchRingEnd | WbchCallState) => void): () => void;
  onFile(listener: (file: WbchFileIn) => void): () => void;
  /** 凭证变了(取到 / 续到)。设置页据此重画。 */
  subscribe(listener: () => void): () => void;
  stop(): void;
  /**
   * ——— 按路线进房(2026-10-21,局域网 M4)。只有给了 `routing` 的通道层有这几样;老的假通道层没有 ———
   * 此刻在哪条路线的房里(驱动说进的那一间);没有路线是 null。
   */
  route?(): RoomRoute | null;
  /**
   * 要一张这条路的票,连令牌存进那一格。本机房间的票只向 `from` 那台 8791 要;云房间的票向中转要,
   * 没登录账号才向 `from`(或驱动判到的直连地址)那台 8791 兜一张**中转签的**票。局域网的票不会被当成云票存,反过来也一样。
   */
  fetchRouteTicket?(route: RoomRoute, from: string | null): Promise<RouteTicketFetch>;
  /** 用这条路那张票进 `url` 的 `room`:已经在别的房里就换房(持有一起搬);换不进去就回原来那间。 */
  enterRoute?(route: RoomRoute, url: string, room: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** 退出这条路的房间(已经换走了就什么都不做)。持有照记,之后没有路线就不再进房。 */
  leaveRoute?(route: RoomRoute): Promise<void>;
  /**
   * 通话中换了路线、通话那一份持有被搬进了另一间房(局域网 M4)。续上同一通是卡 M9;这一版旧房里那一通就此断了,
   * 通话那一层据此当场收场(说「换了网络」),不让屏幕上一直写着「通话中」。
   */
  onCallDropped?(listener: () => void): () => void;
}

/** 通话中换了网络、这一通断了(局域网 M4;续上同一通是卡 M9)。 */
export const WBCH_CALL_ROUTE_DROPPED_TEXT = '换了网络,这一通断了;点一下回拨';

/**
 * 通道层按路线进房要的那几样(2026-10-21,局域网 M4)。由会话(session.ts)把路线驱动接上。
 */
export interface WbchChannelRouting {
  /** 两条路各一份票(连令牌)。 */
  store: WbchRouteCredentialStore;
  /**
   * 向 `base` 那台 8791 发请求、带设备令牌的直连客户端。**401 不许触发「回配对页」**:
   * 是不是我那台撤了我,看的是答话的是不是配对过的那台(路线驱动已经核过 `mac_id` 才会让这里去要票)。
   */
  directAt(base: string): ApiClient;
  /** 驱动此刻判到的 8791 直连地址;不在家是 null。云房间的票没账号可领时向它兜一张。 */
  http(): string | null;
  /** 此刻没有路线可走时,说给人听的那一句(驱动给的原因)。 */
  unavailable(): string;
  /** 当前那张票不能用了 / 该再判一次:让驱动复查(它会重新要票、进房)。 */
  nudge(): void;
  renewed?(route: RoomRoute, ticket: RouteTicket): void;
  callState?(active: boolean, callId: string | null): void;
  roomLost?(route: RoomRoute): void;
}

export interface WbchChannelDeps {
  /** 直连 8791 的那个客户端(**兜底**那条路:老手机包与还没登录账号的手机只有它)。 */
  direct: ApiClient;
  /**
   * 向中转直接领房间凭证(2026-09-21)。**排在 8791 前面** —— 它在任何网络下都成立,
   * 而 8791 只在同一个局域网里成立。没登录账号时它回 null,于是自动落到 8791 那条。
   * 理由全文在 account/roomFromRelay.ts 的文件头。
   */
  relay?: RelayRoomSource;
  store: WbchCredentialStore;
  onUnauthorized: () => void;
  /** 房里显示的名字。 */
  name?: string;
  link?: WbchRoomLink;
  now?: () => number;
  /**
   * 这台手机此刻该有的进房身份(`wb-phone-<device_id>`,2026-09-23)。
   *
   * 本地存着的那张凭证**身份对不上就当没有**:重新扫码配对 / 换账号登录之后 device_id 是新的,
   * 旧的那张是上一次配对(往往是上一次安装)的 —— 拿它进房就是回到旧房间,
   * 从零重装验收里手机正是这样困在旧房间 `workbench` 里的。不给就不核对(老调用方)。
   */
  expectedIdentity?: string;
  /** 进房后等电脑露面多久。缺省 {@link WBCH_WORKER_GRACE_MS}。 */
  workerGraceMs?: number;
  /** 判过「不在」之后隔多久再核对。缺省 {@link WBCH_ABSENT_RECHECK_MS}。 */
  absentRecheckMs?: number;
  /**
   * 按路线进房(2026-10-21,局域网 M4)。给了它,房间凭证不再是「中转优先、8791 兜底」的一张通用票:
   * 本机房间、云房间各一张,此刻进哪间由路线驱动说(见 {@link WbchChannelRouting})。不给就是老样子(老调用方、用例)。
   */
  routing?: WbchChannelRouting;
}

export function createWbchChannel(deps: WbchChannelDeps): WbchChannel {
  const now = deps.now ?? (() => Date.now());
  const link = deps.link ?? createWbchRoomLink();
  const captionListeners = new Set<(caption: WbchCaption) => void>();
  const sayDecisionListeners = new Set<(event: SayDecisionRoomEvent) => void>();
  const ringListeners = new Set<(ring: WbchRing | WbchRingEnd | WbchCallState) => void>();
  const fillerListeners = new Set<(filler: WbchFiller) => void>();
  const backchannelListeners = new Set<(signal: WbchBackchannel) => void>();
  const fillerVoiceListeners = new Set<(changed: WbchFillerVoiceChanged) => void>();
  const fileListeners = new Set<(file: WbchFileIn) => void>();
  const progressListeners = new Set<(progress: WbchFileProgress) => void>();
  const fileStatusListeners = new Set<(status: WbchFileStatus) => void>();
  const changeListeners = new Set<() => void>();
  let credential: WbchCredential | null = null;
  let loaded: Promise<void> | null = null;
  let stopped = false;
  const graceMs = deps.workerGraceMs ?? WBCH_WORKER_GRACE_MS;
  const absentRecheckMs = deps.absentRecheckMs ?? WBCH_ABSENT_RECHECK_MS;
  let presence: WbchPresence = { kind: 'unknown' };
  /** 同一时刻只核对一次:首页轮询、通话状态、外观几条请求会同时要房间。 */
  let diagnosing: Promise<{ ok: true } | { ok: false; error: string }> | null = null;
  /**
   * 「电脑明说不认这台手机了」(2026-10-03,卡 claude/device-revoke-complete)。
   *
   * 中转或 8791 任一边明说(401)就记下那句话,**之后一条网络都不再打** —— 它不是一次失败,
   * 而是一个要人动手才能解开的状态(重新扫码配对)。为什么不许继续试另一边、不许继续重试,
   * 全文在 {@link fetchCredential} 上面那段。
   */
  let revoked: string | null = null;

  /*
   * ——— 按路线进房(2026-10-21,局域网 M4;只在给了 `deps.routing` 时用) ———
   * 两条路各一张票(`routeCreds`);此刻在哪条路(`activeRoute`)、进的是哪间(`entered`:本机房间的地址以驱动从
   * `/channel/route` 拿到的为准)由路线驱动说。`switching`:我们自己换房 / 退房那几下房间「断了」不算掉线。
   */
  const routing = deps.routing;
  const routeCreds: Record<RoomRoute, WbchCredential | null> = { lan: null, cloud: null };
  let activeRoute: RoomRoute | null = null;
  let entered: { url: string; room: string } | null = null;
  let switching = false;
  /** 接起的那一通(换路时续上同一通要它,卡 M9)。 */
  let lastCallId: string | null = null;
  let callHeld = false;
  const callDropListeners = new Set<() => void>();

  function activeCredential(): WbchCredential | null {
    if (activeRoute === null) return null;
    const ticket = routeCreds[activeRoute];
    if (ticket === null) return null;
    return entered === null ? ticket : { ...ticket, url: entered.url, room: entered.room };
  }

  /** 此刻该用的那张:路线模式下是当前路线那张,否则是老的那一张通用票。 */
  function currentCredential(): WbchCredential | null {
    return routing === undefined ? credential : activeCredential();
  }

  const rpc: WbchRpc = createWbchRpc({
    link,
    onSayDecision: (event) => { for (const l of [...sayDecisionListeners]) { try { l(event); } catch { /* 广播监听者故障不阻断房间 */ } } },
    onCaption: (caption) => { for (const l of [...captionListeners]) { try { l(caption); } catch { /* 一个监听者抛不该拦住别人 */ } } },
    onFiller: (filler) => { for (const l of [...fillerListeners]) { try { l(filler); } catch { /* 同上 */ } } },
    onBackchannel: (signal) => { for (const l of [...backchannelListeners]) { try { l(signal); } catch { /* 同上 */ } } },
    onFillerVoice: (changed) => { for (const l of [...fillerVoiceListeners]) { try { l(changed); } catch { /* 同上 */ } } },
    onRing: (ring) => { for (const l of [...ringListeners]) { try { l(ring); } catch { /* 同上 */ } } },
    onFileStatus: (status) => { for (const l of [...fileStatusListeners]) { try { l(status); } catch { /* 同上 */ } } },
  });
  const client = createWbchChannelClient({ rpc, onUnauthorized: deps.onUnauthorized });

  const unlistenFiles = link.listen({
    onFile: (file) => { for (const l of [...fileListeners]) { try { l(file); } catch { /* 同上 */ } } },
    onFileProgress: (progress) => { for (const l of [...progressListeners]) { try { l(progress); } catch { /* 同上 */ } } },
    // 电脑进房 = 在;离房 / 断开 = 不知道(下一条要房间的请求会重新等、重新核对)。
    onWorker: (present) => { setPresence(present ? { kind: 'present' } : { kind: 'unknown' }); },
    onState: (state) => {
      if ((state === 'closed' || state === 'failed') && presence.kind === 'present') setPresence({ kind: 'unknown' });
      // 房间自己掉了(LiveKit 重连放弃、被踢):告诉路线驱动,它当场重判。我们自己换房 / 退房 / 停靠那几下不算。
      if (state === 'closed' && routing !== undefined && activeRoute !== null && !switching && link.parked?.() !== true) {
        try { routing.roomLost?.(activeRoute); } catch { /* 驱动那边抛不该拦住房间 */ }
      }
    },
  });

  function changed(): void {
    for (const l of [...changeListeners]) { try { l(); } catch { /* 同上 */ } }
  }

  function setPresence(next: WbchPresence): void {
    if (next.kind === presence.kind && next.kind !== 'absent' && next.kind !== 'revoked') return;
    presence = next;
    changed();
  }

  /** 等电脑进房,等够了就回来。**不抛**。 */
  function waitForWorker(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); off(); resolve(); };
      const off = link.listen({ onWorker: (present) => { if (present) finish(); } });
      const timer = setTimeout(finish, ms);
    });
  }

  /**
   * **进了房,电脑在不在**(2026-09-23 第二轮从零重装)。
   *
   * 以前远程那条路进了房就算通了,每条请求发进一间没有电脑的房,各等 15 秒超时,
   * 首页写着「等了很久没人答(电脑上的工人可能没在跑)」、卡片还是上一台电脑的数据 ——
   * 而那天电脑是好的,是**换了账号、换了房间**。现在:
   *   1. 等电脑露面 {@link WBCH_WORKER_GRACE_MS};
   *   2. 不在就核对一次房间:换了房 → 搬过去再等一次(同账号的新安装,这一步就接上了);
   *   3. 还是不在 → 记下 `absent` / `revoked`,**这条请求当场失败**;之后 {@link WBCH_ABSENT_RECHECK_MS} 内的请求不再干等。
   */
  async function ensureWorker(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (link.workerPresent()) { setPresence({ kind: 'present' }); return { ok: true }; }
    if (presence.kind === 'absent' && now() - presence.at < absentRecheckMs) {
      return { ok: false, error: presence.check === 'no_account' ? WBCH_NO_ACCOUNT_ROOM_TEXT : WBCH_DESKTOP_NOT_IN_ROOM_TEXT };
    }
    if (presence.kind === 'revoked' && now() - presence.at < absentRecheckMs) return { ok: false, error: presence.error };
    if (diagnosing !== null) return diagnosing;
    diagnosing = (async (): Promise<{ ok: true } | { ok: false; error: string }> => {
      await waitForWorker(graceMs);
      if (link.workerPresent()) { setPresence({ kind: 'present' }); return { ok: true }; }
      const check = await recheck();
      if (check.kind === 'moved') {
        await waitForWorker(graceMs);
        if (link.workerPresent()) { setPresence({ kind: 'present' }); return { ok: true }; }
      }
      if (check.kind === 'revoked') {
        setPresence({ kind: 'revoked', error: check.error, at: now() });
        return { ok: false, error: check.error };
      }
      // 「怎么走的」问房间那一层(2026-09-28,卡 AW)。老的假房间没有这个方法 → `unknown`,照旧口径。
      setPresence({ kind: 'absent', check: check.kind, departure: link.workerDeparture?.() ?? 'unknown', at: now() });
      // 自己再也找不回账号那间房时说那一句(卡 PH);别的照旧。
      return { ok: false, error: check.kind === 'no_account' ? WBCH_NO_ACCOUNT_ROOM_TEXT : WBCH_DESKTOP_NOT_IN_ROOM_TEXT };
    })();
    try { return await diagnosing; } finally { diagnosing = null; }
  }

  /** 核对房间(见接口上 recheckRoom 那段)。首页与通话共用这一份。 */
  async function recheck(): Promise<WbchRoomCheck> {
    // 已经明说不认这台手机了:结论就是这个,不用再问任何一条路(2026-10-03)。
    if (revoked !== null) return { kind: 'revoked', error: revoked };
    await ensureLoaded();
    if (routing !== undefined) return recheckRoute(routing);
    const before = credential;
    const got = await fetchCredential().catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : '取不到房间凭证' }));
    if (!got.ok) {
      if ('revoked' in got && got.revoked === true) return { kind: 'revoked', error: got.error };
      // 没有账号令牌 + 8791 也不通 = **自己再也找不回去**(卡 PH),与「等会儿再试」分开说。
      if ('noAccount' in got && got.noAccount === true) return { kind: 'no_account', error: got.error };
      return { kind: 'unknown', error: got.error };
    }
    const after = credential;
    if (after === null) return { kind: 'unknown', error: WBCH_NO_CREDENTIAL_TEXT };
    if (before !== null && before.room === after.room && before.url === after.url) return { kind: 'same' };
    // 换了一间:正拿着房间的那几份持有(通话、常驻、远程)一起换进去。
    await link.switchRoom?.(after);
    return { kind: 'moved', from: before?.room ?? '', to: after.room };
  }

  /** 路线模式下的核对:向当前这条路的出票方再要一张,房间名变了就换过去。 */
  async function recheckRoute(r: WbchChannelRouting): Promise<WbchRoomCheck> {
    const route = activeRoute;
    if (route === null) return { kind: 'unknown', error: r.unavailable() };
    const before = activeCredential();
    const got = await fetchRouteTicket(route, r.http());
    if (!got.ok) return got.revoked === true ? { kind: 'revoked', error: got.error } : { kind: 'unknown', error: got.error };
    const after = routeCreds[route];
    if (after === null) return { kind: 'unknown', error: WBCH_NO_CREDENTIAL_TEXT };
    if (before !== null && before.room === after.room) return { kind: 'same' };
    entered = { url: after.url, room: after.room };
    switching = true;
    try { await link.switchRoom?.(after); } finally { switching = false; }
    return { kind: 'moved', from: before?.room ?? '', to: after.room };
  }

  /**
   * 落下那个闸,并让首页当场说得出那一句(2026-10-03)。回的就是调用方该往上回的东西。
   * `error` 原样用**电脑/中转说的那句话**:不编别的原因(它自带下一步)。
   */
  function noteRevoked(error: string): { ok: false; error: string; revoked: true } {
    revoked = error;
    setPresence({ kind: 'revoked', error, at: now() });
    return { ok: false, error, revoked: true as const };
  }

  async function save(next: WbchCredential): Promise<void> {
    credential = next;
    await deps.store.save(next);
    changed();
  }

  /** 本地存着的那张。只读一次,之后都在内存里。 */
  async function ensureLoaded(): Promise<void> {
    if (loaded === null) {
      loaded = (async () => {
        if (routing !== undefined) { await loadRoutes(routing); return; }
        const stored = await deps.store.load();
        if (stored !== null && deps.expectedIdentity !== undefined && stored.identity !== deps.expectedIdentity) {
          // 上一次配对留下的:丢掉,别拿它进旧房间。下面谁要凭证谁现取一张新的。
          await deps.store.clear();
          credential = null;
          return;
        }
        credential = stored;
      })();
    }
    await loaded;
  }

  /**
   * 路线模式:两格各读一份;身份对不上的(上一次配对留下的)丢掉。两格都空、而老版本那一张还在,
   * 按地址认路线搬过来(局域网地址进 lan,别的进 cloud);老那一格不删,装回老包时它还在。
   */
  async function loadRoutes(r: WbchChannelRouting): Promise<void> {
    const mine = async (route: RoomRoute | null, c: WbchCredential | null): Promise<WbchCredential | null> => {
      if (c === null) return null;
      if (deps.expectedIdentity === undefined || c.identity === deps.expectedIdentity) return c;
      if (route !== null) await r.store.clear(route);
      return null;
    };
    routeCreds.lan = await mine('lan', await r.store.load('lan'));
    routeCreds.cloud = await mine('cloud', await r.store.load('cloud'));
    if (routeCreds.lan !== null || routeCreds.cloud !== null) return;
    const old = await mine(null, await r.store.legacy());
    if (old === null) return;
    const route: RoomRoute = wbchIsLanUrl(old.url) ? 'lan' : 'cloud';
    routeCreds[route] = old;
    await r.store.save(route, old);
  }

  async function saveRoute(route: RoomRoute, next: WbchCredential): Promise<void> {
    routeCreds[route] = next;
    await routing?.store.save(route, next);
    if (route === activeRoute) changed();
  }

  /**
   * 向 `base` 那台 8791 要一张票,只收这条路的那一种:8791 回包写了 `route` 就按它认(M2 起都写),没写按地址认。
   * 401 = 判到的那台(驱动已核过机器 id)明说不认这台手机。
   */
  async function ticketFromWorkbench(r: WbchChannelRouting, route: RoomRoute, base: string): Promise<RouteTicketFetch> {
    const result = await r.directAt(base).json<unknown>('/channel/token', {
      method: 'POST',
      body: deps.name === undefined ? {} : { name: deps.name },
    });
    if (!result.ok) {
      if (result.kind === 'unauthorized') { noteRevoked(result.error); return { ok: false, error: result.error, revoked: true }; }
      return { ok: false, error: result.error };
    }
    const parsed = parseWbchCredential(result.data);
    if (parsed === null) return { ok: false, error: '工作台回的房间凭证缺字段,没法用' };
    const declared = (result.data as { route?: unknown }).route;
    const isLan = declared === 'lan' || (declared !== 'relay' && wbchIsLanUrl(parsed.url));
    if ((route === 'lan') !== isLan) {
      return { ok: false, error: route === 'lan' ? '电脑这会儿只签得出云房间的票(电脑上的通话服务没起来)' : '电脑这会儿只签得出本机房间的票' };
    }
    await saveRoute(route, parsed);
    return { ok: true, ticket: ticketOf(parsed) };
  }

  async function fetchRouteTicket(route: RoomRoute, from: string | null): Promise<RouteTicketFetch> {
    if (routing === undefined) return { ok: false, error: '通道层不认路线' };
    if (revoked !== null) return { ok: false, error: revoked, revoked: true };
    await ensureLoaded();
    // 本机房间的票只向 8791 要。
    if (route === 'lan') {
      if (from === null) return { ok: false, error: '不知道电脑在哪个地址' };
      return ticketFromWorkbench(routing, 'lan', from);
    }
    // 云房间:中转优先;中转明说不认就到此为止(不去 8791 那边再领一张,那等于没撤)。
    let firstError: string | undefined;
    if (deps.relay !== undefined) {
      const got = await deps.relay.credential().catch(() => null);
      if (got !== null && got.ok) { await saveRoute('cloud', got.credential); return { ok: true, ticket: ticketOf(got.credential) }; }
      if (got !== null && got.revoked === true) { noteRevoked(got.error); return { ok: false, error: got.error, revoked: true }; }
      if (got !== null) firstError = got.error;
    }
    // 没登录账号:向在家时判到的那台 8791 兜一张(它没本机钥匙时签的就是中转的票)。
    const base = from ?? routing.http();
    if (base !== null) {
      const fallback = await ticketFromWorkbench(routing, 'cloud', base);
      if (fallback.ok || fallback.revoked === true) return fallback;
      firstError ??= fallback.error;
    }
    return { ok: false, error: firstError ?? WBCH_NO_CLOUD_TICKET_TEXT };
  }

  async function enterRoute(route: RoomRoute, url: string, room: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (routing === undefined) return { ok: false, error: '通道层不认路线' };
    if (revoked !== null) return { ok: false, error: revoked };
    await ensureLoaded();
    const ticket = routeCreds[route];
    if (ticket === null) return { ok: false, error: '这条路还没有票' };
    const target: WbchCredential = { ...ticket, url, room };
    const before = { route: activeRoute, entered, credential: activeCredential() };
    activeRoute = route;
    entered = { url, room };
    switching = true;
    try {
      if (link.parked?.() === true) {
        // 熄屏时听铃交给了原生:网页收回来进新房(换了房就不和原生那条撞身份);ringHandoff 随后按新票再交出去。
        await link.unpark?.(target);
      } else {
        const inUse = link.current?.() ?? null;
        const held = link.heldBy?.() ?? [];
        if (inUse !== null && held.length > 0 && (inUse.url !== url || inUse.room !== room)) {
          if (link.switchRoom !== undefined) await link.switchRoom(target);
          else { for (const holder of held) await link.release(holder); }
          // 通话那一份也被搬走了:旧房里那一通就此断了(续上是卡 M9)。
          if (held.includes(HOLDER_CALL)) {
            for (const l of [...callDropListeners]) { try { l(); } catch { /* 一个监听者抛不该拦住别人 */ } }
          }
        }
      }
      await link.acquire(HOLDER_ROUTE, target);
      changed();
      return { ok: true };
    } catch (error) {
      activeRoute = before.route;
      entered = before.entered;
      // 换不进去:回原来那一间,电话别落空。回也回不去,就是那间也掉了。
      if (before.credential !== null) {
        try {
          await link.switchRoom?.(before.credential);
          await link.acquire(HOLDER_ROUTE, before.credential);
        } catch {
          if (before.route !== null) { try { routing.roomLost?.(before.route); } catch { /* 同上 */ } }
        }
      }
      changed();
      return { ok: false, error: error instanceof Error && error.message !== '' ? `进不了房间:${error.message}` : '进不了房间' };
    } finally {
      switching = false;
    }
  }

  async function leaveRoute(route: RoomRoute): Promise<void> {
    // 单条连接:进新房那一下旧房就退了;驱动随后说「退旧房」时这里什么都不做。
    if (routing === undefined || activeRoute !== route) return;
    activeRoute = null;
    entered = null;
    switching = true;
    try {
      await link.release(HOLDER_ROUTE);
      await link.detach?.();
    } finally {
      switching = false;
    }
    changed();
  }

  /** 路线模式:此刻没有能用的票时说什么、要不要让驱动去换。回 null = 有,可以用。 */
  function routeBlocked(r: WbchChannelRouting): { ok: false; error: string } | null {
    const c = activeCredential();
    if (c === null) { r.nudge(); return { ok: false, error: r.unavailable() }; }
    if (wbchExpired(c.expires_at, now())) { r.nudge(); return { ok: false, error: WBCH_CREDENTIAL_EXPIRED_TEXT }; }
    return null;
  }

  /**
   * 8791 那条(兜底)。
   *
   * 401 不是「连不上」:那是电脑**明说**不认这把设备令牌(在「我的设备」里移除了这台手机,
   * 或者在本机解除了配对)。带一格 `revoked` 上去 —— 没有账号那条路的手机只有这一条路,
   * 不分出这一格,它就只会一直重试一个永远不会好的东西(2026-10-03,卡 claude/device-revoke-complete)。
   */
  async function fetchFromWorkbench(): Promise<{ ok: true } | { ok: false; error: string; revoked?: true }> {
    const result = await deps.direct.json<unknown>('/channel/token', {
      method: 'POST',
      body: deps.name === undefined ? {} : { name: deps.name },
    });
    if (!result.ok) {
      return result.kind === 'unauthorized'
        ? { ok: false, error: result.error, revoked: true as const }
        : { ok: false, error: result.error };
    }
    const parsed = parseWbchCredential(result.data);
    // 回包缺字段就当没取到:地址猜错会连到别人的服务器上去。
    if (parsed === null) return { ok: false, error: '工作台回的房间凭证缺字段,没法用' };
    await save(parsed);
    return { ok: true };
  }

  /**
   * 取一张凭证:**中转优先,8791 兜底**。
   *
   * 两条都试过才算失败,而且回的是**中转那句话** —— 它说得更准:
   * "这台手机已经从账号里移除了" 与 "连不上工作台" 是两件完全不同的事,
   * 而后者在出门在外时几乎总是成立(8791 本来就够不到),报它等于什么都没说。
   *
   * ★ **「不认这台手机」是终点,不是一次失败**(2026-10-03,卡 claude/device-revoke-complete;
   *   审计附证 A)。从前这里在中转明说 `revoked` 之后**仍然无条件去试 8791**,而人在家里那条
   *   路是通的 —— 于是被移出账号的手机照样领到一张新房票、照样能用。现在只要**任一边**明说
   *   不认(中转 401 / 8791 401),就:
   *     ① 当场记下 {@link revoked}(「停止自动重试」的那个闸):之后 refresh / 续期 / 核对房间
   *        / 要远程通道一条都不再打网络,原样回这句话;
   *     ② **不再试另一边**(审计那一条就是「试了另一边」);
   *     ③ 不刷新、不覆盖手上那张房票;
   *     ④ presence 当场变成 revoked —— 首页据此出「电脑不认这台手机了」+「重新扫码配对」
   *        (stage/linkHealth.ts),不用等进房。
   *   这个闸**不会自己松**:重新扫码配对会换一个 device_id、重建整个通道层(session.ts),
   *   那才是回来的路。
   */
  async function fetchCredential(): Promise<{ ok: true } | { ok: false; error: string; revoked?: true; noAccount?: true }> {
    if (revoked !== null) return { ok: false, error: revoked, revoked: true as const };
    if (deps.relay !== undefined) {
      const fromRelay = await deps.relay.credential().catch(() => null);
      if (fromRelay !== null && fromRelay.ok) {
        await save(fromRelay.credential);
        return { ok: true };
      }
      // 中转明说不认:**到此为止**,不去试 8791(那条路在家里是通的,试了就等于没撤)。
      if (fromRelay !== null && fromRelay.revoked === true) return noteRevoked(fromRelay.error);
      const fallback = await fetchFromWorkbench();
      if (fallback.ok) return fallback;
      // 8791 明说不认(401):同样是确定的「不认这台手机」,不是「等会儿再试」。
      if (fallback.revoked === true) return noteRevoked(fallback.error);
      /**
       * 中转那条路**压根走不了**(没有账号令牌 / 这份账号记录是别的设备的),而 8791 也没通:
       * 这台手机此刻没有任何办法问出「电脑现在在哪一间房」(2026-09-28,卡 PH)。
       * 带一格 `noAccount` 上去 —— 首页那句话要说的是「重新扫一次码」,不是「过会儿再试」。
       */
      if (fromRelay === null) return { ...fallback, noAccount: true as const };
      return { ok: false, error: fromRelay.error };
    }
    const only = await fetchFromWorkbench();
    if (!only.ok && only.revoked === true) return noteRevoked(only.error);
    return only;
  }

  return {
    link,

    credential: () => currentCredential(),

    async remote() {
      // 电脑明说不认这台手机了:原样回那句话,不去进一间进不了的房(2026-10-03)。
      if (revoked !== null) return { ok: false, error: revoked };
      /**
       * 听铃交给原生了(2026-10-20,卡 E):这一页在后台、多半快被冻住,远程那条路当场说一句,
       * **不进房**(进了就把原生那条踢下去)、也不去核对电脑在不在(核出来的「不在」是假的)。
       * 亮屏回来收回房间之后,下一条请求照旧走这里。
       */
      if (link.parked?.() === true) return { ok: false, error: WBCH_PARKED_TEXT };
      await ensureLoaded();
      if (routing !== undefined) {
        const blocked = routeBlocked(routing);
        if (blocked !== null) return blocked;
        try {
          await link.acquire(HOLDER_RPC, activeCredential() as WbchCredential);
        } catch (error) {
          return { ok: false, error: error instanceof Error && error.message !== '' ? `进不了房间:${error.message}` : '进不了房间' };
        }
        const routeGate = await ensureWorker();
        if (!routeGate.ok) return routeGate;
        return { ok: true, client };
      }
      if (credential === null) {
        // 还没有过凭证:现取一张(中转优先,8791 兜底)。
        const got = await fetchCredential();
        // 「不认这台手机」要原样说(它自带下一步);别的照旧说那句老话。
        if (!got.ok) return { ok: false, error: got.revoked === true ? got.error : WBCH_NO_CREDENTIAL_TEXT };
      }
      if (credential === null) return { ok: false, error: WBCH_NO_CREDENTIAL_TEXT };
      if (wbchExpired(credential.expires_at, now())) {
        const got = await fetchCredential();
        // 没有中转那条路时照旧说那句老话(它指的是唯一的那条路);有中转时说中转那句
        // ——「这台手机已经从账号里移除了」与「回到局域网连一次」是两件完全不同的事。
        // 2026-10-03:8791 明说不认时(revoked)也说它那一句,哪条路都一样。
        if (!got.ok) {
          return { ok: false, error: deps.relay === undefined && got.revoked !== true ? WBCH_CREDENTIAL_EXPIRED_TEXT : got.error };
        }
      }
      try {
        await link.acquire(HOLDER_RPC, credential);
      } catch (error) {
        return { ok: false, error: error instanceof Error && error.message !== '' ? `进不了房间:${error.message}` : '进不了房间' };
      }
      // 进了房还要看电脑在不在:不在就当场说,别让每条请求在空房里各等 15 秒(2026-09-23)。
      const gate = await ensureWorker();
      if (!gate.ok) return gate;
      return { ok: true, client };
    },

    presence: () => presence,

    async releaseRemote() {
      await link.release(HOLDER_RPC);
    },

    async refresh() {
      await ensureLoaded();
      if (routing !== undefined) {
        if (activeRoute === null) { routing.nudge(); return { ok: false, error: routing.unavailable() }; }
        const got = await fetchRouteTicket(activeRoute, routing.http());
        if (got.ok) return { ok: true };
        return got.revoked === true ? { ok: false, error: got.error, revoked: true as const } : { ok: false, error: got.error };
      }
      return fetchCredential();
    },

    async renewNow() {
      // 停止自动重试(2026-10-03):续期那个循环看这一格就不再排下一次(useChannel.ts)。
      if (revoked !== null) return { ok: false, error: revoked, revoked: true as const };
      await ensureLoaded();
      if (routing !== undefined) return renewRoute(routing);
      if (credential === null) return { ok: false, error: WBCH_NO_CREDENTIAL_TEXT };
      /**
       * 续期三条路,按"此刻哪条最可能通"排:
       * ① 已经在房里 → 走数据通道让工人续(出门在外、又没登录账号时这是唯一的路);
       * ② 中转 → 有账号就永远通(2026-09-21 新加的那条);
       * ③ 8791 → 局域网里最直接。
       * ②③ 由 fetchCredential 按顺序试。
       */
      if (link.state() === 'connected') {
        const renewed = await rpc.renew();
        if (renewed.ok) {
          await save({ ...credential, token: renewed.credential.token, expires_at: renewed.credential.expires_at });
          return { ok: true };
        }
        const fallback = await fetchCredential();
        if (fallback.ok) return fallback;
        // 换路也明说不认:报它那一句并带上那一格(房里那条代理回的多半只是「工人没答」)。
        if (fallback.revoked === true) return fallback;
        return { ok: false, error: renewed.error };
      }
      return fetchCredential();
    },

    async recheckRoom() {
      const check = await recheck();
      if (check.kind === 'revoked') setPresence({ kind: 'revoked', error: check.error, at: now() });
      return check;
    },

    renewDelayMs() {
      const c = currentCredential();
      if (c === null) return 0;
      return wbchRenewDelayMs(c.expires_at, now());
    },

    onboarding(action, text) {
      return rpc.onboarding(action, text);
    },

    callStart(callId) {
      // 自己拨出去的这一通也有编号了(2026-10-22):告诉路线驱动,换路时续上同一通(卡 M9)要它。
      if (callId !== undefined && callId !== '') {
        lastCallId = callId;
        if (callHeld) { try { routing?.callState?.(true, callId); } catch { /* 驱动那边抛不该拦住这一通 */ } }
      }
      return rpc.callStart(callId);
    },

    answerCall(callId) {
      lastCallId = callId;
      return rpc.callAnswer(callId);
    },

    laterCall(callId) {
      return rpc.callLater(callId);
    },

    playingCall(warmMs) {
      return rpc.callPlaying(warmMs);
    },

    hangupCall() {
      return rpc.callHangup();
    },

    async holdForRing() {
      // 座机模式是一个一直在重试的循环(进不了房就隔一会儿再来)。电脑明说不认这台手机时
      // 原样回那句话并停手,不然它会每隔一会儿敲一次一扇永远不开的门(2026-10-03)。
      if (revoked !== null) return { ok: false, error: revoked };
      await ensureLoaded();
      if (routing !== undefined) {
        const blocked = routeBlocked(routing);
        if (blocked !== null) return blocked;
        try { await link.acquire(HOLDER_RING, activeCredential() as WbchCredential); }
        catch (error) {
          return { ok: false, error: error instanceof Error && error.message !== '' ? `进不了房间:${error.message}` : '进不了房间' };
        }
        return { ok: true };
      }
      if (credential === null || wbchExpired(credential.expires_at, now())) {
        const got = await fetchFromWorkbench();
        if (!got.ok) {
          // 回的是 `{ok:false,error}` 那个形状(这个方法的契约里没有 revoked 那一格);
          // 闸由 noteRevoked 落下,下一次调用在开头就回来了。
          if (got.revoked === true) { noteRevoked(got.error); return { ok: false, error: got.error }; }
          return { ok: false, error: credential === null ? WBCH_NO_CREDENTIAL_TEXT : WBCH_CREDENTIAL_EXPIRED_TEXT };
        }
      }
      if (credential === null) return { ok: false, error: WBCH_NO_CREDENTIAL_TEXT };
      if (wbchNeedsRenew(credential.expires_at, now())) {
        const renewed = await fetchFromWorkbench();
        // 手上那张还能用,所以续不上不算失败;但「不认这台手机」要记下来(下一次就不白敲了)。
        if (!renewed.ok && renewed.revoked === true) noteRevoked(renewed.error);
      }
      if (credential === null) return { ok: false, error: WBCH_NO_CREDENTIAL_TEXT };
      try { await link.acquire(HOLDER_RING, credential); }
      catch (error) {
        return { ok: false, error: error instanceof Error && error.message !== '' ? `进不了房间:${error.message}` : '进不了房间' };
      }
      return { ok: true };
    },

    async releaseRing() {
      await link.release(HOLDER_RING);
    },

    async acquireCall() {
      // 不认这台手机了:当场说那一句,别让这一通电话在一间进不去的房前面干等(2026-10-03)。
      if (revoked !== null) throw new Error(revoked);
      await ensureLoaded();
      if (routing !== undefined) {
        const blocked = routeBlocked(routing);
        if (blocked !== null) throw new Error(blocked.error);
        await link.acquire(HOLDER_CALL, activeCredential() as WbchCredential);
        if (!callHeld) {
          callHeld = true;
          try { routing.callState?.(true, lastCallId); } catch { /* 驱动那边抛不该拦住这一通 */ }
        }
        return;
      }
      if (credential === null || wbchExpired(credential.expires_at, now())) {
        const got = await fetchCredential();
        if (!got.ok) {
          // 「不认这台手机」不论从哪条路听到都原样说(它自带下一步);别的照旧。
          throw new Error(got.revoked === true
            ? got.error
            : credential === null
              ? WBCH_NO_CREDENTIAL_TEXT
              : deps.relay === undefined ? WBCH_CREDENTIAL_EXPIRED_TEXT : got.error);
        }
      }
      if (credential === null) throw new Error(WBCH_NO_CREDENTIAL_TEXT);
      // 快到期了先换一张再进房:一通电话可能打很久,进去之后再过期会被服务器踢下来。
      if (wbchNeedsRenew(credential.expires_at, now())) await fetchCredential();
      if (credential === null) throw new Error(WBCH_NO_CREDENTIAL_TEXT);
      await link.acquire(HOLDER_CALL, credential);
    },

    async releaseCall() {
      // 一通电话收场就把喇叭关回缺省(2026-10-13 晚):常驻房间里喇叭只该在手机自己通话时开着,
      // 哪条收场路漏关一次,下一次话筒通话她的声音就从手机里漏出来。关一下是幂等的。
      try { link.setSpeakerEnabled(false); } catch { /* 没有房间就没有喇叭 */ }
      await link.release(HOLDER_CALL);
      if (callHeld) {
        callHeld = false;
        lastCallId = null;
        try { routing?.callState?.(false, null); } catch { /* 同上 */ }
      }
    },

    async sendFile(file, to, attributes) {
      await ensureLoaded();
      const using = currentCredential();
      if (using === null) return { ok: false, error: routing === undefined ? WBCH_NO_CREDENTIAL_TEXT : routing.unavailable() };
      try {
        // 发文件要进房。发完不马上离房:通话或远程模式可能还持有着,由引用计数决定。
        await link.acquire(HOLDER_FILE, using);
        await link.sendFile(file, WBCH_FILE_TOPIC, to, attributes);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error && error.message !== '' ? error.message : '文件没发出去' };
      } finally {
        await link.release(HOLDER_FILE).catch(() => {});
      }
    },

    async pullOffer(offer) {
      await ensureLoaded();
      const using = currentCredential();
      if (using === null) return { ok: false, error: routing === undefined ? WBCH_NO_CREDENTIAL_TEXT : routing.unavailable() };
      try {
        // 要等字节进来:持有到取的那一层说「收完了 / 不等了」(releasePull)。
        await link.acquire(HOLDER_PULL, using);
      } catch (error) {
        return { ok: false, error: error instanceof Error && error.message !== '' ? `进不了房间:${error.message}` : '进不了房间' };
      }
      // 进了房还要看电脑在不在(同远程那条路):不在就当场说,别让一条请求在空房里等 15 秒。
      const gate = await ensureWorker();
      if (!gate.ok) { await link.release(HOLDER_PULL).catch(() => {}); return gate; }
      const started = await rpc.filePull(offer);
      if (!started.ok) {
        await link.release(HOLDER_PULL).catch(() => {});
        // 老工人不认这种请求:说人话,别把「不认识这种请求:file_pull」原样摆给他。
        if (started.error.includes('不认识这种请求')) return { ok: false, error: WBCH_PULL_OLD_WORKER_TEXT };
      }
      return started;
    },

    async releasePull() {
      await link.release(HOLDER_PULL).catch(() => {});
    },

    onFileProgress(listener) {
      progressListeners.add(listener);
      return () => { progressListeners.delete(listener); };
    },

    onFileStatus(listener) {
      fileStatusListeners.add(listener);
      return () => { fileStatusListeners.delete(listener); };
    },

    onCaption(listener) {
      captionListeners.add(listener);
      return () => { captionListeners.delete(listener); };
    },

    onSayDecision(listener) {
      sayDecisionListeners.add(listener);
      return () => { sayDecisionListeners.delete(listener); };
    },

    onFiller(listener) {
      fillerListeners.add(listener);
      return () => { fillerListeners.delete(listener); };
    },

    onBackchannel(listener) {
      backchannelListeners.add(listener);
      return () => { backchannelListeners.delete(listener); };
    },

    onFillerVoice(listener) {
      fillerVoiceListeners.add(listener);
      return () => { fillerVoiceListeners.delete(listener); };
    },

    onRing(listener) {
      ringListeners.add(listener);
      return () => { ringListeners.delete(listener); };
    },

    onFile(listener) {
      fileListeners.add(listener);
      return () => { fileListeners.delete(listener); };
    },

    subscribe(listener) {
      changeListeners.add(listener);
      return () => { changeListeners.delete(listener); };
    },

    route: () => activeRoute,
    onCallDropped(listener) {
      callDropListeners.add(listener);
      return () => { callDropListeners.delete(listener); };
    },
    fetchRouteTicket,
    enterRoute,
    leaveRoute,
    markRevoked(error) { if (revoked === null) noteRevoked(error); },

    stop() {
      if (stopped) return;
      stopped = true;
      rpc.dispose();
      unlistenFiles();
      void link.release(HOLDER_RPC).catch(() => {});
      void link.release(HOLDER_CALL).catch(() => {});
      void link.release(HOLDER_FILE).catch(() => {});
      void link.release(HOLDER_PULL).catch(() => {});
      void link.release(HOLDER_RING).catch(() => {});
      void link.release(HOLDER_ROUTE).catch(() => {});
    },
  };

  /**
   * 路线模式的续期:在房里走数据通道让工人续(M2 起回包带新票的地址、房间、路线,覆盖同一路线那一格);
   * 不在房里或续不上,向这条路的出票方再要一张。续到的告诉驱动(规格只存票的地址与到期)。
   */
  async function renewRoute(r: WbchChannelRouting): Promise<{ ok: true } | { ok: false; error: string; revoked?: true }> {
    const route = activeRoute;
    const current = activeCredential();
    if (route === null || current === null) { r.nudge(); return { ok: false, error: r.unavailable() }; }
    if (link.state() === 'connected') {
      const renewed = await rpc.renew();
      if (renewed.ok) {
        const c = renewed.credential;
        const into: RoomRoute = c.route === 'relay' ? 'cloud' : c.route === 'lan' ? 'lan' : route;
        const base = routeCreds[into] ?? current;
        const next: WbchCredential = {
          ...base,
          token: c.token,
          expires_at: c.expires_at,
          ...(c.url === undefined ? {} : { url: c.url }),
          ...(c.room === undefined ? {} : { room: c.room }),
        };
        await saveRoute(into, next);
        if (into === route && c.url !== undefined) entered = { url: next.url, room: next.room };
        try { r.renewed?.(into, ticketOf(next)); } catch { /* 同上 */ }
        changed();
        return { ok: true };
      }
    }
    const fetched = await fetchRouteTicket(route, r.http());
    if (fetched.ok) {
      try { r.renewed?.(route, fetched.ticket); } catch { /* 同上 */ }
      return { ok: true };
    }
    return fetched.revoked === true ? { ok: false, error: fetched.error, revoked: true as const } : { ok: false, error: fetched.error };
  }
}

function ticketOf(c: WbchCredential): RouteTicket {
  return { url: c.url, room: c.room, expires_at: c.expires_at };
}

/** 出门要一张云房间的票、而这台手机既没登录账号、也不在家(问不到电脑)时那句话。 */
export const WBCH_NO_CLOUD_TICKET_TEXT = '这台手机没有出门线路:用账号登录一次,或者回到家里的 Wi-Fi';
