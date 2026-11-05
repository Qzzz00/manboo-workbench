/**
 * 一通电话的全部状态(2026-09-17 整合版,从 CallOverlay 里抽出来)。
 *
 * 为什么抽成 hook:Ben 拍板之后通话不再是「整屏盖上去的另一屏」,而是**舞台的一种状态**——
 * 球还是舞台上那一颗,只是形态跟着通话走(她在说 / 你在说 / 在接通)。
 * 球在舞台页画,通话状态在这里管,画的那一层(CallOverlay)只拿状态不持有状态,三边才对得上。
 *
 * 规矩没变:
 *   - 挂断只允许发生一次(按钮连点、卸载与按钮同时触发,都不该打两遍 stop);
 *   - 界面被拆(返回键、切页)也要真的挂断,不然房间里还留着一个在说话的智能体在计费;
 *   - 纪要交不上去只说一句,**不拦着他挂电话**;
 *   - 时长拿不到就整个字段缺席,不填 0。
 *
 * 2026-09-17 晚:**缺省的通话链路换成 LiveKit**(call/livekitCall.ts),火山 RTC 那一份留着当退路,
 * 由 settings.callProvider 选。两份实现的是同一个 CallClient 接口,所以这个 hook 和底部三个键
 * 一个字都不用改——换掉的只是「声音从哪儿来、字幕从哪儿来」。
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useSession } from '../session';
import { useSettings } from '../settings/SettingsContext';
import type { StageMode } from '../swarm/orbState';
import type { CallClient, CallResult } from './rtcCall';
import { createCallClient } from './rtcCall';
import { createWbchCallClient } from './livekitCall';
import type { CallPhase, CallUtterance } from './callModel';
import { appendUtterance, callStageMode, callStatusText, formatCallElapsed, newCallId } from './callModel';
import { MIC_DENIED_TEXT, openMicSettings } from './micPermission';
import { createOnboardingApi, type OnboardingApi } from '../onboarding/onboardingApi';
import { CALL_SCAN_POLL_MS, scanLineOf, scanProgressOf, withScanMode } from '../onboarding/scanHold';
import { CALL_SCAN_IDLE_MAX_MS, EMPTY_CALL_SCAN, nextCallScan } from '../onboarding/scanWindow';
import type { SayDecisionRoomEvent } from './sayDecisionRoomEvent';
import { createSayDecisionEventDeduper, mergeSayDecisionEvent } from './sayDecisionRoomEvent';
import type { SayCardPayload } from '../chat/sayCards';
import { sayChoiceRequest, sayDecidedRequest, saySuggestRequest, sayScreen } from '../chat/sayCards';

/** 麦克风关着时屏幕上那句话。说清后果:不是「静音」那种听不到她,是她听不见你。 */
export const MIC_OFF_TEXT = '麦克风已关,事务官听不见你';

/**
 * 挂断**整件事**最多等多久(2026-09-23 从零重装验收)。到点还没收拾完就**自己收场**:
 * 屏幕退回平常页面,纪要不写(拿不到完整的字幕,写一份残的不如不写),并留一句说明。
 * 验收那天手机守在旧房间里,挂断一直停在「正在挂断…」,只能把 App 划掉 —— 这是兜底的那一道;
 * 真正的每一步超时在 livekitCall.ts 的 WBCH_HANGUP_STEP_MS。
 */
export const CALL_HANGUP_DEADLINE_MS = 10_000;
/** 纪要最多等多久再退回平常页面。纪要是一条记录,不是通话本身,不该把人按在通话页上。 */
export const CALL_RECORD_WAIT_MS = 5_000;
/** 挂断等不到回话、自己收场之后那一句。 */
export const CALL_HANGUP_FORCED_TEXT = '电脑那边一直没回话,这通按已挂断处理;纪要没写';

/**
 * ——— 接通了却一直没听见她开口(2026-09-27,卡 fix/voice-onboarding-latency)———
 *
 * 现场:全新 Air、新注册账号,手机进「语音引导」等了 **34 秒**才听见第一句
 * (电脑那头的账:音频 0.7 秒就合好了,框架把播出按住了 33 秒)。
 * 这 34 秒里屏幕上只有「通话中」—— 人分不清是自己没听见、手机坏了、还是该重打。
 * **不能静默**:到点说一句「她在准备第一句」,再等到 15 秒就说清可能卡在哪 + 下一步。
 *
 * 这一层**只看得见「有没有听见她」**,看不见电脑那头卡在哪一段,所以第二句里
 * 把两种可能都如实说出来,不装作知道是哪一种(电脑上的体检页才有那份计时)。
 */
export const CALL_NO_VOICE_MS = 5_000;
export const CALL_NO_VOICE_TEXT = '事务官在准备第一句,稍等';
export const CALL_NO_VOICE_STUCK_MS = 15_000;
export const CALL_NO_VOICE_STUCK_TEXT
  = '还是没声音。多半是电脑上的事务官在等语音合成,或者屋里有点吵、她的第一句被按住了。可以挂断重打一次,或者在电脑上接着做引导。';

/** 等一个 promise,最多等 `ms`;超时回 `timedOut`。 */
async function waitAtMost<T>(promise: Promise<T>, ms: number): Promise<{ value: T } | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(value => ({ value })),
      new Promise<{ timedOut: true }>((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), ms); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 引导归电脑管时手机上那句话(2026-09-18)。 */
export const ONBOARDING_ON_DESKTOP_TEXT = '电脑上在做引导,先别说';
/** 那颗把主导权拿回手机的按钮。 */
export const TAKE_LEAD_LABEL = '改回手机';

export interface UseCallInput {
  /** false 就整个 hook 什么都不做(没在通话时舞台照常过日子)。 */
  active: boolean;
  avatarId?: string;
  /**
   * 这一通是**引导**(2026-09-18)。接通后房里的工人换上引导那套系统提示、立刻开口;
   * 挂断 = 暂停引导。
   *
   * 2026-09-25(卡 feat/first-look-orb-top):**引导这一通也写纪要了**,但只写时长 + `kind:'onboarding'`,
   * **不带字幕** —— 工作台按引导存档拼一句话(走完了 / 聊到哪一步),落一张「引导通话(27 分)」。
   * 以前不写,维护者 09-24 晚刚打了 27 分钟,手机上「最近一次通话」还说「还没有通过电话」。
   */
  onboarding?: { resume: boolean };
  /**
   * 这一通是**她主动打来的**(2026-09-21,座机响铃)。接起那一下已经在来电页那一层
   * 发给工人了(`{type:'call',action:'answer'}`),这里只负责把电话接好:
   * **不发招呼**(她已经在说「我打给你是因为…」),挂断时告诉工人这通完了。
   * 这一通**照常写通话纪要** —— 它是一通真的电话,和引导那一通不一样。
   */
  incoming?: { callId: string };
  /** 测试注入假的通话客户端;生产缺省按 settings.callProvider 选(缺省 LiveKit)。 */
  createClient?: () => CallClient;
  /** 计时器间隔(测试调快)。 */
  tickMs?: number;
  /** 挂断并收拾干净之后调用(舞台页据此退回待命)。 */
  onEnded: () => void;
  /** 挂断整件事最多等多久(测试调快)。缺省 {@link CALL_HANGUP_DEADLINE_MS}。 */
  hangupDeadlineMs?: number;
  /** 纪要最多等多久(测试调快)。缺省 {@link CALL_RECORD_WAIT_MS}。 */
  recordWaitMs?: number;
  /**
   * 引导那一通拿扫描进度的轮询间隔(2026-09-24)。缺省 {@link CALL_SCAN_POLL_MS};0 = 不轮询。
   * 2026-09-24 傍晚起轮询**只负责补字**(找的是谁、读的是谁、全量进度)与兜底:进执行中靠工人的工具信号,
   * 回去靠她开口(onboarding/scanWindow.ts)。
   */
  scanPollMs?: number;
  /** 测试注入:拿回合回包的接口(生产走 session.client)。 */
  onboardingApi?: Pick<OnboardingApi, 'turns'>;
}

export interface CallHandle {
  phase: CallPhase;
  /** 屏幕上那一行状态字(接不通时是服务端原话)。 */
  statusText: string;
  /** 球画成什么样。与主界面同一套五态语义(找项目时按成在办)。 */
  stageMode: StageMode;
  /**
   * 谁在出声(2026-09-24):她在说 speaking / 你在说 listening / 都没说 idle(没接通时照 callStageMode)。
   * 与 stageMode 的差别只有一处:**不含找项目那一层**。底边声音光看它 —— 找项目时球被按成在办,
   * 他开口光照升(fx/fxModel.callVoice)。
   */
  talkMode: StageMode;
  /** 「03:25」。没接通就是空字符串。 */
  elapsedText: string;
  lines: readonly CallUtterance[];
  /** 房间即时推来的服务端决定卡，按 say_id 聚合；无重放时不补造。 */
  sayDecisionCards?: readonly SayCardPayload[];
  sayDecisionBusy?: boolean;
  sayDecisionError?: string;
  chooseSayDecision?(payload: SayCardPayload, choice: string, askId?: string, suggestId?: string, decidedId?: string): Promise<{ ok: boolean; error?: string }>;
  /** 说到一半、还会被改写的那一句。只画在屏幕上,不进纪要。 */
  interim?: CallUtterance;
  /** 收音关着 = 这台手机不往外送你的声音。接通过程中按的也算数(2026-09-24):轮到发布时照它来。 */
  micOff: boolean;
  /** 挂不掉纪要一类的旁支消息。 */
  note?: string;
  /**
   * 没有录音权限(2026-09-18)。**通话照常**:她说得出话、打字也能用,只是听不到你。
   * `needsSettings` = 已经被永久拒了,只能去系统设置里开。
   */
  micBlocked?: { text: string; needsSettings: boolean };
  /**
   * **声音不在这台手机上**(2026-09-28,座机通话页统一)。座机形态里通话音频走树莓派那只话筒
   * (或房里另一台设备),这台手机只显示字幕与按钮 —— 这是同一张通话页上**唯一**的形态差异,
   * 所以它是这份 handle 上的一格参数,不是另一套页面。
   *
   * 有这一格时 `CallOverlay`:**不摆麦克风键**(这台机器没在收音,摆一颗按不出效果的键是骗人),
   * 顶上多一行 `banner` 说清声音在哪一台上,并把 `muted` 那句「这台是哑的」摆出来。
   * `useCall` 那一路(手机自己在通话里)永远不给这一格。
   */
  elsewhere?: { banner: string; muted: string };
  /** 引导这会儿归谁管。`'desktop'` 时手机上不开口,屏幕上说清并给一颗「改回手机」。 */
  leader?: 'phone' | 'desktop';
  /** 接不通:底部那颗红键要变成「关闭」。 */
  failed: boolean;
  /** 正在挂断:按钮要按不动,别打两遍。 */
  ending: boolean;
  hangup(): void;
  toggleMic(): void;
  /**
   * 打字备胎(2026-09-18):字幕面板里打的一句话。没有这条路(火山那条链路 / 不是引导)时是 undefined,
   * 界面据此决定摆不摆输入框 —— 摆一个发不出去的框是骗人。
   */
  say?(text: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * 引导那一通里她在找你的项目(2026-09-24):字幕位那一行「正在找你的项目… 已看 3/12 · …」。
   * 2026-09-24 傍晚起跟着「那一整段等待」走:工人一开始找就出现,到她开口说结果才收(onboarding/scanWindow.ts);
   * 这一段 stageMode 是 working(她真在出声时说话优先)。不在找(或不是引导)时缺席。
   */
  scanLine?: string;
  /**
   * 接通了却还没听见她开口时那一句人话(2026-09-27)。等得不久是
   * {@link CALL_NO_VOICE_TEXT},久到该说清卡在哪是 {@link CALL_NO_VOICE_STUCK_TEXT};
   * 听见过她开口之后**永不再出现**。
   */
  noVoiceHint?: string;
  /** 打开系统设置里本应用那一页(被永久拒之后唯一的路)。 */
  openSettings(): Promise<{ ok: true } | { ok: false; error: string }>;
  /** 把引导的主导权拿回手机,并让工人这就开口。只有引导那一通有。 */
  takeLead?(): Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * **这一句的语气**(2026-10-02,卡「声音与形象跟着话走」)。交给 Live2D 舞台
   * (`<ButlerStage toneRef={...}>`)驱动表情。**故意是 ref 不是 state**:
   * 字幕一句一条,每条都重渲染就等于每句话重建一次 Live2D(口型那一格同一个理由)。
   * 挂断时写回 null = 回中性。
   */
  toneRef: React.MutableRefObject<string | null>;
}

export function useCall({ active, avatarId, onboarding, incoming, createClient, tickMs = 250, onEnded, hangupDeadlineMs = CALL_HANGUP_DEADLINE_MS, recordWaitMs = CALL_RECORD_WAIT_MS, scanPollMs = CALL_SCAN_POLL_MS, onboardingApi }: UseCallInput): CallHandle {
  const session = useSession();
  const { settings } = useSettings();
  const [phase, setPhase] = useState<CallPhase>('idle');
  const [error, setError] = useState<string | undefined>(undefined);
  const [botSpeaking, setBotSpeaking] = useState(false);
  /** 上一次她在不在出声:只认起声那一下(「那一整段等待」据此收)。 */
  const botSpeakingRef = useRef(false);
  /**
   * 这一句的语气(2026-10-02)。给 Live2D 舞台那一层**每帧看一眼**用的 ——
   * 不进 state 的理由见 {@link CallHandle.toneRef}。
   */
  const toneRef = useRef<string | null>(null);
  /** 引导里「她在找你的项目」那一整段(onboarding/scanWindow.ts):工具信号进、她开口收,轮询补字。 */
  const [callScan, dispatchScan] = useReducer(nextCallScan, EMPTY_CALL_SCAN);
  /**
   * 这一通里**听见过她开口没有**(2026-09-27)。三样里任一样算数:远端音轨起声、
   * 工人推的字幕、她那一句进了字幕列表 —— 见 {@link CALL_NO_VOICE_TEXT} 那一段。
   * 听见过就再也不提示:她已经证明自己出得了声,后面的停顿是对话本身。
   */
  const [heardHer, setHeardHer] = useState(false);
  const [micSpeaking, setMicSpeaking] = useState(false);
  const [lines, setLines] = useState<readonly CallUtterance[]>([]);
  const [sayDecisionCards, setSayDecisionCards] = useState<readonly SayCardPayload[]>([]);
  const [sayDecisionBusy, setSayDecisionBusy] = useState(false);
  const sayDecisionBusyRef = useRef(false);
  const [sayDecisionError, setSayDecisionError] = useState<string | undefined>();
  const [interim, setInterim] = useState<CallUtterance | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [micOff, setMicOff] = useState(false);
  /**
   * 他要不要静音,**以按键那一刻为准**(2026-09-24,卡 fix/call-mute-before-publish)。
   * 放 ref 而不是在 setState 的回调里算:那个回调 React 可能跑不止一遍(StrictMode、并发渲染),
   * 副作用不该待在里头;而 setMuted 必须**每按一次就原样送一次** —— 送丢一次,就是界面说关了、轨道还开着。
   */
  const micOffRef = useRef(false);
  const [note, setNote] = useState<string | undefined>(undefined);
  /** 没有录音权限:通话照常,但屏幕上必须说清「她听不到你」(2026-09-18)。 */
  const [micBlocked, setMicBlocked] = useState<{ text: string; needsSettings: boolean } | undefined>(undefined);
  /** 引导归谁管。undefined = 还没问出来(不是引导,或者还没接通)。 */
  const [leader, setLeader] = useState<'phone' | 'desktop' | undefined>(undefined);
  const clientRef = useRef<CallClient | null>(null);
  const connectedAtRef = useRef<number | undefined>(undefined);
  /** 挂断只允许发生一次。 */
  const hangingUpRef = useRef(false);
  /** 下面那个 `hangup`。电脑那边挂了时要调它,而它在拨号那个 effect 之后才定义。 */
  const hangupRef = useRef<() => void>(() => {});
  // onEnded 放 ref:它在舞台页里是个闭包,变了不该把正在通的电话重拨一遍。
  const endedRef = useRef(onEnded);
  useEffect(() => { endedRef.current = onEnded; }, [onEnded]);
  // 走哪条链路也放 ref:通话中途在设置里切了供应商,不该把正在通的电话重拨一遍。
  const providerRef = useRef(settings.callProvider);
  useEffect(() => { providerRef.current = settings.callProvider; }, [settings.callProvider]);
  // 引导那面旗子同理:它只在拨出去那一下读一次。
  const onboardingRef = useRef(onboarding);
  useEffect(() => { onboardingRef.current = onboarding; }, [onboarding]);
  // 来电那一通同理:只在拨出去那一下读一次。
  const incomingRef = useRef(incoming);
  useEffect(() => { incomingRef.current = incoming; }, [incoming]);
  /**
   * 这一通的编号(2026-10-22,通话落成记录):来电用台账上的 id,他拨出去的由这里编一个、交给工人。
   * 挂断报记录时带上它,工作台把手机与工人报的并成一份,记录也挂得上台账(全景地图「十二」那条老毛病)。
   */
  const callIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!active) return;
    // 一通新电话从头来过:上一通的字幕、时长、麦克风状态都不该留到这一通。
    hangingUpRef.current = false;
    connectedAtRef.current = undefined;
    setPhase('connecting');
    setError(undefined);
    setLines([]);
    setInterim(null);
    setElapsedMs(0);
    // 新一通默认开麦(那一头 livekitCall.ts 的 start() 也复位成开):上一通按过的静音不带过来。
    micOffRef.current = false;
    setMicOff(false);
    setNote(undefined);
    setMicBlocked(undefined);
    setLeader(undefined);
    botSpeakingRef.current = false;
    setHeardHer(false);
    dispatchScan({ kind: 'reset' });

    callIdRef.current = incomingRef.current?.callId ?? newCallId();
    const client = createClient !== undefined
      ? createClient()
      : providerRef.current === 'volc'
        ? createCallClient({ api: session.call })
        : createWbchCallClient({ channel: session.channel, api: session.client });
    clientRef.current = client;
    let alive = true;
    const dialed = onboardingRef.current === undefined && incomingRef.current === undefined;
    void client.start({ ...(avatarId === undefined ? {} : { avatarId }), ...(onboardingRef.current === undefined ? {} : { onboarding: onboardingRef.current }), ...(incomingRef.current === undefined ? {} : { incoming: incomingRef.current }), ...(dialed ? { callId: callIdRef.current } : {}) }, {
      onPhase: (next, detail) => {
        if (!alive) return;
        setPhase(next);
        setError(detail?.error);
        if (next === 'connected') connectedAtRef.current = Date.now();
      },
      onUtterance: (entry) => {
        if (!alive) return;
        if (entry.who === 'butler') setHeardHer(true);
        setLines(prev => appendUtterance(prev, entry));
        setInterim(null);
      },
      onInterim: (entry) => { if (alive) setInterim(entry); },
      onBotSpeaking: (speaking) => {
        if (!alive) return;
        // 远端音轨起声 = 她开口了(「那一整段等待」据此收,见 onboarding/scanWindow.ts)。只认起声那一下。
        if (speaking) setHeardHer(true);
        if (speaking && !botSpeakingRef.current && onboardingRef.current !== undefined) dispatchScan({ kind: 'her', at: Date.now() });
        botSpeakingRef.current = speaking;
        setBotSpeaking(speaking);
      },
      onMicSpeaking: (speaking) => { if (alive) setMicSpeaking(speaking); },
      onMicPermission: (result) => {
        if (!alive) return;
        // 那一行写什么由下面那条链路说了算(2026-09-18):没权限是一句,
        // 权限给了却发不出去是另一句 —— 这一层不替它们合并。
        setMicBlocked(result.granted
          ? undefined
          : { text: result.text ?? MIC_DENIED_TEXT, needsSettings: result.needsSettings });
      },
      onLeader: (next) => { if (alive) setLeader(next); },
      // 电脑那边挂了(她道过别):走自己那条挂断 —— 纪要照交、退回平常页面(2026-09-23 晚)。
      onRemoteHangup: () => { if (alive) hangupRef.current(); },
      /**
       * 引导里她去找 / 读项目(2026-09-24 傍晚,卡 fix/scan-orb-working-whole-wait):工人一开跑就进执行中,
       * 跑完(她跑之前那几句也放完了)就等她开口;她开口就回去。只在引导那一通里算。
       */
      onTool: (event) => {
        if (alive && onboardingRef.current !== undefined) dispatchScan({ kind: 'tool', tool: event.tool, state: event.state, at: Date.now() });
      },
      onButlerSpeech: () => {
        if (!alive) return;
        setHeardHer(true);
        if (onboardingRef.current !== undefined) dispatchScan({ kind: 'her', at: Date.now() });
      },
      /**
       * **这一句的语气**(2026-10-02,卡「声音与形象跟着话走」)。写进 ref,舞台下一帧就换脸
       * (live2d/ButlerStage.tsx);**不进 state** —— 一通电话几十句,每句重渲染等于每句
       * 重建一次 Live2D。形象上没有对应的表情就不动,那由 live2d/tone.ts 说了算。
       */
      onButlerTone: (tone) => { if (alive) toneRef.current = tone; },
    });
    return () => {
      alive = false;
      // 界面被拆了(返回键、切页)也要真的挂断。
      if (!hangingUpRef.current) void client.hangup().catch(() => {});
    };
    // 只在这通电话开始时拨一次:avatarId 中途变了不该重拨。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    if (!active) return;
    setSayDecisionCards([]);
    setSayDecisionBusy(false);
    sayDecisionBusyRef.current = false;
    setSayDecisionError(undefined);
    const acceptEvent = createSayDecisionEventDeduper();
    return session.channel.onSayDecision?.((event: SayDecisionRoomEvent) => {
      if (event.call_id !== undefined && callIdRef.current !== undefined && event.call_id !== callIdRef.current) return;
      if (!acceptEvent(event)) return;
      setSayDecisionCards(previous => mergeSayDecisionEvent(previous, event));
    });
  }, [active, session]);

  useEffect(() => {
    if (!active || phase !== 'connected') return;
    const timer = setInterval(() => {
      const at = connectedAtRef.current;
      setElapsedMs(at === undefined ? 0 : Date.now() - at);
    }, tickMs);
    return () => clearInterval(timer);
  }, [active, phase, tickMs]);

  /**
   * 「接通了,可是还没听见她」那两句的定时器(2026-09-27)。
   *
   * 只在**接通之后**排:没接通那一段有它自己的超时与服务端原话(livekitCall.ts),
   * 这一层再插一句只会盖住更准的那一句。听见过她开口(`heardHer`)就整个撤掉。
   */
  const [noVoice, setNoVoice] = useState<'waiting' | 'stuck' | undefined>(undefined);
  useEffect(() => {
    if (phase !== 'connected' || heardHer) { setNoVoice(undefined); return; }
    const soon = setTimeout(() => setNoVoice('waiting'), CALL_NO_VOICE_MS);
    const late = setTimeout(() => setNoVoice('stuck'), CALL_NO_VOICE_STUCK_MS);
    return () => { clearTimeout(soon); clearTimeout(late); };
  }, [phase, heardHer]);

  const hangup = useCallback(() => {
    if (hangingUpRef.current) return;
    hangingUpRef.current = true;
    // 挂断就回中性(2026-10-02):不然她最后那一句的脸会一直挂在舞台上。
    toneRef.current = null;
    setPhase('ending');
    const connected = connectedAtRef.current !== undefined;
    void (async () => {
      const empty: CallResult = { transcript: [] };
      /**
       * 挂断整件事有个期限(2026-09-23):到点还没收拾完就自己收场,不让人卡在「正在挂断…」。
       * 收拾本身还在后台接着做,做完做不完都不再影响这一屏。
       */
      const waited = clientRef.current === null
        ? { value: empty }
        : await waitAtMost(clientRef.current.hangup().catch(() => empty), hangupDeadlineMs);
      setPhase('ended');
      if ('timedOut' in waited) {
        setNote(CALL_HANGUP_FORCED_TEXT);
        endedRef.current();
        return;
      }
      const result = waited.value;
      // 压根没接通过就不写记录:那是在记一件没发生的事。
      // 引导那一通(2026-09-25 起)也写,只带时长与 kind,不带字幕:那一句话由工作台照引导存档拼。
      if (connected) {
        const isOnboardingCall = onboardingRef.current !== undefined;
        // 记录交不上去只说一句就走人——它不是通话本身。也最多等 recordWaitMs。
        const recording = session.call.record({
          ...(callIdRef.current === undefined ? {} : { callId: callIdRef.current }),
          ...(result.durationSeconds === undefined ? {} : { durationSeconds: result.durationSeconds }),
          transcript: isOnboardingCall ? [] : result.transcript,
          ...(isOnboardingCall ? { kind: 'onboarding' as const } : {}),
        }).then((recorded) => { if (!recorded.ok) setNote(`通话记录没写回工作台:${recorded.error}`); })
          .catch(() => { setNote('通话记录没写回工作台'); });
        await waitAtMost(recording, recordWaitMs);
      }
      endedRef.current();
    })();
  }, [session, hangupDeadlineMs, recordWaitMs]);
  useEffect(() => { hangupRef.current = hangup; }, [hangup]);

  /**
   * 那颗麦克风键。**接通过程中按也照送**(2026-09-24):那一头记下他的意愿,轮到发布时按它来 ——
   * 静音着就不发,发布那一刻他按了就当场关(livekitCall.ts 的 applyMic)。所以屏幕上那句
   * 「麦克风已关,事务官听不见你」说的是真的:轨道确实没在发。
   */
  const toggleMic = useCallback(() => {
    const next = !micOffRef.current;
    micOffRef.current = next;
    setMicOff(next);
    void clientRef.current?.setMuted(next).catch(() => {});
  }, []);

  /**
   * 引导那一通:接通后每 scanPollMs 问一次回合回包,只取里面的 scan(2026-09-24,维护者真机:找项目时球没变工作态)。
   * `after` 跟着拿到的最大 seq 走,不重复搬整段对话。问不到就下一拍再问,不上屏。
   * 2026-09-24 傍晚起它只**补字与兜底**(onboarding/scanWindow.ts):进执行中靠工具信号当场进,回去靠她开口。
   */
  const isOnboarding = onboarding !== undefined;
  const connectedNow = phase === 'connected';
  useEffect(() => {
    if (!active || !isOnboarding || !connectedNow || !(scanPollMs > 0)) return;
    const api = onboardingApi ?? createOnboardingApi(session.client);
    let alive = true;
    let after = 0;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const r = await api.turns(after);
        if (!alive || !r.ok) return;
        for (const turn of r.data.turns ?? []) if (typeof turn.seq === 'number' && turn.seq > after) after = turn.seq;
        dispatchScan({ kind: 'poll', scan: scanProgressOf(r.data), at: Date.now() });
      } catch {
        // 下一拍再问。
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const timer = setInterval(() => { void tick(); }, scanPollMs);
    return () => { alive = false; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在「引导那一通接通了」这件事变时起停
  }, [active, isOnboarding, connectedNow, scanPollMs]);
  // 不再是接通着的引导(挂了、断了):那一整段从头来,不带到下一通。
  useEffect(() => {
    if (!active || !isOnboarding || !connectedNow) dispatchScan({ kind: 'reset' });
  }, [active, isOnboarding, connectedNow]);
  // 保险:窗口开着、好久没有「还在干」的动静就收(onboarding/scanWindow.ts CALL_SCAN_IDLE_MAX_MS)。
  const scanDeadline = callScan.open ? (callScan.seen ?? callScan.since ?? 0) + CALL_SCAN_IDLE_MAX_MS : undefined;
  useEffect(() => {
    if (scanDeadline === undefined) return;
    const timer = setTimeout(() => dispatchScan({ kind: 'tick', at: Date.now() }), Math.max(0, scanDeadline - Date.now()) + 16);
    return () => clearTimeout(timer);
  }, [scanDeadline]);
  const scanning = isOnboarding && connectedNow && callScan.open;

  // 谁在出声:声音光只看它(找项目时球被按成在办,他说话光照升 —— 2026-09-24)。
  const talkMode = useMemo(() => callStageMode({ phase, botSpeaking, micSpeaking }), [phase, botSpeaking, micSpeaking]);
  // 找项目那一整段且她没在说话 → 在办,与文字引导页同一条(scanHold.withScanMode)。
  const stageMode = useMemo(() => withScanMode(talkMode, scanning), [talkMode, scanning]);

  /** 去系统设置里开录音权限。打不开就把原话交给界面显示,不吞。 */
  const openSettings = useCallback(async () => {
    const result = await openMicSettings();
    if (!result.ok) setNote(result.error);
    return result;
  }, []);

  /**
   * 把引导的主导权拿回手机(2026-09-18)。两步,顺序不能反:
   * 先落一笔 `leader:'phone'`(不然工人再问一次简报还是「归电脑管」),再让工人开口。
   */
  const takeLead = useCallback(async () => {
    const api = createOnboardingApi(session.client);
    const set = await api.leader('phone');
    if (!set.ok) return { ok: false as const, error: set.error };
    const client = clientRef.current;
    if (client?.retryOnboarding === undefined) return { ok: false as const, error: '这条链路接不了引导' };
    const again = await client.retryOnboarding();
    if (again.ok) setLeader('phone');
    return again;
  }, [session]);

  /**
   * 打字备胎。发出去那一下**立刻**把我这句话摆进字幕:工人也会推一条 `role:'me'`,
   * 但那要一个来回;屏幕上先有字,人才知道「发出去了」。重复的那条由 appendUtterance 挡掉。
   */
  const say = useCallback(async (text: string) => {
    const client = clientRef.current;
    if (client?.sayText === undefined) return { ok: false as const, error: '现在这条链路不能打字' };
    const trimmed = text.trim();
    if (trimmed === '') return { ok: false as const, error: '这句话是空的' };
    setLines(prev => appendUtterance(prev, { who: 'me', text: trimmed }));
    return client.sayText(trimmed);
  }, []);

  const chooseSayDecision = useCallback(async (payload: SayCardPayload, choice: string, askId?: string, suggestId?: string, decidedId?: string) => {
    if (sayDecisionBusyRef.current) return { ok: false, error: '这张决定卡正在提交。' };
    if (suggestId !== undefined && payload.suggest?.suggest_id !== suggestId) return { ok: false, error: '这条建议已更新，请按最新回话重新选择。' };
    const context = decidedId !== undefined ? sayDecidedRequest(payload, decidedId, choice)
      : suggestId !== undefined ? saySuggestRequest(payload, choice) : sayChoiceRequest(payload, choice, askId);
    if (context === undefined) return { ok: false, error: '服务端没有提供可提交的决定编号或备选。' };
    sayDecisionBusyRef.current = true;
    setSayDecisionBusy(true);
    setSayDecisionError(undefined);
    try {
      const result = await session.client.json<import('../api/protocol').ButlerSayResponse>('/butler/say', {
        method: 'POST', body: { entrance: 'phone', ...context },
      });
      if (!result.ok) { setSayDecisionError(result.error); return { ok: false, error: result.error }; }
      const next = result.data as unknown as SayCardPayload;
      if (sayScreen(next) === undefined) {
        const error = '服务端选择回包缺少 say.screen；卡片未更新为成功。';
        setSayDecisionError(error);
        return { ok: false, error };
      }
      setSayDecisionCards(previous => previous.map(one => one.say_id === payload.say_id ? next : one));
      return { ok: true };
    } catch {
      const error = '工作台服务没应答，决定卡保留原样。';
      setSayDecisionError(error);
      return { ok: false, error };
    } finally { sayDecisionBusyRef.current = false; setSayDecisionBusy(false); }
  }, [sayDecisionBusy, session]);

  return {
    phase,
    statusText: callStatusText(phase, error),
    stageMode,
    talkMode,
    elapsedText: phase === 'connected' ? formatCallElapsed(elapsedMs) : '',
    lines,
    ...(sayDecisionCards.length === 0 ? {} : { sayDecisionCards }),
    ...(sayDecisionBusy ? { sayDecisionBusy } : {}),
    ...(sayDecisionError === undefined ? {} : { sayDecisionError }),
    ...(sayDecisionCards.length === 0 ? {} : { chooseSayDecision }),
    ...(interim === null ? {} : { interim }),
    micOff,
    ...(note === undefined ? {} : { note }),
    failed: phase === 'error',
    ending: phase === 'ending',
    hangup,
    toggleMic,
    openSettings,
    toneRef,
    ...(micBlocked === undefined ? {} : { micBlocked }),
    ...(leader === undefined ? {} : { leader }),
    ...(scanning ? { scanLine: scanLineOf(callScan.shown) } : {}),
    ...(noVoice === undefined ? {} : { noVoiceHint: noVoice === 'stuck' ? CALL_NO_VOICE_STUCK_TEXT : CALL_NO_VOICE_TEXT }),
    ...(onboarding === undefined ? {} : { say, takeLead }),
  };
}
