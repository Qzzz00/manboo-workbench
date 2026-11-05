/**
 * 和事务官打电话:**LiveKit 那一版**(2026-09-17,决策记录「手机通道层改 LiveKit」)。
 *
 * 和火山 RTC 那一版(rtcCall.ts)实现的是**同一个 `CallClient` 接口**,所以底部三个键、
 * 球的形态、通话纪要那一整套一个字都不用改 —— 换的只是「声音从哪儿来、字幕从哪儿来」。
 *
 * 一通电话的顺序:
 *   1. 拿房间凭证(局域网里现向 8791 要一张;出门在外用存着的那张,快到期先续)——由 channel.ts 管;
 *   2. 进房(房间连接是共享的,通话只是**拿住**它,见 roomLink.ts 的引用计数);
 *   3. **打开喇叭** → 她说的话才从这台手机出来(2026-09-22 晚改:缺省是关的,见 roomLink.ts
 *      的 `setSpeakerEnabled`。常驻房间之后「在房里」不再等于「在通话里」);
 *   4. 等到电脑上的工人,再请它**接起**这一通:普通电话发招呼(`call.start`)、引导那一通发「我在做引导」,
 *      都要等到它的回话 —— 回了才算**接通**。进房到接起合起来最多 {@link WBCH_CONNECT_MS}(15 秒),
 *      超了说清卡在哪一步(2026-09-25 返工:统筹 0.2.95 小米一直「正在接通…」一分多钟,没有一句原因);
 *   5. **接通之后才发布麦克风**(2026-09-25,卡 fix/evening-gaps:小米那一通引导卡在「正在接通…」5 分钟,
 *      麦克风开了 5 分钟),而且**不挡接通**:发布要协商,网络慢时 livekit 自己的重试能拖一分多钟 ——
 *      最多等 {@link WBCH_MIC_PUBLISH_MS},等不到就说「麦克风没打开」,电话照样通着。
 *      开不开还只认他的意愿(2026-09-24):按了「关掉麦克风」就不发,见 applyMic;
 *   6. 挂断 / 接不通 / 出错 = **撤掉麦克风轨道、停掉录音** + 放手(2026-09-25:以前只是静音,
 *      轨道留在常驻房间里、Android 的录音一直开着)。局域网里放手就是离房(那时只有通话持有它)。
 *
 * 每一步都往控制台打一行 `[通话] …`(带离「点下去」多少毫秒):真机卡住时,调试口里一眼看得见卡在哪一步。
 *
 * **打断不用手机做任何事**:工人那边 VAD 一听见你出声就停(与火山那版同一条结论)。
 *
 * 字幕来自工人经数据通道推的 `{type:'caption'}`(channelProtocol.ts),**不是**本地转写:
 * 转写是在电脑上做的,手机自己再转一遍只会得到第二份不一样的文字。
 */
import type { ApiClient } from '../api/client';
import { WBCH_ROOM_STALE_TEXT, type WbchChannel, type WbchRoomCheck, WBCH_CALL_ROUTE_DROPPED_TEXT } from '../channel/channel';
import type { WbchCaption, WbchFiller, WbchFillerVoiceChanged } from '../channel/channelProtocol';
import type { FillerAudio, FillerLine, FillerSkipReason } from './fillerAudio';
import { createFillerAudio } from './fillerAudio';
import { createHtmlFillerPlayer } from './fillerPlayer';
import { createAckAudio, type AckAudio } from './ackAudio';
import { createFillerVoiceCache, type FillerVoiceCache } from './fillerVoiceCache';
import { WBCH_OUTPUT_WARM_MS, warmOutput, type WarmSinkLike } from './outputWarm';
import type { CallClient, CallEvents, CallResult, CallStartOptions } from './rtcCall';
import type { CallUtterance } from './callModel';
import { MIC_PUBLISH_FAILED_TEXT, ensureMicPermission, type MicPermissionDeps, type MicPermissionResult } from './micPermission';

export interface WbchCallClientDeps {
  channel: WbchChannel;
  now?: () => number;
  /** 等工人露面等多久。测试调快。 */
  workerWaitMs?: number;
  /**
   * 问录音权限那一步(2026-09-18)。测试注入假的;生产是原生小插件 → getUserMedia 两条路
   * (见 micPermission.ts)。**引导通话与普通通话走的是同一条**:一通电话就是一通电话。
   */
  askMicPermission?: (deps?: MicPermissionDeps) => Promise<MicPermissionResult>;
  /**
   * 缓冲语那一套(2026-09-20)。测试注入假的;生产是包里那七句 m4a
   * (call/fillerAudio.ts,音频在 public/filler/,由 scripts/render-filler-audio.mjs 生成)。
   *
   * 传 `null` 就**整个不垫**(留给「这台机器上一句都放不出来」那种情况 —— 电话照打)。
   */
  createFiller?: (hooks: { onPlayed: (line: FillerLine) => void; onSkipped: (reason: FillerSkipReason) => void }) => FillerAudio | null;
  /**
   * 跟 8791 说话的那个(选好路的:局域网直连 / 经房间代理)。**缓冲语按当前音色现合成**
   * 要用它两条(2026-09-22):
   *   - `GET /butler/status` → 现在是哪个音色(这条本来就在手机的白名单里);
   *   - `POST /butler/proxy/api/tts` → 那一句的音频(`blob`,出了局域网自动走房间的 byte stream)。
   * 不给就**整套用包里那七句** —— 电话照打,只是换了音色之后会有两个嗓子(老行为)。
   */
  api?: ApiClient;
  /** 测试注入假的音色缓存;传 `null` 表示这一版一句都不现合成(只用包里那七句)。 */
  createVoiceCache?: () => FillerVoiceCache | null;
  /** 挂断时每一步(告诉工人、关麦克风、离房)最多等多久。测试调快。 */
  hangupStepMs?: number;
  /** 麦克风那条队里后一次最多等前一次多久(见 {@link WBCH_MIC_QUEUE_WAIT_MS})。测试调快。 */
  micQueueWaitMs?: number;
  /** 开喇叭之后等它起播多久(见 {@link WBCH_SPEAKER_READY_MS})。测试调快。 */
  speakerReadyMs?: number;
  /** 核对房间最多等多久(见 {@link WBCH_RECHECK_MS})。测试调快。 */
  recheckMs?: number;
  /** 进房到工人接起,合起来最多等多久(见 {@link WBCH_CONNECT_MS})。测试调快。 */
  connectMs?: number;
  /** 接通之后发布麦克风最多等多久(见 {@link WBCH_MIC_PUBLISH_MS})。测试调快。 */
  micPublishMs?: number;
  /** 问录音权限最多等多久(见 {@link WBCH_MIC_PERMISSION_WAIT_MS})。测试调快。 */
  micPermissionWaitMs?: number;
  /** 把通话输出烘热最多等多久(见 {@link WBCH_OUTPUT_WARM_MS};卡 OP)。`0` = 不烘。测试调快。 */
  outputWarmMs?: number;
  /** 造那一小段静音(卡 OP)。测试注入假的;缺省是一个循环放静音的 `<audio>`。 */
  makeWarmSink?: () => WarmSinkLike | undefined;
  /** 每一步记一行(缺省打到控制台 `[通话] …`)。测试注入收集器。 */
  trace?: (line: string) => void;
}

/**
 * 麦克风那条队里,后一次最多等前一次多久(2026-09-24)。SDK 里一次开/关正常是几十毫秒到几秒
 * (冷启动 getUserMedia + 协商);万一有一次永远不回,不能让排在后面的「关」永远轮不上。
 * 等不到就照样往下走 —— 每一次「开」落地之后都会再看一眼意愿,所以放行不会把麦克风留成开的。
 */
export const WBCH_MIC_QUEUE_WAIT_MS = 10_000;

/**
 * 挂断时每一步最多等多久(2026-09-23 从零重装验收)。
 *
 * 挂断要告诉工人「这通完了」、关麦克风、放掉房间 —— 每一步都可能**等不到回话**:
 * 手机守在一间没有工人的旧房里时,「告诉工人」那一条永远没人答。以前一步一步干等,
 * 屏幕停在「正在挂断…」回不来,只能把 App 划掉。现在每一步最多等这么久,等不到就当它办完了往下走
 * —— **电话必须挂得掉**,工人那边手机一离房自己也会收场。
 */
export const WBCH_HANGUP_STEP_MS = 3000;

/** 等一个 promise,最多等 `ms`;等不到或者它抛了都回 `undefined`,不抛。 */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.catch(() => undefined),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 房里等不到工人时屏幕上那句话(2026-09-23)。按「核对房间」的结果分:
 *   - 电脑那边用的就是这一间(或者刚换进新的那一间也没有它)→ 工人真的不在;
 *   - 问不到电脑那边现在是哪一间 → 可能是电脑重装过、手上是旧配对:说清并引导重新配对;
 *   - 这条通道不会核对(老接线)→ 老那句。
 */
export function noWorkerText(check: WbchRoomCheck | undefined): string {
  // 中转明说这台手机不认了(2026-09-23):同样是「重新扫码配对」那条路。
  if (check?.kind === 'unknown' || check?.kind === 'revoked') return WBCH_ROOM_STALE_TEXT;
  return WBCH_CALL_NO_WORKER_TEXT;
}

/** 房里没有工人时那句话。这是最常见的一种「打不通」:电脑上的工人没在跑。 */
export const WBCH_CALL_NO_WORKER_TEXT = '电脑上的事务官没接:电脑上的工作台可能没开,或者正在重启。等一两分钟再打';

/**
 * 进房之后等工人露面等多久。
 *
 * 为什么要等而不是进房就问一次:`room.connect()` 刚落地那一瞬间,SDK 的参与者表可能还没填上
 * (本机实测过一次:房里明明有工人,进房那一下 `remoteParticipants` 还是空的)。问早了就会把
 * 一通打得通的电话说成「没人接」。
 */
export const WBCH_CALL_WORKER_WAIT_MS = 3000;

/** 引导接不上时那句话的开头。工人那边会给一句原话,这里只负责不把它吞掉。 */
export const WBCH_ONBOARDING_FAILED_PREFIX = '引导接不上:';

/**
 * 电脑那边说引导早就做完了(2026-09-25)。这一通不该打(配对后只有引导没做完才进引导,见 onboarding/entry.ts),
 * 万一打了也不留一个没人说话的通话页:当场收场,说清一句。
 */
export const WBCH_ONBOARDING_DONE_TEXT = '引导已经做完了,不用再来一遍;有事直接打给我就行';

/**
 * 等不到工人时「核对房间」最多等多久(2026-09-25)。核对要问中转、问电脑,手机不在家里的 Wi-Fi 时
 * 问电脑那一条可能一直不回 —— 以前没有上限,屏幕停在「正在接通…」好几分钟。等不到就当「问不到」。
 */
export const WBCH_RECHECK_MS = 15_000;

/**
 * 进房 → 等工人 → 工人接起,合起来最多等多久(2026-09-25 返工)。从问完录音权限起算(那一步要等人点系统弹框,不算)。
 *
 * 统筹 0.2.95 真机:小米点「通话」一直「正在接通…」一分多钟,没有一句原因,工人一条开始通话的记录都没有。
 * 以前这一段只有「核对房间」有上限;进房、发布麦克风(网络慢时 livekit 自己的协商重试能拖一分多钟)都没有。
 */
export const WBCH_CONNECT_MS = 15_000;

/** 接通之后发布麦克风最多等多久(2026-09-25 返工)。等不到就说清楚,电话照样通着。 */
export const WBCH_MIC_PUBLISH_MS = 15_000;

/**
 * **开喇叭之后等它真的起播多久**(毫秒,2026-09-27,卡 CL)。
 *
 * 维护者 21:3x 手机打过去:「一上来就听到『吩咐』两个字,『吩』字还是尾巴,前面估计被吃了。」
 * 工人那边一帧都没少发(日志:`房里开始通话(手机)` → `普通通话招呼 ← 手机:说了` →
 * 700ms → `她说:老板,有什么吩咐?`),而手机十七分钟前就订上了那条音轨 —— 吃掉前半句的是
 * **这一侧的起播**:常驻房间时那个 `<audio>` 是暂停 + 静音的,接通才 `play()`,
 * Android WebView 要重开一次 AudioTrack 才真出声,这期间到的帧在抖动缓冲里过期就丢了。
 *
 * 所以**请工人接起之前**先等这一下(`link.speakerReady()`)。600ms 是个上限不是个等待:
 * `play()` 通常几十毫秒就回来,回来就走。等不到也照样往下打 —— 这一条绝不许挡住接通
 * (工人那边还垫了 260ms 静音兜着,channel-worker/src/tts/greeting.ts)。
 */
export const WBCH_SPEAKER_READY_MS = 600;

/**
 * 烘热用的那一小段静音**最多留多久**(毫秒,2026-09-28,卡 OP)。她真的出声了会当场停掉;
 * 一直没出声(她没说话、或者那条轨没挂上)也别让它循环一整通。
 */
export const WBCH_OUTPUT_HOLD_MS = 8000;

/**
 * **一小段静音**(2026-09-28,卡 OP):拿它把这台机器的通话音频输出真的打开。
 *
 * 卡 CF 第 4 条那一版用的是「新建一个 `AudioContext`,看它的时钟走不走」—— 那个时钟一 `resume()`
 * 就在走,与 Android WebView 切通话路由、重开 AudioTrack 毫无关系,于是手机在开喇叭那一刻就报
 * 「我在放了」,她的第一个字照旧被吃。现在改成**经同一个音频输出真的播点东西**:
 * 播的是静音(人一个字都听不到),而它的 `currentTime` 只有在输出真的在消化音频时才往前走 ——
 * 那就是「喇叭真的在出声」。判据与纪律在 outputWarm.ts。
 *
 * 循环播:一秒的片子放完就停,时钟也就不走了。
 */
function silentWavUrl(): string {
  const rate = 8000;
  const frames = rate; // 一秒
  const size = 44 + frames * 2;
  const buf = new ArrayBuffer(size);
  const view = new DataView(buf);
  const ascii = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF'); view.setUint32(4, size - 8, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, frames * 2, true);
  // 采样全是 0 —— 静音。
  let text = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 1) text += String.fromCharCode(bytes[i] ?? 0);
  return `data:audio/wav;base64,${btoa(text)}`;
}

let silentUrl: string | undefined;

function makeSilentSink(): WarmSinkLike | undefined {
  try {
    const Ctor = (globalThis as { Audio?: new (src?: string) => HTMLAudioElement }).Audio;
    if (Ctor === undefined) return undefined;
    silentUrl ??= silentWavUrl();
    const element = new Ctor(silentUrl);
    element.loop = true;
    element.preload = 'auto';
    try { element.setAttribute('playsinline', ''); } catch { /* 不是所有 WebView 都认 */ }
    return element;
  } catch { return undefined; }
}

/**
 * 问录音权限那一步最多等多久(2026-09-25 返工)。它不算进 {@link WBCH_CONNECT_MS}(要等人点系统弹框),
 * 但也不能没有上限:原生那一问万一不回,屏幕就又是一直「正在接通…」。等不到就当这一通没有权限 ——
 * 电话照打,屏幕上说清楚,只是这一通不开麦克风。
 */
export const WBCH_MIC_PERMISSION_WAIT_MS = 30_000;

/** 问录音权限 30 秒没回应时屏幕上那一行。 */
export const WBCH_MIC_PERMISSION_SLOW_TEXT = '问录音权限那一步 30 秒没有回应,这一通先不开麦克风(她听不到你);挂断重打试试';

/** 15 秒还没进到房间。 */
export const WBCH_CONNECT_ROOM_TIMEOUT_TEXT = '没接通:15 秒还没连上通话的房间,手机的网络可能不通或太慢。换个网络(Wi-Fi 或流量)再打';

/** 进了房、工人也在,到点没等到它接起。 */
export const WBCH_CONNECT_NO_ANSWER_TEXT = '没接通:电脑上的事务官一直没应答(房间是通的,可能网络太慢,或者电脑正忙)。等一会儿再打';

/** 接通之后麦克风 15 秒没发出去:接在「麦克风没打开,事务官听不到你」后面的那半句。 */
export const WBCH_MIC_PUBLISH_SLOW_TEXT = '15 秒没发出去,网络可能太慢;挂断重打试试';

/** 进房那一下抛了一句英文(livekit 的原话):说人话,原话放在括号里给查的人看。 */
export const WBCH_CONNECT_ROOM_FAILED_TEXT = '没接通:连不上通话的房间,手机的网络可能不通或太慢。换个网络(Wi-Fi 或流量)再打';

/** 请工人接起那一条发不出去(livekit 的原话,多半是手机到房间的那一路没建好)。 */
export const WBCH_CONNECT_SEND_FAILED_TEXT = '没接通:手机这边的消息发不到电脑上(到房间的那一路没建好,网络可能不通或太慢)。换个网络再打';

/**
 * 一句原话要不要换成人话:这个仓库里给人看的话都是中文,**一个汉字都没有**的就是 SDK / 网络层的原话
 * (「could not establish pc connection」之类)—— 换成 `human`,原话放在括号里给查的人看。
 */
export function humanized(raw: string, human: string): string {
  const text = raw.trim();
  if (text !== '' && /[\u4e00-\u9fff]/.test(text)) return text;
  return text === '' ? human : `${human}(${text})`;
}

/** 等一个 promise 到期限为止。到点了回 `{ done: false }`;它**抛了照样往外抛**(调用方的 catch 说那句原话)。 */
async function beforeDeadline<T>(promise: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ done: true as const, value })),
      new Promise<{ done: false }>((resolve) => { timer = setTimeout(() => resolve({ done: false }), Math.max(0, ms)); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 一次「让麦克风跟上他的意愿」落地之后的样子(见 createWbchCallClient 里的 applyMic)。 */
interface MicStep {
  /** 这一次真的去开了(不是只关)。 */
  tried: boolean;
  /** 这是这一通**第一次**去开:接通时那一下;接通时他正静音着的话,就是他第一次取消静音。 */
  first: boolean;
  /** SDK 回了一条发布。发出去之后因为他按了静音又被关掉的,也算发出去了 —— 那不是「发不出去」。 */
  published: boolean;
  /** 没发出去时 SDK 那句原话。 */
  error?: string;
}

export function createWbchCallClient(deps: WbchCallClientDeps): CallClient {
  const now = deps.now ?? (() => Date.now());
  const channel = deps.channel;
  const waitMs = deps.workerWaitMs ?? WBCH_CALL_WORKER_WAIT_MS;
  const stepMs = deps.hangupStepMs ?? WBCH_HANGUP_STEP_MS;
  const micWaitMs = deps.micQueueWaitMs ?? WBCH_MIC_QUEUE_WAIT_MS;
  const recheckMs = deps.recheckMs ?? WBCH_RECHECK_MS;
  const speakerReadyMs = deps.speakerReadyMs ?? WBCH_SPEAKER_READY_MS;
  const connectMs = deps.connectMs ?? WBCH_CONNECT_MS;
  const micPublishMs = deps.micPublishMs ?? WBCH_MIC_PUBLISH_MS;
  const micPermissionWaitMs = deps.micPermissionWaitMs ?? WBCH_MIC_PERMISSION_WAIT_MS;
  const outputWarmMs = deps.outputWarmMs ?? WBCH_OUTPUT_WARM_MS;
  const makeWarmSink = deps.makeWarmSink ?? makeSilentSink;
  const askMic = deps.askMicPermission ?? ensureMicPermission;
  const writeTrace = deps.trace ?? ((line: string) => { try { console.info(`[通话] ${line}`); } catch { /* 没有控制台就算了 */ } });
  /** 这一通点下去的那一刻。每一步记一行「+N ms 在做什么」。 */
  let tappedAt = 0;
  function step(what: string): void {
    writeTrace(`+${Math.max(0, now() - tappedAt)}ms ${what}`);
  }
  /**
   * 缓冲语:**一通电话建一套**(七个 `<audio>` 跟着建,挂断一起放掉)。
   * 为什么不做成全局单例:两通电话之间牌堆要重洗,而且挂断之后不该还留着七个 `<audio>` 在内存里。
   */
  /**
   * ——— 缓冲语的音色(2026-09-22)———
   *
   * 那七句从这一版起**按当前音色现合成、缓存在手机本地**;包里那七句退成兜底。
   * 一通电话建一套(跟着 `<audio>` 一起放掉),缓存本身在 Cache Storage 里跨通话、跨重启活着。
   *
   * `api` 没给(老接线、用例)就整个不建 —— 那时 `urlFor` 这一层不存在,播放器照旧放包里那一份。
   */
  const makeVoiceCache = deps.createVoiceCache ?? (() => {
    const api = deps.api;
    if (api === undefined) return null;
    return createFillerVoiceCache({
      currentVoice: async () => {
        const result = await api.json<{ voice?: unknown }>('/butler/status');
        if (!result.ok) return undefined;
        const voice = (result.data as { voice?: unknown } | null)?.voice;
        return typeof voice === 'string' && voice.trim() !== '' ? voice.trim() : undefined;
      },
      synthesize: async (text, scene) => {
        const result = await api.blob('/butler/proxy/api/tts', { method: 'POST', body: { text, scene } });
        if (!result.ok) throw new Error(result.error);
        return result.data;
      },
    });
  });
  let voiceCache: FillerVoiceCache | null = null;

  const makeFiller = deps.createFiller ?? ((hooks) => {
    // 每次要放才问一遍地址:音色对齐是异步的,第一句可能赶在它前面 —— 那时包里那一份是对的。
    const player = createHtmlFillerPlayer(voiceCache === null ? {} : { resolveUrl: id => voiceCache?.urlFor(id) ?? '' });
    const audio = createFillerAudio({
      play: (line) => player.play(line),
      stop: () => player.stop(),
      onPlayed: hooks.onPlayed,
      onSkipped: (reason) => hooks.onSkipped(reason),
    });
    return {
      ...audio,
      dispose: () => { audio.dispose(); player.dispose(); },
    };
  });

  /**
   * 应声那几声(2026-10-02,卡「声音与形象跟着话走」第 5 件)。**另起一个播放器** ——
   * 和垫场共用一个的话,一声「嗯」会把正在放的「我想想」掐掉(两件事的 `current` 是同一个)。
   * 这几声放的是**包里那一份**(`fillerAssetUrl` 的缺省):运行期按音色合成是垫场那条路的事,
   * 十一条一起合正是 09-20 那次 502 的病根,理由写在 ackAudio.ts 的文件头。
   */
  const makeAck = () => {
    const player = createHtmlFillerPlayer();
    const audio = createAckAudio({
      play: (line) => player.play(line),
      stop: () => player.stop(),
      onPlayed: (line) => step(`应了一声「${line.text}」`),
      onSkipped: (reason) => step(`没应声(${reason})`),
    });
    return { ...audio, dispose: () => { audio.dispose(); player.dispose(); } };
  };

  /** 等工人进房。它进来了(或者等够了)就回来,**不抛**。 */
  function waitForWorker(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); off(); resolve(); };
      const off = channel.link.listen({ onWorker: (present) => { if (present) finish(); } });
      const timer = setTimeout(finish, ms);
    });
  }

  let startedAt: number | undefined;
  let transcript: CallUtterance[] = [];
  let closed = false;
  let unsubscribe: (() => void) | null = null;
  /** 这一通是不是引导。挂断时要告诉工人「暂停」,而不是让它以为还在引导。 */
  let onboarding = false;
  /**
   * 这一通是她主动打来的那一通(2026-09-21)。挂断时要告诉工人 ——
   * 它据此换回平时那套人设,排着的下一通才开始响。
   */
  let incomingCallId: string | undefined;
  /** 这一通的引导是不是「续做」。「改回手机」之后要照原样再发一次。 */
  let onboardingResume = false;
  /**
   * 这一通**能不能开**麦克风:录音权限给了,而且第一次发布没失败。
   * 不能时取消静音什么都不开(她本来就听不见你,屏幕上那一行已经说了)。**关不看它** —— 关永远可以。
   */
  let micGranted = false;
  /** 这一通的缓冲语。挂断 / 拆界面时要 dispose(不然七个 `<audio>` 会留着)。 */
  let filler: FillerAudio | null = null;
  let ack: AckAudio | null = null;
  /**
   * 「**这边真的开始出声了**」那一下(2026-09-28,卡 CF 第 4 条;判据 2026-09-28 卡 OP 换过,
   * 见 outputWarm.ts)。报出去之后工人的开场白才开口。
   *
   * `releaseWarm` 是那一小段静音的停止键:**热了之后不立刻停**(停了 AudioTrack 可能被回收、
   * 她的第一帧到了又要重开一次),等她真的出声了 / 挂断了再停。
   */
  let releaseWarm: (() => void) | null = null;
  /** 这一通报过「我在放了」没有(只报一次:烘热与远端真出声两条路都会来)。 */
  let toldPlaying = false;

  /**
   * ——— 麦克风:以他的意愿为准(2026-09-24,卡 fix/call-mute-before-publish)———
   *
   * 统筹真机 0.2.81:接通过程中(键一出现的 0.57 秒、冷启动后第一通的 4–5 秒)按「关掉麦克风」,
   * 界面已经是「麦克风已关,事务官听不见你」,工人日志里之后几十秒照样有「他说(ASR)」——
   * 旁边人的说话声被收走、识别、写进日志。根子:以前那一下只对着**此刻的轨道**说一句「关」——
   * 录音权限还没问完就直接不管(`micGranted` 还是 false)、房还没进好就抛了被吞掉、
   * 轨道还没发布就什么都关不到;随后接通流程照样 `setMicrophoneEnabled(true)`。界面说关了,轨道是开的。
   *
   * 现在三条:
   *   1. `muted` 是**唯一的真相**:那颗键只改它;新一通复位成 false(默认开麦);
   *   2. 轨道的每一次开/关都排进 `micQueue` 一条队,**轮到时按那一刻的意愿**落地(applyMic)——
   *      不并发地开关同一条轨道,也不靠 SDK 里「发布到一半先等它」那种内部行为碰运气;
   *   3. 会开麦克风的地方(接通时发布、换房之后重发、取消静音)全走 applyMic:这一通收场了、
   *      他要静音、接通流程还没走到发布那一步、不能开 —— 一律不开;开的那一下要等(getUserMedia +
   *      协商,冷启动能到几秒),等回来再看一眼,这期间他按了静音或者挂了,当场关掉。
   */
  let muted = false;
  /** 接通流程走到「发布麦克风」那一步了没有。没走到之前取消静音也不抢先开(顺序见 start():先问权限、进房、开喇叭)。 */
  let micReady = false;
  /** 这一通去开过麦克风没有。第一次没发出去要说(2026-09-18 那条规矩),之后几次照旧不吵。 */
  let micTried = false;
  let micQueue: Promise<unknown> = Promise.resolve();
  /** 这一通的回调。第一次发布可能发生在他取消静音那一下(接通时他正静音着),发不出去要说 —— 那时手上得有它。 */
  let callEvents: CallEvents | null = null;

  /**
   * **「我这边真的在出声了」报给工人**(2026-09-28,卡 OP)。两条路都叫它,**只报一次**:
   *   ① 烘热成了(经同一输出播静音,它的媒体时钟真的在走)—— 拨出那一路靠它,
   *      因为这时工人还没被请去开口(顺序见 start() 里那一段);
   *   ② 远端那条 `<audio>` 报出播放进度(她真的在放了)—— 最硬的一条,来电那一路多半是它先到。
   *
   * 报不上去不算错:工人那道闸有上限(2.5s),到点照旧开口。
   */
  function tellWorkerPlaying(why: string, warmMs?: number): void {
    if (closed || toldPlaying) return;
    toldPlaying = true;
    step(`这边真的在出声了(${why}),告诉工人`);
    void channel.playingCall(warmMs).catch(() => { /* 见上 */ });
  }

  function tearDown(): void {
    unsubscribe?.();
    unsubscribe = null;
    // 烘热用的那一小段静音:这一通收场就停掉(卡 OP)。
    releaseWarm?.();
    releaseWarm = null;
    toldPlaying = false;
    filler?.dispose();
    filler = null;
    ack?.dispose();
    ack = null;
    voiceCache?.dispose();
    voiceCache = null;
  }

  /** 此刻该不该在发:这一通还在、他没要静音、接通流程走到了发布那一步、能开。 */
  function micWanted(): boolean {
    return !closed && !muted && micReady && micGranted;
  }

  /**
   * 关。**关永远可以**:没进房、没发布过、SDK 抛了,都吞掉 —— 关不到的只有本来就没有的。
   *
   * 两种关(2026-09-25):通话里他按了静音 → 静这条轨道(再开快);**这一通收场了**(挂断、接不通、出错)
   * → 撤掉轨道、停掉录音(`stopMicrophone`)。以前两种都是静音:轨道留在常驻房间里,Android 的录音一直开着,
   * 电脑上的工人照样订着它跑 VAD 与火山识别(09-24 晚 18:53–19:19)。
   */
  async function micOff(): Promise<void> {
    if (closed) {
      try { await channel.link.stopMicrophone(); } catch { /* 见上 */ }
      return;
    }
    try { await channel.link.setMicrophoneEnabled(false); } catch { /* 见上 */ }
  }

  /** 让轨道跟上意愿。只由 syncMic 排着调;**绝不抛**。 */
  async function applyMic(): Promise<MicStep> {
    if (!micWanted()) {
      await micOff();
      return { tried: false, first: false, published: false };
    }
    const first = !micTried;
    micTried = true;
    let published = false;
    let error: string | undefined;
    try { published = await channel.link.setMicrophoneEnabled(true); }
    catch (thrown) { error = thrown instanceof Error && thrown.message !== '' ? thrown.message : undefined; }
    /**
     * **发布那一刻补一次静音**:等回来的这几秒里他按了「关掉麦克风」、或者挂了 —— 当场关。
     * 没发出去也关一下:万一 SDK 半路留了一条轨道,界面上那句「她听不到你」不能是假的。
     */
    if (!published || !micWanted()) await micOff();
    return { tried: true, first, published, ...(error === undefined ? {} : { error }) };
  }

  /**
   * 排一次「让轨道跟上意愿」。一次一次来;轮到时才读意愿,所以排在最后的那一次落的永远是最新的意愿。
   * 前一次最多等 micWaitMs(见 {@link WBCH_MIC_QUEUE_WAIT_MS})。
   */
  function syncMic(): Promise<MicStep> {
    const run = within(micQueue, micWaitMs).then(applyMic);
    micQueue = run.catch(() => undefined);
    return run;
  }

  /**
   * 第一次去开的结果交给界面(2026-09-18 那条规矩,原样):权限给了却没发出去 → 当场说清楚,
   * 那颗键也别再装作能切。接通时那一下(start)与「接通时正静音着、他第一次取消静音」(setMuted)走的都是这一处。
   * 之后几次(取消静音、换房之后重发)没发出去照旧不吵 —— 与以前一样。
   */
  function settleFirstTry(step: MicStep): void {
    if (!step.tried || !step.first || step.published || closed) return;
    micGranted = false;
    callEvents?.onMicPermission?.({
      granted: false,
      // 这不是被永久拒,去设置页没有用 —— 别摆那颗按钮。
      needsSettings: false,
      text: step.error === undefined ? MIC_PUBLISH_FAILED_TEXT : `${MIC_PUBLISH_FAILED_TEXT}(${step.error})`,
      ...(step.error === undefined ? {} : { error: step.error }),
    });
  }

  /** 这一通收场了(挂断 / 没接通):从此麦克风只许关。回的是「关」那一步排好的队。 */
  function endMic(): Promise<MicStep> {
    closed = true;
    return syncMic();
  }

  /**
   * **接通之后**开麦克风(2026-09-25 返工)。不挡接通:接通那一刻就回,发布在后面走。
   *
   * 最多等 {@link WBCH_MIC_PUBLISH_MS}:发布要一来一回地协商,网络慢时 livekit 自己的重试
   * (协商超时 → 等重连 → 再发一遍)能拖一分多钟。等不到就当这一次没发出去,当场说清楚
   * (settleFirstTry:这一通不再开;那一下真回来了,applyMic 看见「不该开」当场关掉)。
   */
  async function openMicAfterConnect(): Promise<void> {
    micReady = true;
    step('开麦克风');
    const opened = await beforeDeadline(syncMic(), micPublishMs).catch(() => ({ done: false as const }));
    if (closed) return;
    if (!opened.done) {
      step(`麦克风 ${Math.round(micPublishMs / 1000)} 秒没发出去`);
      // 这是这一通第一次去开(接通时那一下,或「改回手机」那一下):没发出去要说。
      settleFirstTry({ tried: true, first: true, published: false, error: WBCH_MIC_PUBLISH_SLOW_TEXT });
      return;
    }
    const result = opened.value;
    if (result.tried) step(result.published ? '麦克风开了' : `麦克风没发出去${result.error === undefined ? '' : `:${result.error}`}`);
    settleFirstTry(result);
  }

  return {
    async start(_options: CallStartOptions, events: CallEvents) {
      closed = false;
      onboarding = _options.onboarding !== undefined;
      incomingCallId = _options.incoming?.callId;
      onboardingResume = _options.onboarding?.resume === true;
      micGranted = false;
      // 新一通从头来过:默认开麦(2026-09-24)。上一通按过的静音不带到这一通。
      muted = false;
      micReady = false;
      micTried = false;
      callEvents = events;
      transcript = [];
      startedAt = undefined;
      tappedAt = now();
      step(_options.onboarding !== undefined ? '点了引导' : _options.incoming !== undefined ? '接起来电' : '点了通话');
      events.onInterim?.(null);
      events.onPhase('connecting');
      try {
        /**
         * ——— 缓冲语(2026-09-20,Ben:「缓冲语可以存到手机里啊」) ———
         *
         * 垫出来的那一句**当成她说的一句**推进字幕与纪要 —— 和上一版(工人推 caption)
         * 在屏幕上看到的一模一样,只是这一版里**字幕上写的就是喇叭里放的那一句**。
         * 放不出来时字幕照样有(那是 onPlayed 先于 play 的理由,见 fillerAudio.ts)。
         */
        /**
         * ——— 那七句用的是哪个嗓子(2026-09-22)———
         *
         * **进房就对齐一次**:问一句现在是哪个音色,按音色去缓存里取那七句,缺的现合成。
         * `void` 是**故意的** —— 这一步绝不许挡住接通:对齐没完之前放的是包里那一份,
         * 对齐完了下一句就是新嗓子。对不上(8792 没跑、离线)就一直是包里那七句。
         */
        voiceCache = makeVoiceCache();
        void voiceCache?.refresh();
        filler = makeFiller({
          onPlayed: (line) => {
            if (closed) return;
            const entry: CallUtterance = { who: 'butler', text: line.text };
            events.onInterim?.(null);
            transcript = transcript.concat(entry);
            events.onUtterance(entry);
          },
          onSkipped: () => { /* 没垫成不是错:她答得快才是好事。要查为什么就在这儿打点 */ },
        });
        /**
         * 应声(2026-10-02):他说得久了工人广播一条,这台手机当场放一声「嗯」。
         * **不进字幕、不进纪要**(ackAudio.ts 纪律 ④)—— 一声「嗯」不是一句话。
         * 老工人不发这一条 → `ack` 建着也永远不响,和从前一样。
         */
        ack = makeAck();
        const offAck = channel.onBackchannel?.((signal) => {
          if (closed) return;
          ack?.signal({ round: signal.round, ...(signal.line === undefined ? {} : { line: signal.line }) });
        }) ?? (() => {});
        const offFiller = channel.onFiller((signal: WbchFiller) => {
          if (closed) return;
          /**
           * 慢工具开跑 / 跑完(2026-09-24 傍晚,卡 fix/scan-orb-working-whole-wait):**不管垫不垫话都先转上去** ——
           * 引导通话页拿它管「她在找你的项目」那一整段球的执行中样子。`tool_done` 到这儿为止,不垫话。
           */
          if ((signal.kind === 'tool' || signal.kind === 'tool_done') && signal.tool !== undefined) {
            events.onTool?.({ tool: signal.tool, state: signal.kind === 'tool' ? 'start' : 'done' });
          }
          if (signal.kind === 'tool_done') return;
          /**
           * **工人已经用当前音色自己垫了**(2026-09-23 晚):这台手机一句都不放 ——
           * 本地那份是固定音色,再放就是一通电话两个嗓子、两句叠在一起。
           * 老工人不带这个标记,那时照老行为自己垫。
           */
          if (signal.voiced_by === 'worker') return;
          filler?.signal({ kind: signal.kind, round: signal.round, ...(signal.tool === undefined ? {} : { tool: signal.tool }) });
        });
        /**
         * 电脑上把音色改了(2026-09-22)。**这一通电话里什么都不做** ——
         * 当场去合七句就是七条 `/api/tts` 一起打出去,而那正是 09-20 那次 502 的病根;
         * 而且这一通已经在放的那几句换到一半更难听。只记一笔,**下次进房**按新音色重取。
         */
        const offVoice = channel.onFillerVoice((changed: WbchFillerVoiceChanged) => {
          voiceCache?.markStale(changed.voice);
        });
        const onCaption = (caption: WbchCaption) => {
          if (closed) return;
          const who: CallUtterance['who'] = caption.role === 'me' ? 'me' : 'butler';
          const entry: CallUtterance = { who, text: caption.text };
          /**
           * **她那条字幕 = 她的真声要来了**。工人在「这一句开始出声」那一刻推它
           * (交接-0918:字幕比声音早 56–130ms),所以拿它掐缓冲语,掐完正好赶在她开口之前。
           * 他那条(`role:'me'`)是他在说话 —— 手机自己还在念叨最糟,照样掐。
           */
          if (caption.role === 'butler') {
            filler?.butlerSpoke();
            events.onButlerSpeech?.();
            /**
             * **语气跟着这一句一起到**(2026-10-02)。字幕是在「这一句开始出声」那一刻推的,
             * 所以表情该变的时刻就是这一刻 —— 上一层写进 toneRef,舞台下一帧就换脸。
             * 没有这一格就不调(脸不动);认不认得这个取值由 live2d/tone.ts 那张表说了算。
             */
            if (caption.tone !== undefined) events.onButlerTone?.(caption.tone);
            // 她开口了:一声「嗯」不许叠在她的真声上(ackAudio.ts 纪律 ②)。
            ack?.butlerSpoke();
          }
          else filler?.userSpoke();
          // 中间结果只画在屏幕上,不进纪要——纪要里留一句改到一半的话没意义。
          if (!caption.final) { events.onInterim?.(entry); return; }
          events.onInterim?.(null);
          transcript = transcript.concat(entry);
          events.onUtterance(entry);
        };
        const offCaption = channel.onCaption(onCaption);
        const offLink = channel.link.listen({
          onRemoteSpeaking: (speaking) => {
            if (closed) return;
            // 音轨真的有能量 —— 比字幕慢,但它是铁证(字幕丢了一条也还有这一路)。
            filler?.setRemoteSpeaking(speaking);
            events.onBotSpeaking(speaking);
          },
          onLocalSpeaking: (speaking) => {
            if (closed) return;
            if (speaking) filler?.userSpoke();
            /**
             * **他一停就不放**(2026-10-02,ackAudio.ts 纪律 ①)。这一路是本机麦克风的音量,
             * 比工人那头的 VAD 更贴近「他这会儿到底在不在说」—— 信号在路上那几十毫秒里
             * 他刚停口的那一下,全靠它挡住。
             */
            ack?.userSpeaking(speaking);
            events.onMicSpeaking(speaking);
          },
          onState: (state) => {
            // 房间自己断了(掉网、被踢):如实说一声,别让屏幕上一直写着「通话中」。
            if (!closed && (state === 'closed' || state === 'failed')) events.onPhase('error', { error: '房间断开了' });
          },
          /*
           * **她的声音真的从这台机器里出来了**:挂着的那条 `<audio>` 报出了播放进度 ——
           * 最硬的一条判据(2026-09-28,卡 CF 第 4 条)。另一条(烘热)在 outputWarm.ts。
           *
           * 到这一步输出板上钉钉是热的,烘热用的那一小段静音就该停了(卡 OP)。
           */
          onPlaybackProgress: () => {
            tellWorkerPlaying('远端音轨在本地放出来了');
            releaseWarm?.();
            releaseWarm = null;
          },
        });
        /**
         * **电脑那边挂了**(2026-09-23 晚,她道过别由她挂)。工人广播 `call_state{idle}`,
         * `by` 不是 `phone`(我自己挂的那一条是回声,不认)。
         *
         * 只管**这台手机自己拨的那一通**:她打来、我接起的那一通由来电状态机收
         * (`ring_end{hung_up}` → 待机 → 通话页拆掉),两条都认就会挂两遍。
         * 没接通之前也不认 —— 那时还谈不上「这一通」。
         */
        const offRing = channel.onRing((message) => {
          if (closed || incomingCallId !== undefined || startedAt === undefined) return;
          if (message.type !== 'call_state' || message.state !== 'idle' || message.by === 'phone') return;
          events.onRemoteHangup?.();
        });
        /**
         * **通话中换了网络**(2026-10-21,局域网 M4):出了家门、通话那一份被搬进云房间,旧房里这一通就此断了
         * (续上同一通是卡 M9)。如实说一声收场,别让屏幕上一直写着「通话中」;首页那条横幅给「点一下回拨」。
         */
        const offDropped = channel.onCallDropped?.(() => {
          if (!closed) events.onPhase('error', { error: WBCH_CALL_ROUTE_DROPPED_TEXT });
        }) ?? (() => {});
        unsubscribe = () => { offCaption(); offFiller(); offAck(); offVoice(); offLink(); offRing(); offDropped(); };

        /**
         * **先问录音权限,再进房**(2026-09-18,Ben 真机:「没有去要录音的权限,我说话它听不到」)。
         *
         * 顺序是这张卡的关键:以前这一下是靠 `setMicrophoneEnabled(true)` 里的 getUserMedia
         * 顺带触发 WebView 的权限询问 —— 弹框压在一通已经接通的电话上,开场白正说到一半;
         * 而且被拒两次之后 Android 从此不弹,getUserMedia 静默失败,人对着屏幕说话她听不到。
         * 现在**进房之前**问,拒了就当场说清楚,并给一条「去设置里打开」的路。
         *
         * 权限没给**不算通话失败**:她照样说得出话、打字备胎照样能用,只是听不到你。
         */
        step('问录音权限');
        const asked = await beforeDeadline(askMic(), micPermissionWaitMs);
        if (closed) return;
        if (!asked.done) {
          // 原生那一问一直不回:这一通当没有权限(电话照打,屏幕上说清楚),别让屏幕一直「正在接通…」。
          step(`问录音权限 ${Math.round(micPermissionWaitMs / 1000)} 秒没回`);
          micGranted = false;
          events.onMicPermission?.({ granted: false, needsSettings: false, text: WBCH_MIC_PERMISSION_SLOW_TEXT });
        }
        else {
          const mic = asked.value;
          micGranted = mic.granted;
          events.onMicPermission?.({
            granted: mic.granted,
            needsSettings: mic.needsSettings,
            ...(mic.error === undefined ? {} : { error: mic.error }),
          });
        }

        /**
         * ——— 从这里起计时:进房 → 等工人 → 工人接起,合起来最多 {@link WBCH_CONNECT_MS}(2026-09-25 返工)———
         *
         * 统筹 0.2.95 真机:小米点「通话」一直「正在接通…」一分多钟,没有一句原因,工人一条开始通话的记录都没有。
         * 那一版里「工人在」与招呼(`call.start`)之间只隔着一步:发布麦克风 —— 它没有上限,网络慢时 livekit 自己的重试
         * (协商超时 → 等重连 → 再发一遍)能拖一分多钟,招呼就一直排在它后面没发出去,和工人那边一条记录都没有对得上
         * (用真 App 的通话代码把发布卡住,原样复现:channel-worker/dev/load-call.ts --phone app --stall-mic)。
         * 真机上到底卡在哪一步,每一步那一行 `[通话] …` 会说。
         * 现在:麦克风挪到接通之后(下面第 ⑤ 步,不挡接通);这三步合起来到点就收场,说清卡在哪一步。
         * 问权限那一步不算进来:要等人点系统弹框(它自己另有上限 {@link WBCH_MIC_PERMISSION_WAIT_MS})。
         */
        const deadline = now() + connectMs;
        const left = (): number => Math.max(0, deadline - now());
        /** 请工人接起那一步至少给这么久:工人明明在房里,前面几步(核对房间换了房)用光了时间也不该一下都不等。 */
        const answerWindow = (): number => Math.max(left(), Math.round(connectMs / 3));
        /**
         * 接不通:收拾干净(喇叭关、麦克风撤、放手),说那一句。
         * `undo` = 请它接起的那一条可能晚到了:补一句「挂了」/「引导停了」,免得工人在一通没人的电话里干听着
         * (引导那一条晚到的话,工人还会一直留在引导那套人设里,下一通普通电话连招呼都不打)。
         */
        const fail = async (text: string, undo?: () => Promise<unknown>): Promise<void> => {
          step(`接不通:${text}`);
          tearDown();
          try { channel.link.setSpeakerEnabled(false); } catch { /* 拆的时候什么都可能抛 */ }
          await within(endMic(), stepMs);
          if (undo !== undefined) await within(Promise.resolve().then(undo), stepMs);
          await within(channel.releaseCall(), stepMs);
          events.onPhase('error', { error: text });
        };

        // ① 进房(常驻着的话当场就回;没常驻、或者房间断了,这一下要连,网络不通时最慢)。
        step('进房');
        const entered = await beforeDeadline(channel.acquireCall(), left());
        /**
         * **进房这几秒里他挂了**(2026-09-24):到此为止。以前这里不看 —— 挂断之后照样往下走,
         * 打开喇叭、发布麦克风,留在常驻房间里一直开着(直到下一通挂断才关)。
         * 房间那一份由 hangup() 放(它已经放过了)。
         */
        if (closed) return;
        if (!entered.done) { await fail(WBCH_CONNECT_ROOM_TIMEOUT_TEXT); return; }
        /**
         * **这一通归这台手机说话**(2026-09-22 晚)。
         *
         * 远端那条音轨从 0917 起是「进房就挂上一个 autoplay 的 `<audio>`」;
         * 从今天起手机**常驻房间**(不常驻就收不到 `ring`),于是那条老规矩变成了
         * 「房里谁说话手机就播谁」—— 他拿起听筒说话,她的回答却从桌上那台手机里出来
         * (Ben 20:50 真机)。所以喇叭改成缺省关、由这里明着打开。
         *
         * 放在 `acquireCall()` **之后**:房间还没连上时开关没地方落。
         * 放在接起之前:她的招呼 / 开场白(主动来电那一通的 `ringOpener`)一接起就开始说 —— 晚一秒开喇叭就吃掉一个字。
         */
        channel.link.setSpeakerEnabled(true);
        /**
         * **等喇叭真的起播,再去请她开口**(2026-09-27,卡 CL;理由与真机证据见 {@link WBCH_SPEAKER_READY_MS})。
         * 到点没回就照样往下走:这一条治的是「第一个字被吃」,不许把它变成「打不通」。
         */
        step('开喇叭');
        /**
         * ★ **先把通话音频输出真的烘热,再请她开口**(2026-09-28,卡 OP)。
         *
         * 两版之前都不对:
         *   · 卡 CL 等的是 `play()` 那个 promise —— 只表示浏览器接下了这次播放;
         *   · 卡 CF 第 4 条改成手机自己判「真的在放了」再报一条 `call.playing`,可其中一条判据
         *     (新建一个 `AudioContext`、看它的时钟走不走)**一建就成立** —— 手机在开喇叭那一刻
         *     就报了,而**拨出这一路是先开喇叭、后发 `call.start`**,那条 `playing` 比接起先到,
         *     工人那道闸当时把先到的丢掉,于是白等到上限。真机(0.4.55,Pixel 10 → 本机,18:1x)
         *     日志里一行「在放了」都没有,维护者听到的是「何吩咐」。
         *
         * 现在:经**同一个音频输出**播一小段静音,看它的媒体时钟是不是真的在往前走
         * (路由没切过来、AudioTrack 没起来,它一动不动)—— 这才对应「喇叭真的在出声」。
         * 判据与纪律在 outputWarm.ts。
         *
         * **这一下 await**(与卡 CF 那一版相反):顺序才是这张卡的解 —— 输出热了再往下走,
         * 底下第 ③ 步才去请工人接起。上限 {@link WBCH_OUTPUT_WARM_MS} 且不超过这一通剩下的时间,
         * 到点照样往下打:这一条治的是「第一个字被吃」,绝不许把它变成「打不通」。
         */
        step('烘热通话输出');
        const warm = await warmOutput({
          makeSink: makeWarmSink,
          now,
          warmMs: Math.min(outputWarmMs, Math.max(0, left())),
        });
        if (closed) { warm.release(); return; }
        releaseWarm = warm.release;
        step(warm.how === 'warm'
          ? `通话输出热了(真的出声在 +${warm.progressMs ?? 0}ms,一共 ${warm.waitedMs}ms)`
          : warm.how === 'timeout'
            ? `等了 ${warm.waitedMs}ms 通话输出还没出声,照样往下打(第一个字可能被吃)`
            : '这台机器判不出输出热没热,照旧往下打');
        // 热了才报:报的是「喇叭真的在出声」,不是「时钟在走」。判不出来 / 没热就不报 ——
        // 工人那道闸等不到就到点照旧开口,而不是被一个不可信的判据骗着当场开口。
        if (warm.how === 'warm') tellWorkerPlaying('输出烘热了', warm.waitedMs);
        /**
         * 那一小段静音**最多留这么久**:她真的出声了会当场停掉(onPlaybackProgress),
         * 一直没出声的话别让它循环一整通。
         */
        setTimeout(() => { releaseWarm?.(); releaseWarm = null; }, WBCH_OUTPUT_HOLD_MS);
        /**
         * 卡 CL 那一下照旧等(`play()` 回来才算浏览器认下了这次播放)——
         * 烘热成了的话它早就回来了,这里是给「判不出来」那几台兜的。
         */
        await within(channel.link.speakerReady(), Math.min(speakerReadyMs, Math.max(0, left())));
        if (closed) return;

        /*
         * ② 房里没有工人 = 打通了但**没人接**。这一判要在 `connected` **之前**做完:
         * 一旦报了 connected,挂断时就会往看板上写一条「和事务官通了个电话(38 秒)」——
         * 那是在记一件没发生的事(本机实测踩到过)。所以先等工人露面,等不到就只报错、不报接通。
         *
         * **这一段麦克风还没开**(2026-09-25):等工人、核对房间、请它接起,都在开麦之前 ——
         * 接不通的那一通从头到尾不录音。
         */
        step('等电脑上的事务官');
        if (!channel.link.workerPresent()) await waitForWorker(Math.min(waitMs, left()));
        if (closed) return;
        /**
         * **等不到工人时先核对一次房间**(2026-09-23 从零重装验收)。电脑重装之后换了一间房,
         * 手机手上那张凭证还是旧房间的 —— 这时工人当然「不在」,可电脑是好的。
         * 核对出来换了房:通道层已经换上新凭证、把房间换过去了,喇叭开回来再等一次。
         * 核对最多等 {@link WBCH_RECHECK_MS},也不超过这一通剩下的时间(2026-09-25):
         * 手机不在家里的 Wi-Fi 时问电脑那一条可能一直不回。
         */
        let check: WbchRoomCheck | undefined;
        if (!channel.link.workerPresent() && channel.recheckRoom !== undefined) {
          step('核对房间');
          const recheck = channel.recheckRoom().catch((error: unknown) => ({ kind: 'unknown' as const, error: error instanceof Error ? error.message : '' }));
          check = (await within(recheck, Math.min(recheckMs, left()))) ?? { kind: 'unknown', error: '核对房间超时' };
          if (closed) return;
          if (check.kind === 'moved') {
            channel.link.setSpeakerEnabled(true);
            if (!channel.link.workerPresent()) await waitForWorker(Math.min(waitMs, left()));
            if (closed) return;
          }
        }
        if (!channel.link.workerPresent()) { await fail(noWorkerText(check)); return; }

        /**
         * ③ 请工人**接起**这一通,等到它回话才算接通(2026-09-25 返工)。
         *
         * 引导(2026-09-18):告诉工人「我在做引导」。它会把系统提示换成引导那一套,
         * 并**立刻**把这一段该说的那句流式 TTS 说出来(开场白只说一次,重不重说由工作台定)。
         * 接不上就如实说那句原话 —— 不要让人对着一个不会开口的球干等。
         * 09-24 晚小米配对后那一通引导,这一条等了很久没回话,屏幕停在「正在接通…」,
         * 麦克风却已经开了 5 分钟(Android 录音记录 21:28:30 → 21:33:18)—— 所以它排在开麦之前。
         *
         * 普通电话(2026-09-18 起有那句招呼):以前是「发出去就算,说不出去不拦通话」,排在开麦之后。
         * 从收音闸起(工人只在通话里听,2026-09-25)这一条就是**接起**:工人收到它才进通话、才开始听 ——
         * 它没到,接通了也是白通(她听不见你)。所以等它回话:回了「好」才报接通;回了「不行」照原话说;
         * 到点没回就收场,并补一句「挂了」,免得招呼晚到、工人在一通没人的电话里干听着。
         *
         * **她主动打来的那一通不发招呼**(2026-09-21):他按「接起」那一刻工人就已经
         * 开口说「我打给你是因为…」了(接起走的是 `{type:'call',action:'answer'}`,
         * 在来电页那一层发的,不在这儿)。这儿再说一句「喂,我在,你说」就是两个声音抢话。
         */
        let micNow = true;
        if (_options.onboarding !== undefined) {
          step('请事务官接起引导');
          const begun = await beforeDeadline(channel.onboarding(_options.onboarding.resume ? 'resume' : 'start'), answerWindow());
          if (closed) return;
          if (!begun.done) { await fail(WBCH_CONNECT_NO_ANSWER_TEXT, () => channel.onboarding('stop')); return; }
          if (!begun.value.ok || begun.value.stage === 'done') {
            await fail(begun.value.ok ? WBCH_ONBOARDING_DONE_TEXT : `${WBCH_ONBOARDING_FAILED_PREFIX}${humanized(begun.value.error, WBCH_CONNECT_SEND_FAILED_TEXT.replace(/^没接通:/, ''))}`);
            return;
          }
          /**
           * 归电脑管(2026-09-18,拍板「手机已扫码就优先手机的引导」的另一半):
           * 工人一个字都不说。**电话照样接通** —— 人可以在这一屏上按「改回手机」把主导权拿回来,
           * 那时候 retryOnboarding() 再让她开口。挂断当然也行。
           * 这时**不开麦**(2026-09-25):她不说话、电脑那边也不听;按了「改回手机」、她开口了才开。
           */
          if (begun.value.leader === 'desktop') { events.onLeader?.('desktop'); micNow = false; }
          else events.onLeader?.('phone');
        }
        else if (_options.incoming === undefined) {
          step('请事务官接起');
          const started = await beforeDeadline(channel.callStart(_options.callId), answerWindow());
          if (closed) return;
          if (!started.done) { await fail(WBCH_CONNECT_NO_ANSWER_TEXT, () => channel.hangupCall()); return; }
          if (!started.value.ok) { await fail(humanized(started.value.error, WBCH_CONNECT_SEND_FAILED_TEXT), () => channel.hangupCall()); return; }
        }

        // ④ 接通。
        startedAt = now();
        step('接通');
        events.onPhase('connected');

        /**
         * ⑤ 发布麦克风 —— **接通之后才发**(2026-09-25),**不挡接通**(2026-09-25 返工,见 openMicAfterConnect),
         * 而且**按他的意愿**(2026-09-24):接通这几秒里他已经按了「关掉麦克风」就不发,等他取消静音那一下再发;
         * 发的那一下等回来,期间按了就当场关掉(applyMic)。工人那边收到招呼就已经在等这台手机的麦克风了,
         * 轨道一发上来它当场订上(收音闸)。
         *
         * 没有录音权限就**不发**(2026-09-24 起):屏幕上那句「没有录音权限,她听不到你」已经说清楚了,
         * 电话照样接通。以前这里仍然顺手 `setMicrophoneEnabled(true)` 试一下、吞掉失败 —— 那一下会让
         * WebView 在通话中途再弹一次系统权限框,万一他点了允许,麦克风就开了,而屏幕上还写着
         * 「没有录音权限」、那颗键也按不动(`micGranted` 是 false):正是这张卡要堵的那一类。
         *
         * 权限给了却发不出去(2026-09-18,交接-0918-引导不理人)是**另一件事**:当场说清楚,
         * 电话照样通着 —— 她说得出话,只是听不到你(settleFirstTry)。
         *
         * 接通上面已经报了;这里等它只为 start() 收尾时麦克风的结果也定了(界面那一层不等 start,见 useCall)。
         */
        if (micNow) await openMicAfterConnect();
      } catch (error) {
        // 进房那一下抛的多半是 livekit 的英文原话(「could not establish pc connection」):换成人话,原话留在括号里。
        const text = humanized(error instanceof Error ? error.message : '', WBCH_CONNECT_ROOM_FAILED_TEXT);
        step(`接不通(抛了):${text}`);
        tearDown();
        // 进不去就把房间放回去,别占着一个半死的连接。喇叭也关回去(可能已经开过了);
        // 麦克风同理(2026-09-24:以前这一支不关,抛在发布之后的话它就一直开着)。
        try { channel.link.setSpeakerEnabled(false); } catch { /* 同上 */ }
        await within(endMic(), stepMs);
        await within(channel.releaseCall(), stepMs);
        events.onPhase('error', { error: text });
      }
    },

    async hangup(): Promise<CallResult> {
      step('挂断');
      closed = true;
      tearDown();
      // **先闭嘴再收拾**:房间可能还留着(常驻那一份持有着),而这台手机已经不在通话里了。
      try { channel.link.setSpeakerEnabled(false); } catch { /* 拆的时候什么都可能抛 */ }
      /**
       * 麦克风也**先关**(2026-09-24):以前排在下面「告诉工人」那两条之后,那两条各最多等 stepMs ——
       * 按了挂断之后还有几秒在往房里送声音。先停麦克风再放手的顺序不变。
       * 排在麦克风那条队里:接通时那一下发布还没回来的话,等不及也不要紧 ——
       * 它一回来就看见「这一通收场了」,当场关掉。挂了的电话不许留着一路在发的麦克风。
       */
      await within(endMic(), stepMs);
      // 挂断 = 暂停引导(进度在 onboarding.json,下次接着做)。说不出去也照挂 ——
      // 工人那边手机一离开房间自己也会暂停。
      const wasOnboarding = onboarding;
      if (onboarding) { onboarding = false; await within(channel.onboarding('stop'), stepMs); }
      /**
       * 告诉工人这通挂了。**发不出去也照挂**。
       *   - 她打来的那一通:换回人设、放行排着的下一通(老行为);
       *   - 我自己拨的那一通(2026-09-23 晚补上):以前**一个字都不说**,工人那边的「这会儿在通话」
       *     与纪要就一直开着,直到手机离房 —— 手机常驻房间,于是下一通话筒电话的纪要被它吞了。
       *     引导那一通不发(它有自己的 stop)。
       */
      if (incomingCallId !== undefined || (!wasOnboarding && startedAt !== undefined)) {
        incomingCallId = undefined;
        await within(channel.hangupCall(), stepMs);
      }
      // 麦克风上面已经停了,这才放手:顺序反过来的话,离房那一瞬间还在往房里送音频。
      // 每一步最多等 stepMs(见 WBCH_HANGUP_STEP_MS):拆的时候什么都可能抛、什么都可能不回 —— 电话必须挂得掉。
      await within(Promise.resolve().then(() => channel.releaseCall()), stepMs);
      const durationSeconds = startedAt === undefined ? undefined : Math.max(0, Math.round((now() - startedAt) / 1000));
      startedAt = undefined;
      return { transcript, ...(durationSeconds === undefined ? {} : { durationSeconds }) };
    },

    /**
     * 再试一次「我在做引导」(2026-09-18)。人按了「改回手机」、主导方已经切回来之后调它。
     * **不重开电话**:房间还连着,只是让工人换上引导那套提示词并开口。
     */
    async retryOnboarding() {
      if (!onboarding) return { ok: false as const, error: '现在不是引导' };
      const begun = await channel.onboarding(onboardingResume ? 'resume' : 'start');
      if (!begun.ok) return { ok: false as const, error: begun.error };
      if (begun.leader === 'desktop') return { ok: false as const, error: '电脑那边还占着引导,先在电脑上退出' };
      // 她这就开口了:麦克风这才开(接通那会儿归电脑管,没开 —— 2026-09-25)。同样不挡、同样有上限。
      if (!closed && !micReady) void openMicAfterConnect();
      return { ok: true as const };
    },

    /** 打字备胎:走同一条 `wb.rpc`,由工人当成他说的话喂给模型 —— 答案照旧经 record 落盘。 */
    async sayText(text: string) {
      const trimmed = text.trim();
      if (trimmed === '') return { ok: false as const, error: '这句话是空的' };
      if (!onboarding) return { ok: false as const, error: '现在不是引导,这句话没送出去' };
      return channel.onboarding('say', trimmed);
    },

    /**
     * 那颗麦克风键(2026-09-24 改)。**只改意愿,轨道能落多少落多少**:
     *   - 什么时候按都算数 —— 接通过程中(权限还在问、房还没进好、发布还没回来)按的,轮到发布时照它来;
     *   - 关永远落到轨道上(SDK 那一侧是静音这条轨道:她那边收到的是静音,不是你的声音);
     *   - 开要「能开」:没权限 / 第一次就没发出去时什么都不开(她本来就听不见你,屏幕上那一行已经说了)。
     * 接通时他正静音着、第一次取消静音才真的发布 —— 那一下发不出去照样当场说清楚。
     */
    async setMuted(next: boolean) {
      muted = next;
      settleFirstTry(await syncMic());
    },
  };
}
