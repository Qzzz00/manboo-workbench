/**
 * 手机与 LiveKit 房间之间的那一层(2026-09-17)。**全 App 只有这个文件认识 livekit-client**。
 *
 * 为什么要这一层:房间同时承载三样东西——通话的音频、控制指令的数据通道、文件。
 * 三样各自有一份「连房间」的代码就会长出三条命,而房间只有一条。所以:
 * 连/断、发数据/收数据、发文件/收文件、麦克风开关,都在这里;上面的 rpc.ts、useChannel.ts、
 * livekitCall.ts 只对这个接口说话,测试里塞一份假 SDK 就能把两条路都走一遍。
 *
 * **谁持有这条连接**:引用计数(acquire/release)。通话要它、远程模式下的 RPC 也要它;
 * 最后一个放手才真的离房。Ben 的口径是「挂断 = 离房」——在局域网里就是这样(那时只有通话持有它);
 * 出了局域网,挂断之后 RPC 还持有着,房间留着不断,否则挂断电话就等于把手机变砖。
 *
 * SDK 是动态 import 的:不打电话、不出局域网就不下载那一大包(与火山 SDK 同一条规矩)。
 */
import type { WbchCredential } from './credentialStore';
import { WBCH_FILE_TOPICS, WBCH_RPC_TOPIC, WBCH_WORKER_IDENTITY } from './channelProtocol';

/* eslint-disable @typescript-eslint/no-explicit-any */

export type WbchLinkState = 'closed' | 'connecting' | 'connected' | 'failed';

/**
 * **电脑那一方上一次是怎么离开这间房的**(2026-09-28,卡 AW)。
 *
 * 现场:维护者的新 Air 不插电时会自己睡,一睡手机首页就写「找不到你的电脑」——
 * 那句话说的是「配对坏了」,而实际上只是电脑睡了。要说人话就得先分得清:
 *
 *   - `closed`:**确知**电脑那一方自己走的(工作台在电脑上退出 / 主动离房);
 *   - `timeout`:**没说再见就消失了**(服务器把它超时踢了、信令断了、媒体断了)——
 *     合盖、断电、断网都长这样;
 *   - `unknown`:没有依据。**一律落这里,不猜**。
 */
export type WbchWorkerDeparture = 'timeout' | 'closed' | 'unknown';

/*
 * livekit `DisconnectReason` 的那几个数(@livekit/protocol 1.50.4,livekit-client 2.22 锁死)。
 * 不 import 那个枚举:这一层只从动态 import 的 SDK 上拿 `Room` 与 `RoomEvent`(见 WbchLivekitSdk),
 * 为一个数字把 protocol 包拽进主包不值当。版本是 pin 死的,数值不会自己变。
 */
/** 对方自己走的。 */
const LK_CLIENT_INITIATED = 1;
/** 信令 websocket 意外关闭。 */
const LK_SIGNAL_CLOSE = 9;
/** 服务器把这个参与者的会话超时了 —— 合盖睡过去最常见的就是这一个。 */
const LK_CONNECTION_TIMEOUT = 14;
/** 媒体流断了 / 媒体超时。 */
const LK_MEDIA_FAILURE = 15;

/**
 * `participantDisconnected` 第二个参数 → 依据。**取不到就是 null**(交给下面那条兜底);
 * 服务器明说了原因、而那个原因既不是「睡了」也不是「自己退了」(被踢、关房、迁移……)→ `unknown`:
 * 它已经把话说清了,不许再拿兜底那条去盖。
 */
function wbchDepartureFromReason(reason: unknown): WbchWorkerDeparture | null {
  if (typeof reason !== 'number') return null;
  if (reason === LK_CLIENT_INITIATED) return 'closed';
  if (reason === LK_SIGNAL_CLOSE || reason === LK_CONNECTION_TIMEOUT || reason === LK_MEDIA_FAILURE) return 'timeout';
  return 'unknown';
}

/** 工人发过来的一个文件。 */
export interface WbchFileIn {
  name: string;
  bytes: Uint8Array;
  mimeType?: string;
  from: string;
  /**
   * 发的那一头签在流上的几样(2026-09-25,卡 J):`sha256`、`bytes`。收完拿 sha256 对一遍,
   * 对不上就丢掉并如实说。老工人不带就缺席(那就不对)。
   */
  attributes?: Record<string, string>;
}

/**
 * 一个文件**正在收**(2026-09-25,卡 J)。几十 MB 的文件在外面要传好一会儿,屏幕上得有个数在动;
 * 断在半路要说断在百分之几。`total` 是流上声明的大小,没有就缺席(那就只显示收了多少)。
 */
export interface WbchFileProgress {
  /** 这一条流的 id(同一个名字可能同时来两份)。 */
  key: string;
  name: string;
  from: string;
  received: number;
  total?: number;
  /** 收完了(紧接着就是 onFile)。 */
  done?: boolean;
  /** 断在半路:一句人话。 */
  failed?: string;
}

export interface WbchLinkListener {
  /** `wb.rpc` 上来的一行 JSON(文本流,框架已经把分块重组好了)。 */
  onText?: (text: string, from: string | undefined) => void;
  onFile?: (file: WbchFileIn) => void;
  /** 正在收的那个文件收到哪儿了(2026-09-25)。 */
  onFileProgress?: (progress: WbchFileProgress) => void;
  onState?: (state: WbchLinkState) => void;
  /**
   * 工人在不在房里。房里没有工人时,发出去的请求没人答。
   * 不在时第二个参数是**它是怎么走的**(2026-09-28,卡 AW;见 {@link WbchWorkerDeparture})。
   */
  onWorker?: (present: boolean, departure?: WbchWorkerDeparture) => void;
  /** 她在不在出声(远端活跃说话人)。 */
  onRemoteSpeaking?: (speaking: boolean) => void;
  /** 你在不在出声。 */
  onLocalSpeaking?: (speaking: boolean) => void;
  /**
   * **这边真的开始放远端音轨了**(2026-09-28,卡 CF 第 4 条):挂着的那个 `<audio>` 报出了
   * 播放进度(`playing` / `timeupdate` 且时间在走)。通话那一层据此告诉工人「我这边在放了」,
   * 工人的开场白等它 —— 「订上音轨」十几分钟前就成立了,救不了第一个字。
   */
  onPlaybackProgress?: () => void;
}

export interface WbchRoomLink {
  state(): WbchLinkState;
  workerPresent(): boolean;
  /**
   * 电脑那一方上一次是怎么离开的(2026-09-28,卡 AW)。**可缺**:老的假房间没有它,
   * 上面那层就当 `unknown`(照旧那套口径)。
   */
  workerDeparture?(): WbchWorkerDeparture;
  /**
   * 拿住这条连接并保证连上。已经连着就直接回来。
   * `holder` 是谁要它(`'call'` / `'rpc'`),同一个 holder 反复拿只算一次。
   * 连不上会抛——调用方要知道连不上,不能默默当成连上了。
   */
  acquire(holder: string, credential: WbchCredential): Promise<void>;
  /** 放手。没人持有时真的离房。 */
  release(holder: string): Promise<void>;
  /**
   * **换一间房,持有不变**(2026-09-23 从零重装验收)。电脑重装之后房间名换了,
   * 手机手上那张是旧房间的:这时正拿着房间的那几份(通话、常驻、远程)要一起搬过去,
   * 而不是各自放手再各自拿 —— 那样中间会有一瞬间谁都不在房里,电话打不进来。
   * 没人持有就只是什么都不做(下一次 acquire 自然用新凭证)。喇叭开关跟着搬过去。
   */
  switchRoom?(credential: WbchCredential): Promise<void>;
  /**
   * 往 `wb.rpc` 发一行 JSON。**走文本流不是数据包**:`publishData` 单包 15KB 封顶,
   * 而 `/state` 一份快照远不止;文本流由框架自动分块重组(与 Mac 侧 channel-worker/src/rpc.ts 对齐)。
   *
   * `to` 给了就**只发那一台**(2026-09-22 晚,给座机换网那条):那条消息里有
   * Wi-Fi 密码,没必要让房里的电脑和另一台手机也收到一份。不给就发给房里所有人 ——
   * 原来那几处调用一个字都不用改。
   */
  sendText(text: string, topic: string, to?: string): Promise<void>;
  /**
   * 发一个文件。`to` 给了就**只发那一台**(2026-09-21,设备间传文件);
   * 不给就发给房里所有人 —— 09-17 那版的行为,一个字没改。
   */
  sendFile(file: File, topic: string, to?: string, attributes?: Record<string, string>): Promise<void>;
  /**
   * 发一段**已经在内存里的字节**(2026-09-25,卡 S:出了局域网「按住说话」的录音)。**只发 `to` 那一台**。
   *
   * 为什么不用上面的 `sendFile`:livekit-client 2.22 的 `sendFile` **不带流上的属性**(它的 SendFileOptions
   * 里压根没有 attributes,传了也被丢掉),而录音得靠属性带上编号,工人才对得上是哪一次识别。
   * `sendBytes` 带属性,整段在内存里时还能走单包快路(小于 15KB)。可缺:老的假房间没有它,识别那条路会如实说走不了。
   */
  sendBytes?(bytes: Uint8Array, topic: string, to: string, options?: { name?: string; mimeType?: string; attributes?: Record<string, string>; compress?: boolean }): Promise<void>;
  /**
   * 开/关本地麦克风轨道。回的是**真的发出去了没有**(2026-09-18)。
   *
   * 以前这里是 `Promise<void>`,于是「没抛,但一条轨道也没有」在界面上完全是哑的:
   * 人对着屏幕说话,她听不到,屏幕什么都不说 —— 那正是 09-18 真机上查了两轮才排除的那一头。
   * `enabled: true` 时,SDK 回了一条本地发布(LocalTrackPublication)才算数;
   * `enabled: false` 时一律回 false(关掉本来就不该有轨道)。
   */
  setMicrophoneEnabled(enabled: boolean): Promise<boolean>;
  /**
   * **撤掉麦克风轨道、停止录音**(2026-09-25,卡 fix/evening-gaps 第 1 条:隐私 + 计费)。
   *
   * 和上面 `setMicrophoneEnabled(false)` 不是一回事:那一下对**已发布**的轨道只是 mute ——
   * livekit-client 缺省不停底下的 MediaStreamTrack,Android 的录音一直开着、麦克风指示一直亮,
   * 轨道也一直挂在房里(手机从 09-22 起常驻房间,挂断并不离房)。09-24 晚维护者挂断引导之后,
   * 电脑上的工人照样订着这条静音轨道、跑了二十多分钟 VAD 与火山识别。
   *
   * 所以**通话里的静音**仍用 mute(再开快、不用重新协商),**这一通收场**(挂断、接不通、出错)用这一下:
   * 从房里撤掉并停掉轨道 —— 录音释放、指示灯灭、电脑那边再也订不到它。没进房、没有轨道时什么都不做,**不抛**。
   */
  stopMicrophone(): Promise<void>;
  /**
   * **她的声音从这台手机的喇叭里出不出来**(2026-09-22 晚,Ben:「响铃应该是手机发出,
   * 而不是话筒,话筒自己是用来对话的」)。
   *
   * **缺省是关的**,这是这一版反过来的那一条:0917 那版进房就把远端音轨挂到一个
   * `autoplay` 的 `<audio>` 上,因为那时「在房里」几乎等于「在通话里」。从 2026-09-22 晚起
   * 手机**常驻房间**(不通话也在房里,不然电话根本打不进来),于是那条老规矩变成了
   * 「房里谁说话,这台手机就播谁」—— 他拿起听筒对着话筒说话,她的回答却从桌上那台
   * 手机里出来。那正是 20:50 真机上看到的一幕。
   *
   * 所以改成**由通话那一层明着打开**(call/livekitCall.ts:接通时开,挂断时关)。
   * 一句话:**谁接谁说话,另一端只看不出声**。
   *
   * 同步生效,没有 await:她可能正说到一半,这一下要立刻。
   */
  setSpeakerEnabled(enabled: boolean): void;
  /**
   * **喇叭真的开始放了没有**(2026-09-27,卡 CL)。
   *
   * 维护者 21:3x 真机:手机打过去「一上来就听到『吩咐』两个字,『吩』字还是尾巴」。
   * 工人那边一帧都没少发 —— 吃掉前半句的是**这一侧的起播**:常驻房间时那个
   * `<audio>` 是静音 + 暂停的,接通才 `play()`,而 Android WebView 从 `play()`
   * 到扬声器真出声要重开一次 AudioTrack(几百毫秒),这期间到的帧在抖动缓冲里
   * 过期就被丢掉。座机(树莓派)一路不吃字正是因为它那根 `aplay` 管子一直开着
   * (phone-bridge/room_link.py 的 `_to_earpiece`)。
   *
   * 所以通话那一层在**请工人接起之前**先等这一下:`play()` 的 promise 回来
   * (= 浏览器认下了这次播放)才去请她开口。等不到也照样打 —— 这一条只等一小会儿
   * (call/livekitCall.ts 的 {@link WBCH_SPEAKER_READY_MS}),不许因为它接不通。
   *
   * 喇叭没开、还没订上音轨时**当场就回**:没有什么可等的。
   */
  speakerReady(): Promise<void>;
  listen(listener: WbchLinkListener): () => void;
  /**
   * 此刻谁持有这条连接(2026-10-20,卡 E:原生收铃要看「只剩守铃 / 远程」才交给原生)。
   * **可缺**:老的假房间没有它。
   */
  heldBy?(): readonly string[];
  /**
   * **停靠**(2026-10-20,卡 E)。离房但记着谁持有:熄屏久了 WebView 这一页会被冻住、房间里的消息没人读,
   * 这时把「听铃」交给原生前台服务,它用**同一个身份**进房 —— LiveKit 同一身份第二条连接会把第一条踢掉,
   * 所以这一条得先让出来。停靠期间 {@link WBCH_PARKABLE_HOLDERS} 那几份再来要只记一笔、不进房;
   * 别的(通话 / 文件)来要就自己收回并进房(会把原生那条踢下去,原生据此收场)。
   */
  park?(): Promise<void>;
  /** 收回:持有还在就重新进房。 */
  unpark?(credential: WbchCredential): Promise<void>;
  parked?(): boolean;
  /**
   * 此刻连着的是哪一间(地址 + 房间名);没连着是 null(2026-10-21,局域网 M4:换路线时据此判要不要换房)。
   * **可缺**:老的假房间没有它。
   */
  current?(): { url: string; room: string } | null;
  /**
   * 退出房间、持有照记、不算停靠(2026-10-21,局域网 M4:两条路都走不了 —— 撤销、出了门又没接中转)。
   * 下一次谁带着票来拿(acquire),就再进。**可缺**。
   */
  detach?(): Promise<void>;
}

/**
 * 停靠时还能「只记一笔」的那几份持有(2026-10-20,卡 E):守铃(`ring`)、远程代理(`rpc`),
 * 以及路线那一份(`route`,2026-10-21 局域网 M4:路线驱动「人在这条路的房里」那一份,和守铃一样只是在房里等)。
 * 这几样在熄屏冻住的页面里本来就是聋的;通话、发文件、取文件那几份是他正在用的,不许停靠。
 * 名字与 channel.ts 的 HOLDER_RING / HOLDER_RPC / HOLDER_ROUTE 同一份。
 */
export const WBCH_PARKABLE_HOLDERS: ReadonlySet<string> = new Set(['ring', 'rpc', 'route']);

/** livekit-client 里我们用到的那几样。不把整份 d.ts 搬进来。 */
export interface WbchLivekitSdk {
  Room: new (options?: any) => any;
  RoomEvent: Record<string, string>;
}

export interface WbchRoomLinkDeps {
  /** 测试注入假 SDK;生产是动态 import('livekit-client')。 */
  loadSdk?: () => Promise<WbchLivekitSdk>;
  /** 远端音轨挂到哪儿。缺省挂一个隐藏的 <audio> 到 body。 */
  attachAudio?: (element: HTMLMediaElement) => void;
  detachAudio?: (element: HTMLMediaElement) => void;
}

async function defaultLoadSdk(): Promise<WbchLivekitSdk> {
  // 字面量 specifier:Vite 会把它单独切一块,启动和主界面都不背这个包。
  const mod = await import('livekit-client');
  return mod as unknown as WbchLivekitSdk;
}

function defaultAttach(element: HTMLMediaElement): void {
  try {
    element.setAttribute('data-wbch', 'remote-audio');
    element.style.display = 'none';
    (element as HTMLAudioElement).autoplay = true;
    document.body.appendChild(element);
    // **静音着的不催它播**(2026-09-22 晚):常驻房间时这一路本来就该是哑的,
    // 催一遍只是白烧电。喇叭打开时 setSpeakerEnabled 会补这一下。
    if (!element.muted) void element.play?.().catch(() => { /* 自动播放被拦:点一下屏幕就恢复 */ });
  } catch { /* 没有 DOM(测试 / 非浏览器)就算了 */ }
}

function defaultDetach(element: HTMLMediaElement): void {
  try { element.remove(); } catch { /* 同上 */ }
}

/** 流上的属性 → 一张干净的表(只收字符串)。没有就 undefined。 */
function wbchStreamAttributes(raw: unknown): Record<string, string> | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

export function createWbchRoomLink(deps: WbchRoomLinkDeps = {}): WbchRoomLink {
  const loadSdk = deps.loadSdk ?? defaultLoadSdk;
  const attachAudio = deps.attachAudio ?? defaultAttach;
  const detachAudio = deps.detachAudio ?? defaultDetach;

  const listeners = new Set<WbchLinkListener>();
  /** `wb.rpc` 上来的文本流按打开顺序一条一条读(见下面注册处的理由)。 */
  let textQueue: Promise<void> = Promise.resolve();
  const holders = new Set<string>();
  /** 停靠中(见接口上 `park` 那段):听铃交给了原生,这一条不进房。 */
  let parked = false;
  let sdk: WbchLivekitSdk | null = null;
  let room: any = null;
  let state: WbchLinkState = 'closed';
  let worker = false;
  /**
   * 电脑那一方上一次是怎么走的(2026-09-28,卡 AW)。缺省 `unknown` —— 一次都没见过它的时候
   * 本来就没有依据(手机可能守在一间早就作废的旧房里)。
   */
  let departure: WbchWorkerDeparture = 'unknown';
  /**
   * **这一次房间连接里确实见过电脑在房里**。这是没有 reason 时唯一允许用的那条依据(见 `noteWorkerLeft`)。
   * 换房 / 断开 / 重开都清掉:上一间房里见过的,不能拿来说这一间。
   */
  let workerSeen = false;
  let connecting: Promise<void> | null = null;
  /** 此刻这间房是拿哪张票进的(地址 + 房间名)。见接口上的 `current`。 */
  let openedWith: { url: string; room: string } | null = null;
  const attached: HTMLMediaElement[] = [];
  /**
   * 远端的声音放不放(见接口上那段)。**缺省关**:常驻房间的手机在不通话时一声不出。
   * 记成一个变量而不是只改元素:音轨可能比「开喇叭」那一下**后**才订上来
   * (她先开口、手机才接通),那时新挂上去的这一个也要跟着当前这个值走。
   */
  let speaker = false;
  /**
   * 还没回来的那几下 `play()`(2026-09-27,卡 CL)。`speakerReady()` 等的就是它们:
   * 每次开喇叭都可能有一条,回来之后自己清掉(不清的话一整天的常驻会攒一串)。
   */
  let playing: Promise<unknown>[] = [];

  function emit<K extends keyof WbchLinkListener>(key: K, ...args: Parameters<NonNullable<WbchLinkListener[K]>>): void {
    for (const l of [...listeners]) {
      const fn = l[key] as ((...a: unknown[]) => void) | undefined;
      // 一个监听者抛异常不该把别的监听者带走,更不该把房间带走。
      if (fn !== undefined) { try { fn(...args); } catch { /* 见上 */ } }
    }
  }

  /**
   * 一个 `<audio>` 跟上当前的喇叭开关。元素可能已经被拆了,所以整段 try。
   *
   * **`play()` 那个 promise 留着**(2026-09-27,卡 CL):它回来才算浏览器认下了
   * 这次播放,而通话那一层要在请工人开口之前等它(见 `speakerReady`)。
   */
  /**
   * 这个 `<audio>` 一旦报出**播放进度**就说一声(2026-09-28,卡 CF 第 4 条)。
   *
   * `play()` 回来只表示浏览器接下了这次播放;真有音频被播出去才会有 `playing` / `timeupdate`
   * (而且 `currentTime` 在走)。**同一个元素只挂一次**:常驻一整天的房间不许攒监听器。
   * 它可能一直不来(工人还没开口,那条轨上没有帧)—— 所以通话那一层另有一条判据与上限,
   * 见 src/call/playbackReady.ts。
   */
  const watched = new WeakSet<HTMLMediaElement>();
  function watchPlayback(element: HTMLMediaElement): void {
    if (watched.has(element)) return;
    watched.add(element);
    const tell = (): void => {
      try { if ((element.currentTime ?? 0) <= 0) return; } catch { return; }
      emit('onPlaybackProgress');
    };
    try {
      element.addEventListener?.('playing', tell);
      element.addEventListener?.('timeupdate', tell);
    } catch { /* 没有 DOM / 已经拆了 */ }
  }

  function applySpeaker(element: HTMLMediaElement): void {
    try {
      element.muted = !speaker;
      if (speaker) watchPlayback(element);
      // 静音的那一刻顺手暂停:muted 的 `<audio>` 仍在解码,而常驻房间是一整天的事。
      if (speaker) {
        const started = (element as HTMLAudioElement).play?.();
        // 自动播放被拦:点一下屏幕就恢复 —— 但**不许把这条 promise 变成一个未捕获的拒绝**,
        // 也不许因此让 speakerReady 一直等着(所以 catch 之后照样算「起播这一下过了」)。
        if (started !== undefined && started !== null) playing.push(Promise.resolve(started).catch(() => undefined));
      }
      else (element as HTMLAudioElement).pause?.();
    } catch { /* 没有 DOM / 已经拆了 */ }
  }

  function setState(next: WbchLinkState): void {
    if (state === next) return;
    state = next;
    emit('onState', next);
  }

  function refreshWorker(): void {
    const present = room !== null
      && typeof room.remoteParticipants?.has === 'function'
      && room.remoteParticipants.has(WBCH_WORKER_IDENTITY) === true;
    if (present === worker) return;
    worker = present;
    // 在房里就没有「怎么走的」这回事:见过它 + 依据清零,下一次走的时候重新判。
    if (present) { workerSeen = true; departure = 'unknown'; }
    emit('onWorker', present, present ? undefined : departure);
  }

  /**
   * **电脑那一方从房里消失了,记下依据**(2026-09-28,卡 AW)。
   *
   * 首选 livekit 给的 `disconnectReason`(`participantDisconnected` 的第二个参数)。
   * livekit-client 2.22 只在**参与者信息更新**那条路上带着它(Room.ts 的 handleParticipantUpdates),
   * 也就是正常情况下的那一条;另外两条不带 reason 的路是「我们自己在重连」(handleRestarting)
   * 与「房间被搬走」(RoomMoved)。
   *
   * 所以 reason 取不到时**只用一条依据**:这一次连接里确实见过电脑在这间房,而且我们自己的房间
   * 连接当时是好的(`state === 'connected'`),它却消失了 —— 那就是「没说再见就消失了」。
   * **这条依据的边界**(必须说清,不许含糊):
   *   - 它分不清「合盖睡了」和「电脑那头的工作台被干净地杀掉、而服务器没来得及说 reason」——
   *     两者都会落 `timeout`。落 `timeout` 的那句话只说「睡着了/合盖或省电」,所以万一是后者,
   *     说的话偏了一点,但仍然指向「去电脑那儿看一眼」,不会像「重新扫码配对」那样把人带错路;
   *   - 我们自己在重连、或者房间被搬走时,紧接着会来 `Reconnecting` / `Moved`,那两处把依据清回
   *     `unknown`(见下面的 wire),所以那两条路不会被说成「电脑睡了」;
   *   - 一次都没见过电脑(手机守在旧房里)→ `workerSeen` 是 false → `unknown`。**这正是不许编的那一格。**
   */
  function noteWorkerLeft(reason: unknown): void {
    const told = wbchDepartureFromReason(reason);
    if (told !== null) { departure = told; return; }
    departure = workerSeen && state === 'connected' ? 'timeout' : 'unknown';
  }

  function wire(current: any, events: Record<string, string>): void {
    current.on?.(events.TrackSubscribed ?? 'trackSubscribed', (track: any) => {
      if (track?.kind !== 'audio') return;
      try {
        const element = track.attach() as HTMLMediaElement;
        // **先按当前的开关静音,再挂上去**:反过来的话,不通话的时候她的第一个字
        // 会从手机里漏出来(autoplay 的 <audio> 一挂上就开始放)。
        applySpeaker(element);
        attached.push(element);
        attachAudio(element);
      } catch { /* 挂不上就听不见;通话本身的成败不由它决定 */ }
    });
    current.on?.(events.TrackUnsubscribed ?? 'trackUnsubscribed', (track: any) => {
      try { for (const element of track?.detach?.() ?? []) detachAudio(element as HTMLMediaElement); } catch { /* 同上 */ }
    });
    current.on?.(events.ActiveSpeakersChanged ?? 'activeSpeakersChanged', (speakers: { identity?: string }[]) => {
      const ids = new Set((speakers ?? []).map((s) => s?.identity).filter((x): x is string => typeof x === 'string'));
      emit('onRemoteSpeaking', ids.has(WBCH_WORKER_IDENTITY));
      const me = current.localParticipant?.identity;
      emit('onLocalSpeaking', typeof me === 'string' && ids.has(me));
    });
    current.on?.(events.ParticipantConnected ?? 'participantConnected', refreshWorker);
    current.on?.(events.ParticipantDisconnected ?? 'participantDisconnected', (participant: any, reason: unknown) => {
      // 只认电脑那一方;房里还有另一台手机、那只听筒,它们怎么走的与首页这句话无关。
      // 已经换走的那一间不算数(同 `disconnected` 那条):手上是另一间,别拿旧房的事说新房。
      if (room === current && participant?.identity === WBCH_WORKER_IDENTITY) noteWorkerLeft(reason);
      refreshWorker();
    });
    current.on?.(events.Disconnected ?? 'disconnected', () => {
      // 已经换走的那一间(换房 / 重开)断开时不算数:这时手上是另一间,别把它说成「断了」。
      if (room !== current) return;
      // 房间自己断了(掉网、被踢)。状态如实翻过去,上面那层会重连或退回未连接。
      worker = false;
      // 断的是**我们这一头**:电脑怎么样完全不知道,依据清掉(否则会把自己掉网说成电脑睡了)。
      departure = 'unknown';
      workerSeen = false;
      emit('onWorker', false, departure);
      setState('closed');
    });
    current.on?.(events.Reconnecting ?? 'reconnecting', () => {
      // 我们自己在重连:这期间收到的「电脑不在了」不作数(见 noteWorkerLeft 的边界那段)。
      if (room === current) { departure = 'unknown'; workerSeen = false; }
      setState('connecting');
    });
    current.on?.(events.Reconnected ?? 'reconnected', () => { setState('connected'); refreshWorker(); });
    // 房间被服务器搬走:房里所有人会先「消失」一遍,那也不是电脑睡了。
    current.on?.(events.Moved ?? 'moved', () => { if (room === current) { departure = 'unknown'; workerSeen = false; } });
    // `wb.rpc`:文本流。注册在 connect 之前,工人可能一进来就推字幕。
    try {
      /**
       * **一条一条读**(2026-09-18 实测)。每条 `sendText` 是一条独立的文本流;并发地 readAll
       * 读出来的顺序是乱的 —— 本机跑通那一遍里,事务官一段话拆成四小句发过来,
       * 屏幕上**先出现的是最后一句**。字幕乱序比晚几十毫秒糟得多,所以按流打开的顺序排队读。
       * (发的那一侧不排队:`sendText` 的 promise 要等对面收完才落地,排在发端会把后几句压后好几秒。)
       */
      current.registerTextStreamHandler?.(WBCH_RPC_TOPIC, (reader: any, info: { identity?: string }) => {
        textQueue = textQueue.then(async () => {
          try {
            const text: string = await reader.readAll();
            emit('onText', text, info?.identity);
          } catch { /* 一条没收完不该把房间带走 */ }
        });
      });
    } catch { /* 同一个 topic 注册两遍会抛,忽略 */ }
    for (const topic of WBCH_FILE_TOPICS) {
      try {
        current.registerByteStreamHandler?.(topic, (reader: any, info: { identity?: string }) => {
          void (async () => {
            const name = typeof reader.info?.name === 'string' && reader.info.name !== '' ? reader.info.name : '未命名文件';
            const from = info?.identity ?? '';
            const key = typeof reader.info?.id === 'string' && reader.info.id !== '' ? reader.info.id : `${name}-${Date.now()}`;
            const attributes = wbchStreamAttributes(reader.info?.attributes);
            const declared = Number(reader.info?.size ?? attributes?.bytes);
            const total = Number.isFinite(declared) && declared > 0 ? declared : undefined;
            let received = 0;
            let lastEmit = 0;
            const progress = (extra: Partial<WbchFileProgress> = {}): void => {
              emit('onFileProgress', { key, name, from, received, ...(total === undefined ? {} : { total }), ...extra });
            };
            const chunks: Uint8Array[] = [];
            try {
              progress();
              /**
               * **一块一块读,边读边报**(2026-09-25,卡 J)。以前是一次 readAll 读完 ——
               * 40MB 在外面要传一两分钟,屏幕上一动不动,断了也不知道断在哪。
               * 老的假 SDK / 老版本只有 readAll 的,退回整读。
               */
              if (typeof reader[Symbol.asyncIterator] === 'function') {
                for await (const chunk of reader as AsyncIterable<Uint8Array>) {
                  chunks.push(chunk);
                  received += chunk.byteLength;
                  // 每 256KB 报一次就够了:报得太勤反而把界面拖慢。
                  if (received - lastEmit >= 256 * 1024) { lastEmit = received; progress(); }
                }
              } else {
                const all: Uint8Array[] = await reader.readAll();
                for (const chunk of all) { chunks.push(chunk); received += chunk.byteLength; }
              }
            } catch (error) {
              const pct = total === undefined ? '' : `(收到 ${Math.floor((received / total) * 100)}%)`;
              progress({ failed: `传到一半断了${pct}${error instanceof Error && error.message !== '' ? `:${error.message}` : ''}` });
              return;
            }
            try {
              const bytes = new Uint8Array(received);
              let at = 0;
              for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
              const mimeType = typeof reader.info?.mimeType === 'string' ? reader.info.mimeType : undefined;
              progress({ done: true });
              emit('onFile', { name, bytes, from, ...(mimeType === undefined ? {} : { mimeType }), ...(attributes === undefined ? {} : { attributes }) });
            } catch { /* 一个文件收坏了不该把房间带走 */ }
          })();
        });
      } catch { /* 同一个 topic 注册两遍会抛,忽略 */ }
    }
  }

  async function open(credential: WbchCredential): Promise<void> {
    if (state === 'connected' && room !== null) return;
    if (connecting !== null) return connecting;
    connecting = (async () => {
      setState('connecting');
      try {
        /**
         * **断掉的那一间先关掉再开新的**(2026-09-22 晚)。以前走到这儿时 `room` 可能
         * 还留着一间已经 `disconnected` 的房 —— 那时「重连」几乎不会发生(只有通话那一层
         * 会重新 acquire)。从今天起手机**常驻房间**,上面那根看门狗会一遍遍走这条路,
         * 不关掉旧的就是一间漏一间。
         */
        if (room !== null) {
          const stale = room;
          room = null;
          // 重开一间:依据跟着房间走(2026-09-28,卡 AW)。
          departure = 'unknown';
          workerSeen = false;
          for (const element of attached.splice(0)) detachAudio(element);
          try { await stale.disconnect(); } catch { /* 已经断了 */ }
        }
        sdk = sdk ?? await loadSdk();
        const current = new sdk.Room({ adaptiveStream: false, dynacast: false });
        wire(current, sdk.RoomEvent ?? {});
        await current.connect(credential.url, credential.token);
        room = current;
        openedWith = { url: credential.url, room: credential.room };
        setState('connected');
        refreshWorker();
      } catch (error) {
        room = null;
        openedWith = null;
        setState('failed');
        throw error;
      } finally {
        connecting = null;
      }
    })();
    return connecting;
  }

  async function close(): Promise<void> {
    const current = room;
    room = null;
    openedWith = null;
    worker = false;
    // 是我们自己离房:电脑那边怎么样一概不知道,依据清回「不知道」。
    departure = 'unknown';
    workerSeen = false;
    // 离房把喇叭关回缺省:下一次进房(常驻那一份)不该带着上一通电话的开关。
    speaker = false;
    for (const element of attached.splice(0)) detachAudio(element);
    if (current !== null) {
      try { await current.disconnect(); } catch { /* 拆的时候什么都可能抛 */ }
    }
    setState('closed');
  }

  return {
    state: () => state,
    workerPresent: () => worker,
    workerDeparture: () => departure,

    async acquire(holder, credential) {
      holders.add(holder);
      if (parked) {
        // 停靠中:守铃 / 远程只记一笔(进房就把原生那条踢下去);别的要房间的,收回来再进。
        if (WBCH_PARKABLE_HOLDERS.has(holder)) return;
        parked = false;
      }
      try {
        await open(credential);
      } catch (error) {
        // 拿不到就别占着:不然下一次 release 会把一个根本没连上的房间当成连着的。
        holders.delete(holder);
        throw error;
      }
    },

    async release(holder) {
      holders.delete(holder);
      if (holders.size === 0) { parked = false; await close(); }
    },

    heldBy: () => [...holders],

    parked: () => parked,

    async park() {
      if (holders.size === 0 || parked) return;
      parked = true;
      // 正在连的那一下等它落地再断:不然它连上之后又占着这个身份。
      if (connecting !== null) { try { await connecting; } catch { /* 没连上正好 */ } }
      await close();
    },

    async unpark(credential) {
      if (!parked) return;
      parked = false;
      if (holders.size === 0) return;
      await open(credential);
    },

    async switchRoom(credential) {
      if (holders.size === 0) return;
      // 断掉旧的那一间;`open` 里那段「断掉的那一间先关掉再开新的」会把音轨与连接一起收拾干净。
      const keepSpeaker = speaker;
      if (room !== null) {
        const stale = room;
        room = null;
        openedWith = null;
        worker = false;
        // 换一间房:上一间里那点依据不能带进新房间(2026-09-28,卡 AW)。
        departure = 'unknown';
        workerSeen = false;
        emit('onWorker', false, departure);
        for (const element of attached.splice(0)) detachAudio(element);
        try { await stale.disconnect(); } catch { /* 已经断了 */ }
      }
      // 不经 setState:这不是「断了」,是「换一间」—— 通话那一层看到 closed 会当成掉线收场。
      state = 'closed';
      await open(credential);
      speaker = keepSpeaker;
    },

    current: () => (room === null ? null : openedWith),

    async detach() {
      // 正在连的那一下等它落地再断:不然它连上之后又占着房间。
      if (connecting !== null) { try { await connecting; } catch { /* 没连上正好 */ } }
      await close();
    },

    async sendText(text, topic, to) {
      if (room === null) throw new Error('还没进房');
      await room.localParticipant?.sendText(text, {
        topic,
        // 点名发:LiveKit 只把这条流送给它,房里别的设备连有这回事都不知道。
        ...(to === undefined || to === '' ? {} : { destinationIdentities: [to] }),
      });
    },

    async sendBytes(bytes, topic, to, options = {}) {
      if (room === null) throw new Error('还没进房');
      await room.localParticipant?.sendBytes(bytes, {
        topic,
        // 只发工人那一台:录音不该让房里的另一台电脑、那只听筒也收一份。
        destinationIdentities: [to],
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.mimeType === undefined ? {} : { mimeType: options.mimeType }),
        ...(options.attributes === undefined ? {} : { attributes: options.attributes }),
        ...(options.compress === undefined ? {} : { compress: options.compress }),
      });
    },

    async sendFile(file, topic, to, attributes) {
      if (room === null) throw new Error('还没进房');
      // 名字必须自己给:浏览器的 File 自带 name,但显式传一遍两端都不会拿到 "unknown"
      // (原型工人那边踩过这个坑,见交接-0917-LiveKit通道层原型 第五节)。
      await room.localParticipant?.sendFile(file, {
        topic,
        name: file.name,
        mimeType: file.type,
        // 点名发:LiveKit 只把这条流送给它,房里别的设备连有这回事都不知道。
        ...(to === undefined || to === '' ? {} : { destinationIdentities: [to] }),
        // 统一输入框的附件带 `purpose: attachment`(2026-09-25):电脑首页据此不把它当成「发来了一个文件」。
        ...(attributes === undefined ? {} : { attributes }),
      });
    },

    setSpeakerEnabled(enabled) {
      if (speaker === enabled) return;
      speaker = enabled;
      if (!enabled) playing = [];
      for (const element of attached) applySpeaker(element);
    },

    async speakerReady() {
      // 喇叭没开 / 还没订上音轨:没有什么可等的(当场回,别把接通拖慢)。
      if (!speaker || playing.length === 0) return;
      const waiting = playing;
      await Promise.all(waiting);
      // 这一批过了就不留着(下一次开喇叭又是新的一批)。
      if (playing === waiting) playing = [];
    },

    async setMicrophoneEnabled(enabled) {
      if (room === null) throw new Error('还没进房');
      // livekit-client 回一条 LocalTrackPublication(开)或 undefined(关 / 没成)。
      const publication: unknown = await room.localParticipant?.setMicrophoneEnabled(enabled);
      return enabled && publication !== undefined && publication !== null;
    },

    async stopMicrophone() {
      const participant = room?.localParticipant;
      if (participant === undefined || participant === null) return;
      let publications: any[] = [];
      try { publications = [...(participant.trackPublications?.values?.() ?? [])]; } catch { publications = []; }
      // 麦克风那一条(livekit-client 的 Track.Source.Microphone 就是字符串 'microphone')。
      for (const publication of publications) {
        if (publication?.source !== 'microphone') continue;
        const track = publication.track;
        if (track === undefined || track === null) continue;
        // 第二个参数 true = 撤掉的同时 stop():底下的 MediaStreamTrack 停了,系统的录音才释放。
        try { await participant.unpublishTrack(track, true); } catch { /* 撤不掉也要停,见下一行 */ }
        try { track.stop?.(); } catch { /* 已经停了 */ }
      }
    },

    listen(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
