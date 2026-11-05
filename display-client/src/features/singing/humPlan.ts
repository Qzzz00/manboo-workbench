/**
 * 哼唱计划：把乐谱编译成一组定步长采样的控制曲线（基频/增益/共振峰/拍点）。
 * 这一层是**纯函数**，是本功能的重点测试对象；把它挂到 Web Audio 上的是 humVoice.ts 的薄层。
 * 分家的理由与 animalSynth.ts 相同：同一份数学既能离线算也能实时发声，且离线可测。
 *
 * ★两处对 spec 的有意偏离：
 *  1) 不产口型曲线——哼鸣是**闭口鼻音**，嘴不该动。口型通道（setMouthOpen）在哼唱期间必须保持 0。
 *  2) formants 是 3 个常数而非轨迹——哼鸣不换元音，共振峰恒定。开口唱词时（P3+）再改回轨迹。
 */
import { centsToRatio, midiToHz, type Score } from './score.ts';

/** 控制曲线的采样步长（秒）。50Hz 对 5.5Hz 颤音有 ~9 点/周期，足够平滑。 */
export const PLAN_STEP_SEC = 0.02;

/**
 * 每角色一份音色档案——九个角色哼同一首曲子不该听起来是同一个人。
 * ★transpose 与 formantScale 正交：**移调不改变共振峰**。想让角色听起来"更小更可爱"
 * 必须动 formantScale（声道越短共振峰越高＝大脑判定的体型越小）；只移调只是把同一个人
 * 唱高唱低。这是 animalSynth.ts 里已经栽过一次的坑。
 */
export type HumVoiceProfile = {
  /** 半音移调，决定音域高低 */
  transpose: number;
  /** 共振峰整体缩放，决定"体型感"（>1 更小更可爱） */
  formantScale: number;
  /** 颤音速度（Hz） */
  vibratoHz: number;
  /** 颤音深度（音分） */
  vibratoCents: number;
  /** 气声比例 0..1，渲染层混入噪声的量 */
  breathiness: number;
};

export const DEFAULT_HUM_PROFILE: HumVoiceProfile = {
  transpose: 0,
  formantScale: 1,
  vibratoHz: 5.5,
  vibratoCents: 25,
  breathiness: 0.06,
};

/**
 * 闭口鼻音 [m] 的共振峰（Hz）。声音走鼻腔，F1 低、高频弱——
 * 这正是"哼"区别于"小声唱"的地方。开口元音 [a] 是 [800, 1200, 2800]，此处不用。
 */
const HUM_FORMANTS = [280, 1150, 2400];

/** 音符之间的滑音时长（秒）——不跳变，人唱歌是滑过去的。 */
const PORTAMENTO_SEC = 0.04;
/** 乐句首音的起音上滑：从下方 SCOOP_CENTS 音分在 SCOOP_SEC 内够上目标。 */
const SCOOP_SEC = 0.08;
const SCOOP_CENTS = -40;
/** 颤音只加在时长 ≥ 此值的音符上，且延迟 VIBRATO_DELAY_SEC 才起。 */
const VIBRATO_MIN_DUR_SEC = 0.4;
const VIBRATO_DELAY_SEC = 0.15;
/** 休止符 ≥ 此拍数才算一次换气。 */
const BREATH_MIN_BEATS = 0.5;

/** 每音符的音准微扰幅度（音分），±该值。人唱歌不会每个音都精确落在标准音高上。 */
const JITTER_CENTS = 10;

export type HumPlan = {
  /** 曲线采样步长（秒） */
  stepSec: number;
  durationSec: number;
  /** 基频曲线（Hz），每 stepSec 一个点 */
  f0: number[];
  /** 三个共振峰的中心频率（Hz），哼鸣期间恒定 */
  formants: number[];
  /** 幅度包络 0..1，每 stepSec 一个点 */
  gain: number[];
  /** 拍点时刻（秒），供演出层驱动头/身摇摆 */
  beats: number[];
  /** 呼吸声时刻（秒），渲染层在这些点放一小段气声 */
  breaths: number[];
};

type NoteSpan = {
  startSec: number;
  endSec: number;
  durSec: number;
  beats: number;
  /** null = 休止符 */
  hz: number | null;
};

function layoutNotes(score: Score, transpose: number): NoteSpan[] {
  const secPerBeat = 60 / score.bpm;
  let cursor = 0;
  return score.notes.map((n) => {
    const durSec = n.beats * secPerBeat;
    const span: NoteSpan = {
      startSec: cursor,
      endSec: cursor + durSec,
      durSec,
      beats: n.beats,
      hz: n.pitch === null ? null : midiToHz(n.pitch + transpose),
    };
    cursor += durSec;
    return span;
  });
}

/** 单音符的幅度包络：软起音 + 收尾回落，中段满幅。 */
function envelopeAt(elapsed: number, durSec: number): number {
  const attack = Math.min(0.05, durSec / 3);
  const release = Math.min(0.08, durSec / 3);
  if (elapsed < attack) return elapsed / attack;
  const fromEnd = durSec - elapsed;
  if (fromEnd < release) return Math.max(0, fromEnd / release);
  return 1;
}

export function buildHumPlan(
  score: Score,
  profile: HumVoiceProfile = DEFAULT_HUM_PROFILE,
  rng: () => number = Math.random,
): HumPlan {
  const spans = layoutNotes(score, profile.transpose);
  const durationSec = spans.length ? spans[spans.length - 1].endSec : 0;
  const steps = Math.max(1, Math.ceil(durationSec / PLAN_STEP_SEC) + 1);

  const f0 = new Array<number>(steps).fill(0);
  const gain = new Array<number>(steps).fill(0);

  // 休止时基频保持上一个有效值：写 0Hz 会让振荡器与带通滤波器跳变，出爆音。
  let lastHz = spans.find((s) => s.hz !== null)?.hz ?? 220;

  // ★每个音符恰好抽一次，且必须在采样循环之外抽——
  // 放进循环会让 rng 调用次数依赖采样步长，结果不可复现（测试里有护栏盯这个）。
  const jitterCents = spans.map(() => (rng() * 2 - 1) * JITTER_CENTS);

  let cursor = 0;

  for (let i = 0; i < steps; i += 1) {
    const t = i * PLAN_STEP_SEC;
    while (cursor < spans.length - 1 && t >= spans[cursor].endSec) cursor += 1;
    const span = spans[cursor];
    if (!span || span.hz === null || t < span.startSec || t > span.endSec) {
      f0[i] = lastHz;
      gain[i] = 0;
      continue;
    }
    lastHz = span.hz;
    const elapsed = t - span.startSec;
    const targetHz = span.hz * centsToRatio(jitterCents[cursor]);
    let hz = targetHz;

    const prev = spans[cursor - 1];
    if (elapsed < PORTAMENTO_SEC && prev && prev.hz !== null) {
      // 滑音：从前一个音符线性滑到本音符，不跳变
      const prevHz = prev.hz * centsToRatio(jitterCents[cursor - 1]);
      hz = prevHz + (targetHz - prevHz) * (elapsed / PORTAMENTO_SEC);
    } else if (elapsed < SCOOP_SEC && (!prev || prev.hz === null)) {
      // 乐句首音：从下方够上去——人唱歌的自然起音
      hz = targetHz * centsToRatio(SCOOP_CENTS * (1 - elapsed / SCOOP_SEC));
    }

    if (span.durSec >= VIBRATO_MIN_DUR_SEC && elapsed >= VIBRATO_DELAY_SEC) {
      // 颤音：长音上的 LFO 调频，是"像人在唱"最省力的一刀
      const phase = 2 * Math.PI * profile.vibratoHz * (elapsed - VIBRATO_DELAY_SEC);
      hz *= centsToRatio(profile.vibratoCents * Math.sin(phase));
    }

    f0[i] = hz;
    gain[i] = envelopeAt(elapsed, span.durSec);
  }

  const secPerBeat = 60 / score.bpm;
  const beats: number[] = [];
  for (let t = 0; t < durationSec - 1e-9; t += secPerBeat) beats.push(t);

  // 换气：乐句之间的长休止处放一小段气声，渲染层据此起噪声。
  const breaths = spans
    .filter((s) => s.hz === null && s.beats >= BREATH_MIN_BEATS)
    .map((s) => s.startSec + 0.05);

  return {
    stepSec: PLAN_STEP_SEC,
    durationSec,
    f0,
    formants: HUM_FORMANTS.map((f) => f * profile.formantScale),
    gain,
    beats,
    breaths,
  };
}
