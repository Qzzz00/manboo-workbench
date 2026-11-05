/**
 * 哼唱渲染层——把 HumPlan 的控制曲线挂到 Web Audio 节点图上。
 * 节点图照 animalSynth.ts 的共振峰合成：锯齿波(+噪声) → 三路带通 → 增益 → 低通 → 输出。
 *
 * 这一层**没有单测**（vitest 是 node 环境，无 AudioContext），判据是耳朵。
 * 所有能算的东西都在 humPlan.ts 那个纯函数里，这里只负责打点。
 */
import type { HumPlan, HumVoiceProfile } from './humPlan.ts';

/** 砍掉小喇叭放不好又刺耳的高频。哼鸣本来高频就弱，这条只是保险。 */
const HUM_LOWPASS_HZ = 2500;
/** 三路共振峰的相对增益与 Q（F2/F3 压得很低——哼鸣的能量集中在 F1）。 */
const FORMANT_GAINS = [1, 0.25, 0.06];
const FORMANT_Q = [8, 9, 8];
/** 整体输出音量：待机自娱自乐，不该盖过环境。 */
const HUM_PEAK_GAIN = 0.22;
/** 被打断时的淡出时长（毫秒）——硬切会「咔」一声。 */
const DEFAULT_FADE_MS = 200;
/**
 * 气声噪声的缓冲区时长（秒）——循环播放，不再按整首曲子长度一次性生成。
 * 按整曲长度（最长 ~16.8s）生成的话，48kHz 下是一次 806k 次 Math.random() 的同步
 * 主线程循环 + 3.2MB Float32Array，就发生在起哼那一刻——而低端机的 Live2D 预算只有
 * 12fps。1 秒白噪声循环在 breathiness ≤ 0.12 的混音量级下听不出周期性。
 */
const NOISE_LOOP_SEC = 1;

export type HumHandle = {
  stop(fadeMs?: number): void;
  readonly durationSec: number;
};

export type HumFrame = {
  /** 当前拍内的相位 0..1，供演出层驱动头/身摇摆 */
  beatPhase: number;
  elapsedSec: number;
};

let sharedCtx: AudioContext | null = null;

/**
 * 惰性单例 AudioContext。移动端首次创建可能是 suspended 状态（需用户手势解锁），
 * 但待机哼唱之前必然已经有过交互，resume() 一般能成。建不出来就返回 null——
 * 老 WebView 上整个功能静默跳过，不弹错。
 */
export function getHumAudioContext(): AudioContext | null {
  if (sharedCtx) return sharedCtx;
  try {
    const Ctor = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    sharedCtx = new Ctor();
    return sharedCtx;
  } catch {
    return null;
  }
}

/** 把一条定步长曲线写进 AudioParam。 */
function applyCurve(param: AudioParam, values: number[], startTime: number, stepSec: number, scale = 1): void {
  for (let i = 0; i < values.length; i += 1) {
    param.setValueAtTime(values[i] * scale, startTime + i * stepSec);
  }
}

function makeNoiseBuffer(ctx: AudioContext, durSec: number): AudioBuffer {
  const len = Math.max(1, Math.ceil(ctx.sampleRate * durSec));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
  return buf;
}

export function renderHumPlan(
  ctx: AudioContext,
  destination: AudioNode,
  plan: HumPlan,
  profile: HumVoiceProfile,
  onFrame: (frame: HumFrame) => void,
  onEnded: () => void,
): HumHandle {
  const t0 = ctx.currentTime + 0.05; // 留一点排程余量
  const { stepSec, durationSec } = plan;

  // ★所有已 start() 的排程源都要登记在这里。AudioScheduledSourceNode 一旦 start()，
  //   在它自己的结束时刻到来之前会一直被音频线程持有——丢掉 JS 引用不会让它闭嘴。
  //   换气噪声挂在 out **下游**（bg → lowpass），out.gain 淡到 0 也罩不住它，
  //   不显式 stop 的话打断之后好几秒还会「噗」地喷两下（违反 spec 的「打断即停」）。
  const scheduled: AudioScheduledSourceNode[] = [];

  const out = ctx.createGain();
  out.gain.value = 0;
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = HUM_LOWPASS_HZ;
  lowpass.Q.value = 0.7;
  out.connect(lowpass);
  lowpass.connect(destination);

  // —— 声源：锯齿波（谐波丰富，像声带脉冲）+ 一点气声噪声 ——
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  applyCurve(osc.frequency, plan.f0, t0, stepSec);

  const source = ctx.createGain();
  source.gain.value = 1;
  osc.connect(source);

  let noise: AudioBufferSourceNode | null = null;
  if (profile.breathiness > 0) {
    noise = ctx.createBufferSource();
    noise.buffer = makeNoiseBuffer(ctx, NOISE_LOOP_SEC);
    noise.loop = true;
    const ng = ctx.createGain();
    ng.gain.value = profile.breathiness;
    noise.connect(ng);
    ng.connect(source);
  }

  // —— 共振峰：三个并联带通 ——
  plan.formants.forEach((hz, i) => {
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = hz;
    bp.Q.value = FORMANT_Q[i];
    const g = ctx.createGain();
    g.gain.value = FORMANT_GAINS[i];
    source.connect(bp);
    bp.connect(g);
    g.connect(out);
  });

  // —— 幅度包络：直接照 plan.gain 打点 ——
  applyCurve(out.gain, plan.gain, t0, stepSec, HUM_PEAK_GAIN);

  // —— 换气：休止处的一小段气声 ——
  plan.breaths.forEach((atSec) => {
    const b = ctx.createBufferSource();
    b.buffer = makeNoiseBuffer(ctx, 0.18);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0, t0 + atSec);
    bg.gain.linearRampToValueAtTime(0.05, t0 + atSec + 0.05);
    bg.gain.linearRampToValueAtTime(0, t0 + atSec + 0.18);
    b.connect(bg);
    bg.connect(lowpass); // 只过低通，不过共振峰——换气不是嗓音
    b.start(t0 + atSec);
    b.stop(t0 + atSec + 0.18);
    scheduled.push(b);
  });

  osc.start(t0);
  osc.stop(t0 + durationSec);
  scheduled.push(osc);
  if (noise) {
    noise.start(t0);
    noise.stop(t0 + durationSec);
    scheduled.push(noise);
  }

  // —— 演出帧：按 ctx 时钟吐拍点相位，供上层驱动摇摆 ——
  let raf = 0;
  let stopped = false;
  const secPerBeat = plan.beats.length > 1 ? plan.beats[1] - plan.beats[0] : 0.5;

  function tick() {
    if (stopped) return;
    const elapsedSec = ctx.currentTime - t0;
    if (elapsedSec >= durationSec) {
      finish(false);
      return;
    }
    onFrame({
      elapsedSec,
      beatPhase: elapsedSec > 0 ? (elapsedSec % secPerBeat) / secPerBeat : 0,
    });
    raf = requestAnimationFrame(tick);
  }

  function finish(interrupted: boolean) {
    if (stopped) return;
    stopped = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    // ★onEnded 只表示「自然唱完」。被打断时不触发——调用方在 stop() 之后要自己走
    // 「打断」清理（计入连续打断、可能触发退避），若这里也 onEnded 一下，调用方的
    // markHumCompleted 会抢在 markHumInterrupted 之前把计数清零，退避规则永远不生效。
    if (!interrupted) onEnded();
  }

  raf = requestAnimationFrame(tick);

  return {
    durationSec,
    stop(fadeMs = DEFAULT_FADE_MS) {
      if (stopped) return;
      const now = ctx.currentTime;
      const fade = Math.max(0.02, fadeMs / 1000);
      try {
        out.gain.cancelScheduledValues(now);
        out.gain.setValueAtTime(out.gain.value, now);
        out.gain.linearRampToValueAtTime(0, now + fade);
      } catch {
        // 包络已经收过就算了
      }
      // 逐个 stop（含换气噪声），且各自 try——单个源已结束/抛错不能拖累其余的，
      // 漏掉任何一个都意味着淡出之后还有声音冒出来。重设的 stop 时刻若早于原定
      // 起始时刻，该源就整个不会发声（Web Audio 规范：stop 早于 start ⇒ 不播）。
      for (const src of scheduled) {
        try {
          src.stop(now + fade);
        } catch {
          // 已经停过就算了
        }
      }
      finish(true);
    },
  };
}
