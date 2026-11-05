/**
 * 叫声播放器：播一段动物叫声，并从波形实时算能量包络驱动口型。
 *
 * ★为什么走 Web Audio 而不是 <audio>：口型需要「当前这一刻多大声」。原来 TTS 是由 tts.ts 的
 * onMouthChange 回调喂 level 的，换成叫声后没人喂了——这里用 AnalyserNode 读时域波形算 RMS 顶上，
 * 下游（mouthOverridesForLevel → Live2DStage.mouthSyncOverrides）完全不用改，
 * 原生 GL 与 Pixi 两条渲染路径的口型都照旧自动路由。
 *
 * 低端机注意（U3 = MTK P22 / Chromium 101 WebView）：
 * - 解码后的 AudioBuffer 按 url 缓存，同一条叫声不重复解码（26 条总共才 152KB，全缓存也无压力）。
 * - rAF 只在播放期间跑，播完立刻停，静默期零开销。
 * - 素材是 Ogg Opus：Chromium 自带解码器，不依赖 Android 平台编解码（这台无 GMS 的 ROM 更稳）。
 */

import type { AckPlan } from './radioVoicePack.ts';
import { synthesizeCry } from './animalCry.ts';

export type AnimalVoiceHandle = {
  /**
   * 播一次应答（可能是连着好几声，如狗的「汪汪汪」）。
   * 播完（或被下一次打断/被 stop）后 resolve。素材缺失/解码失败也 resolve（不抛）。
   */
  play: (plan: AckPlan) => Promise<void>;
  /**
   * 预热：把这些叫声提前 fetch+decode+量基准存进缓存，让真正要叫的时候是 ~1.5ms 起播而不是 ~175ms。
   * 逐条之间让出主线程，避免在低端机上把启动卡住。重复调用/已缓存的会自动跳过。
   */
  prewarm: (urls: string[]) => Promise<void>;
  /**
   * 叫声音量 0..1（独立于系统/音乐音量）。
   * ★为什么需要它：叫声和音乐是两条独立的输出——音乐经 media3 播放、音量由播放器/系统媒体音量决定，
   * 而叫声是 Web Audio 直出，永远是素材本身的响度。Ben 实测「音乐已经很小了，叫声依然很大」就是这个原因，
   * 光调系统音量没法把两者分开。
   */
  setVolume: (v: number) => void;
  /** 立刻停止当前叫声并把口型归零。 */
  stop: () => void;
  /** 释放 AudioContext 与缓存。 */
  dispose: () => void;
};

type Options = {
  /** 口型能量 0..1，静默时会被显式喂 0（保证嘴一定闭上）。 */
  onLevel: (level: number) => void;
  /** 是否正在发声——上层用它做「防自听」麦克风门控，取代原来的 ttsState。 */
  onSpeakingChange?: (speaking: boolean) => void;
  /** 初始音量 0..1（见 setVolume）。 */
  volume?: number;
};

// ★口型增益是「每条叫声自适应」而不是固定值。
// 素材虽然都峰值归一到了 -3dBFS，但【峰值齐平不等于包络齐平】：一声狗吠是瞬时爆发（峰值高、
// 平均能量低），呼噜是持续低吼（峰值同样高、平均能量却高得多）。用同一个固定增益的话，
// 狗吠嘴几乎不张、呼噜嘴一直张满。所以解码时先量出这条叫声自己的「最响 20ms 窗 RMS」，
// 播放时按它归一——每条叫声在自己最响的瞬间都张到接近满口，跨素材观感一致。
// 0.85 = 留一点余量，让嘴在接近（而非必须达到）峰值时就张满，看着更有力。
const MOUTH_HEADROOM = 0.85;
// 量包络用的窗长：20ms，与人眼可辨的口型变化速度匹配，太短会抖、太长会糊。
const RMS_WINDOW_SEC = 0.02;
// 平滑：低端机 rAF 掉帧时嘴会一跳一跳，做个非对称平滑（张嘴快、闭嘴慢）更像真的在叫。
const ATTACK = 0.6;
const RELEASE = 0.25;

// 扫描步长：算归一基准时每隔 4 个样本取 1 个。这只是求个「最响窗有多响」的基准值，
// 4 倍抽samples 对结果影响 <1%，但在 U3(P22) 上把这趟扫描从 78ms 砍到 ~20ms
//（真机实测：冷启首叫 fetch 40ms + decode 57ms + 这趟扫描 78ms = 175ms，扫描是最大单项且是我们自己的代码）。
const RMS_SCAN_STRIDE = 4;

/** 合成叫声的口型归一分母：合成输出幅度由我们自己定（峰值 ~0.85×包络），
 * 不像素材那样每条不同，固定值即可。真机看嘴张得不够就调小。 */
const CRY_LEVEL_DIVISOR = 0.18;

/** 量一条叫声「最响的那个 20ms 窗」的 RMS，用作该条的口型归一基准。 */
function peakWindowRms(buffer: AudioBuffer): number {
  const data = buffer.getChannelData(0);
  const win = Math.max(1, Math.floor(buffer.sampleRate * RMS_WINDOW_SEC));
  let best = 0;
  for (let start = 0; start + win <= data.length; start += win) {
    let sum = 0;
    let n = 0;
    for (let i = start; i < start + win; i += RMS_SCAN_STRIDE) { sum += data[i] * data[i]; n += 1; }
    const rms = Math.sqrt(sum / Math.max(1, n));
    if (rms > best) best = rms;
  }
  return best;
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1);

export function createAnimalVoice(opts: Options): AnimalVoiceHandle {
  // 缓存解码结果 + 该条的口型归一基准（peakRms 只在首次解码时算一次）。
  const bufferCache = new Map<string, { buffer: AudioBuffer; peakRms: number }>();
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let gain: GainNode | null = null;
  let volume = clamp01(opts.volume ?? 1);
  // 一次应答可能排了好几声（狗连叫），全部记下来才能被打断/stop 时一起掐掉。
  let currentSources: AudioBufferSourceNode[] = [];
  let rafId = 0;
  let smoothed = 0;
  // 当前这条叫声的归一分母（播放时设好，静默时无所谓）。
  let levelDivisor = 1;
  // 合成档的收尾定时器（stop/dispose 时要清掉）
  const cryTimers: ReturnType<typeof setTimeout>[] = [];
  let disposed = false;
  // 每次播放自增：异步解码回来时若已不是最新一次请求，直接丢弃（防止旧叫声后到把新的顶掉）。
  let playToken = 0;

  const ensureCtx = (): AudioContext | null => {
    if (disposed) return null;
    if (!ctx) {
      const Ctor: typeof AudioContext | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 256; // 够算 RMS，越小越省
      gain = ctx.createGain();
      gain.gain.value = volume;
      // ★接法：source → analyser → gain → destination。
      // analyser 必须在 gain【之前】——口型是从 analyser 读的，接在 gain 之后的话
      // 把音量调小会连嘴一起变小、调成静音嘴就完全不动了。口型该只跟叫声的波形走，与音量无关。
      analyser.connect(gain);
      gain.connect(ctx.destination);
    }
    return ctx;
  };

  const stopMeter = () => {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    smoothed = 0;
    opts.onLevel(0);
  };

  const startMeter = () => {
    if (!analyser || rafId) return;
    const data = new Uint8Array(analyser.fftSize);
    const tick = () => {
      if (!analyser || disposed) return;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) {
        const v = (data[i] - 128) / 128; // 0..255 → -1..1
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      const target = Math.min(1, rms / levelDivisor);
      const k = target > smoothed ? ATTACK : RELEASE;
      smoothed += (target - smoothed) * k;
      opts.onLevel(smoothed);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  };

  const stopCurrent = () => {
    while (cryTimers.length) { const id = cryTimers.pop(); if (id) clearTimeout(id); }
    for (const s of currentSources) {
      s.onended = null;
      try { s.stop(); } catch { /* 已自然结束或尚未开始 */ }
      try { s.disconnect(); } catch { /* 已断开 */ }
    }
    currentSources = [];
    stopMeter();
  };

  const loadBuffer = async (
    audioCtx: AudioContext,
    url: string,
  ): Promise<{ buffer: AudioBuffer; peakRms: number } | null> => {
    const cached = bufferCache.get(url);
    if (cached) return cached;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const bytes = await res.arrayBuffer();
      // Chromium 101 支持 Promise 版 decodeAudioData。
      const buffer = await audioCtx.decodeAudioData(bytes);
      const entry = { buffer, peakRms: peakWindowRms(buffer) };
      bufferCache.set(url, entry);
      return entry;
    } catch {
      return null; // 素材缺失/解码失败 → 静默跳过，绝不让角色因为没声音就崩掉回合
    }
  };

  const play = async (plan: AckPlan): Promise<void> => {
    const token = ++playToken;
    const audioCtx = ensureCtx();
    if (!audioCtx) return;
    stopCurrent();

    // —— 合成档（卡通角色）：现场生成，没有素材要 fetch/decode，起播零延迟 ——
    if (plan.kind === 'cry') {
      if (audioCtx.state === 'suspended') {
        try { await audioCtx.resume(); } catch { /* 仍被挂起 → 这次没声音 */ }
        if (disposed || token !== playToken) return;
      }
      // 合成信号也走 analyser，口型链路照旧不用改。
      // 归一分母用固定值：合成输出的幅度是我们自己定的（峰值 ~0.85 × 包络），
      // 不像素材那样每条都不同，所以不需要逐条量。
      levelDivisor = CRY_LEVEL_DIVISOR;
      const total = synthesizeCry(audioCtx, analyser!, plan.voice, audioCtx.currentTime + 0.02, {
        variant: plan.variant, pitch: plan.pitch, speed: plan.speed, toneScale: plan.toneScale,
      });
      opts.onSpeakingChange?.(true);
      startMeter();
      // 合成节点是 fire-and-forget（各自 stop 了），用定时收尾即可
      await new Promise<void>((resolve) => {
        const id = setTimeout(() => {
          if (token === playToken) {
            stopMeter();
            opts.onSpeakingChange?.(false);
          }
          resolve();
        }, (total + 0.1) * 1000);
        cryTimers.push(id);
      });
      return;
    }

    if (plan.clips.length === 0) return;

    const entries = await Promise.all(plan.clips.map((u) => loadBuffer(audioCtx, u)));
    // 解码期间又发起了新的播放/已 dispose → 这次作废
    if (disposed || token !== playToken) return;
    const usable = entries.map((e, i) => ({ e, i })).filter((x) => x.e != null);
    if (usable.length === 0) return; // 素材全缺 → 静默跳过，不崩回合

    // 口型归一基准取这一串里最响的那条：整串共用一个分母，连叫时每声的相对强弱才保留下来
    //（各声各自归一的话，弱的那声也会被拉到满口，听感和口型对不上）。
    const peak = Math.max(...usable.map((x) => x.e!.peakRms));
    levelDivisor = peak > 1e-4 ? peak * MOUTH_HEADROOM : 1;

    // 自动播放策略：AudioContext 可能是 suspended（需用户手势）。电台里发声一定发生在
    // 用户点了「拨通」之后，resume 能成功；失败也不抛，静默跳过。
    if (audioCtx.state === 'suspended') {
      try { await audioCtx.resume(); } catch { /* 仍被挂起 → 这次没声音 */ }
      if (disposed || token !== playToken) return;
    }

    // 排期：用 AudioContext 的时钟一次性排好整串（不是 setTimeout 逐声触发）——
    // 低端机主线程一卡，setTimeout 会把「汪汪汪」抖成不齐的节奏，音频线程的排期不受主线程影响。
    const lead = 0.02; // 20ms 起播余量，避免第一声因排期已过而被丢
    let when = audioCtx.currentTime + lead;
    const sources: AudioBufferSourceNode[] = [];
    for (const { e, i } of usable) {
      const src = audioCtx.createBufferSource();
      src.buffer = e!.buffer;
      // 随机变速：同一条素材每次音高/长短略不同，少量素材也不显复读（planAck 给的值）
      src.playbackRate.value = plan.rates[i] ?? 1;
      src.connect(analyser!);
      when += (plan.gaps[i] ?? 0) / 1000;
      src.start(when);
      when += e!.buffer.duration / (plan.rates[i] ?? 1);
      sources.push(src);
    }
    currentSources = sources;
    opts.onSpeakingChange?.(true);
    startMeter();

    await new Promise<void>((resolve) => {
      const last = sources[sources.length - 1];
      last.onended = () => {
        // 只有仍是「当前这串」才收尾，避免被打断的旧串把新一串的口型/状态清掉
        if (currentSources === sources) {
          currentSources = [];
          stopMeter();
          opts.onSpeakingChange?.(false);
        }
        resolve();
      };
    });
  };

  const prewarm = async (urls: string[]): Promise<void> => {
    const audioCtx = ensureCtx();
    if (!audioCtx) return;
    for (const url of urls) {
      if (disposed) return;
      if (bufferCache.has(url)) continue;
      await loadBuffer(audioCtx, url);
      // 让出主线程：低端机上连着解码十来条会明显卡住启动动画/首次滑动。
      await new Promise((r) => setTimeout(r, 0));
    }
  };

  const setVolume = (v: number) => {
    volume = clamp01(v);
    // 用 setTargetAtTime 做 ~30ms 渐变，拖滑块时不会一格一格「咔咔」响。
    if (gain && ctx) gain.gain.setTargetAtTime(volume, ctx.currentTime, 0.03);
    else if (gain) gain.gain.value = volume;
  };

  const stop = () => {
    playToken += 1; // 让在途解码作废
    const wasPlaying = currentSources.length > 0 || cryTimers.length > 0;
    stopCurrent();
    if (wasPlaying) opts.onSpeakingChange?.(false);
  };

  const dispose = () => {
    disposed = true;
    stop();
    bufferCache.clear();
    if (ctx) { void ctx.close().catch(() => {}); ctx = null; analyser = null; gain = null; }
  };

  return { play, prewarm, setVolume, stop, dispose };
}
