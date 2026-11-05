/**
 * 通话 RTC 抽象层
 *
 * 把「和智能体打电话」的底层实现藏在一个统一接口 CallClient 后面，
 * UI（CallOverlay）只关心状态机：connecting → connected → ended/error。
 *
 * 目前默认走 mock 客户端（不依赖后端、不依赖 SDK），用来先把整套 UI 跑通。
 * 等火山后端就绪后，安装 `@volcengine/rtc`，实现 createVolcCallClient，
 * 把 USE_MOCK_RTC 置为 false 即可无缝切换——UI 一行都不用改。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { CallSettings } from './callSettingsStore.ts';
import { apiPost } from './apiClient.ts';
import { analyzeAudioLevel, createTalkingMouth } from '../features/live2d/mouthSync.ts';

export type CallStatus = 'connecting' | 'connected' | 'ended' | 'error';

export type StartCallOptions = {
  avatarId: string;
  avatarName: string;
  /** 该角色的通话音色（每角色配置，调后端 start 时透传） */
  voice?: string;
  /** 角色人设，作为智能体 LLM 的 SystemMessages（可选） */
  systemMessage?: string;
  /** 智能体接通后的开场白（可选） */
  welcomeMessage?: string;
  /** 通话模式：voice=纯语音(默认)；video=视频通话(接通即推视频、开视觉、先看后开口) */
  mode?: 'voice' | 'video';
  callSettings: CallSettings;
  /** 演出挂钩：远端(智能体)说话音量 0-1，逐帧回调 → 驱动口型。挂断自动归零。 */
  onBotAudioLevel?: (level: number) => void;
  /** 演出挂钩：智能体定稿字幕（每句一次）→ 供本地情绪判断驱动表情/动作。 */
  onBotUtterance?: (text: string) => void;
};

export type CallStatusListener = (status: CallStatus, detail?: { error?: string; visionAvailable?: boolean; cameraOn?: boolean }) => void;

export interface CallClient {
  /** 发起通话；状态变化通过 onStatus 回调推送 */
  start(options: StartCallOptions, onStatus: CallStatusListener): Promise<void>;
  /** 挂断并清理资源 */
  hangup(): Promise<void>;
  /** 麦克风静音/取消静音：muted=true 停止本地采集（停止上行），false 恢复采集 */
  setMuted(muted: boolean): Promise<void>;
  /** 开/关摄像头（视频上行 + 云端视觉理解）。on 时需传入本地预览容器。 */
  setCameraEnabled(on: boolean, renderDom?: HTMLElement): Promise<void>;
  /** "直接视频"模式下，视频已在接通前推流；接通后把本地预览挂到容器上。 */
  attachLocalPreview(renderDom?: HTMLElement): void;
}

/** true=本地 mock（无后端/SDK 也能跑 UI）；false=真实火山 RTC（需已 npm i @volcengine/rtc + 后端配好 RTC provider） */
const USE_MOCK_RTC = false;

/** 模拟接通耗时（ms），贴近云 API 的真实建连感受 */
const MOCK_CONNECT_DELAY = 1800;

/**
 * Mock 客户端：不连任何后端，纯本地模拟一次通话的生命周期。
 * 用于在后端就绪前验证 UI 全流程。
 */
function createMockCallClient(): CallClient {
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  let active = false;

  function clearTimer() {
    if (connectTimer !== null) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
  }

  return {
    async start(_options, onStatus) {
      active = true;
      onStatus('connecting');
      clearTimer();
      connectTimer = setTimeout(() => {
        connectTimer = null;
        if (active) {
          onStatus('connected');
        }
      }, MOCK_CONNECT_DELAY);
    },
    async hangup() {
      active = false;
      clearTimer();
    },
    async setMuted() {
      // mock：无真实音轨，静音切换无副作用
    },
    async setCameraEnabled() {
      // mock：无真实摄像头，视频切换无副作用
    },
    attachLocalPreview() {
      // mock：无真实视频，挂预览无副作用
    },
  };
}

type TokenResponse = { appId: string; roomId: string; userId: string; token: string; visionAvailable?: boolean };
type StartResponse = { taskId: string; botUserId: string; visionAvailable?: boolean };

// 动态加载 @volcengine/rtc（字面量 specifier：Vite 代码分割，仅真实通话时才加载该大包）。
async function loadVERTC(): Promise<any> {
  const mod: any = await import('@volcengine/rtc');
  return mod.default ?? mod;
}

/**
 * 火山引擎 RTC 实时对话式 AI（RTC AIGC）真实客户端。
 * 后端三件套（同一应用服务器，带鉴权）：
 *   POST /rtc/token → { appId, roomId, userId, token }（后端用 AppKey 签，前端只拿 Token）
 *   POST /rtc/start → StartVoiceChat（ASR + 豆包 LLM + TTS，智能体进同一房间说话）
 *   POST /rtc/stop  → StopVoiceChat
 */
/**
 * 视频通话优先用前置(自拍)摄像头：移动端火山 SDK deviceId 'user'=前置 / 'environment'=后置。
 * 默认 startVideoCapture() 在部分 WebView 会选到后摄——对着墙/天花板却说"看到你"，体验很差。
 * 极少数设备不认 'user' 字面量 → 退回 SDK 默认，保证仍能出画面。
 */
async function startFrontCamera(engine: any): Promise<void> {
  try {
    await engine.startVideoCapture('user');
  } catch {
    await engine.startVideoCapture();
  }
}

function createVolcCallClient(): CallClient {
  let engine: any = null;
  let vertc: any = null;
  let session: { roomId: string; userId: string; taskId?: string } | null = null;
  let visionAvailable = false;
  let cameraPublished = false; // 视频通话：音视频主流是否已发布
  // ───────── 口型同步：远端 AI 音频轨 → AnalyserNode → onBotAudioLevel ─────────
  // 与聊天自动播报共用同一套分析参数（analyzeAudioLevel/smoothMouthLevel），口型手感一致；
  // 出口由调用方统一（App.setMouthOpen / mouthSyncOverrides），静音由阈值自然归零。
  let mouthCtx: AudioContext | null = null;
  let mouthRaf = 0;
  let mouthTrackTimer: ReturnType<typeof setInterval> | null = null;
  let onBotAudioLevel: ((level: number) => void) | null = null;
  // 演出挂钩：智能体定稿字幕 → 上层做本地情绪判断（表情/动作）
  let onBotUtterance: ((text: string) => void) | null = null;

  function stopMouthSync() {
    if (mouthTrackTimer) { clearInterval(mouthTrackTimer); mouthTrackTimer = null; }
    if (mouthRaf) { cancelAnimationFrame(mouthRaf); mouthRaf = 0; }
    if (mouthCtx) { void mouthCtx.close().catch(() => {}); mouthCtx = null; }
    onBotAudioLevel?.(0);
  }

  // 远端流发布事件到达时音轨可能尚未就绪：轮询 getRemoteStreamTrack 直到拿到（最多 5s 放弃）。
  function startMouthSync(uid: string) {
    if (!onBotAudioLevel || mouthTrackTimer || mouthCtx) return;
    let tries = 0;
    mouthTrackTimer = setInterval(() => {
      tries += 1;
      // 0 = StreamIndex.STREAM_INDEX_MAIN
      const track: MediaStreamTrack | undefined = engine?.getRemoteStreamTrack?.(uid, 0, 'audio');
      if (!track) {
        if (tries >= 25 && mouthTrackTimer) {
          clearInterval(mouthTrackTimer);
          mouthTrackTimer = null;
          console.warn('[rtc-lipsync] 拿不到远端音轨，口型不驱动（通话不受影响）');
        }
        return;
      }
      if (mouthTrackTimer) { clearInterval(mouthTrackTimer); mouthTrackTimer = null; }
      attachMouthAnalyser(track);
    }, 200);
  }

  function attachMouthAnalyser(track: MediaStreamTrack) {
    const emit = onBotAudioLevel;
    if (!emit) return;
    const ctx = new AudioContext();
    mouthCtx = ctx;
    // WebView 的 AudioContext 可能因自动播放策略挂起：先 resume，失败则等用户点一下通话页恢复。
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => queueResume(() => { void ctx.resume().catch(() => {}); }));
    }
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    // 只分析不出声：远端音频由 SDK 自己播放，不接 destination 避免双声。
    source.connect(analyser);
    const samples = new Uint8Array(analyser.frequencyBinCount);
    // 「说话口型」引擎（与聊天 TTS 共用，见 mouthSync.createTalkingMouth）：
    // 音节摆动 × 真实声波 gate。RTC 音频经 AGC 压平，divisor 300 避免响的部分削顶，
    // 顶端起伏靠摆动补、低端(安静/停顿)靠 gate 收嘴。
    const mouth = createTalkingMouth();
    const tick = () => {
      if (mouthCtx !== ctx) return; // 已被 stopMouthSync/新一轮替换
      analyser.getByteFrequencyData(samples);
      const raw = analyzeAudioLevel(samples, { bandStart: 1, bandEnd: 22, threshold: 0.04, divisor: 300 });
      emit(mouth(raw));
      mouthRaf = requestAnimationFrame(tick);
    };
    mouthRaf = requestAnimationFrame(tick);
    console.info(`[rtc-lipsync] 远端音轨已接入口型分析 @${rel()}ms`);
  }

  // ───────── 通话延迟监控（仅日志，不改链路）─────────
  // 火山 RTC AIGC 云端一体化（ASR+豆包+TTS），「你说完→听到回应」耗时几乎全在云端。
  // 这里给云端经房间消息下发的事件打高精度时间戳，拆出 ① VAD+ASR ② LLM+TTS 各段。
  let callT0 = 0;                                            // performance.now() 基准（每次 start 重置）
  const rel = () => Math.round(performance.now() - callT0);  // 相对建连的毫秒数
  let botUserId = '';                                        // 智能体 userId（判定她的字幕=TTS出字）

  // 轮次/阶段计时：以云端 conv「Stage」状态机为权威信号（已由真机日志确认编码）：
  //   1=listening(听你说) 2=thinking(LLM思考) 3=answering(出声/TTS) 4=interrupted(被打断) 5=answerFinish(答完) 0=errorOccurred
  // 各段：① 你说完→听懂(VAD+ASR尾) ② thinking→answering(LLM首字, 大头) ③ answering→首字幕(TTS首包)。
  const NONE = -1;
  let lastUserSpeechEnd = NONE; // mic 判停的「你说完」时刻（仅用于估算 ① ASR 尾）
  let curRound = NONE;          // 当前轮 RoundID
  let tThinking = NONE;         // 本轮 thinking 起点
  let tAnswering = NONE;        // 本轮 answering 起点
  let ttsLogged = false;        // 本轮首字幕(TTS首包)是否已记
  function onStage(roundId: number, code: number, _desc: string, raw: string) {
    const t = rel();
    if (code === 2) {            // thinking：已听懂你，LLM 开始想
      curRound = roundId; tThinking = t; tAnswering = NONE; ttsLogged = false;
      const asrTail = lastUserSpeechEnd !== NONE ? ` ｜ ① 你说完→听懂(VAD+ASR尾) = ${t - lastUserSpeechEnd}ms` : '';
      console.info(`[rtc-timing] 🧠 R${roundId} 听懂·LLM开始(thinking) @${t}ms${asrTail}`);
      lastUserSpeechEnd = NONE;
      sendFiller(roundId); // 思考期间垫一句（感知延迟掩盖），真回复到了自然接上
    } else if (code === 3 && roundId === curRound) {  // answering：LLM 出结果，TTS 开始
      tAnswering = t;
      const llm = tThinking !== NONE ? `${t - tThinking}ms` : '?';
      console.info(`[rtc-timing] 💬 R${roundId} LLM出结果(answering) @${t}ms ｜ ★② LLM首字(thinking→answering) = ${llm}`);
    } else if (code === 5 && roundId === curRound) {
      console.info(`[rtc-timing] ✅ R${roundId} 答完(answerFinish) @${t}ms`);
    } else if (code === 4) {
      console.info(`[rtc-timing] ✋ R${roundId} 被打断(interrupted) @${t}ms`);
    } else if (code === 0) {
      console.warn(`[rtc-timing] ⚠️ R${roundId} 出错(errorOccurred) @${t}ms: ${raw}`);
    }
  }
  // 本轮 answering 之后第一条 bot 字幕 = TTS 首包真正出字
  function maybeLogTtsFirst(speaker: string | undefined) {
    if (ttsLogged || tAnswering === NONE || !botUserId || speaker !== botUserId) return;
    ttsLogged = true;
    const t = rel();
    console.info(`[rtc-timing] 🔊 R${curRound} 首字幕(TTS首包) @${t}ms ｜ ③ answering→字幕 = ${t - tAnswering}ms`);
  }

  // ───────── 思考垫话（感知延迟掩盖）─────────
  // thinking 期间用火山 ExternalTextToSpeech 让智能体先用「自己的音色」垫一句，
  // 真回复(answering)到了自然接上。避开「嗯/啊」开头（豆包真回复常用，否则双重）。
  // 走客户端 sendUserBinaryMessage(botUserId, {Command:'ExternalTextToSpeech',...})，音色自动一致、不用改后端。
  // ⚠️ 经真机验证：ExternalTextToSpeech(任何 InterruptMode)都会把正在生成的 LLM 那一轮顶掉，
  // 没法做「正文前的垫场」。故默认关闭；垫话若要做，改用本地音频播放（不经智能体、不干扰正文）。
  const FILLER_ENABLED = false;
  const FILLER_INTERRUPT_MODE = 1; // 1=立即说 / 2=当前说完再说（已知都不适合垫场）
  const FILLERS = ['让我想想哦~', '这个嘛…', '稍等我一下~', '我组织下语言哈'];
  let fillerIndex = 0;
  // 火山 AIGC 二进制消息协议：4字节 magic(ascii) + 4字节长度(大端) + UTF-8 JSON。
  // 控制类命令(ExternalTextToSpeech)用 magic 'ctrl'；裸 JSON 智能体不认 → 不出声。
  // 与我们解码进来的消息(handleAigc)同一套格式。
  const AIGC_CMD_MAGIC = 'ctrl';
  function frameAigcCommand(obj: unknown): ArrayBuffer {
    const json = new TextEncoder().encode(JSON.stringify(obj));
    const buf = new ArrayBuffer(8 + json.byteLength);
    const view = new DataView(buf);
    for (let i = 0; i < 4; i += 1) view.setUint8(i, AIGC_CMD_MAGIC.charCodeAt(i));
    view.setUint32(4, json.byteLength); // DataView 默认大端
    new Uint8Array(buf, 8).set(json);
    return buf;
  }
  function sendFiller(roundId: number) {
    if (!FILLER_ENABLED || !engine || !botUserId) return;
    if (typeof engine.sendUserBinaryMessage !== 'function') {
      console.warn('[rtc] 垫话失败：Web SDK 无 sendUserBinaryMessage，需退回后端 UpdateVoiceChat');
      return;
    }
    const msg = FILLERS[fillerIndex % FILLERS.length];
    fillerIndex += 1;
    try {
      // 必须按火山二进制协议封帧（magic+长度+JSON），裸 JSON 智能体不处理。
      engine.sendUserBinaryMessage(botUserId, frameAigcCommand({
        Command: 'ExternalTextToSpeech',
        Message: msg,
        InterruptMode: FILLER_INTERRUPT_MODE,
      }));
      console.info(`[rtc-timing] 🗣️ R${roundId} 垫话注入 @${rel()}ms: "${msg}"`);
    } catch (e) {
      console.warn('[rtc] 垫话发送异常（可退回后端 UpdateVoiceChat）:', e);
    }
  }

  // mic 判停：本地音量从高跌到持续低 → 认定你说完（前端近似，真 VAD 在云端）
  // 火山 linearVolume 是 0~100 量程（实测说话时约 25），底噪通常 <5。
  const VOICE_ON = 5;      // 判定「在说话」的音量阈值（0~100 量程）
  const SILENCE_MS = 600;  // 静音持续多久算「说完」
  let micSpeaking = false;
  let lastVoiceRel = 0;

  // 远端音频自动播放可能被浏览器/WebView 策略拦截 → 攒下「恢复播放」动作，
  // 在用户于通话页点击一次后统一恢复（点哪都行，监听 document pointerdown）。
  const pendingPlays: Array<() => void> = [];
  let resumeBound = false;
  function queueResume(fn: () => void) {
    pendingPlays.push(fn);
    if (resumeBound || typeof window === 'undefined') return;
    resumeBound = true;
    const handler = () => {
      resumeBound = false;
      pendingPlays.splice(0).forEach((f) => f());
    };
    window.addEventListener('pointerdown', handler, { once: true });
  }

  return {
    async start(options, onStatus) {
      callT0 = performance.now();
      lastUserSpeechEnd = NONE;
      curRound = NONE;
      tThinking = NONE;
      tAnswering = NONE;
      ttsLogged = false;
      micSpeaking = false;
      lastVoiceRel = 0;
      visionAvailable = false;
      cameraPublished = false;
      onBotAudioLevel = options.onBotAudioLevel ?? null;
      onBotUtterance = options.onBotUtterance ?? null;
      onStatus('connecting');
      try {
        let step = performance.now();
        const stepMs = () => { const d = Math.round(performance.now() - step); step = performance.now(); return d; };

        // 1) 取进房 Token（后端用 AppKey 签）
        const tk = (await apiPost('/rtc/token', {})) as TokenResponse;
        session = { roomId: tk.roomId, userId: tk.userId };
        console.info(`[rtc-timing] ① token ${stepMs()}ms（room=${tk.roomId} userId=${tk.userId}）`);

        // 2) 进房 + 采集麦克风
        vertc = await loadVERTC();
        engine = vertc.createEngine(tk.appId);
        console.info(`[rtc-timing] ② SDK加载+建引擎 ${stepMs()}ms`);

        // 诊断事件 + 远端(智能体)音频播放
        engine.on('onError', (e: unknown) => console.error('[rtc] engine error', e));
        engine.on('onUserJoined', (e: { userInfo?: { userId?: string } }) =>
          console.info('[rtc] 远端进房(智能体):', e?.userInfo?.userId),
        );
        // 远端发布音频流 → 显式播放（MediaType.AUDIO=1 / AUDIO_AND_VIDEO=3）。
        // 自动播放被浏览器拦则 catch，攒到用户点击时恢复。
        engine.on('onUserPublishStream', (e: { userId?: string; mediaType?: number }) => {
          console.info(`[rtc] 远端发布流(智能体在说话): ${e?.userId} mediaType=${e?.mediaType} @${rel()}ms`);
          if (e?.userId && (e.mediaType === 1 || e.mediaType === 3)) {
            const uid = e.userId;
            void Promise.resolve(engine.play(uid, 1)).catch(() => {
              console.warn('[rtc] 远端音频自动播放被拦，点屏幕恢复声音');
              queueResume(() => { void engine?.play(uid, 1).catch(() => {}); });
            });
            // 口型同步：拿她的音轨接分析器（异步轮询，不阻塞播放）
            startMouthSync(uid);
          }
        });
        // 浏览器自动播放策略拦截回调：点一下通话页即恢复声音。
        engine.on('onAutoplayFailed', (e: { userId?: string }) => {
          console.warn('[rtc] onAutoplayFailed，点屏幕恢复声音:', e?.userId);
          const uid = e?.userId;
          if (uid) queueResume(() => { void engine?.play(uid, 1).catch(() => {}); });
        });
        // 本地麦克风音量：仅用于「你开始/说完」提示 + 估算 ① ASR 尾（你说完→听懂）。
        // 真正的轮次/阶段计时由云端 conv Stage 状态机驱动（见 onStage）。
        engine.on('onLocalAudioPropertiesReport', (list: any[]) => {
          const v = list?.[0]?.audioPropertiesInfo?.linearVolume ?? 0;
          const now = rel();
          if (v > VOICE_ON) {
            if (!micSpeaking) {
              micSpeaking = true;
              console.info(`[rtc-timing] 🎙️ 你开始说话 @${now}ms（mic=${Number(v).toFixed(1)}）`);
            }
            lastVoiceRel = now;
          } else if (micSpeaking && now - lastVoiceRel >= SILENCE_MS) {
            micSpeaking = false;
            lastUserSpeechEnd = lastVoiceRel; // 记「你说完」时刻，供下个 thinking 估算 ASR 尾
            console.info(`[rtc-timing] 🤫 你说完 @${lastVoiceRel}ms`);
          }
        });

        // AIGC 对话消息（实时转写/智能体字幕/状态）走房间二进制消息。
        // 协议：前4字节 magic(ascii，如 subv/func/ctrl) + 4字节长度(BE) + UTF-8 JSON；解不出原样打。
        // 在原样打印上加：高精度时间戳 + 启发式识别「ASR最终 / 她首字幕」，喂给单轮计时。
        const decoder = new TextDecoder();
        // 解析火山消息：conv → 喂 Stage 状态机驱动计时；subtitle → 检测 bot 首字幕(TTS首包)。
        const interpretAigc = (json: any) => {
          // 会话状态机 conv：{ RoundID, Stage:{Code,Description}, ErrorInfo? }
          if (json && typeof json.RoundID === 'number' && json.Stage && typeof json.Stage.Code === 'number') {
            onStage(json.RoundID, json.Stage.Code, String(json.Stage.Description ?? ''), JSON.stringify(json.ErrorInfo ?? json.Stage));
            return;
          }
          // 字幕 subtitle：data[0].userId 是说话人；bot 的首条 = TTS 首包出字
          const d = Array.isArray(json?.data) ? json.data[0] : null;
          if (d) {
            maybeLogTtsFirst(d.userId);
            // 她的定稿字幕（definite=true，每句一次）→ 抛给上层做本地情绪判断驱动表情。
            // 用「不是我」判定说话人：botUserId 在 /rtc/start 返回前可能还没拿到。
            if (
              onBotUtterance &&
              d.definite === true &&
              typeof d.text === 'string' &&
              d.text.trim() &&
              d.userId &&
              d.userId !== session?.userId
            ) {
              onBotUtterance(d.text.trim());
            }
          }
        };
        const handleAigc = (source: string, fromUserId: string | undefined, buf: ArrayBuffer | undefined) => {
          if (!buf || !(buf instanceof ArrayBuffer)) return;
          let magic = '';
          let text = '';
          try {
            if (buf.byteLength >= 8) {
              const view = new DataView(buf);
              magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
              const len = view.getUint32(4);
              if (/^[a-zA-Z]{4}$/.test(magic) && 8 + len <= buf.byteLength) {
                text = decoder.decode(new Uint8Array(buf, 8, len));
              }
            }
            if (!text) { magic = ''; text = decoder.decode(buf); }
          } catch {
            console.info(`[rtc] AIGC消息(无法解析) ${source} from=${fromUserId} @${rel()}ms bytes=${buf.byteLength}`);
            return;
          }
          let json: any = null;
          try { json = JSON.parse(text); } catch { /* 非 JSON，原样打 */ }
          // 摘要：字幕只摘 data[0] 的 text/definite/speaker（避免上百条刷屏）；
          // 其它类型（尤其 conv 的 Stage 状态机）整体 stringify —— 这是拆 LLM/TTS 的关键，
          // Chrome 默认会把对象折叠成 {…}，stringify 后才能在复制的日志里读到内容。
          let summary: string;
          if (json && (json.type === 'subtitle' || Array.isArray(json.data))) {
            const d = Array.isArray(json.data) ? json.data[0] : json;
            const t = typeof d?.text === 'string' ? d.text : '';
            summary = `subtitle speaker=${d?.userId ?? '?'} definite=${d?.definite} text="${t.length > 40 ? `${t.slice(0, 40)}…` : t}"`;
          } else {
            summary = json ? JSON.stringify(json) : text;
          }
          console.info(`[rtc] AIGC ${source} from=${fromUserId} type=${magic || '?'} @${rel()}ms: ${summary}`);
          if (json) interpretAigc(json);
        };
        engine.on('onRoomBinaryMessageReceived', (e: { userId?: string; message?: ArrayBuffer }) =>
          handleAigc('room', e?.userId, e?.message),
        );
        engine.on('onUserBinaryMessageReceived', (e: { userId?: string; message?: ArrayBuffer }) =>
          handleAigc('user', e?.userId, e?.message),
        );

        // 先进房（关自动发布），再采集并「显式发布」麦克风——确保上行音频进房，智能体 ASR 才听得到你。
        await engine.joinRoom(
          tk.token,
          tk.roomId,
          { userId: tk.userId },
          { isAutoPublish: false, isAutoSubscribeAudio: true, isAutoSubscribeVideo: false },
        );
        console.info(`[rtc-timing] ③ 进房 ${stepMs()}ms`);

        // 视频通话：进房即采集并发布「音视频主流」——视频必须先于 StartVoiceChat 进房间，
        // 火山启动抽帧时才能订阅到这路视频。语音通话则只发音频（行为同原始）。
        const isVideo = options.mode === 'video';
        await engine.startAudioCapture();
        if (isVideo) {
          try {
            await startFrontCamera(engine); // 前置自拍头，对着用户
            await engine.publishStream(3); // 3 = MediaType.AUDIO_AND_VIDEO
            cameraPublished = true;
            console.info(`[rtc-timing] ④ 采集+发布音视频(视频通话) ${stepMs()}ms`);
          } catch (e) {
            cameraPublished = false;
            await engine.publishStream(1); // 视频失败则降级纯音频
            console.warn('[rtc-vision] 视频采集/发布失败，降级纯语音:', e);
          }
        } else {
          await engine.publishStream(1); // 1 = MediaType.AUDIO
          console.info(`[rtc-timing] ④ 采集+发布麦克风 ${stepMs()}ms`);
        }
        try { engine.enableAudioPropertiesReport?.({ interval: 200 }); } catch { /* 诊断可选 */ }
        console.info('[rtc] joined room + 已发布上行流');

        // 3) 启动智能体（ASR+豆包+TTS）。
        // 语音模式：带 welcomeMessage 开场白，接通即说话。
        // 视频模式：不发开场白(vision:true)，改为连接后触发"先看画面再打招呼"，避免秒发语音开场白。
        const started = (await apiPost('/rtc/start', {
          roomId: tk.roomId,
          userId: tk.userId,
          avatarId: options.avatarId,
          voice: options.voice ?? '',
          systemMessage: options.systemMessage ?? '',
          welcomeMessage: isVideo ? '' : (options.welcomeMessage || `你好呀，我是${options.avatarName}，能听到我说话吗？`),
          vision: isVideo,
        })) as StartResponse;
        session.taskId = started.taskId;
        botUserId = started.botUserId;
        visionAvailable = started.visionAvailable ?? false;
        console.info(`[rtc-timing] ⑤ 启动智能体 ${stepMs()}ms（bot=${started.botUserId} visionAvailable=${visionAvailable}）`);
        console.info(`[rtc-timing] ✅ 建连总计 ${rel()}ms —— 以下为每轮对话延迟`);
        console.info('[rtc] 智能体已启动 taskId=', started.taskId, 'bot=', started.botUserId);

        onStatus('connected', { visionAvailable, cameraOn: cameraPublished });

        // 视频通话：连接后触发"先看画面再打招呼"——让她的第一句就基于实际画面，而非秒发开场白。
        if (isVideo && cameraPublished && session?.taskId) {
          apiPost('/rtc/vision-greet', { roomId: session.roomId, taskId: session.taskId })
            .then((r) => console.info('[rtc-vision] vision-greet 已触发:', r))
            .catch((e: unknown) => console.warn('[rtc-vision] vision-greet 失败:', e));
        }
      } catch (err) {
        console.error('[rtc] start failed:', err);
        onStatus('error', { error: err instanceof Error ? err.message : '通话建立失败' });
      }
    },

    async hangup() {
      stopMouthSync();
      try {
        if (session?.taskId) {
          await apiPost('/rtc/stop', { roomId: session.roomId, taskId: session.taskId }).catch(() => {});
        }
        if (engine) {
          await engine.stopAudioCapture?.();
          await engine.stopVideoCapture?.(); // 清理摄像头（若未开启则无副作用）
          await engine.leaveRoom?.();
          if (vertc?.destroyEngine) vertc.destroyEngine(engine);
        }
      } finally {
        engine = null;
        vertc = null;
        session = null;
      }
    },

    async setMuted(muted) {
      if (!engine) return;
      // 停止/恢复本地麦克风采集：停止后不再有上行音频（智能体听不到）
      if (muted) await engine.stopAudioCapture?.();
      else await engine.startAudioCapture?.();
    },

    attachLocalPreview(renderDom) {
      // "直接视频"：视频已在接通前(start)推流，这里只把本地预览挂到容器。
      if (!engine || !session || !renderDom) return;
      try {
        engine.setLocalVideoPlayer(0, { renderDom, userId: session.userId }); // 0 = STREAM_INDEX_MAIN
      } catch (e) {
        console.warn('[rtc-vision] 挂本地预览失败:', e);
      }
    },

    async setCameraEnabled(on, renderDom) {
      if (!engine || !session?.taskId) return;
      if (on) {
        // 开摄像头：采集 → 本地预览 → 发布视频流 → 通知后端开启视觉理解
        try {
          await startFrontCamera(engine); // 前置自拍头，对着用户
          if (renderDom) {
            // 0 = StreamIndex.STREAM_INDEX_MAIN
            engine.setLocalVideoPlayer(0, { renderDom, userId: session.userId });
          }
          await engine.publishStream(2); // 2 = MediaType.VIDEO
          console.info('[rtc-vision] 摄像头已采集+推流，通知后端开启视觉理解…', { room: session.roomId, task: session.taskId });
          await apiPost('/rtc/vision', {
            roomId: session.roomId,
            taskId: session.taskId,
            enable: true,
          })
            .then((r) => console.info('[rtc-vision] /rtc/vision enable 成功:', r))
            .catch((e: unknown) => console.error('[rtc-vision] /rtc/vision enable 失败:', e));
        } catch (err) {
          await engine.stopVideoCapture?.().catch(() => {});
          throw err;
        }
      } else {
        // 关摄像头：先通知后端停止视觉理解，再停止上行和采集
        await apiPost('/rtc/vision', {
          roomId: session.roomId,
          taskId: session.taskId,
          enable: false,
        }).catch((e: unknown) => console.warn('[rtc] /rtc/vision disable 失败:', e));
        await engine.unpublishStream(2); // 2 = MediaType.VIDEO
        await engine.stopVideoCapture();
      }
    },
  };
}

export function createCallClient(): CallClient {
  return USE_MOCK_RTC ? createMockCallClient() : createVolcCallClient();
}
