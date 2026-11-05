import { getBaseUrl, getStoredToken, getDeviceId } from './apiClient.ts';
import {
  API_AI_TTS,
  DEFAULT_QWEN_TTS_MODEL,
  DEFAULT_QWEN_TTS_VOICE,
  DEFAULT_QWEN_TTS_INSTRUCTIONS,
} from './apiConfig.ts';
import { analyzeAudioLevel, createTalkingMouth } from '../features/live2d/mouthSync.ts';
import { emotionToQwenInstruction, type Emotion } from './emotion.ts';
import { acquireVoice, releaseVoice, type VoiceToken } from './voiceChannel.ts';

export type TtsProvider = 'off' | 'browser' | 'gateway' | 'qwen' | 'api' | 'capacitor';

export type TtsState = 'idle' | 'synthesizing' | 'playing';

export type TtsSettings = {
  provider: TtsProvider;
  browserVoice: string;
  apiUrl: string;
  apiKey: string;
  apiModel: string;
  apiVoice: string;
  apiInstructions: string;
};

let CapacitorTts: typeof import('@capacitor-community/text-to-speech').TextToSpeech | null = null;
async function getCapacitorTts() {
  if (!CapacitorTts) {
    const mod = await import('@capacitor-community/text-to-speech');
    CapacitorTts = mod.TextToSpeech;
  }
  return CapacitorTts;
}

type SpeakArgs = {
  text: string;
  settings: TtsSettings;
  onMouthChange: (value: number) => void;
  onBlob?: (blob: Blob) => void;
  avatarId?: string;
  /** 本句的语音情绪，驱动 TTS 语气；缺省按 neutral 处理。 */
  emotion?: Emotion;
};

// LLM 回复里常带 (动作/神态) 旁白，如「（微笑）你好呀」。这些只该显示在气泡里，
// 不该被 TTS 念出来。这里把括弧旁白剥掉，只保留要朗读的台词。
// 全角（）必剥；半角()也剥（保险，LLM 偶尔混用）。提取出的旁白文本一并返回，
// 供后续（如情绪推断）使用。
export function extractStageDirections(text: string): { spoken: string; directions: string[] } {
  const directions: string[] = [];
  const spoken = text
    .replace(/（([^（）]*)）/g, (_match, inner: string) => {
      const trimmed = inner.trim();
      if (trimmed) directions.push(trimmed);
      return '';
    })
    .replace(/\(([^()]*)\)/g, (_match, inner: string) => {
      const trimmed = inner.trim();
      if (trimmed) directions.push(trimmed);
      return '';
    })
    // 剥离后可能残留多余空白/连续标点，做一次轻量收敛。
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { spoken, directions };
}

export type PreparedSpeech = {
  start: () => Promise<void>;
  cancel: () => void;
  audioUrl?: string;
  durationMs?: number;
  mimeType?: string;
};

type SpeechSynthesisWithOptionalPending = SpeechSynthesis & {
  pending?: boolean;
};

const ttsSettingsStorageKey = 'llm-live2d:tts-settings';


let activeSpeech: SpeechSynthesisUtterance | null = null;
let activeAudio: HTMLAudioElement | null = null;
let activeObjectUrl: string | null = null;
let activeAnimationFrame = 0;
let activeAudioContext: AudioContext | null = null;
let activeAbortController: AbortController | null = null;
let activeOnMouthChange: ((value: number) => void) | null = null;
// 当前播放被「自然结束」以外的方式中断时（stopSpeaking / 被新播放抢占）要触发的清理钩子，
// 例如让 UI 把「正在播放」的语音气泡复位。自然结束在 onended 里单独处理，不经此钩子，避免重复。
let activeOnEnded: (() => void) | null = null;

// ---- Global TTS state ----
let globalTtsState: TtsState = 'idle';
const stateListeners = new Set<(state: TtsState) => void>();

function emitState(state: TtsState) {
  globalTtsState = state;
  stateListeners.forEach((fn) => fn(state));
}

export function getTtsState(): TtsState {
  return globalTtsState;
}

export function subscribeTtsState(fn: (state: TtsState) => void): () => void {
  stateListeners.add(fn);
  return () => stateListeners.delete(fn);
}

export function getDefaultTtsSettings(): TtsSettings {
  return {
    provider: 'gateway',
    browserVoice: '',
    apiUrl: '',
    apiKey: '',
    apiModel: DEFAULT_QWEN_TTS_MODEL,
    apiVoice: DEFAULT_QWEN_TTS_VOICE,
    apiInstructions: DEFAULT_QWEN_TTS_INSTRUCTIONS,
  };
}

export function loadStoredTtsSettings(): TtsSettings {
  const fallback = getDefaultTtsSettings();

  if (typeof window === 'undefined') {
    return fallback;
  }

  try {
    const raw = window.localStorage.getItem(ttsSettingsStorageKey);
    if (!raw) {
      return fallback;
    }

    const parsed = JSON.parse(raw) as Partial<TtsSettings>;
    const isLegacyBrowserDefault = parsed.provider === 'browser'
      && !parsed.browserVoice
      && !parsed.apiModel
      && !parsed.apiVoice;

    if (isLegacyBrowserDefault) {
      return fallback;
    }

    return {
      provider: parsed.provider === 'off'
        || parsed.provider === 'browser'
        || parsed.provider === 'gateway' || parsed.provider === 'qwen' || parsed.provider === 'api'
        || parsed.provider === 'capacitor'
        ? parsed.provider
        : fallback.provider,
      browserVoice: parsed.browserVoice ?? fallback.browserVoice,
      apiUrl: parsed.apiUrl?.trim() ?? fallback.apiUrl,
      apiKey: parsed.apiKey?.trim() ?? fallback.apiKey,
      apiModel: parsed.apiModel?.trim() ?? fallback.apiModel,
      apiVoice: parsed.apiVoice?.trim() ?? fallback.apiVoice,
      apiInstructions: parsed.apiInstructions?.trim() ?? fallback.apiInstructions,
    };
  } catch {
    return fallback;
  }
}

export function saveStoredTtsSettings(settings: TtsSettings) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(ttsSettingsStorageKey, JSON.stringify(settings));
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function stopSpeaking() {
  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
  }

  if (activeAnimationFrame) {
    cancelAnimationFrame(activeAnimationFrame);
    activeAnimationFrame = 0;
  }

  if (activeSpeech && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
    activeSpeech = null;
  }

  if (activeAudio) {
    activeAudio.pause();
    activeAudio.src = '';
    activeAudio = null;
  }

  if (activeObjectUrl) {
    URL.revokeObjectURL(activeObjectUrl);
    activeObjectUrl = null;
  }

  if (activeAudioContext) {
    void activeAudioContext.close();
    activeAudioContext = null;
  }

  if (activeOnMouthChange) {
    activeOnMouthChange(0);
    console.info('[lipsync] end reason=interrupted finalMouth=0');
    activeOnMouthChange = null;
  }

  if (activeOnEnded) {
    const onEnded = activeOnEnded;
    activeOnEnded = null;
    onEnded();
  }

  releaseVoice('tts');
  emitState('idle');
}

function startSyntheticMouthLoop(onMouthChange: (value: number) => void) {
  const start = performance.now();

  function tick(now: number) {
    const elapsed = now - start;
    const syllable = Math.abs(Math.sin(elapsed / 82));
    const secondary = Math.abs(Math.sin(elapsed / 137 + 0.8));
    const value = Math.min(0.85, 0.08 + syllable * 0.45 + secondary * 0.18);
    onMouthChange(value);
    activeAnimationFrame = requestAnimationFrame(tick);
  }

  activeAnimationFrame = requestAnimationFrame(tick);
}

// token（可选）：调用方把自己 acquireVoice 时拿到的 token 带进来，release 才会精确匹配
// 「这确实是我这次抢到的会话」，不会被同名但更晚的新会话误伤（review #2：旧会话迟到的
// 终止回调——比如 speechSynthesis.cancel() 后仍会落地的 onend/onerror，或 <audio>.src=''
// 触发的 onerror——如果只按 'tts' 这个名字 release，会清掉后来居上的新会话）。
function stopMouthLoop(onMouthChange: (value: number) => void, token?: VoiceToken) {
  if (activeAnimationFrame) {
    cancelAnimationFrame(activeAnimationFrame);
    activeAnimationFrame = 0;
  }

  onMouthChange(0);
  activeOnMouthChange = null;
  releaseVoice('tts', token);
}

type PlayAudioElementOptions = {
  avatarId?: string;
  /** [lipsync] 日志里的来源类型标签（blob=自动播报/重播，bubble=语音气泡点击）。 */
  logType?: string;
  /** 由本播放创建、需在停止时 revoke 的 object URL；外部 URL（气泡）传 null 不接管。 */
  objectUrl?: string | null;
  /** 自然播放结束时的额外回调（中断时由 stopSpeaking 经 activeOnEnded 触发）。 */
  onEnded?: () => void;
  /** 不广播全局 ttsState（语音气泡点击用）：只驱动口型，不让 composer 进入「停止朗读」态。 */
  suppressState?: boolean;
};

// 口型同步播放核心：把一个 <audio> 接到 Web Audio AnalyserNode 上，逐帧取 RMS 驱动 onMouthChange。
// 自动播报(blob)、气泡重播(blob)、语音气泡点击(url) 全部复用这一条已验证的路径，
// 保证三者口型行为一致；差异只在入参（来源、是否接管 objectUrl、结束回调、是否广播 ttsState）。
function playAudioElement(
  audio: HTMLAudioElement,
  onMouthChange: (value: number) => void,
  options: PlayAudioElementOptions = {},
): Promise<void> {
  // 气泡点击不改全局 ttsState（与自动播报解耦）：composer 不进入「停止朗读」，仅驱动口型。
  const emit = (state: TtsState) => {
    if (!options.suppressState) emitState(state);
  };
  return new Promise((resolve, reject) => {
    // 抢占扬声器。★必须在下面几行赋值之前——acquireVoice 会调旧占用者的 stop
    // （若旧的也是 tts 就是 stopSpeaking），那会清掉 activeAudio 等状态；
    // 放在赋值之后会把刚设好的新状态一起清掉。
    // voiceToken 是这次播放的身份凭证：下面每个 stopMouthLoop 调用点都要带上它
    // （review #2），否则被顶替的旧会话迟到的 onerror 会按名字误清后来的新会话。
    const voiceToken = acquireVoice('tts', stopSpeaking);
    activeOnMouthChange = onMouthChange;
    activeObjectUrl = options.objectUrl ?? null;
    activeAudio = audio;
    activeAudioContext = new AudioContext();
    activeOnEnded = options.onEnded ?? null;

    const analyser = activeAudioContext.createAnalyser();
    analyser.fftSize = 512;
    const source = activeAudioContext.createMediaElementSource(audio);
    source.connect(analyser);
    analyser.connect(activeAudioContext.destination);

    const samples = new Uint8Array(analyser.frequencyBinCount);
    // 与通话共用的「说话口型」引擎：音节摆动 × 真实声波 gate。此前聊天用纯音量直驱，
    // 长音/平稳段会把嘴停住显得呆；换成同一引擎让聊天口型与通话一样自然（gateNorm 因
    // 聊天音频未经 AGC、动态更真实而略低，更易满幅）。
    const mouth = createTalkingMouth({ gateNorm: 0.45 });

    function tick() {
      analyser.getByteFrequencyData(samples);
      const rawLevel = analyzeAudioLevel(samples, { bandStart: 1, bandEnd: 22, threshold: 0.05, divisor: 260 });
      onMouthChange(mouth(rawLevel));
      activeAnimationFrame = requestAnimationFrame(tick);
    }

    audio.onplay = () => {
      emit('playing');
      activeAnimationFrame = requestAnimationFrame(tick);
      console.info(`[lipsync] start type=${options.logType ?? 'blob'} avatar=${options.avatarId ?? ''}`);
    };
    audio.onended = () => {
      stopMouthLoop(onMouthChange, voiceToken);
      console.info('[lipsync] end reason=onended finalMouth=0');
      emit('idle');
      // 自然结束：直接触发并清空结束回调，不经 stopSpeaking 的 interrupted 路径，避免重复。
      const onEnded = activeOnEnded;
      activeOnEnded = null;
      onEnded?.();
      resolve();
    };
    audio.onerror = () => {
      stopMouthLoop(onMouthChange, voiceToken);
      console.info('[lipsync] end reason=onerror finalMouth=0');
      emit('idle');
      activeOnEnded = null;
      reject(new Error('Audio playback error'));
    };

    void activeAudioContext.resume().then(() => {
      void audio.play().catch((e) => {
        stopMouthLoop(onMouthChange, voiceToken);
        console.info('[lipsync] end reason=onerror finalMouth=0');
        emit('idle');
        activeOnEnded = null;
        reject(e);
      });
    }).catch((e) => {
      stopMouthLoop(onMouthChange, voiceToken);
      console.info('[lipsync] end reason=onerror finalMouth=0');
      emit('idle');
      activeOnEnded = null;
      reject(e);
    });
  });
}

// 自动播报 / 气泡重播：拿到的是合成出来的 Blob，本函数负责创建并接管 object URL（停止时 revoke）。
function playAudioBlob(audioBlob: Blob, onMouthChange: (value: number) => void, avatarId?: string): Promise<void> {
  const objectUrl = URL.createObjectURL(audioBlob);
  return playAudioElement(new Audio(objectUrl), onMouthChange, { avatarId, logType: 'blob', objectUrl });
}

// 语音气泡点击播放：拿到的是消息持有的 blob URL（所有权归消息，停止时不 revoke）。
// 复用同一口型核心（驱动口型），但 suppressState 不广播全局 ttsState——气泡播放不让
// composer 变「停止朗读」，与自动播报解耦。onEnded 用于让 UI 复位「正在播放」状态。
export function playAudioUrl(
  url: string,
  onMouthChange: (value: number) => void,
  options: { avatarId?: string; onEnded?: () => void } = {},
): Promise<void> {
  return playAudioElement(new Audio(url), onMouthChange, {
    avatarId: options.avatarId,
    logType: 'bubble',
    onEnded: options.onEnded,
    suppressState: true,
  });
}

function speakWithBrowser({ text, settings, onMouthChange, avatarId }: SpeakArgs) {
  if (!('speechSynthesis' in window)) {
    throw new Error('Browser speech synthesis is not supported in this environment.');
  }
  activeOnMouthChange = onMouthChange;

  const speechSynthesis = window.speechSynthesis as SpeechSynthesisWithOptionalPending;
  const utterance = new SpeechSynthesisUtterance(text);
  const voices = speechSynthesis.getVoices();
  const selectedVoice = voices.find((voice) => voice.name === settings.browserVoice);

  if (selectedVoice) {
    utterance.voice = selectedVoice;
    utterance.lang = selectedVoice.lang;
  } else {
    utterance.lang = navigator.language || 'zh-CN';
  }

  utterance.rate = 1;
  utterance.pitch = 1;
  utterance.volume = 1;
  utterance.onstart = () => {
    startSyntheticMouthLoop(onMouthChange);
    emitState('playing');
    console.info(`[lipsync] start type=browser avatar=${avatarId ?? ''}`);
  };
  utterance.onend = () => {
    stopMouthLoop(onMouthChange, voiceToken);
    console.info('[lipsync] end reason=onended finalMouth=0');
    emitState('idle');
  };
  utterance.onerror = () => {
    stopMouthLoop(onMouthChange, voiceToken);
    console.info('[lipsync] end reason=onerror finalMouth=0');
    emitState('idle');
  };

  stopSpeaking();
  // 抢占扬声器。★不能放在函数开头（activeOnMouthChange 赋值之前）——那样的话，
  // 下面这行既有的 stopSpeaking() 会紧接着把刚抢到的 voiceChannel 交还出去
  // （stopSpeaking 尾部固定 releaseVoice('tts')），真正开口说话时反而没占着。
  // 必须放在这行 stopSpeaking() 之后：它已经把「同类型旧会话」清干净，此处
  // acquireVoice 顶掉的只可能是别的 owner（比如 singing），不会自己冲自己。
  // voiceToken 是这次朗读的身份凭证，供上面 onend/onerror release 时做身份校验
  // （review #2：speechSynthesis.cancel() 打断旧会话后，旧 utterance 仍可能落地
  // onend/onerror，没有 token 会按名字误清后来的新会话）。声明在这里而不是函数顶部：
  // onend/onerror 闭包只在事件真正触发（必然晚于这行执行）时才会读 voiceToken，
  // 同一层块作用域内 const 声明在后、闭包定义在前，不影响闭包运行时正确捕获到它。
  const voiceToken = acquireVoice('tts', stopSpeaking);
  activeSpeech = utterance;
  speechSynthesis.speak(utterance);
}

function createNoopPreparedSpeech(onMouthChange: (value: number) => void): PreparedSpeech {
  return {
    start: () => {
      onMouthChange(0);
      emitState('idle');
      return Promise.resolve();
    },
    cancel: () => {
      stopSpeaking();
    },
  };
}

function estimateSpeechDurationMs(text: string) {
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latinWords = (text.match(/[a-zA-Z0-9]+/g) ?? []).length;
  const units = chineseChars + latinWords * 2;
  return Math.min(12000, Math.max(1200, units * 260));
}

function prepareBrowserSpeech(args: SpeakArgs): PreparedSpeech {
  return {
    start: () => {
      speakWithBrowser(args);
      return Promise.resolve();
    },
    cancel: () => {
      stopSpeaking();
    },
  };
}

async function prepareGatewaySpeech({ text, settings, onMouthChange, onBlob, avatarId, emotion }: SpeakArgs): Promise<PreparedSpeech> {
  if (!settings.apiModel || !settings.apiVoice) {
    throw new Error('Gateway TTS settings are incomplete.');
  }

  // 情绪两条落点（服务端按实际 provider 取用其一）：
  //  - Qwen：把情绪语气描述拼进 instructions（角色基线在前，情绪在后）。
  //  - SeedTTS(火山)：把 canonical emotion 原样带给后端，由 volcengine.cjs 映射。
  const emotionPhrase = emotion ? emotionToQwenInstruction(emotion) : '';
  const instructions = [settings.apiInstructions, emotionPhrase].filter(Boolean).join('，');
  const hasEmotion = !!emotion && emotion !== 'neutral';

  stopSpeaking();
  emitState('synthesizing');
  const abortController = new AbortController();
  activeAbortController = abortController;

  try {
    const baseUrl = getBaseUrl();
    const url = `${baseUrl}${API_AI_TTS}`;
    const token = getStoredToken();
    const startedAt = performance.now();
    console.log('[TTS] gateway request', {
      url,
      voice: settings.apiVoice,
      textLength: text.length,
    });
    const response = await fetch(url, {
      method: 'POST',
      signal: abortController.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': getDeviceId(),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        text,
        model: settings.apiModel,
        voice: settings.apiVoice,
        // 带上 avatarId，服务端以后台为该角色配置的音色为权威来源
        ...(avatarId ? { avatarId } : {}),
        ...(instructions ? { instructions } : {}),
        ...(hasEmotion ? { emotion } : {}),
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `Gateway TTS failed with ${response.status}`);
    }

    const audioBlob = await response.blob();
    onBlob?.(audioBlob);
    const bubbleAudioUrl = URL.createObjectURL(audioBlob);
    console.log('[TTS] gateway audio ready', {
      elapsedMs: Math.round(performance.now() - startedAt),
      bytes: audioBlob.size,
      contentType: audioBlob.type,
    });
    if (activeAbortController === abortController) {
      activeAbortController = null;
    }
    emitState('idle');

    let cancelled = false;
    return {
      start: async () => {
        if (cancelled) return;
        await playAudioBlob(audioBlob, onMouthChange, avatarId);
      },
      cancel: () => {
        cancelled = true;
        stopSpeaking();
      },
      audioUrl: bubbleAudioUrl,
      durationMs: estimateSpeechDurationMs(text),
      mimeType: audioBlob.type || 'audio/mpeg',
    };
  } catch (error) {
    if (isAbortError(error)) {
      emitState('idle');
      return createNoopPreparedSpeech(onMouthChange);
    }
    emitState('idle');
    throw error;
  } finally {
    if (activeAbortController === abortController) {
      activeAbortController = null;
    }
  }
}

function prepareCapacitorSpeech(args: SpeakArgs): PreparedSpeech {
  return {
    start: async () => {
      activeOnMouthChange = args.onMouthChange;
      // review #1：capacitor 失败后若成功交接给 browser 兜底，speakWithBrowser 内部会
      // 自己 acquireVoice 抢到扬声器、自己接管口型收尾——下面的 finally 不能再对它刚抢到
      // 的会话喊停（那样会在真正开口说话前就把它释放掉）。这个标记就是给 finally 用来
      // 识别「已经交接出去了，这里不用再收尾」的信号。
      let handedOffToBrowserFallback = false;
      let voiceToken: VoiceToken | undefined;
      try {
        stopSpeaking();
        // 抢占扬声器，理由同 speakWithBrowser：必须放在上面 stopSpeaking() 之后，
        // 否则会被它尾部的 releaseVoice('tts') 立刻自己冲掉。
        voiceToken = acquireVoice('tts', stopSpeaking);
        emitState('playing');
        const tts = await getCapacitorTts();
        startSyntheticMouthLoop(args.onMouthChange);
        console.info(`[lipsync] start type=capacitor avatar=${args.avatarId ?? ''}`);
        await tts.speak({
          text: args.text,
          lang: 'zh-CN',
          rate: 1.1,
          pitch: 1.0,
        });
      } catch (e) {
        console.error('[TTS] Capacitor error:', e);
        // Fallback: try browser speech
        try {
          speakWithBrowser(args);
          handedOffToBrowserFallback = true;
          return;
        } catch { /* ignore */ }
        emitState('idle');
        throw e;
      } finally {
        // review #1：交接成功就跳过——browser 兜底已经自己接管了扬声器和口型收尾，
        // 这里再 stopMouthLoop 会把它刚抢到的会话立刻释放掉（真正开口说话前又变空闲）。
        if (!handedOffToBrowserFallback) {
          stopMouthLoop(args.onMouthChange, voiceToken);
          console.info('[lipsync] end reason=onended finalMouth=0');
          emitState('idle');
        }
      }
    },
    cancel: () => {
      stopSpeaking();
    },
  };
}

export async function prepareSpeech(args: SpeakArgs): Promise<PreparedSpeech> {
  // 朗读前先剥掉 (动作/神态) 旁白，气泡显示用的原文不受影响（在 useChat 里单独保留）。
  args = { ...args, text: extractStageDirections(args.text).spoken };
  console.log('[TTS] provider:', args.settings.provider, 'text length:', args.text.length);
  if (!args.text.trim() || args.settings.provider === 'off') {
    stopSpeaking();
    return createNoopPreparedSpeech(args.onMouthChange);
  }

  try {
    if (args.settings.provider === 'capacitor') {
      return prepareCapacitorSpeech(args);
    }

    if (args.settings.provider === 'gateway') {
      return await prepareGatewaySpeech(args);
    }

    return prepareBrowserSpeech(args);
  } catch (error) {
    // Fallback: remote TTS failed → try browser native TTS
    if (args.settings.provider !== 'gateway'
      && args.settings.provider !== 'browser'
      && args.settings.provider !== 'capacitor') {
      console.warn('[TTS] Remote TTS failed, falling back to browser:', error);
      try {
        return prepareBrowserSpeech(args);
      } catch {
        // fallback also failed, throw original error
      }
    }
    throw error;
  }
}

export async function speakText(args: SpeakArgs) {
  const preparedSpeech = await prepareSpeech(args);
  await preparedSpeech.start();
}
