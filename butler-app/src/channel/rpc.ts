/**
 * 经房间数据通道打 HTTP(2026-09-17)。出了局域网之后,原来发给 8791 的请求都从这里走,
 * 由 Mac 上的工人代理。协议逐字见 channelProtocol.ts 的文件头。
 *
 * 三条规矩:
 *   1. **只认工人发来的响应**(identity === `wb-channel-worker`)。房里别人说什么都不当答复——
 *      房间是共享的,谁都能发数据,答复是要拿去当 /state 用的。
 *   2. **一定要有超时**。房里没有工人时请求发得出去、永远没人答;没有超时,界面会一直转圈,
 *      也永远切不回直连。超时按「连不上」处理,和 HTTP 那条路的 kind=network 一个口径。
 *   3. **id 要对得上**。迟到的响应(超时之后才回来)直接丢掉,不许去改一个已经算数的结果。
 *
 * 字幕也从这条 topic 上来(工人推 `{type:'caption',...}`),它没有 id、不配对,直接转给上面那层。
 *
 * 传输走的是 **LiveKit 的文本流**(`sendText` / `registerTextStreamHandler`),不是 `publishData` ——
 * 单个数据包 15KB 封顶,`/state` 一份快照装不下。两端必须一致,见 channelProtocol.ts 的文件头。
 */
import {
  WBCH_ASR_ID_ATTRIBUTE,
  WBCH_ASR_TOPIC,
  WBCH_MEETING_ID_ATTRIBUTE,
  WBCH_MEETING_TOPIC,
  WBCH_RPC_TOPIC,
  WBCH_WORKER_IDENTITY,
  encodeWbchOutbound,
  parseWbchInbound,
  type WbchCaption,
  type WbchBackchannel,
  type WbchFiller,
  type WbchFillerVoiceChanged,
  type WbchMethod,
  type WbchOnboardingAction,
  type WbchRing,
  type WbchRingEnd,
  type WbchCallState,
  type WbchFileStatus,
} from './channelProtocol';
import type { WbchRoomLink } from './roomLink';
import { parseSayDecisionRoomEvent, type SayDecisionRoomEvent } from '../call/sayDecisionRoomEvent';

/**
 * 没办成是哪一种(2026-09-25,卡 S):识别那条要分清「等太久」「房间断了」「工人说它不认这种请求」—— 三种话不一样。
 * 别的调用方只看 `error`,这一格可有可无。
 */
export type WbchRpcFailureCause = 'timeout' | 'closed' | 'worker';

export type WbchRpcResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; error: string; cause?: WbchRpcFailureCause };

export interface WbchRpcRenewed {
  token: string;
  expires_at: number;
  /** 8791 回了才有(局域网 M2 起):新票的地址、房间、路线。 */
  url?: string;
  room?: string;
  route?: 'lan' | 'relay';
}

export interface WbchRpc {
  http(input: { method: WbchMethod; path: string; body?: unknown }): Promise<WbchRpcResult>;
  /** 换一张进房凭证。 */
  renew(): Promise<{ ok: true; credential: WbchRpcRenewed } | { ok: false; error: string }>;
  /**
   * 引导那条消息(2026-09-18):开始 / 接着做 / 打字说一句 / 挂断暂停。
   * 工人接不了引导(没有接话模型、工作台没配记忆仓库)时回的是一句人话,**原样显示给他看**。
   */
  onboarding(action: WbchOnboardingAction, text?: string): Promise<{ ok: true; stage?: string; leader?: string } | { ok: false; error: string }>;
  /**
   * 「这是一通普通电话,打个招呼吧」(2026-09-18)。**只有普通通话发它**,引导那一通不发 ——
   * 招呼与开场白是互斥的两件事,那正是 Ben 在真机上先听见「喂,我在,你说」的原因。
   *
   * `callId`(2026-10-22):手机给自己拨的这一通编的号。工人报通话记录时带它,手机挂断报的也带它,
   * 工作台并成一份。老工人不认这一格 → 照旧打招呼,只是记录各报各的。
   */
  callStart(callId?: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * 座机主动来电那三条(2026-09-21)。`answer` / `later` 必须带那一通的 id ——
   * 铃可能刚好在他按下去那一刻超时,不带 id 就会接起下一通而以为接的是上一通。
   */
  callAnswer(callId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  callLater(callId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** 挂断:工人换回平时那套人设,排着的下一通才响。**发不出去也照挂**。 */
  callHangup(): Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * 「**我这边真的开始出声了**」(2026-09-28,卡 CF 第 4 条;判据在 2026-09-28 卡 OP 换过)。
   * 工人的开场白等它(上限 2.5s);判据在 src/call/outputWarm.ts。
   * `warmMs` = 烘热那一下等了多久,只给工人记进日志。
   */
  callPlaying(warmMs?: number): Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * 在外面取打字要的那个文件(2026-09-25,卡 J):让工人把这张取件单上的文件推过来。
   * 回的是**开始推了没有**;字节随后从 `wb.file` 到。
   */
  filePull(offer: string): Promise<{ ok: true; name?: string; bytes?: number } | { ok: false; error: string }>;
  /**
   * **出了局域网也能按住说话**(2026-09-25,卡 S)。`wb.rpc` 上发一条 `{ id, type:'asr' }`,录音同时在 `wb.asr`
   * 字节流上只发给工人(属性带同一个 id);工人交给电脑上的识别,回一条与 http 代理同形状的 `type:'http'`。
   * 回的就是那条 HTTP 的 status + body(与直连 `/butler/proxy/api/asr` 同一个口径),没办成带 `cause`。
   * 可缺:老的假 rpc 没有它。
   */
  asr?(audio: Uint8Array, mimeType: string): Promise<WbchRpcResult>;
  /**
   * **出了局域网传一段会议录音**(2026-10-09):`wb.rpc` 上 `{ id, type:'meeting_segment', meeting_id, seq, ms }` +
   * `wb.meeting` 字节流(只发工人,属性带同一个 id);回的是 8791 `/meeting/segment` 原样的 status + body。
   * 只在她这一场点过「现在经服务器传」时才被调(meetingApi.ts)。可缺:老的假 rpc 没有它。
   */
  meetingSegment?(audio: Uint8Array, mimeType: string, target: { meetingId: string; seq: number; ms?: number }): Promise<WbchRpcResult>;
  /** 拆掉监听;还等着的请求一律以「已断开」收场,不许悬着。 */
  dispose(): void;
}

export interface WbchRpcDeps {
  link: WbchRoomLink;
  onCaption?: (caption: WbchCaption) => void;
  onSayDecision?: (event: SayDecisionRoomEvent) => void;
  /** 缓冲语信号(2026-09-20)。和字幕一样是**广播**、一样不等回包,见 call/fillerAudio.ts。 */
  onFiller?: (filler: WbchFiller) => void;
  /** 应声信号(2026-10-02):他说得久了,这台手机本地插一声「嗯」。同样是广播、不等回包。 */
  onBackchannel?: (signal: WbchBackchannel) => void;
  /** 事务官的音色换了(2026-09-22)。同样是广播、同样不等回包,见 call/fillerVoiceCache.ts。 */
  onFillerVoice?: (changed: WbchFillerVoiceChanged) => void;
  /** 座机响了 / 这一通完了(2026-09-21)。同样是广播、同样不配对答复。 */
  onRing?: (ring: WbchRing | WbchRingEnd | WbchCallState) => void;
  /** 一个文件没推过来(2026-09-25)。同样是推送、不配对答复。 */
  onFileStatus?: (status: WbchFileStatus) => void;
  timeoutMs?: number;
  /** 识别那一条等多久(缺省 {@link WBCH_ASR_TIMEOUT_MS})。 */
  asrTimeoutMs?: number;
  /** 测试注入递增 id;生产是 crypto.randomUUID。 */
  newId?: () => string;
}

/**
 * 识别那一条最多等多久(2026-09-25,卡 S)。工人那一侧:等录音传完最多 12 秒、等识别最多 20 秒
 * (channel-worker/src/asrRelay.ts),这里比两者之和多一点。**这是上限,不是常态**:5 秒的一段正常网络下两三秒出字。
 */
export const WBCH_ASR_TIMEOUT_MS = 35_000;

/**
 * 会议分段那一条最多等多久(2026-10-09)。一段十分钟的 m4a 约 4.7MB,在外面的上行可能要传一两分钟;
 * 工人那一侧等录音最多 5 分钟、落盘最多 1 分钟(channel-worker/src/meetingRelay.ts),这里比两者之和多一点。
 */
export const WBCH_MEETING_SEGMENT_TIMEOUT_MS = 6.5 * 60_000;

/**
 * 发进房里、等到超时也没人答时那句话。和 HTTP 那条路的口径一致:说的是「连不上」,不是「出错了」。
 *
 * 2026-09-23 第二轮从零重装:以前这句带着「(电脑上的工人可能没在跑)」—— 可真机那天电脑是好的,
 * 是**换了账号、手机守在一间没有电脑的旧房里**。现在远程那条路进房后先看电脑在不在
 * (channel.ts `ensureWorker`),不在就当场说那句「房里没有电脑」,请求根本不发;
 * 走到这句超时的,是**电脑在房里、这一条没答上来**,所以不再猜「工人没在跑」。
 */
export const WBCH_RPC_TIMEOUT_TEXT = '经房间问电脑上的事务官,等了很久没回话(电脑在房里,可能正忙,等一会儿再试)';
/**
 * 电脑上的工人不认这台手机(2026-09-25,卡 fix/evening-gaps)。它对不是配对过的手机**一条都不代办**,
 * 连引导 / 通话那种请求也回一条 `http 403`;以前这边只认同类回包,把它丢了,手机干等 15 秒超时
 * (小米测试机那一通引导卡在「正在接通…」,老包那时麦克风已经开了)。现在当场收场,并说清出路。
 */
export const WBCH_RPC_NOT_PAIRED_TEXT = '电脑上的事务官不认这台手机(它不是这台电脑配对过的手机):到「设置」里退出登录,再扫电脑上的二维码重新配对';
/**
 * 工人那边「不认这台手机」的原话(channel-worker/src/rpc.ts 的 RPC_NOT_PAIRED_TEXT,两边要一字不差)。
 * 新工人对引导 / 通话 / 取文件回**同类**的一条 `ok:false` 带着它(2026-09-25);手机这边换成上面那句能照着做的话。
 */
export const WBCH_WORKER_NOT_PAIRED_TEXT = '房间代理只替已配对的手机办事';
/** 工人回的那句原话:认出「不认这台手机」就换成能照着做的那句,别的原样。 */
function workerError(error: string | undefined, fallback: string): string {
  if (error === WBCH_WORKER_NOT_PAIRED_TEXT) return WBCH_RPC_NOT_PAIRED_TEXT;
  return error ?? fallback;
}
export const WBCH_RPC_CLOSED_TEXT = '房间断开了,这条没发出去';

const DEFAULT_TIMEOUT_MS = 15000;

function randomId(): string {
  try {
    const uuid: string | undefined = globalThis.crypto?.randomUUID?.();
    if (typeof uuid === 'string' && uuid.length > 0) return uuid;
  } catch { /* 老 WebView 没有 randomUUID */ }
  return `wbch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

interface Pending {
  resolve: (value: WbchRpcResult) => void;
  timer: ReturnType<typeof setTimeout>;
  /** renew 等的是 type:'token',http 等的是 type:'http',引导那条等的是 type:'onboarding'。 */
  want: 'http' | 'token' | 'onboarding' | 'call' | 'file_pull';
  renewed?: (credential: WbchRpcRenewed) => void;
  acked?: (ack: { ok: boolean; stage?: string; error?: string; leader?: string; name?: string; bytes?: number }) => void;
  /** 没办成时要不要带上 `cause`(只有识别那条要;别的调用方拿到的还是原来那个形状)。 */
  withCause?: boolean;
}

export function createWbchRpc(deps: WbchRpcDeps): WbchRpc {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const newId = deps.newId ?? randomId;
  const pending = new Map<string, Pending>();
  let disposed = false;

  function settle(id: string, result: WbchRpcResult, renewed?: WbchRpcRenewed): void {
    const entry = pending.get(id);
    if (entry === undefined) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (renewed !== undefined) entry.renewed?.(renewed);
    entry.resolve(result.ok || entry.withCause === true || result.cause === undefined ? result : { ok: false, error: result.error });
  }

  const unlisten = deps.link.listen({
    onText: (text, from) => {
      // 只认工人。这一条不能松:答复要拿去当 /state 用。
      if (from !== WBCH_WORKER_IDENTITY) return;
      const sayDecision = parseSayDecisionRoomEvent(text);
      if (sayDecision !== null) { deps.onSayDecision?.(sayDecision); return; }
      const message = parseWbchInbound(text);
      if (message === null) return;
      if (message.type === 'caption') { deps.onCaption?.(message); return; }
      if (message.type === 'filler') { deps.onFiller?.(message); return; }
      if (message.type === 'backchannel') { deps.onBackchannel?.(message); return; }
      if (message.type === 'filler_voice_changed') { deps.onFillerVoice?.(message); return; }
      // `call_state` 走同一条路(2026-09-23):它和 ring / ring_end 一样是**广播**、一样不配对答复。
      if (message.type === 'ring' || message.type === 'ring_end' || message.type === 'call_state') { deps.onRing?.(message); return; }
      if (message.type === 'file_status') { deps.onFileStatus?.(message); return; }
      const entry = pending.get(message.id);
      if (entry === undefined) return; // 迟到的、或者根本不是我问的
      if (message.type === 'http') {
        if (entry.want !== 'http') {
          /**
           * 引导 / 通话那种请求收到一条 http 回包:工人只会在「不认这台手机」时这么回(403,见上面那句话的来由)。
           * 当场收场,别等 15 秒超时 —— 那 15 秒里老包的麦克风是开着的。别的形状照旧不认。
           */
          if ((entry.want === 'onboarding' || entry.want === 'call' || entry.want === 'file_pull') && message.status >= 400) {
            settle(message.id, { ok: false, error: message.status === 403 ? WBCH_RPC_NOT_PAIRED_TEXT : `电脑上的事务官没接这一条(${message.status})` });
          }
          return;
        }
        settle(message.id, { ok: true, status: message.status, body: message.body });
        return;
      }
      // 工人明说这条没办成(它那边连 8791 都连不上一类)。原话转达,不套一层。
      if (message.type === 'error') { settle(message.id, { ok: false, error: message.error, cause: 'worker' }); return; }
      if (message.type === 'onboarding') {
        if (entry.want !== 'onboarding') return;
        entry.acked?.({
          ok: message.ok,
          ...(message.stage === undefined ? {} : { stage: message.stage }),
          ...(message.error === undefined ? {} : { error: workerError(message.error, '引导没接上') }),
          ...(message.leader === undefined ? {} : { leader: message.leader }),
        });
        settle(message.id, message.ok ? { ok: true, status: 200, body: message } : { ok: false, error: workerError(message.error, '引导没接上') });
        return;
      }
      if (message.type === 'file_pull') {
        if (entry.want !== 'file_pull') return;
        entry.acked?.({
          ok: message.ok,
          ...(message.error === undefined ? {} : { error: workerError(message.error, '电脑那边没推') }),
          ...(message.name === undefined ? {} : { name: message.name }),
          ...(message.bytes === undefined ? {} : { bytes: message.bytes }),
        });
        settle(message.id, message.ok ? { ok: true, status: 200, body: message } : { ok: false, error: workerError(message.error, '电脑那边没推') });
        return;
      }
      if (message.type === 'call') {
        if (entry.want !== 'call') return;
        entry.acked?.({ ok: message.ok, ...(message.error === undefined ? {} : { error: workerError(message.error, '招呼没说出去') }) });
        settle(message.id, message.ok ? { ok: true, status: 200, body: message } : { ok: false, error: workerError(message.error, '招呼没说出去') });
        return;
      }
      if (entry.want !== 'token') return;
      settle(
        message.id,
        { ok: true, status: 200, body: { token: message.token, expires_at: message.expires_at } },
        {
          token: message.token,
          expires_at: message.expires_at,
          ...(message.url === undefined ? {} : { url: message.url }),
          ...(message.room === undefined ? {} : { room: message.room }),
          ...(message.route === undefined ? {} : { route: message.route }),
        },
      );
    },
    onState: (state) => {
      // 房间断了:等着的那些不会再有答复,现在就告诉他们,别悬到超时。
      if (state === 'closed' || state === 'failed') {
        for (const id of [...pending.keys()]) settle(id, { ok: false, error: WBCH_RPC_CLOSED_TEXT, cause: 'closed' });
      }
    },
  });

  /** 发送失败那一下:当场收场(不等超时)。 */
  function failSend(id: string, error: unknown): void {
    settle(id, { ok: false, error: error instanceof Error && error.message !== '' ? error.message : WBCH_RPC_CLOSED_TEXT, cause: 'closed' });
  }

  async function send(
    message: { id: string; want: 'http' | 'token' | 'onboarding' | 'call' | 'file_pull' },
    line: string,
    hooks: { renewed?: (c: WbchRpcRenewed) => void; acked?: (a: { ok: boolean; stage?: string; error?: string; leader?: string; name?: string; bytes?: number }) => void } = {},
    /**
     * 识别那条(2026-09-25,卡 S)要的几样:只发给工人(`to`)、等得久一点(`timeoutMs`)、
     * 同时再发一条字节流(`alongside`,录音本身)、没办成时带上是哪一种(`withCause`)。别的请求一个都不用传。
     */
    options: { to?: string; timeoutMs?: number; alongside?: () => Promise<void>; withCause?: boolean } = {},
  ): Promise<WbchRpcResult> {
    if (disposed) return { ok: false, error: WBCH_RPC_CLOSED_TEXT, ...(options.withCause === true ? { cause: 'closed' as const } : {}) };
    const result = new Promise<WbchRpcResult>((resolve) => {
      const timer = setTimeout(() => settle(message.id, { ok: false, error: WBCH_RPC_TIMEOUT_TEXT, cause: 'timeout' }), options.timeoutMs ?? timeoutMs);
      pending.set(message.id, {
        resolve, timer, want: message.want,
        ...(hooks.renewed === undefined ? {} : { renewed: hooks.renewed }),
        ...(hooks.acked === undefined ? {} : { acked: hooks.acked }),
        ...(options.withCause === true ? { withCause: true } : {}),
      });
    });
    /**
     * **不等 `sendText` 落地**(2026-09-23 从零重装验收)。它的 promise 要等对面收完才落地,
     * 而房里没有工人时它可能永远不落地 —— 以前这里 `await` 它,于是上面那根超时明明已经到点、
     * 结果也已经定了,调用方还是一直等着:手机挂断时卡在「正在挂断…」回不来,就是这一处。
     * 发送失败照旧当场收场;成败以答复 / 超时 / 断开三者先到的那个为准。
     */
    try {
      const sent = options.to === undefined ? deps.link.sendText(line, WBCH_RPC_TOPIC) : deps.link.sendText(line, WBCH_RPC_TOPIC, options.to);
      void sent.catch((error: unknown) => failSend(message.id, error));
    } catch (error) {
      failSend(message.id, error);
    }
    // 字节流与那一行并发发:工人那边谁先到都对得上(asrRelay.ts 的信箱),不必一前一后多等一程。
    if (options.alongside !== undefined) {
      try { void options.alongside().catch((error: unknown) => failSend(message.id, error)); }
      catch (error) { failSend(message.id, error); }
    }
    return result;
  }

  /**
   * 通话那几个动作走同一条路:发出去、等工人那一条 `type:'call'` 的答复。
   *
   * `start` / `answer` 一律带上 `reports_playing`(2026-09-28,卡 CF 第 4 条):**这个包会发 `playing`**。
   * 它就是那个「能力开关」—— 老包压根不发这一格,工人于是不等;新包发了,工人才多等那一下。
   */
  async function callAction(
    action: 'start' | 'answer' | 'later' | 'hangup' | 'playing',
    callId?: string,
    warmMs?: number,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const id = newId();
    let ack: { ok: boolean; error?: string } | undefined;
    const result = await send(
      { id, want: 'call' },
      encodeWbchOutbound({
        id,
        type: 'call',
        action,
        ...(callId === undefined ? {} : { call_id: callId }),
        ...(action === 'start' || action === 'answer' ? { reports_playing: true as const } : {}),
        // 烘热等了多久(卡 OP):**取到了才带**,取不到就缺席 —— 不编一个数。
        ...(warmMs === undefined || !Number.isFinite(warmMs) ? {} : { warm_ms: Math.max(0, Math.round(warmMs)) }),
      }),
      { acked: (a) => { ack = a; } },
    );
    if (!result.ok) return { ok: false, error: result.error };
    if (ack !== undefined && !ack.ok) return { ok: false, error: ack.error ?? '这一条没办成' };
    return { ok: true };
  }

  return {
    http(input) {
      const id = newId();
      return send(
        { id, want: 'http' },
        encodeWbchOutbound({ id, type: 'http', method: input.method, path: input.path, body: input.body ?? null }),
      );
    },

    async renew() {
      const id = newId();
      let credential: WbchRpcRenewed | undefined;
      const result = await send({ id, want: 'token' }, encodeWbchOutbound({ id, type: 'renew' }), { renewed: (c) => { credential = c; } });
      if (!result.ok) return { ok: false, error: result.error };
      if (credential === undefined) return { ok: false, error: '工人回的续期答复里没有新凭证' };
      return { ok: true, credential };
    },

    async onboarding(action, text) {
      const id = newId();
      let ack: { ok: boolean; stage?: string; error?: string; leader?: string } | undefined;
      const result = await send(
        { id, want: 'onboarding' },
        encodeWbchOutbound({ id, type: 'onboarding', action, ...(text === undefined ? {} : { text }) }),
        { acked: (a) => { ack = a; } },
      );
      if (!result.ok) return { ok: false, error: result.error };
      if (ack !== undefined && !ack.ok) return { ok: false, error: ack.error ?? '引导没接上' };
      return {
        ok: true,
        ...(ack?.stage === undefined ? {} : { stage: ack.stage }),
        ...(ack?.leader === undefined ? {} : { leader: ack.leader }),
      };
    },

    async callStart(callId) {
      return callAction('start', callId);
    },

    callAnswer(callId) {
      return callAction('answer', callId);
    },

    callLater(callId) {
      return callAction('later', callId);
    },

    callHangup() {
      return callAction('hangup');
    },

    /**
     * 「**我这边在放了**」(2026-09-28,卡 CF 第 4 条)。工人的开场白在等它。
     * 发不出去不算错:工人那道闸有上限(2.5s),到点照旧开口。
     */
    callPlaying(warmMs) {
      return callAction('playing', undefined, warmMs);
    },

    async filePull(offer) {
      const id = newId();
      let ack: { ok: boolean; error?: string; name?: string; bytes?: number } | undefined;
      const result = await send(
        { id, want: 'file_pull' },
        encodeWbchOutbound({ id, type: 'file_pull', offer }),
        { acked: (a) => { ack = a; } },
      );
      if (!result.ok) return { ok: false, error: result.error };
      if (ack !== undefined && !ack.ok) return { ok: false, error: ack.error ?? '电脑那边没推' };
      return { ok: true, ...(ack?.name === undefined ? {} : { name: ack.name }), ...(ack?.bytes === undefined ? {} : { bytes: ack.bytes }) };
    },

    async asr(audio, mimeType) {
      const link = deps.link;
      if (link.sendBytes === undefined) return { ok: false, error: '这一版的房间连接发不了录音', cause: 'worker' };
      const id = newId();
      // 两样一起发:一行 `{id, type:'asr'}`(老工人当场回「不认识这种请求」)+ 录音字节流(只给工人,属性带同一个 id)。
      return send(
        { id, want: 'http' },
        encodeWbchOutbound({ id, type: 'asr' }),
        {},
        {
          to: WBCH_WORKER_IDENTITY,
          withCause: true,
          timeoutMs: deps.asrTimeoutMs ?? WBCH_ASR_TIMEOUT_MS,
          alongside: () => link.sendBytes!(audio, WBCH_ASR_TOPIC, WBCH_WORKER_IDENTITY, {
            name: 'asr.wav',
            mimeType,
            attributes: { [WBCH_ASR_ID_ATTRIBUTE]: id },
            // 不压:PCM 录音压不了几成,白烧手机的 CPU;也不赌收的那一头认不认压缩。
            compress: false,
          }),
        },
      );
    },

    async meetingSegment(audio, mimeType, target) {
      const link = deps.link;
      if (link.sendBytes === undefined) return { ok: false, error: '这一版的房间连接发不了录音', cause: 'worker' };
      const id = newId();
      return send(
        { id, want: 'http' },
        encodeWbchOutbound({ id, type: 'meeting_segment', meeting_id: target.meetingId, seq: target.seq, ...(target.ms === undefined ? {} : { ms: target.ms }) }),
        {},
        {
          to: WBCH_WORKER_IDENTITY,
          withCause: true,
          timeoutMs: WBCH_MEETING_SEGMENT_TIMEOUT_MS,
          alongside: () => link.sendBytes!(audio, WBCH_MEETING_TOPIC, WBCH_WORKER_IDENTITY, {
            name: `${String(target.seq).padStart(2, '0')}.m4a`,
            mimeType,
            attributes: { [WBCH_MEETING_ID_ATTRIBUTE]: id },
            // 不压:m4a 本来就压过了。
            compress: false,
          }),
        },
      );
    },

    dispose() {
      disposed = true;
      unlisten();
      for (const id of [...pending.keys()]) settle(id, { ok: false, error: WBCH_RPC_CLOSED_TEXT, cause: 'closed' });
    },
  };
}
