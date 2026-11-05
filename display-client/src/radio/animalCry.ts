/**
 * 「宝可梦式」角色叫声合成——**风格化**的方波短叫，不模拟真实动物。
 *
 * ★为什么走这条路（Ben 拍板）：写实路线连否五轮（真实录音 / 人嘴模仿 / 共振峰合成 / miau 物理建模）。
 * 共同问题是**恐怖谷**——越想像真猫，做不到位就越显得假、甚至瘆人（他原话「好吓人」）。
 * 风格化叫声绕开了这件事：没人指望方波像真猫，它只要"节奏和音高对"就成立。
 *
 * ★而且它天生适配这台机器：U3 是廉价 MP4 机的微型喇叭——**没有低频、2-5kHz 有刺耳共振**。
 * 脉冲波能量集中在中频、不依赖低频，200ms 短音也不给共振区驻留时间。
 *
 * ★★用哪套音色按【角色美术风格】而不是物种分（Ben：「不像猫，但很合适给幽灵小狗用，
 * 可能是因为幽灵小狗也很宝可梦吧」）——见 radioVoicePack 的 MODE_BY_SPECIES。
 *
 * ★★**变体（variant）= 这只角色的"叫声词汇表"**：Ben 反馈「就一两条，能不能多来几条」。
 * 光靠随机音高/时长偏移听着仍是同一声，真正的变化来自**不同的音高折线和音节数**——
 * 单声 / 双声 / 三连 / 上扬疑问 / 拖长 / 颤音。同一套音色（占空比、低通）保证还是同一只角色，
 * 变的是它"说了什么"。
 */

export type CrySpecies = 'cat' | 'dog' | 'ghost';

/** 一个音符：一段连续发声。多个音符串起来就是"双声/三连"。 */
type Note = {
  /** 音高折线 [时间比例 0..1, Hz]。★辨识度几乎全在这条线上。 */
  pitch: Array<[number, number]>;
  dur: number;
  /** 占空比 0..0.5：0.5=方波(饱满)、0.28=偏薄、0.125=细尖。不填用音色默认值。 */
  duty?: number;
  vibratoHz?: number;
  vibratoSemis?: number;
  /** 混一点噪声（0..1）。 */
  noise?: number;
};

type CryVariant = {
  /** 这一声由哪几个音符组成（长度 1=单声，2=双声，3=三连）。 */
  notes: Note[];
  /** 音符之间的静音间隔（秒），长度 = notes.length-1。 */
  gaps: number[];
};

/** 每个音色的公共参数（决定"是哪只角色"），变体只改音高与节奏。 */
type CryTimbre = {
  duty: number;
  attack: number;
  release: number;
  lowpass: number;
  variants: CryVariant[];
};

// —— 卡通角色 A：Ben 试听后点名"很合适给幽灵小狗"的那套音色 ——
// 8 个变体覆盖不同"语气"：应一声 / 短促 / 双声 / 疑问 / 嘟囔 / 打颤 / 三连 / 拖长。
const CAT_VARIANTS: CryVariant[] = [
  // 1 基础：先扬后抑，就是 Ben 说合适的那条
  { notes: [{ pitch: [[0, 720], [0.18, 1060], [0.55, 960], [1, 610]], dur: 0.34, vibratoHz: 14, vibratoSemis: 0.22 }], gaps: [] },
  // 2 短促应一声
  { notes: [{ pitch: [[0, 800], [0.25, 1130], [1, 880]], dur: 0.19, vibratoHz: 12, vibratoSemis: 0.18 }], gaps: [] },
  // 3 双声「哔-哔」：第二声低一点，像随口应两下
  {
    notes: [
      { pitch: [[0, 900], [0.3, 1090], [1, 950]], dur: 0.13 },
      { pitch: [[0, 780], [0.3, 930], [1, 760]], dur: 0.15 },
    ],
    gaps: [0.075],
  },
  // 4 疑问：收尾往上飘（"嗯？"）
  { notes: [{ pitch: [[0, 700], [0.4, 880], [1, 1210]], dur: 0.32, vibratoHz: 11, vibratoSemis: 0.2 }], gaps: [] },
  // 5 嘟囔：整体低、占空比大一点更闷（"哼…"）
  { notes: [{ pitch: [[0, 640], [0.3, 720], [1, 500]], dur: 0.3, duty: 0.42, vibratoHz: 8, vibratoSemis: 0.15 }], gaps: [] },
  // 6 打颤：颤音拉满，像撒娇
  { notes: [{ pitch: [[0, 860], [0.5, 1080], [1, 900]], dur: 0.3, vibratoHz: 19, vibratoSemis: 0.55 }], gaps: [] },
  // 7 三连：快速下行，像着急催promise
  {
    notes: [
      { pitch: [[0, 1040], [1, 980]], dur: 0.1 },
      { pitch: [[0, 940], [1, 880]], dur: 0.1 },
      { pitch: [[0, 840], [1, 700]], dur: 0.13 },
    ],
    gaps: [0.062, 0.062],
  },
  // 8 拖长：慢一点、两段起伏，像打招呼
  { notes: [{ pitch: [[0, 690], [0.22, 1080], [0.62, 990], [1, 640]], dur: 0.47, vibratoHz: 13, vibratoSemis: 0.3 }], gaps: [] },
];

// —— 卡通角色 B：小幽灵，更细尖、更飘 ——
const GHOST_VARIANTS: CryVariant[] = [
  { notes: [{ pitch: [[0, 780], [0.35, 1180], [0.7, 1090], [1, 1240]], dur: 0.4, vibratoHz: 9, vibratoSemis: 0.5 }], gaps: [] },
  { notes: [{ pitch: [[0, 900], [0.5, 1260], [1, 1150]], dur: 0.26, vibratoHz: 11, vibratoSemis: 0.4 }], gaps: [] },
  { notes: [{ pitch: [[0, 1000], [0.4, 860], [1, 1080]], dur: 0.34, vibratoHz: 8, vibratoSemis: 0.6 }], gaps: [] },
  {
    notes: [
      { pitch: [[0, 1120], [1, 1240]], dur: 0.14, vibratoHz: 12, vibratoSemis: 0.3 },
      { pitch: [[0, 960], [1, 1120]], dur: 0.18, vibratoHz: 10, vibratoSemis: 0.4 },
    ],
    gaps: [0.08],
  },
  { notes: [{ pitch: [[0, 700], [0.5, 1020], [1, 1320]], dur: 0.46, vibratoHz: 7, vibratoSemis: 0.7 }], gaps: [] },
];

// —— 备用：写实一点的"汪"（当前没有角色在用，留着备选） ——
const DOG_VARIANTS: CryVariant[] = [
  {
    notes: [
      { pitch: [[0, 900], [0.1, 1010], [1, 480]], dur: 0.13, duty: 0.5, noise: 0.12 },
      { pitch: [[0, 860], [0.1, 960], [1, 460]], dur: 0.13, duty: 0.5, noise: 0.12 },
    ],
    gaps: [0.1],
  },
  {
    notes: [
      { pitch: [[0, 940], [0.1, 1050], [1, 500]], dur: 0.12, duty: 0.5, noise: 0.14 },
      { pitch: [[0, 880], [0.1, 980], [1, 470]], dur: 0.12, duty: 0.5, noise: 0.12 },
      { pitch: [[0, 820], [0.1, 900], [1, 440]], dur: 0.14, duty: 0.5, noise: 0.1 },
    ],
    gaps: [0.095, 0.11],
  },
];

export const TIMBRES: Record<CrySpecies, CryTimbre> = {
  cat: { duty: 0.28, attack: 0.012, release: 0.11, lowpass: 3200, variants: CAT_VARIANTS },
  dog: { duty: 0.5, attack: 0.004, release: 0.06, lowpass: 3000, variants: DOG_VARIANTS },
  ghost: { duty: 0.125, attack: 0.03, release: 0.16, lowpass: 3400, variants: GHOST_VARIANTS },
};

/** 某个音色有几种叫法——planAck 据此随机挑变体。 */
export function cryVariantCount(species: CrySpecies): number {
  return TIMBRES[species].variants.length;
}

/**
 * 造一个指定占空比的脉冲波。
 * Web Audio 内建只有 'square'（占空比固定 50%），别的占空比要自己给傅里叶系数：
 * 占空比 d 的脉冲波，第 n 次谐波幅度 ∝ sin(nπd)/(nπ)。占空比越小音色越"细尖"。
 */
function pulseWave(ctx: BaseAudioContext, duty: number, harmonics = 24): PeriodicWave {
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  for (let n = 1; n <= harmonics; n += 1) {
    imag[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * duty);
  }
  return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
}

const lerpAt = (pts: Array<[number, number]>, t: number): number => {
  if (t <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i += 1) {
    if (t <= pts[i][0]) {
      const [t0, v0] = pts[i - 1];
      const [t1, v1] = pts[i];
      const k = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
      return v0 + (v1 - v0) * k;
    }
  }
  return pts[pts.length - 1][1];
};

export type CryOptions = {
  /** 挑第几种叫法（不传则随机）。 */
  variant?: number;
  /** 整体音高缩放（1=基准）。 */
  pitch?: number;
  /** 时长缩放。 */
  speed?: number;
  /** 低通截止缩放（<1 更闷更暖）。 */
  toneScale?: number;
  rand?: () => number;
};

/** 排一次完整应答（可能是双声/三连），返回总时长（秒）。 */
export function synthesizeCry(
  ctx: BaseAudioContext,
  destination: AudioNode,
  species: CrySpecies,
  when: number,
  opts: CryOptions = {},
): number {
  const tim = TIMBRES[species];
  const rand = opts.rand ?? Math.random;
  const vi = Math.min(tim.variants.length - 1,
    Math.max(0, opts.variant ?? Math.floor(rand() * tim.variants.length)));
  const variant = tim.variants[vi];
  const pitchScale = opts.pitch ?? 1;
  const speed = opts.speed ?? 1;

  // 低通：砍掉脉冲波最上面那截谐波（既扎耳又是小喇叭的共振区）。整声共用一个，省节点。
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = tim.lowpass * (opts.toneScale ?? 1);
  lp.Q.value = 0.7;
  lp.connect(destination);

  let t = when;
  variant.notes.forEach((note, i) => {
    const dur = note.dur * speed;
    // 连声时后面几声略轻略低：等响等高会像机器
    const decay = 1 - i * 0.06;

    const g = ctx.createGain();
    g.gain.value = 0;
    g.connect(lp);

    const osc = ctx.createOscillator();
    osc.setPeriodicWave(pulseWave(ctx, note.duty ?? tim.duty));
    const steps = 20;
    for (let s = 0; s <= steps; s += 1) {
      const k = s / steps;
      osc.frequency.setValueAtTime(lerpAt(note.pitch, k) * pitchScale * decay, t + k * dur);
    }
    osc.connect(g);

    const vibHz = note.vibratoHz ?? 0;
    if (vibHz > 0) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = vibHz;
      const depth = ctx.createGain();
      const mid = lerpAt(note.pitch, 0.5) * pitchScale;
      depth.gain.value = mid * (Math.pow(2, (note.vibratoSemis ?? 0.2) / 12) - 1);
      lfo.connect(depth);
      depth.connect(osc.frequency);
      lfo.start(t);
      lfo.stop(t + dur);
    }

    if (note.noise && note.noise > 0) {
      const n = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur) + 1, ctx.sampleRate);
      const d = n.getChannelData(0);
      for (let k = 0; k < d.length; k += 1) d[k] = (Math.random() * 2 - 1) * (1 - k / d.length);
      const ns = ctx.createBufferSource();
      ns.buffer = n;
      const nf = ctx.createBiquadFilter();
      nf.type = 'bandpass'; nf.frequency.value = 1400; nf.Q.value = 1.2;
      const ng = ctx.createGain();
      ng.gain.value = note.noise * decay;
      ns.connect(nf); nf.connect(ng); ng.connect(g);
      ns.start(t); ns.stop(t + dur);
    }

    // 幅度包络：脆起脆收
    const peak = 0.85 * decay;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + tim.attack);
    g.gain.setValueAtTime(peak, Math.max(t + tim.attack, t + dur - tim.release));
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);

    osc.start(t);
    osc.stop(t + dur);

    t += dur + (variant.gaps[i] ?? 0) * speed;
  });

  return t - when;
}
