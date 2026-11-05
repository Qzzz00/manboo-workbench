/**
 * 和事务官打电话:火山 RTC 实时对话式 AI 的客户端那一半(2026-09-17)。
 * 逻辑取自 Aiboo 的 src/lib/rtcCall.ts,只留语音通话——视觉/摄像头/垫话/旅程一概没搬。
 *
 * ⚠️ **2026-09-17 晚:这条链路不再是缺省**。决策记录「手机通道层改 LiveKit」拍板之后,
 * 通话走 `call/livekitCall.ts`(同一个 `CallClient` 接口,同一套底部三键与通话纪要)。
 * 这个文件**留着不删**:它是 LiveKit 那条路真机跑不通时的退路,也是「火山智能体 vs 我们自己的接话模型」
 * 这个选择一旦推翻时的现成实现。开关在 settings.callProvider(设置页「通话」那一节),
 * 缺省 `livekit`;`ApiClient` 里 `/rtc/*` 那几条接口一个字没改。
 *
 * 一通电话的顺序(顺序不能改,每一步都有理由):
 *   1. POST /rtc/token           后端用 AppKey 签的进房 token。**AppKey 永远不到手机上。**
 *   2. createEngine + 进房       进房时关自动发布(isAutoPublish:false),
 *   3. 采集麦克风 + 显式发布      —— 先进房再发布,才保证上行音频真的在房间里,智能体的 ASR 听得到你;
 *   4. POST /rtc/start           智能体(ASR + 豆包 + TTS)进同一个房间开口说话。
 *      人设与开场白由**工作台在代理层注入**,手机一个字都不传(见 workbench-plugin/src/server/rtcCall.ts)。
 *   5. 挂断 POST /rtc/stop       再离房、销毁引擎。stop 失败也照样离房——不能让人挂不掉电话。
 *
 * 打断:InterruptMode 0 在后端就是 0,你一出声她就停。这里不需要做任何事。
 *
 * **谁在说话**靠云端下发的会话状态机(房间二进制消息里的 conv:Stage.Code)判定,
 * 不去接 AnalyserNode 分析远端音轨——WebView 里 AudioContext 会被自动播放策略挂起,
 * 那条路在手机上不可靠,而球画成什么样不值得为它冒险。你这边说没说话用本地音量报告判。
 */
import type { CallApi } from '../api/call';
import type { CallPhase, CallUtterance } from './callModel';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 火山 Web SDK 的模块形状。只用到这几样,不把整份 d.ts 搬进来。 */
export interface VolcRtcModule {
  createEngine: (appId: string) => any;
  destroyEngine?: (engine: any) => void;
}

export interface CallEvents {
  onPhase: (phase: CallPhase, detail?: { error?: string }) => void;
  /** 定稿字幕(每句一次)。 */
  onUtterance: (entry: CallUtterance) => void;
  /**
   * 还没定稿的那一句(说到一半、随时会被改写)。null = 定稿了或撤了。
   * **只画在屏幕上,不进纪要** —— 纪要里留一句改到一半的话没意义。
   * 火山那条链路不推中间结果,所以它从不调这个;LiveKit 那条会(工人推的 `final:false`)。
   */
  onInterim?: (entry: CallUtterance | null) => void;
  /** 她在不在出声(云端会话状态机判定)。 */
  onBotSpeaking: (speaking: boolean) => void;
  /** 你在不在出声(本地麦克风音量)。 */
  onMicSpeaking: (speaking: boolean) => void;
  /**
   * 「她听不听得到你」的结论(2026-09-18,Ben 真机:「没有去要录音的权限,我说话它听不到」)。
   *
   * 两件事都从这一条出来,而且**不合成一句**:
   *   ① 权限没给 —— 进房之前就问出来,所以这一条总在 `connected` 之前到;
   *   ② 权限给了、麦克风却没发出去(WebView 不给采集、一条轨道也没建起来)。
   * 前者能给「去设置里打开」,后者只能重打一次 —— 合成一句话就等于让人猜。
   *
   * 两种都**不算通话失败**:她照样说得出话、打字备胎照样能用,但屏幕上必须有那一行,
   * 不能静默。火山那条退路不调它(它自己那套 SDK 管采集)。
   */
  onMicPermission?: (result: {
    granted: boolean;
    needsSettings: boolean;
    error?: string;
    /** 屏幕上那一行写什么。缺席 = 缺省那句「没有录音权限,她听不到你」。 */
    text?: string;
  }) => void;
  /**
   * 引导这会儿归谁管(2026-09-18)。`'desktop'` = 人在电脑上按了「改在电脑上做」,
   * 工人一个字都不说 —— 手机据此显示「电脑上在做,先别说」并摆一颗「改回手机」。
   */
  onLeader?: (leader: 'phone' | 'desktop') => void;
  /**
   * **电脑那边把这一通挂了**(2026-09-23 晚,维护者真机 0.2.73「说了拜拜之后没有真的拜拜」)。
   * 他道了别、她回了一句道别,工人在那句播完之后挂断,广播 `call_state{idle}`。
   * 上一层据此走**自己那条挂断**(纪要照交、退回平常页面),不另起一套收场。
   * 火山那条退路不调它。
   */
  onRemoteHangup?: () => void;
  /**
   * 工人那边一件慢工具开跑 / 跑完了(2026-09-24 傍晚,卡 fix/scan-orb-working-whole-wait)。
   * 缓冲语那条通道上的 `{kind:'tool'}` / `{kind:'tool_done'}`,**不管这台手机垫不垫话都转上来** ——
   * 引导通话页拿它管「她在找你的项目」那一整段球的执行中样子(onboarding/scanWindow.ts)。
   * `done` = 工具跑完、而且她跑之前说的那几句也放完了:她下一次开口就是在说结果。火山那条退路不调它。
   */
  onTool?: (event: { tool: string; state: 'start' | 'done' }) => void;
  /**
   * 工人推来**她的**一条字幕(定稿或中间结果都算)—— 她真开口了。**手机本地垫的那句不算**
   * (那句也会进字幕,但那是手机自己在念,不是她说完了在说结果)。火山那条退路不调它。
   */
  onButlerSpeech?: () => void;
  /**
   * **这一句的语气**(2026-10-02,卡「声音与形象跟着话走」)。工人在字幕上带的那一格
   * (取值见 channel/channelProtocol.ts 的 `WbchCaption.tone`),上一层拿它驱动 Live2D 的表情。
   * 模型没写、老工人不带 → 这一条**不调**(脸就不动,和从前一样)。火山那条退路不调它。
   */
  onButlerTone?: (tone: string) => void;
  /**
   * **该应一声了**(2026-10-02,卡「声音与形象跟着话走」第 5 件):他说得久、还没说完,
   * 这台手机本地放一声「嗯」。阈值全在工人那一头算(channel-worker/src/backchannel.ts),
   * 这一条只是「现在放」。老工人不发 → 没有应声,和从前一样。火山那条退路不调它。
   */
  onBackchannel?: (signal: { round: number; line?: string }) => void;
}

export interface CallStartOptions {
  avatarId?: string;
  /**
   * 这一通是**引导**(2026-09-18)。LiveKit 那条链路据此在接通后告诉房里的工人
   * 「我在做引导」,工人把系统提示换成引导那一套并立刻说这一段该说的那句。
   * `resume: true` 表示上次没做完(工作台说过 askedAt);**开场白重不重说仍由工作台定**。
   * 火山那条退路不认这个字段(它的智能体在云端,接不了引导),会忽略。
   */
  onboarding?: { resume: boolean };
  /**
   * 这一通是**她主动打来的**(2026-09-21,座机响铃)。他在来电页上按了「接起」,
   * 工人那边已经开口了(「我打给你是因为…」)—— 所以这一通**不发那句招呼**,
   * 两句一起说就是两个声音抢话(同引导那一条的理由)。
   * `callId` 挂断时要带回去,工人据此换回平时那套人设、让排着的下一通开始响。
   * 火山那条退路不认这个字段(它的智能体在云端,收不到座机来电),会忽略。
   */
  incoming?: { callId: string };
  /**
   * 他拨出去的这一通的编号(2026-10-22,通话落成记录)。手机拨号时编、交给工人,挂断报记录时带同一个,
   * 工作台据此把手机与工人报的并成一份。来电那一通用 `incoming.callId`,这一格不带。
   * 火山那条退路不认(它不经工人),会忽略。
   */
  callId?: string;
}

export interface CallResult {
  durationSeconds?: number;
  transcript: readonly CallUtterance[];
}

export interface CallClient {
  start(options: CallStartOptions, events: CallEvents): Promise<void>;
  /** 挂断并清理。**绝不抛**——挂电话这个动作不允许失败。 */
  hangup(): Promise<CallResult>;
  setMuted(muted: boolean): Promise<void>;
  /**
   * 打字备胎(2026-09-18):把一句打出来的话当成他说的送进去。
   * 只有 LiveKit 那条链路在引导里实现它;没有这一项时界面上不摆输入框。
   */
  sayText?(text: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * 再试一次「我在做引导」(2026-09-18)。人在手机上按了「改回手机」、主导方已经切回来之后调它,
   * 工人这才开口。只有 LiveKit 那条链路的引导通话有这一项。
   */
  retryOnboarding?(): Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface CallClientDeps {
  api: CallApi;
  /** 火山 Web SDK 的加载器。测试注入假引擎;生产是动态 import(那是个大包,只在真打电话时才加载)。 */
  loadSdk?: () => Promise<VolcRtcModule>;
  now?: () => number;
}

/** 火山会话状态机(conv)的 Stage.Code。真机日志确认过的编码,与 Aiboo 同。 */
const STAGE_ANSWERING = 3;
const STAGE_INTERRUPTED = 4;
const STAGE_ANSWER_FINISH = 5;

/** 本地音量判「你在说话」。火山 linearVolume 是 0~100 量程,底噪通常 <5。 */
const VOICE_ON = 5;
/** 静音持续多久算你说完(只用来把球从「聆听」收回去,真 VAD 在云端)。 */
const SILENCE_MS = 600;

/** MediaType.AUDIO。 */
const MEDIA_AUDIO = 1;
const MEDIA_AUDIO_AND_VIDEO = 3;

async function defaultLoadSdk(): Promise<VolcRtcModule> {
  // 字面量 specifier:Vite 会把这个大包单独切一块,启动和主界面都不背它。
  const mod = await import('@volcengine/rtc') as any;
  return (mod.default ?? mod) as VolcRtcModule;
}

/**
 * 火山 AIGC 的房间二进制消息:4 字节 magic(ascii) + 4 字节长度(大端) + UTF-8 JSON。
 * 解不出来就返回 undefined——这是网络上来的字节,解析失败不该把通话打断。
 */
export function decodeAigcMessage(buffer: ArrayBuffer | undefined): unknown {
  if (buffer === undefined || !(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) return undefined;
  const decoder = new TextDecoder();
  let text = '';
  try {
    if (buffer.byteLength >= 8) {
      const view = new DataView(buffer);
      const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
      const length = view.getUint32(4);
      if (/^[a-zA-Z]{4}$/.test(magic) && 8 + length <= buffer.byteLength) {
        text = decoder.decode(new Uint8Array(buffer, 8, length));
      }
    }
    if (text === '') text = decoder.decode(buffer);
    return JSON.parse(text) as unknown;
  }
  catch {
    return undefined;
  }
}

export function createCallClient(deps: CallClientDeps): CallClient {
  const now = deps.now ?? (() => Date.now());
  const loadSdk = deps.loadSdk ?? defaultLoadSdk;

  let sdk: VolcRtcModule | null = null;
  let engine: any = null;
  let session: { roomId: string, userId: string, taskId?: string } | null = null;
  let startedAt: number | undefined;
  let transcript: CallUtterance[] = [];
  let micTimer: ReturnType<typeof setInterval> | null = null;
  let micLastVoice = 0;
  let micSpeaking = false;
  /** 挂断中/已挂断:迟到的事件不该再改界面。 */
  let closed = false;
  /**
   * 他要不要静音(2026-09-24,与 livekitCall.ts 同一条规矩):**唯一的真相**,新一通复位成 false。
   * 以前按键时引擎还没建好(拿 token、加载 SDK 那几秒)就直接不管,进房那一下按的会被随后的
   * 「开采集」盖掉 —— 界面说关了,麦克风是开的。现在按键只改它,轮到采集那一步照它来。
   */
  let muted = false;
  /** 接通流程走到「采集麦克风」那一步了没有。没到之前按键只记意愿。 */
  let captureReady = false;

  function stopMicTimer(): void {
    if (micTimer !== null) { clearInterval(micTimer); micTimer = null; }
  }

  return {
    async start(options, events) {
      closed = false;
      // 新一通默认开麦(2026-09-24):上一通按过的静音不带到这一通。
      muted = false;
      captureReady = false;
      transcript = [];
      startedAt = undefined;
      micSpeaking = false;
      events.onPhase('connecting');
      try {
        const tokenResult = await deps.api.token();
        // 拿 token 这几秒里他挂了:到此为止,引擎都还没建(2026-09-24;以前照样往下走,挂了的电话接着进房、开采集)。
        if (closed) return;
        if (!tokenResult.ok) { events.onPhase('error', { error: tokenResult.error }); return; }
        const tk = tokenResult.data;
        session = { roomId: tk.roomId, userId: tk.userId };

        sdk = await loadSdk();
        if (closed) return;
        engine = sdk.createEngine(tk.appId);

        engine.on?.('onError', () => { /* 诊断用;通话本身的成败由下面各步的返回值说了算 */ });
        // 远端(智能体)发布音频 → 显式播放。自动播放被 WebView 拦掉时点一下屏幕就恢复(见 CallOverlay)。
        engine.on?.('onUserPublishStream', (e: { userId?: string, mediaType?: number }) => {
          if (e?.userId === undefined) return;
          if (e.mediaType === MEDIA_AUDIO || e.mediaType === MEDIA_AUDIO_AND_VIDEO) {
            void Promise.resolve(engine?.play?.(e.userId, MEDIA_AUDIO)).catch(() => {});
          }
        });
        engine.on?.('onAutoplayFailed', (e: { userId?: string }) => {
          if (e?.userId !== undefined) void Promise.resolve(engine?.play?.(e.userId, MEDIA_AUDIO)).catch(() => {});
        });
        // 本地音量 → 「你在说话」。只驱动球的形态,不参与任何判停逻辑。
        engine.on?.('onLocalAudioPropertiesReport', (list: any[]) => {
          if (closed) return;
          const volume = Number(list?.[0]?.audioPropertiesInfo?.linearVolume ?? 0);
          if (volume > VOICE_ON) {
            micLastVoice = now();
            if (!micSpeaking) { micSpeaking = true; events.onMicSpeaking(true); }
          }
        });
        const handleMessage = (e: { userId?: string, message?: ArrayBuffer }) => {
          if (closed) return;
          const json = decodeAigcMessage(e?.message) as any;
          if (json === undefined || json === null) return;
          // 会话状态机 conv:{ RoundID, Stage:{ Code } }。她出声/停下靠它,不靠音频分析。
          if (typeof json.RoundID === 'number' && typeof json.Stage?.Code === 'number') {
            const code = json.Stage.Code as number;
            if (code === STAGE_ANSWERING) events.onBotSpeaking(true);
            else if (code === STAGE_INTERRUPTED || code === STAGE_ANSWER_FINISH) events.onBotSpeaking(false);
            return;
          }
          // 字幕 subtitle:data[0] = { userId, text, definite }。只收定稿的那一条。
          const item = Array.isArray(json.data) ? json.data[0] : null;
          if (item === null || item === undefined) return;
          if (item.definite !== true || typeof item.text !== 'string' || item.text.trim() === '') return;
          // 说话人用「是不是我」判:botUserId 在 /rtc/start 回来之前还拿不到。
          const who: CallUtterance['who'] = item.userId === session?.userId ? 'me' : 'butler';
          const entry = { who, text: item.text.trim() };
          transcript = transcript.concat(entry);
          events.onUtterance(entry);
        };
        engine.on?.('onRoomBinaryMessageReceived', handleMessage);
        engine.on?.('onUserBinaryMessageReceived', handleMessage);

        // 先进房(关自动发布),再采集并显式发布麦克风——顺序见文件头。
        await engine.joinRoom(
          tk.token,
          tk.roomId,
          { userId: tk.userId },
          { isAutoPublish: false, isAutoSubscribeAudio: true, isAutoSubscribeVideo: false },
        );
        // 进房这一下里他挂了:hangup() 已经把引擎拆掉,别再对着它开采集。
        if (closed) return;
        /**
         * 采集麦克风 —— **按他的意愿**(2026-09-24):接通过程中按了「关掉麦克风」就不开,等他取消静音再开;
         * 开的那一下等回来再看一眼,期间按了(或者挂了)当场停掉。不采集时照样发布:没有上行音频,她听不见你。
         */
        captureReady = true;
        if (!muted) {
          await engine.startAudioCapture();
          if (muted || closed) await engine?.stopAudioCapture?.();
        }
        if (closed) return;
        await engine.publishStream(MEDIA_AUDIO);
        // 挂了就别再去请智能体进房(它在计费,也会对着一个拆掉的引擎说话)。
        if (closed) return;
        try { engine.enableAudioPropertiesReport?.({ interval: 200 }); } catch { /* 只是诊断,没有就算了 */ }

        const started = await deps.api.start({
          roomId: tk.roomId,
          userId: tk.userId,
          ...(options.avatarId === undefined ? {} : { avatarId: options.avatarId }),
        });
        if (!started.ok) { events.onPhase('error', { error: started.error }); return; }
        session.taskId = started.data.taskId;
        startedAt = now();

        // 「你说完了」只能靠轮询判:音量报告在你不出声时根本不回调。
        stopMicTimer();
        micLastVoice = now();
        micTimer = setInterval(() => {
          if (closed || !micSpeaking) return;
          if (now() - micLastVoice >= SILENCE_MS) { micSpeaking = false; events.onMicSpeaking(false); }
        }, 200);

        events.onPhase('connected');
      }
      catch (error) {
        events.onPhase('error', { error: error instanceof Error && error.message !== '' ? error.message : '通话没接通' });
      }
    },

    async hangup() {
      closed = true;
      stopMicTimer();
      const current = session;
      session = null;
      // 先让火山那边的智能体停下(它在计费也在说话),再拆本地。stop 失败照样往下拆——
      // 电话必须挂得掉,不能因为一个请求失败把人困在通话界面里。
      if (current?.taskId !== undefined) {
        try { await deps.api.stop({ roomId: current.roomId, taskId: current.taskId }); } catch { /* 见上 */ }
      }
      try { await engine?.stopAudioCapture?.(); } catch { /* 拆的时候什么都可能抛,一律吞 */ }
      try { await engine?.leaveRoom?.(); } catch { /* 同上 */ }
      try { if (engine !== null) sdk?.destroyEngine?.(engine); } catch { /* 同上 */ }
      engine = null;
      sdk = null;
      const durationSeconds = startedAt === undefined ? undefined : Math.max(0, Math.round((now() - startedAt) / 1000));
      startedAt = undefined;
      return { transcript, ...(durationSeconds === undefined ? {} : { durationSeconds }) };
    },

    async setMuted(next) {
      // 先记意愿(2026-09-24):还没走到采集那一步(拿 token、加载 SDK、进房)时只记,start() 轮到采集时照它来。
      muted = next;
      if (engine === null || !captureReady || closed) return;
      // 停掉采集就没有上行音频,她听不见你(比 SDK 的静音更彻底,也更容易解释)。
      try {
        if (next) await engine.stopAudioCapture?.();
        else await engine.startAudioCapture?.();
      }
      catch { /* 切换失败不该炸掉通话;界面上那个按钮的状态由调用方自己管 */ }
    },
  };
}
