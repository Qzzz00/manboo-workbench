/**
 * 座机来电接到界面上的那一层(2026-09-21)。做六件事:
 *
 *   1. **常驻房间**(2026-09-22 晚起**不再看座机模式**):不在房里就永远收不到那条 `ring`;
 *   2. 收 `ring` / `ring_end`,推 call/incomingModel.ts 那个状态机;
 *   3. 响铃(本地那段合成音)+ 震动(原生优先,网页 `navigator.vibrate` 兜底);
 *   4. **夜间静默那一条不响** —— 它带 `silent`,只交给原生发一条通知;
 *   5. 「接起」要**等工人那一声**才真的进通话(铃可能刚好在他按下去那一刻超时);
 *   6. 回到前台时拉一次 `GET /call/log`,把未接来电列出来;
 *   7. 「清空」未接(`POST /call/missed/clear`,2026-09-22)—— 只告诉工作台他看过了,不删台账。
 *
 * 状态机是纯的(incomingModel.ts),响铃是可注入的(ringtone.ts / deskPhone.ts),
 * 所以这一层的用例不用假装有 `<audio>`、有原生插件。
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { Session } from '../session';
import type { WbchCallState, WbchRing, WbchRingEnd } from '../channel/channelProtocol';
import {
  IDLE,
  RING_REASON_TITLES,
  parseCallLog,
  reduceIncoming,
  type CallLogView,
  type IncomingState,
} from './incomingModel';
import { createRingtone, type Ringtone } from './ringtone';
import {
  listenNativeRing,
  nativeRingReady,
  nativeRingState,
  requestNotifications,
  setRingStandby,
  startRinging,
  stopRinging,
  unlistenNativeRing,
  type DeskPhoneRingInput,
} from '../deskphone/deskPhone';
import { createRingHandoff, type NativeRingPort, type ParkableLink } from './ringHandoff';

/** 手机自己那根倒计时的节拍。1 秒够了 —— 差一秒收掉来电页没人看得出来。 */
const TICK_MS = 1000;

/** 房间没连上时那句话。**说清后果**:座机收不到电话。 */
export const RING_NO_ROOM_TEXT = '座机没连上房间,电话打不进来';

/**
 * **看门狗多久看一眼「我还在房里吗」**(2026-09-22 晚)。
 *
 * 为什么要它:`holdForRing()` 只在挂载那一下调一次,而这条连接会掉 ——
 * 切 Wi-Fi、手机睡过去、服务器重启、凭证过期。掉了之后房里就没有这台手机,
 * 工人那根领活的节拍看见「房里没有手机」压根不领,于是电话一整天都不会响,
 * **而屏幕上什么都不说**。那正是这类毛病最坏的一种:界面说好着,事实是没有(D13)。
 *
 * 20 秒:比工人那根 2 秒的领活节拍长得多(不抢它的活),比一通电话的 60 秒短 ——
 * 最坏情况是掉线之后错过一通,而不是错过一整天。
 */
export const RING_HOLD_CHECK_MS = 20_000;

/** 进不去房时重试的那几档(毫秒)。到顶就一直用最后一个。 */
const RING_HOLD_BACKOFF_MS = [5_000, 10_000, 20_000, 60_000] as const;

export interface IncomingHandle {
  state: IncomingState;
  /** 未接来电那一本。回到前台、以及每次有电话收场之后重新拉。 */
  log: CallLogView;
  /** 顶上那句「未接来电 N」。一条都没有就是 null。 */
  answer(): Promise<{ ok: true } | { ok: false; error: string }>;
  later(): Promise<void>;
  /**
   * **挂掉这一通**(2026-09-22)。话筒接起的那种情况下手机上只剩这一颗键。
   *
   * 话筒挂机现在由工人广播一条 `ring_end{outcome:'hung_up'}` 自动收掉这一屏(待拍板 E1),
   * 所以这一颗不再是唯一的出路;留着是因为话筒那头卡住、或者他就是想在手机上结束时,
   * 屏上得有一条自己走得掉的路。
   */
  hangup(): Promise<void>;
  /** 这通已接的电话挂了(StagePage 挂断之后回调)。 */
  ended(): void;
  /** 回拨一条未接来电:让工作台再排一通,工人这就打过来。 */
  callBack(entry: { reason: WbchRing['reason']; item_id: string; title: string }): Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * 「清空」未接来电(2026-09-22):告诉工作台**这几条他看过了**。
   * 服务端只给它们记一个 `dismissed_at`,台账一条不删(见 server/callOut.ts 第 7 条规矩)。
   */
  clearMissed(): Promise<{ ok: true } | { ok: false; error: string }>;
  refreshLog(): Promise<void>;
  /** 接不上、响不出来一类的旁支消息。显示完由界面清掉。 */
  note: string | null;
  clearNote(): void;
}

export interface UseIncomingOptions {
  /**
   * **常驻房间开不开**(2026-09-22 晚)。缺省 `true`,而且今天**没有任何调用方传 false**
   * —— 留这一格只是为了用例能把这根看门狗关掉。
   *
   * 以前这一格是 `deskPhone`(座机模式),Ben 2026-09-22 晚的原话把它否掉了:
   * 「要用户自己打开座机模式这个交互也不对」。一台收不到电话的座机不是设置没开,
   * 是它坏了 —— 所以从今天起**App 活着就在房里**。
   * 代价(如实):常驻一条 LiveKit 连接费电、费流量,没有量过具体数字;
   * App 被彻底杀掉照旧叫不醒(那要推送,见交接-0921 第六节)。
   */
  hold?: boolean;
  /**
   * **后台待机**(2026-10-03,缺省开,设置里那一格)。开着时原生起一个前台服务:
   * Android 14 起没有它,切到别的 App 或锁屏几秒,进程就被冻住、房间就断,电话打不进来。
   */
  standby?: boolean;
  /** 测试注入假的。缺省是原生那个「要通知权限」的框。 */
  askNotify?: () => Promise<boolean>;
  /** 测试注入假的。 */
  setStandby?: (on: boolean) => Promise<{ ok: boolean; note?: string }>;
  makeRingtone?: () => Ringtone;
  /** `tone: 'native'` = 原生已经在放铃声,网页那段 `<audio>` 不放(不双响);缺省按 `web`。 */
  ring?: (input: DeskPhoneRingInput) => Promise<{ ok: boolean; fullScreen: boolean; tone?: 'native' | 'web'; note?: string }>;
  /** 停铃。带 `callId` = 只停那一通(原生自己收的那一通不许被顺手掐掉,卡 E)。 */
  stopRing?: (callId?: string) => Promise<void>;
  /** 原生听铃那一头(卡 E,测试注入假的)。缺省是 deskPhone.ts 那两件。 */
  nativeRing?: NativeRingPort;
  /** 熄屏时多久看一眼该不该交给原生(测试调快)。 */
  handoffTickMs?: number;
  tickMs?: number;
  /** 看门狗多久看一眼(测试调快)。 */
  holdCheckMs?: number;
  now?: () => number;
}

/**
 * 熄屏时多久看一眼「该不该把听铃交给原生」(2026-10-20,卡 E)。冻结前网页的定时器按秒走,
 * 2 秒一拍让交接落在熄屏后 10–12 秒;亮着的时候这一拍只是几次比较,不碰网络。
 */
export const RING_HANDOFF_TICK_MS = 2_000;

const DEFAULT_NATIVE_RING: NativeRingPort = {
  listen: listenNativeRing,
  unlisten: unlistenNativeRing,
  canListen: nativeRingReady,
  listenState: nativeRingState,
};

/** 房间那一层停得了靠吗(老的假房间没有这几样)。 */
function parkable(link: unknown): ParkableLink | null {
  const l = link as Partial<ParkableLink>;
  return typeof l.park === 'function' && typeof l.unpark === 'function' && typeof l.parked === 'function' && typeof l.heldBy === 'function'
    ? (l as ParkableLink)
    : null;
}

/** 这台手机进房的 identity。拿不到(还没凭证、假会话)就 undefined —— 不编。 */
function selfIdentity(session: Session): string | undefined {
  try {
    const identity = session.channel.credential?.()?.identity;
    return typeof identity === 'string' && identity !== '' ? identity : undefined;
  }
  catch { return undefined; }
}

export function useIncoming(session: Session, options: UseIncomingOptions): IncomingHandle {
  const [state, dispatch] = useReducer(reduceIncoming, IDLE);
  const [log, setLog] = useState<CallLogView>({ entries: [], missed: 0, doneCall: false });
  const [note, setNote] = useState<string | null>(null);
  const tickMs = options.tickMs ?? TICK_MS;
  /**
   * 响铃那两件**放 ref**:它们在调用方常常是就地写的箭头函数,每次重画都是新的一个。
   * 直接写进 effect 的依赖里,结果是「界面重画一次就再响一遍」—— 本机用例里当场量到:
   * 一通电话响了两次。同 useCall 里 onEnded / provider 放 ref 的那条理由。
   */
  const ringRef = useRef(options.ring ?? startRinging);
  ringRef.current = options.ring ?? startRinging;
  const stopRef = useRef(options.stopRing ?? stopRinging);
  stopRef.current = options.stopRing ?? stopRinging;
  const askNotifyRef = useRef(options.askNotify ?? requestNotifications);
  askNotifyRef.current = options.askNotify ?? requestNotifications;
  const standbyRef = useRef(options.setStandby ?? setRingStandby);
  standbyRef.current = options.setStandby ?? setRingStandby;
  const nowRef = useRef(options.now ?? (() => Date.now()));
  nowRef.current = options.now ?? (() => Date.now());
  const ringtone = useMemo<Ringtone>(
    () => (options.makeRingtone ?? createRingtone)(),
    // 一台机器一套 `<audio>`:座机可能一天响十次,不为每一通新建一个。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  useEffect(() => () => { ringtone.dispose(); }, [ringtone]);

  const refreshLog = useCallback(async () => {
    // 拉不到**不吵**:多半是这会儿连不上电脑,或者这份工作台还没有主动来电(404)。
    // `try` 不能省:这一条走的是 routedClient,房间那条路上什么都可能抛。
    try {
      const result = await session.client.json<unknown>('/call/log');
      if (result.ok) setLog(parseCallLog(result.data));
    }
    catch { /* 见上。下一次回到前台再拉 */ }
  }, [session]);

  /**
   * ——— 常驻房间 + 一根看门狗(2026-09-21 建,2026-09-22 晚改) ———
   *
   * 改的是**前提**:以前要「座机模式开着」才常驻,于是 Ben 那台手机在 20:50 之前
   * 一通电话都收不到,而设置页上一个字都没说。Ben 的话是「要用户自己打开座机模式
   * 这个交互也不对」,所以这一版**App 活着就在房里**。
   *
   * 看门狗每 {@link RING_HOLD_CHECK_MS} 看一眼 `link.state()`:不是 `connected` 就再拿一次。
   * `holdForRing()` 自己会先看凭证过没过期、要不要换一张,所以「凭证过期掉线」这一种
   * 也走同一条路修回来。连不上就按 {@link RING_HOLD_BACKOFF_MS} 退避,并把**服务端那句原话**
   * 摆到屏幕上 —— 收不到电话这件事不许是哑的。
   */
  const holdCheckMs = options.holdCheckMs ?? RING_HOLD_CHECK_MS;
  const hold = options.hold ?? true;
  useEffect(() => {
    if (!hold) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;

    const again = (ms: number): void => {
      if (!alive) return;
      timer = setTimeout(() => { void pass(); }, ms);
    };

    const pass = async (): Promise<void> => {
      if (!alive) return;
      // 已经在房里就什么都不做 —— acquire 是幂等的,但每 20 秒白跑一趟没必要。
      if (session.channel.link.state() === 'connected') { failures = 0; again(holdCheckMs); return; }
      const held = await session.channel.holdForRing().catch((error: unknown) => ({
        ok: false as const,
        error: error instanceof Error && error.message !== '' ? error.message : '进不了房间',
      }));
      if (!alive) return;
      if (held.ok) {
        // 只在**刚才真的报过「进不去」**时才清那一句:note 是整屏共用的一行,
        // 顺手清掉别人的一句话(比如「铃声没放出来」)就是把一条如实的消息吃了。
        if (failures > 0) setNote(null);
        failures = 0;
        again(holdCheckMs);
        return;
      }
      setNote(`${RING_NO_ROOM_TEXT}:${held.error}`);
      const wait = RING_HOLD_BACKOFF_MS[Math.min(failures, RING_HOLD_BACKOFF_MS.length - 1)] ?? holdCheckMs;
      failures += 1;
      again(wait);
    };

    void pass();
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
      void session.channel.releaseRing().catch(() => {});
    };
  }, [session, hold, holdCheckMs]);

  /**
   * ——— 后台待机(2026-10-03) ———
   * 跟着开关走。卸载时**不关**:这个 hook 卸载就是 Activity 没了,那一刻原生自己收场
   * (划掉任务时那条通知改口成「已退出」),这里再发一句只会和它抢。
   */
  const standby = options.standby ?? true;
  useEffect(() => {
    const apply = (): void => {
      void standbyRef.current(standby).then((result) => {
        if (standby && !result.ok && result.note !== undefined) setNote(result.note);
      }).catch(() => {});
    };
    apply();
    /**
     * 回到前台再说一遍:Android 12+ 不许从后台起前台服务,那一次没起来的,回到前台补上;
     * 已经在跑的,原生那边重复起是幂等的。
     */
    if (!standby) return;
    const onVisible = (): void => { if (document.visibilityState === 'visible') apply(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [standby]);

  /**
   * ——— 通知权限(2026-10-04) ———
   * 后台来电在顶上弹出来靠的是原生那条来电通知,Android 13+ 没这项权限它一条都发不出去,
   * 只剩铃声和震动。以前只在「有事的时候主动打电话给我」被拨开那一下才要 —— 那一格缺省就开着,
   * 于是从来没要过。现在待机开着就在打开 App 时要**一次**:给过了原生当场回 true、不弹框;
   * 拒过两次系统也不再弹,剩下的交给设置页那一行。
   */
  useEffect(() => {
    if (!standby) return;
    void askNotifyRef.current().catch(() => false);
  }, [standby]);

  /**
   * ——— 熄屏 / 后台时把听铃交给原生(2026-10-20,卡 E) ———
   * 理由、先后与不交的几种全在 ringHandoff.ts 的文件头。这里只接线:看得见与否、界面忙不忙、开关开没开。
   */
  const busyRef = useRef(false);
  busyRef.current = state.kind === 'answered' || state.kind === 'handset';
  const standbyOnRef = useRef(standby);
  standbyOnRef.current = standby;
  const nativeRingRef = useRef(options.nativeRing ?? DEFAULT_NATIVE_RING);
  nativeRingRef.current = options.nativeRing ?? DEFAULT_NATIVE_RING;
  const handoffTickMs = options.handoffTickMs ?? RING_HANDOFF_TICK_MS;
  useEffect(() => {
    if (!hold) return;
    const link = parkable(session.channel.link);
    if (link === null) return;
    const handoff = createRingHandoff({
      link,
      native: {
        listen: (credential) => nativeRingRef.current.listen(credential),
        unlisten: () => nativeRingRef.current.unlisten(),
        canListen: () => nativeRingRef.current.canListen?.() ?? Promise.resolve({ ok: true }),
        listenState: () => nativeRingRef.current.listenState?.() ?? Promise.resolve(null),
      },
      credential: () => session.channel.credential(),
      visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
      standby: () => standbyOnRef.current,
      busy: () => busyRef.current,
      now: () => nowRef.current(),
      onNote: (text) => { if (text !== null) setNote(text); },
    });
    const kick = (): void => { void handoff.update().catch(() => {}); };
    kick();
    const timer = setInterval(kick, handoffTickMs);
    document.addEventListener('visibilitychange', kick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', kick);
      void handoff.dispose().catch(() => {});
    };
  }, [session, hold, handoffTickMs]);

  // ——— 收来电 ———
  useEffect(() => {
    return session.channel.onRing((message: WbchRing | WbchRingEnd | WbchCallState) => {
      /**
       * **这会儿房里在不在通话里**(2026-09-23,「打进打出同一张页」)。
       * 他提机拨出去的那一通只有这一条信号 —— 没有铃,所以这一支**不碰铃声**:
       * 往下走会进 `handset` 态,而那一面本来就不响、不出声、不收音。
       */
      /**
       * 带上**我是谁**(2026-09-23 晚):新工人在「接起来了」里写明是哪一台接的(`by_identity`),
       * 状态机拿它和自己比 —— 是我就进通话,不是我才进字幕页。拿不到自己的 identity 就不带,
       * 状态机退回「我刚按了接起没有」那条判据。
       */
      const self = selfIdentity(session);
      if (message.type === 'call_state') { dispatch({ type: 'call_state', state: message, ...(self === undefined ? {} : { self }) }); return; }
      if (message.type === 'ring_end') { dispatch({ type: 'ring_end', end: message, ...(self === undefined ? {} : { self }) }); return; }
      /**
       * **夜间静默那一条不是来电**(2026-09-21 第 2 条规矩):不响、不弹来电页,
       * 只让原生发一条通知。第二天早上他在未接列表里看得见它 —— 「只发通知不响铃」
       * 说的正是这件事,而不是「不打」。
       */
      if (message.silent) {
        void ringRef.current({
          callId: message.call_id,
          title: `${RING_REASON_TITLES[message.reason]} · ${message.title}`,
          text: message.note ?? '夜间静默时段,没有响铃',
          silent: true,
        });
        return;
      }
      dispatch({ type: 'ring', ring: message });
    });
  }, [session]);

  // ——— 响铃与震动:跟着状态走,不在收消息那一刻做 ———
  const ringingId = state.kind === 'ringing' ? state.call.call_id : null;
  const ringingTitle = state.kind === 'ringing' ? `${RING_REASON_TITLES[state.call.reason]} · ${state.call.title}` : '';
  useEffect(() => {
    if (ringingId === null) {
      /**
       * 只停网页那段 `<audio>`。原生那一路**不在这里全停**(2026-10-20,卡 E):这一页刚挂上(Activity 被系统收过又重开)
       * 时状态是 idle,而原生可能正响着它自己收到的那一通 —— 一句全停就把它掐了,工人补发的那份还没到。
       * 上一通的原生铃由下面那个清理函数按 id 停。
       */
      ringtone.stop();
      return;
    }
    let live = true;
    void ringRef.current({ callId: ringingId, title: ringingTitle, text: '事务官打来的', silent: false }).then((started) => {
      // 做不到全屏通知不是错:App 在前台时来电页本来就是网页画的。如实记一句,界面上不吵。
      if (started.note !== undefined) setNote(started.note);
      /**
       * 铃声二选一(2026-10-03):原生放了(后台 / 锁屏时只有它放得出来)网页就不放;
       * 原生没放(没插件、老包)才轮到 `<audio>`。等原生那一声回来再定,宁可晚几十毫秒,不双响。
       */
      if (!live || started.tone === 'native') return;
      void ringtone.start().then((played) => {
        if (!played.ok && played.error !== undefined) setNote(`铃声没放出来:${played.error}`);
      });
    });
    return () => { live = false; ringtone.stop(); void stopRef.current(ringingId); };
    // **只认「响的是哪一通」**:标题、响铃函数变了都不该让它再响一遍(见上面 ringRef 那段)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ringingId, ringtone]);

  // ——— 手机自己那根倒计时(不只等工人那条 ring_end) ———
  useEffect(() => {
    if (state.kind !== 'ringing') return;
    const timer = setInterval(() => dispatch({ type: 'timeout', now: nowRef.current() }), tickMs);
    return () => clearInterval(timer);
  }, [state.kind, tickMs]);

  // ——— 每次回到「没有电话」就重新拉一次台账(刚才那一通的结局要进未接列表) ———
  const lastKind = useRef(state.kind);
  useEffect(() => {
    const was = lastKind.current;
    lastKind.current = state.kind;
    if (state.kind === 'idle' && was !== 'idle') void refreshLog();
  }, [state.kind, refreshLog]);

  useEffect(() => { void refreshLog(); }, [refreshLog]);

  const answer = useCallback(async () => {
    if (state.kind !== 'ringing') return { ok: false as const, error: '这会儿没有电话在响' };
    // 连点两下:第一下的回话还没到,第二下不再发一遍。
    if (state.answering === true) return { ok: true as const };
    const callId = state.call.call_id;
    /**
     * ★ **先在本地记下「我正在接这一通」**(2026-09-23 晚,维护者真机「手机接起来没声」)。
     * 工人先广播「接起来了」、后回 RPC,广播先到 —— 没有这一笔,那条广播会被当成
     * 「另一台设备接的」,于是画成字幕页、喇叭和麦克风一次都没开。
     */
    dispatch({ type: 'answering' });
    // 先停铃:他已经按下去了,屏幕上还在响是最难受的。
    ringtone.stop();
    void stopRef.current(callId);
    /**
     * **等工人那一声才真的进通话**。铃有可能刚好在他按下去那一刻超时了 ——
     * 那时工人会回「正在响的不是这一通」,这一通就该收掉,而不是把他送进一通
     * 谁也不会开口的电话里(D13)。
     */
    const said = await session.channel.answerCall(callId).catch((error: unknown) => ({
      ok: false as const,
      error: error instanceof Error && error.message !== '' ? error.message : '没接上',
    }));
    if (!said.ok) {
      // 只退回自己的乐观那一格;这期间真被别的设备接走了的话,那一面留着(见 answer_failed)。
      dispatch({ type: 'answer_failed' });
      setNote(`这一通没接上:${said.error}`);
      return said;
    }
    dispatch({ type: 'answer' });
    return { ok: true as const };
  }, [state, session, ringtone]);

  const later = useCallback(async () => {
    if (state.kind !== 'ringing') return;
    const callId = state.call.call_id;
    dispatch({ type: 'dismiss' });
    ringtone.stop();
    void stopRef.current(callId);
    // 记成未接。说不出去也照收 —— 工人那边 60 秒后自己也会记。
    await session.channel.laterCall(callId).catch(() => {});
  }, [state, session, ringtone]);

  const hangup = useCallback(async () => {
    dispatch({ type: 'dismiss' });
    ringtone.stop();
    void stopRef.current();
    // 说不出去也照收:屏幕上那一屏是他要走的,工人那边房里没人时自己也会收场(agent.ts 那条补刀)。
    // 工人**不会**把这一下广播回来(手机自己挂的那条路不发回声),所以这一屏不会被收两次。
    await session.channel.hangupCall().catch(() => {});
  }, [session, ringtone]);

  const ended = useCallback(() => { dispatch({ type: 'dismiss' }); }, []);

  /**
   * 回拨(2026-09-22 修):**每一次都把台账再拉一遍**,不管排上没排上。
   *
   *   · 排上了 → 那一通此刻是 `queued`,未接列表里那颗键据此变灰(`hasLiveCall`),
   *     连点五下排出五通那件事在手机这一侧也堵住了;
   *   · 被拒了 → 拒的原因多半正是「这一件还有一通没收场」,拉一遍台账就看得见那一通,
   *     那颗键同样变灰,**直到它收场**(响完变 `missed` 之后下一次拉台账就亮回来)。
   *
   * 服务端那句原话照旧原样返回给调用方 —— 它要摆在**那一行上**,不是只塞进 note
   * (note 是整屏一句,三行未接里哪一行被拒了看不出来)。note 仍然留着:
   * 它是给不在未接列表上的调用方看的。
   */
  const callBack = useCallback(async (entry: { reason: WbchRing['reason']; item_id: string; title: string }) => {
    const result = await session.client.json<{ ok?: boolean; error?: string }>('/call/out', {
      method: 'POST',
      body: { reason: entry.reason, item_id: entry.item_id, title: entry.title },
    });
    if (!result.ok) { setNote(`回拨没排上:${result.error}`); void refreshLog(); return { ok: false as const, error: result.error }; }
    if (result.data?.ok === false) {
      const error = result.data.error ?? '工作台拒绝了';
      setNote(`回拨没排上:${error}`);
      void refreshLog();
      return { ok: false as const, error };
    }
    setNote('回拨排上了,事务官这就打过来');
    void refreshLog();
    return { ok: true as const };
  }, [session, refreshLog]);

  /**
   * 清空未接(2026-09-22,Ben 真机:九条「完成 · 下班例程」堆着,`missed` 只增不减)。
   *
   * 发完**当场把台账再拉一遍** —— 面板上那一下是乐观收起的,拉回来的那一份才是真的
   * (清掉了就空了;没清掉,下一次它自己又回来,而不是在屏幕上装作收掉了)。
   */
  const clearMissed = useCallback(async () => {
    const result = await session.client.json<{ ok?: boolean; dismissed?: number }>('/call/missed/clear', {
      method: 'POST',
      body: {},
    });
    if (!result.ok) { setNote(`未接来电没收掉:${result.error}`); return { ok: false as const, error: result.error }; }
    await refreshLog();
    return { ok: true as const };
  }, [session, refreshLog]);

  return {
    state,
    log,
    answer,
    later,
    hangup,
    ended,
    callBack,
    clearMissed,
    refreshLog,
    note,
    clearNote: useCallback(() => setNote(null), []),
  };
}
