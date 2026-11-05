// 底条军师问答的编排：触摸事件 → 截屏 → SSE → 状态机。
// UI 在 StrategistPanel，纯逻辑在 strategistSession，这里只做副作用编排。

import { useEffect, useReducer, useRef, useState } from 'react';

import {
  asr,
  chatStream,
  createSession,
  hotwords,
  resolvePack,
  uploadSaveState,
  type AibooEndpoint,
  type StrategistEndpoint,
} from '../lib/strategist/strategistClient.ts';
import { saveCandidates } from '../lib/strategist/saveFile.ts';
import { characterPrompt } from './strategistCharacter.ts';
import { createRecorder, type Recorder } from './petRecorder.ts';
import { createSpeaker, playClip, type Speaker } from './strategistSpeech.ts';
import {
  createGreetingPlaybackGate,
  greetingPresentationKey,
  playGreetingClipAtBoundary,
  type GreetingAudioTraceHost,
} from './strategistGreetingGate.ts';
import { GREETING, getCached, pickFiller, warmVoiceCache } from './strategistVoiceCache.ts';
import { initialState, isBusy, strategistReducer } from './strategistSession.ts';

const SHOT_MAX_BYTES = 300_000;
/** 截屏桥的等待上限。原生正常 <300ms，超了说明桥没接上，不能让 UI 一直转。 */
const SHOT_TIMEOUT_MS = 8000;

/** 读存档桥的等待上限。就是一次本地磁盘查找，正常几毫秒。 */
const SAVE_TIMEOUT_MS = 4000;

type Native = {
  AibooStrategist?: { capture: (reqId: string, cropBottomPx: number, maxBytes: number) => void };
  AibooStrategistSave?: {
    read: (reqId: string, candidatesJson: string, sinceMtimeMs: string) => void;
  };
};

// 在途截屏请求。★模块级、且必须在 captureViaBridge 之前声明——原生回调
// window.__strategistShot 是全局的，它落在这张表上找 resolver。
const pending: Record<string, (b64: string, err: string) => void> = {};
// 在途读存档请求（同上，另一张表）。
const pendingSave: Record<string, (json: string) => void> = {};
// typeof window 守卫：vitest 环境是 node，模块级裸碰 window 会让任何 import 直接炸。
if (typeof window !== 'undefined') {
  const w = window as unknown as {
    __strategistShot?: (id: string, b64: string, err: string) => void;
    __strategistSave?: (id: string, json: string) => void;
  };
  w.__strategistShot = (id, b64, err) => {
    pending[id]?.(b64, err);
  };
  w.__strategistSave = (id, json) => {
    pendingSave[id]?.(json);
  };
}

export type NativeSaveResult = {
  found: boolean;
  unchanged?: boolean;
  path?: string;
  mtimeMs?: number;
  sizeBytes?: number;
  base64?: string;
  error?: string;
};

/** 向原生要玩家的存档。形状同截屏桥（reqId 请求/应答）。 */
function readSaveViaBridge(romPath: string, sinceMtimeMs: number): Promise<NativeSaveResult> {
  const bridge = (window as unknown as Native).AibooStrategistSave;
  const candidates = saveCandidates(romPath);
  if (!bridge || !candidates.length) return Promise.resolve({ found: false });
  const reqId = `v${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  return new Promise<NativeSaveResult>((resolve) => {
    const timer = setTimeout(() => {
      delete pendingSave[reqId];
      resolve({ found: false, error: 'SAVE_TIMEOUT' });
    }, SAVE_TIMEOUT_MS);
    pendingSave[reqId] = (json) => {
      clearTimeout(timer);
      delete pendingSave[reqId];
      try {
        resolve(JSON.parse(json) as NativeSaveResult);
      } catch {
        resolve({ found: false, error: 'BAD_JSON' });
      }
    };
    bridge.read(reqId, JSON.stringify(candidates), String(sinceMtimeMs));
  });
}

/**
 * 向原生要一张截图。
 * ★JavascriptInterface 是同步的而截屏是异步的，所以走「JS 传 reqId → 原生回调
 * window.__strategistShot(reqId, base64, errCode)」的请求/应答形状，
 * 与 __petFraming 那类单向推送不同。
 */
function captureViaBridge(cropBottomPx: number): Promise<string> {
  const bridge = (window as unknown as Native).AibooStrategist;
  if (!bridge) return Promise.reject(new Error('NO_NATIVE'));
  const reqId = `s${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      delete pending[reqId];
      reject(new Error('CAPTURE_TIMEOUT'));
    }, SHOT_TIMEOUT_MS);
    pending[reqId] = (b64, err) => {
      clearTimeout(timer);
      delete pending[reqId];
      if (err) reject(new Error(err));
      else resolve(b64);
    };
    bridge.capture(reqId, cropBottomPx, SHOT_MAX_BYTES);
  });
}

export type StrategistDeps = {
  endpoint: () => StrategistEndpoint;
  /** Aiboo 后台（阿里云）——语音走它，不是军师服务端。 */
  aibooEndpoint: () => AibooEndpoint;
  /** 底条那只角色，传给 /ai/tts 查音色绑定。 */
  avatarId: string;
  /** 原生每次 reveal 递增的展示编号；普通预览使用稳定 legacy 编号。 */
  presentationId: number;
  /** 原生窗口已 reveal，而不是仍在隐藏预热/park。 */
  presentationVisible: boolean;
  /** Native service elapsed at the reveal bridge event. */
  presentationRevealedElapsedMs: number;
  /** performance.now() captured when that bridge event entered this WebView. */
  presentationReceivedAt: number;
  /** 当前 Live2D 背景、模型和最终布局已经形成完整帧。 */
  compositeReady: boolean;
  romFileName: string;
  /** ROM 绝对路径。空串＝不知道在玩哪个文件，读存档整条静默跳过。 */
  romPath?: string;
  stripHeightPx: number;
  /** SSE action 事件（emotion）转给 Live2D。 */
  onEmotion?: (emotion: string) => void;
  /** 播报期间的口型驱动量（0-1），转给 petCall stage 的 onBotAudioLevel。 */
  onSpeechLevel?: (level: number) => void;
};

export function useStrategist(deps: StrategistDeps) {
  const [state, dispatch] = useReducer(strategistReducer, undefined, initialState);
  // 语音念到第几个字 —— 面板靠它跟着朗读滚（答案 240 字，一屏只放得下约 100 字）。
  const [spokenChars, setSpokenChars] = useState(0);
  const sessionRef = useRef<string | null>(null);
  const abortRef = useRef<null | (() => void)>(null);
  // 事件回调是在 effect 里一次性注册的闭包，读 state 会读到首次渲染那份快照，
  // 必须走 ref 才拿得到当前值。
  const stateRef = useRef(state);
  stateRef.current = state;
  const recorderRef = useRef<Recorder | null>(null);
  const speakerRef = useRef<Speaker | null>(null);
  // 按下那一刻截的图，留到松手发送时用。
  const shotRef = useRef<string>('');
  // 已经上传过的那份存档的 mtime。原生据此判断「没变就别搬 128KB」。
  const savedMtimeRef = useRef<number>(0);
  // 按下时起跑、松手时收口的存档同步（见 beginVoice / endVoice）。
  const saveSyncRef = useRef<Promise<void>>(Promise.resolve());
  // 上一轮答完时后台取好的 ASR 热词，给下一次按住说话用（见 startChat 的 onDone）。
  const hotwordsRef = useRef<string[]>([]);
  const greetingGateRef = useRef(createGreetingPlaybackGate());
  const greetingRuntimeRef = useRef({
    aibooEndpoint: deps.aibooEndpoint,
    avatarId: deps.avatarId,
  });
  greetingRuntimeRef.current = {
    aibooEndpoint: deps.aibooEndpoint,
    avatarId: deps.avatarId,
  };
  const greetingKey = greetingPresentationKey({
    avatarId: deps.avatarId,
    presentationId: deps.presentationId,
    visible: deps.presentationVisible,
    compositeReady: deps.compositeReady,
  });

  // 底条一起来就预热开场白与垫词。★垫词的全部意义是「立刻有声音」——等要用的时候
  // 才合成就晚了（一次往返 1-2 秒，正好是它要填的那个空档）。fire-and-forget。
  useEffect(() => {
    const runtime = greetingRuntimeRef.current;
    if (!runtime.avatarId) return;
    void warmVoiceCache(runtime.aibooEndpoint, runtime.avatarId);
  }, [deps.avatarId]);

  // 播放和后台预热分离：只有原生已 reveal 且完整帧 ready 的 presentation 才有 key。
  // cleanup 会令尚未完成的缓存 promise 失效；已经开播的音频仍由 native park 立即 stop。
  useEffect(() => {
    const runtime = greetingRuntimeRef.current;
    return greetingGateRef.current.update(greetingKey, {
      warm: () => warmVoiceCache(runtime.aibooEndpoint, runtime.avatarId),
      getClip: () => getCached(runtime.avatarId, GREETING),
      play: (clip) => playGreetingClipAtBoundary(
        (typeof window === 'undefined' ? {} : window) as GreetingAudioTraceHost,
        deps.presentationId,
        clip,
        playClip,
      ),
    });
  }, [greetingKey, deps.presentationId]);

  /** 换一个播报器（顺带把上一轮没念完的掐掉）。 */
  function newSpeaker(): Speaker {
    speakerRef.current?.stop();
    setSpokenChars(0); // 新一轮从头念，面板的跟读位置也回到开头
    const sp = createSpeaker({
      endpoint: deps.aibooEndpoint,
      avatarId: deps.avatarId,
      onLevel: deps.onSpeechLevel,
      onSpokenChars: setSpokenChars,
    });
    speakerRef.current = sp;
    return sp;
  }

  /** 拿（或建）会话。ROM 没变就复用——resolve+create 是两个往返，别每次都走。 */
  async function ensureSession(ep: StrategistEndpoint): Promise<string> {
    if (sessionRef.current) return sessionRef.current;
    let packId: string | null = null;
    try {
      const r = await resolvePack(ep, deps.romFileName);
      // 未命中就用最高分候选；一个都没有则 null = 通用兜底模式（文档 §7.1）。
      packId = r.matched ? r.pack_id ?? null : r.candidates?.[0]?.pack_id ?? null;
    } catch {
      /* resolve 挂了也要能问——走无 pack 的 Web 兜底 */
    }
    const sid = await createSession(ep, {
      deviceId: 'handheld',
      packId,
      romFilename: deps.romFileName,
    });
    sessionRef.current = sid;
    return sid;
  }

  /**
   * 把玩家的存档同步给服务端——军师靠它知道「他现在打到哪」。
   *
   * ★每次开口问之前都调一次，但**只在存档真变了时才搬那 128KB**：
   * 原生按 mtime 判断，没变就只回一句 unchanged。玩家一次会话能玩几个小时，
   * 只在建会话时传一次的话，越玩越不准。
   *
   * ★必须 await 完再发问：这一轮要用的就是这份进度，边传边问的话第一句
   * 会按上一次的进度回答（而「上一次」很可能正是他刚打完的那个节点之前）。
   *
   * 整条链路全程静默降级：读不到存档、桥没接上、服务端说这个包没有解读表——
   * 一律当作「没有进度」，问答照常，绝不因为它让玩家问不了问题。
   */
  async function syncSaveState(ep: StrategistEndpoint, sessionId: string): Promise<void> {
    if (!deps.romPath) return;
    try {
      const r = await readSaveViaBridge(deps.romPath, savedMtimeRef.current);
      if (!r.found) {
        return;
      }
      if (r.unchanged || !r.base64) return;
      await uploadSaveState(ep, sessionId, { saveBase64: r.base64, savedAtMs: r.mtimeMs });
      savedMtimeRef.current = r.mtimeMs ?? 0;
    } catch {
      /* 进度是锦上添花，不能挡住提问 */
    }
  }

  function checkedEndpoint(): StrategistEndpoint | null {
    const ep = deps.endpoint();
    if (!ep.baseUrl || !ep.deviceToken) {
      dispatch({ type: 'error', message: '先在设置里填军师服务器和 token' });
      return null;
    }
    return ep;
  }

  /** 起一轮对话流：SSE 事件同时喂状态机（显示）与播报器（念）。 */
  function startChat(ep: StrategistEndpoint, sid: string, message: string, shot?: string) {
    const sp = newSpeaker();
    const h = chatStream(
      ep,
      {
        sessionId: sid,
        message,
        // 带图就走一键卡关流程（服务端据此调 VLM 并要求首句确认场景）。
        quickAction: shot ? 'stuck' : undefined,
        screenshotBase64: shot,
        // 底条这只角色的人设——她用自己的声音说话，说的话也该像她（见 strategistCharacter.ts）
        character: characterPrompt(deps.avatarId),
      },
      {
        onMeta: () => {},
        onDelta: (t) => {
          dispatch({ type: 'delta', text: t });
          sp.push(t); // 攒够一句就去合成，把 TTS 往返藏在下一句里
        },
        onAction: (emo) => deps.onEmotion?.(emo),
        onSources: () => {},
        onDone: () => {
          dispatch({ type: 'done' });
          sp.flush(); // 最后半句（模型常不给结尾标点）
          // ★这一轮答完了才去刷热词：它是「**下一句**会说什么」的先验，
          // 服务端按刚聊过的内容选词（他刚在佩雷市看到鬼斯通，下一句多半还问它们）。
          // 放在这里而不是按住说话时取——那条路径上每多一个往返，他就多等一下。
          void hotwords(ep, sid)
            .then((w) => {
              hotwordsRef.current = w;
            })
            .catch(() => {});
        },
        onError: (code, msg) => {
          sp.stop();
          dispatch({ type: 'error', message: describeError(code, msg) });
        },
      },
    );
    abortRef.current = h.abort;
  }

  /** 按住角色：先截屏再开录。 */
  async function beginVoice() {
    // ★截屏必须在**按下那一刻**做：等他说完再截，画面早变了（战斗过了一回合、
    // 菜单翻了一页）——军师会对着一个不存在的处境出主意。
    try {
      shotRef.current = await captureViaBridge(deps.stripHeightPx);
    } catch {
      shotRef.current = ''; // 截不到也让他说完，退化成纯文字提问
    }
    // ★同步存档也放在按下这一刻起跑，与录音并行：玩家要说两三秒话，
    // 这段时间正好把「读文件 + 上传 128KB」的延迟整个藏掉。松手时再 await
    // （见 endVoice）——它必须在发问之前完成，否则这一句按的是上一次的进度。
    saveSyncRef.current = (async () => {
      const ep = deps.endpoint();
      if (!ep.baseUrl || !ep.deviceToken) return;
      await syncSaveState(ep, await ensureSession(ep));
    })().catch(() => {});
    const rec = createRecorder();
    recorderRef.current = rec;
    try {
      await rec.start();
    } catch {
      recorderRef.current = null;
      dispatch({ type: 'error', message: '录不了音——先在设置里给麦克风权限' });
    }
  }

  /** 松开：停录 → ASR 回显 → 带着按下那刻的截图发问。 */
  async function endVoice() {
    const rec = recorderRef.current;
    recorderRef.current = null;
    if (!rec) return;
    const ep = checkedEndpoint();
    try {
      const { pcmBase64, sampleRate } = await rec.stop();
      if (!ep) return;
      if (!pcmBase64) {
        dispatch({ type: 'error', message: '没听到声音，再说一次' });
        return;
      }
      // ASR 走 Aiboo 后台（凭证在那边、且公网可达）
      const text = await asr(deps.aibooEndpoint(), {
        pcmBase64,
        sampleRate,
        // 上一轮答完时后台取好的（见 startChat 的 onDone）。第一轮为空，
        // 那轮只有通用词——没有更早的上下文可依据，本来也选不出更好的。
        hotwords: hotwordsRef.current,
      });
      dispatch({ type: 'transcribed', text });
      // 垫一句「我看看啊…」把接下来 5 秒的空档填上（不 await：它跟检索并行跑）。
      const filler = pickFiller(deps.avatarId);
      if (filler) void playClip(filler.audioBase64, filler.mime);
      // 按下时起跑的存档同步收口（多半早就完了）。它失败也不该挡住提问，
      // 所以 syncSaveState 内部已经吞掉异常，这里只是等它落地。
      await saveSyncRef.current;
      startChat(ep, await ensureSession(ep), text, shotRef.current || undefined);
    } catch (e) {
      dispatch({ type: 'error', message: describeError(errCodeOf(e)) });
    }
  }

  // 触摸桥：原生 StrategistTapWindow → window.__strategistTap。
  useEffect(() => {
    (window as unknown as { __strategistTap?: (kind: string) => void }).__strategistTap = (kind) => {
      if (kind === 'holdStart') {
        if (isBusy(stateRef.current)) return; // 忙时按住不抢占正在跑的那一轮
        dispatch({ type: 'holdStart' });
        void beginVoice();
        return;
      }
      if (kind === 'holdEnd') {
        if (stateRef.current.kind !== 'listening') return; // 没在录音就什么都不做
        dispatch({ type: 'holdEnd' });
        void endVoice();
        return;
      }
      if (kind !== 'tap') return;
      // ★点一下不再发问：提问必须由用户开口（按住说话）。它只做两件事——
      // 打断正在跑的那一轮（掌机上没有别的地方能点「停」）、把上一条答案收走回待命。
      // 不发请求也就不花钱，误触零成本。
      abortRef.current?.();
      abortRef.current = null;
      speakerRef.current?.stop();
      dispatch({ type: 'ask' });
    };
  }, []);

  // ★答案不再定时收走：问题可能复杂，用户要能回头慢慢看（面板此时可滚动）。
  // 收走的时机只有两个——点一下角色，或问下一个问题。

  return { state, dispatch, spokenChars };
}

function errCodeOf(e: unknown): string {
  return String((e as { message?: string })?.message ?? e);
}

/** 错误码 → 一句**指向下一步动作**的中文。掌机上没地方看日志，文案就是唯一诊断。 */
export function describeError(code: string, msg?: string): string {
  switch (code) {
    case 'SERVICE_DISABLED':
      return '截屏要先开无障碍（设置→无障碍→Aiboo 按键）';
    case 'INTERVAL_TOO_SHORT':
      return '截太快了，等一秒再点';
    case 'CAPTURE_TIMEOUT':
      return '截屏没回来，再试一次';
    case 'CAPTURE_FAILED':
      return '截屏失败了，再试一次';
    case 'NO_NATIVE':
      return '这个功能只在掌机底条里有';
    case 'HTTP_401':
      return 'token 不对，去设置里核一下';
    case 'NETWORK':
      return '连不上军师服务器（adb reverse 起了吗）';
    case 'STREAM_TRUNCATED':
      return '回答断了，再问一次';
    default:
      return msg || '出了点问题，再试一次';
  }
}
