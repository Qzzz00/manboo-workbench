import type {
  DiscoveredLive2DParameter,
  MouthSyncTarget,
  MouthSyncState,
  MouthSyncSource,
} from './types.ts';

export type { MouthSyncTarget, MouthSyncState, MouthSyncSource };

export type MouthSyncOptions = {
  /** 静音阈值 (0-1)，低于此值视为静音 */
  threshold?: number;
  /** 上升速度因子 (0-1) */
  riseFactor?: number;
  /** 下降速度因子 (0-1) */
  fallFactor?: number;
};

export type AnalyzeOptions = {
  /** 频率 bin 起始索引（含） */
  bandStart?: number;
  /** 频率 bin 结束索引（不含） */
  bandEnd?: number;
  /** 归一化除数，用于把 0-255 均值映射到 0-1 */
  divisor?: number;
  /** 静音阈值 (0-1)，低于此值输出 0 */
  threshold?: number;
};

/**
 * 从已发现参数中选择最合适的嘴部参数。
 * 优先级：ParamMouthOpenY > 含 MouthOpen > 含 Mouth
 */
export function selectMouthParameter(
  parameters: DiscoveredLive2DParameter[],
): DiscoveredLive2DParameter | undefined {
  if (!parameters || parameters.length === 0) {
    return undefined;
  }

  const exact = parameters.find((p) => p.id === 'ParamMouthOpenY');
  if (exact) return exact;

  const mouthOpen = parameters.find((p) => /MouthOpen/i.test(p.id));
  if (mouthOpen) return mouthOpen;

  const mouth = parameters.find((p) => /Mouth/i.test(p.id));
  if (mouth) return mouth;

  return undefined;
}

/**
 * 把原始音频 level (0-1) 映射到目标参数的取值范围，并做 clamp。
 */
export function computeMouthValue(
  rawLevel: number,
  target: MouthSyncTarget,
): number {
  const level = Math.min(1, Math.max(0, rawLevel));
  const mapped = target.min + level * (target.max - target.min);
  return Math.min(target.max, Math.max(target.min, mapped));
}

/**
 * 对音频频率采样数据做分析，返回归一化 0-1 的音量等级。
 */
export function analyzeAudioLevel(
  samples: Uint8Array,
  options?: AnalyzeOptions,
): number {
  const bandStart = options?.bandStart ?? 1;
  const bandEnd = options?.bandEnd ?? 23;
  const divisor = options?.divisor ?? 160;
  const threshold = options?.threshold ?? 0.06;

  const start = Math.max(0, Math.min(bandStart, samples.length));
  const end = Math.max(start, Math.min(bandEnd, samples.length));
  if (end <= start) return 0;

  let sum = 0;
  for (let i = start; i < end; i++) {
    sum += samples[i];
  }
  const average = sum / (end - start);
  const normalized = average / divisor;

  if (normalized < threshold) return 0;
  return Math.min(1, normalized);
}

/**
 * 平滑 mouth level：上升快、下降慢。
 * 调用方可传入 immediate=true 在音频停止时立即归零。
 */
export function smoothMouthLevel(
  current: number,
  target: number,
  options?: MouthSyncOptions,
  immediate = false,
): number {
  if (immediate) return target;

  const factor = target > current
    ? (options?.riseFactor ?? 0.45)
    : (options?.fallFactor ?? 0.12);

  return current + (target - current) * factor;
}

export type TalkingMouthOptions = {
  /** 声波包络归一到 gate 的除数：越小越易满幅。默认 0.55（RTC AGC 音频）。 */
  gateNorm?: number;
};

/**
 * 「说话口型」引擎（通话 + 聊天共用）。
 *
 * 纯音量直驱在长音/平稳段会把嘴停在某个开度，显得呆；改为
 * 「程序化音节摆动(~1.7Hz) × 真实声波包络(gate)」：摆动提供持续的说话张合感，
 * 真实幅度做 gate——声音小 / 句中停顿把嘴收到 0。
 *
 * 用法：每帧把 analyzeAudioLevel 得到的 raw(0-1) 传进 step(raw)，返回该帧口型值。
 * 通话音频经 AGC 压平、raw 顶端起伏少（靠摆动补动态）；聊天音频干净、raw 起伏真实
 * （gate 更有表现力）——同一引擎两处都自然。
 */
export function createTalkingMouth(options?: TalkingMouthOptions) {
  const gateNorm = options?.gateNorm ?? 0.55;
  let ampEnv = 0;
  let smoothed = 0;
  const t0 = performance.now();

  return function step(raw: number, nowMs: number = performance.now()): number {
    // 真实声波包络：快升较快落——声音一小或中间停顿就往下掉。
    ampEnv = smoothMouthLevel(ampEnv, raw, { riseFactor: 0.7, fallFactor: 0.35 }, raw === 0);
    const gate = Math.min(1, ampEnv / gateNorm);
    let target = 0;
    if (gate > 0.02) {
      const el = nowMs - t0;
      const syllable = Math.abs(Math.sin(el / 185));       // 主音节节奏 ~1.7Hz
      const secondary = Math.abs(Math.sin(el / 290 + 0.8)); // 次级慢起伏，避免机械
      const osc = 0.16 + syllable * 0.5 + secondary * 0.22;
      target = Math.min(0.9, osc * gate);
    }
    smoothed = smoothMouthLevel(smoothed, target, { riseFactor: 0.5, fallFactor: 0.45 }, gate <= 0.02);
    return smoothed;
  };
}



/**
 * 从解码后的 PCM 逐帧算口型电平（**离线**版）。
 *
 * ★为什么需要它：展示台的口播改由原生播放器出声了（WebView 的 <audio> 在那台 ROM 上
 * 根本走不动，见 djClient 里的说明）。音频不再经过 WebView 的 AudioContext，
 * `analyzeAudioLevel` 那条「逐帧取 AnalyserNode 频谱」的路就没有输入了。
 *
 * 所以改成：把同一段 mp3 取回来解码，**离线**先把整条包络算好，
 * 播放时按时间轴喂给 setMouth。嘴形的平滑仍然用 smoothMouthLevel，一行没改；
 * 归一化也照搬 analyzeAudioLevel 的形状（均值 → 除以 divisor → 低于 threshold 归零 → 截到 1），
 * 唯一的差别是取样源从「低频段的频谱均值」变成「该帧的 RMS 振幅」——
 * 音频不在音频图里，拿不到频谱，这一步是没法避免的替代。
 */
export function envelopeFromPcm(
  pcm: Float32Array,
  sampleRate: number,
  frameMs = 25,
  options?: { divisor?: number, threshold?: number },
): Float32Array {
  const divisor = options?.divisor ?? 0.22;
  const threshold = options?.threshold ?? 0.06;
  const frameLen = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const frames = Math.max(1, Math.ceil(pcm.length / frameLen));
  const out = new Float32Array(frames);

  for (let f = 0; f < frames; f++) {
    const start = f * frameLen;
    const end = Math.min(pcm.length, start + frameLen);
    let sum = 0;
    for (let i = start; i < end; i++) sum += pcm[i] * pcm[i];
    const rms = end > start ? Math.sqrt(sum / (end - start)) : 0;
    const normalized = rms / divisor;
    out[f] = normalized < threshold ? 0 : Math.min(1, normalized);
  }
  return out;
}

/** 按播放进度取包络上的电平。越界一律返回 0（口闭上）。 */
export function envelopeLevelAt(envelope: Float32Array, elapsedMs: number, frameMs = 25): number {
  if (envelope.length === 0 || elapsedMs < 0) return 0;
  const idx = Math.floor(elapsedMs / frameMs);
  return idx >= 0 && idx < envelope.length ? envelope[idx] : 0;
}
