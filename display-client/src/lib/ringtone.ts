/**
 * 铃声模块：优先播放角色自定义 mp3（ringtoneUrl），无则回落 WebAudio 程序化
 * 合成双音「叮-咚」。供来电出口（Task 9/10/来电铃声）消费：
 * createRingtone(ringtoneUrl?) 返回 { start, stop }。
 * AudioContext / Audio 不可用的环境（如 vitest node 环境）下 start/stop 安全 no-op。
 */

const DING_FREQ = 880;
const DONG_FREQ = 659;
const BEAT_DUR_MS = 350;
const DEFAULT_CYCLE_MS = 1200;
const VOLUME = 0.25;

export type RingBeat = { freq: number; atMs: number; durMs: number };

/** 纯函数：按周期编排「叮-咚」节拍时序，供 createRingtone 与测试共用。 */
export function ringSchedule(cycleMs: number = DEFAULT_CYCLE_MS): RingBeat[] {
  const beats: RingBeat[] = [];
  const perCycle: Array<{ freq: number; offsetMs: number }> = [
    { freq: DING_FREQ, offsetMs: 0 },
    { freq: DONG_FREQ, offsetMs: BEAT_DUR_MS },
  ];
  const cycleCount = Math.max(1, Math.floor(cycleMs / DEFAULT_CYCLE_MS));

  for (let cycle = 0; cycle < cycleCount; cycle += 1) {
    const cycleStartMs = cycle * DEFAULT_CYCLE_MS;
    for (const beat of perCycle) {
      beats.push({ freq: beat.freq, atMs: cycleStartMs + beat.offsetMs, durMs: BEAT_DUR_MS });
    }
  }

  // cycleMs 小于单轮两拍所需时长时，只保留能完整放入 cycleMs 窗口内的节拍。
  if (cycleMs < DEFAULT_CYCLE_MS) {
    return beats.filter((beat) => beat.atMs + beat.durMs <= cycleMs);
  }
  return beats;
}

export type Ringtone = { start(): void; stop(): void };

/** 纯函数：按是否有非空白 URL 选择播放源，供 createRingtone 分发与测试共用。 */
export function pickRingtoneSource(url?: string): 'audio' | 'synth' {
  return url && url.trim() ? 'audio' : 'synth';
}

/** HTMLAudioElement 循环播放上传的 mp3。Audio 构造函数不可用时（如 vitest node 环境）安全 no-op。 */
function createAudioRingtone(url: string): Ringtone {
  if (typeof Audio === 'undefined') {
    return {
      start() {},
      stop() {},
    };
  }

  let audio: HTMLAudioElement | null = null;

  return {
    start() {
      if (audio) return; // 已在响铃，忽略重复 start。
      audio = new Audio(url);
      audio.loop = true;
      audio.play().catch(() => {}); // 自动播放策略/无音频环境下静默失败，不抛错。
    },
    stop() {
      if (!audio) return;
      audio.pause();
      audio.currentTime = 0;
      audio = null;
    },
  };
}

/** 创建铃声控制器。有 ringtoneUrl 时循环播放该 mp3；否则回落程序化合成叮咚。 */
export function createRingtone(ringtoneUrl?: string): Ringtone {
  if (pickRingtoneSource(ringtoneUrl) === 'audio') {
    return createAudioRingtone(ringtoneUrl!);
  }
  return createSynthRingtone();
}

/** WebAudio 程序化合成双音「叮-咚」。AudioContext 不可用时返回安全 no-op 的 start/stop。 */
function createSynthRingtone(): Ringtone {
  const AudioCtor: typeof AudioContext | undefined =
    typeof AudioContext !== 'undefined'
      ? AudioContext
      : typeof (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext !== 'undefined'
        ? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : undefined;

  if (!AudioCtor) {
    return {
      start() {},
      stop() {},
    };
  }

  let ctx: AudioContext | null = null;
  let timers: Array<ReturnType<typeof setTimeout>> = [];
  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let activeNodes: Array<{ osc: OscillatorNode; gain: GainNode }> = [];

  const clearTimers = () => {
    timers.forEach(clearTimeout);
    timers = [];
    if (intervalTimer !== null) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
  };

  const silenceActiveNodes = () => {
    activeNodes.forEach(({ osc, gain }) => {
      try {
        gain.gain.cancelScheduledValues(ctx!.currentTime);
        gain.gain.setValueAtTime(0, ctx!.currentTime);
        osc.stop();
      } catch {
        // 节点可能已停止/已断开，忽略。
      }
      try {
        osc.disconnect();
        gain.disconnect();
      } catch {
        // 忽略重复断开。
      }
    });
    activeNodes = [];
  };

  const playBeat = (freq: number, durMs: number) => {
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.value = VOLUME;
    osc.connect(gain);
    gain.connect(ctx.destination);
    const node = { osc, gain };
    activeNodes.push(node);
    osc.start();
    osc.stop(ctx.currentTime + durMs / 1000);
    osc.onended = () => {
      try {
        osc.disconnect();
        gain.disconnect();
      } catch {
        // 忽略。
      }
      activeNodes = activeNodes.filter((n) => n !== node);
    };
  };

  const scheduleCycle = () => {
    const beats = ringSchedule();
    beats.forEach((beat) => {
      const t = setTimeout(() => playBeat(beat.freq, beat.durMs), beat.atMs);
      timers.push(t);
    });
  };

  return {
    start() {
      if (ctx) return; // 已在响铃，忽略重复 start。
      ctx = new AudioCtor();
      scheduleCycle();
      intervalTimer = setInterval(scheduleCycle, DEFAULT_CYCLE_MS);
    },
    stop() {
      clearTimers();
      silenceActiveNodes();
      if (ctx) {
        void ctx.close();
        ctx = null;
      }
    },
  };
}
