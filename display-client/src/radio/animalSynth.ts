/**
 * 动物叫声【程序化合成】——不放素材，用 Web Audio 现场生成。
 *
 * ★为什么走合成（Ben：「换一组声音吧，可能是因为 mp4 的扬声器太差…有没有那种项目是能模拟猫狗叫声的？」）：
 * 前两轮素材（真实录音 / 人嘴模仿）都被否，共同症状是「尖锐、不可爱」。
 * 关键在硬件——U3 是廉价 MP4 机的微型喇叭：**几乎没有低频，且在 2-5kHz 有共振**，
 * 正好把素材里那段最刺耳的频率放大。挑现成录音改不了它的频谱分布，合成可以：
 * 我们能把能量精确放在这只喇叭还原得了的中频、并把 4kHz 以上直接砍掉。
 *
 * ★发声原理（共振峰合成 / formant synthesis）：
 * 动物叫声 = 声带产生的**周期性谐波源** → 经声道**共振峰滤波** → 幅度包络。
 * 「喵」的本质是**一次张嘴—闭嘴动作**同时带出「基频拱形」和「共振峰下滑」：
 * 实测 F1 从 ~1300Hz（张到最大）滑到 ~600Hz（闭上），F2/F3 按比例跟着走。
 * 文献里做过对照实验：**只给 F1 这一条滑动**，听者就有 75-93% 听成 [au]（即"喵"）。
 *
 * ★「可爱 vs 尖锐」的关键——**体型线索靠共振峰，不靠基频**：
 * 声道越短共振峰越高，大脑据此判断「这是个小动物」。所以要「小而软」＝
 * 共振峰上移 + 基频适中 + **高频谐波压掉**（尖锐感来自 2-5kHz 的谐波能量）+ 起音要软（attack 慢一点）。
 * 上一轮我只做了移调（−2.5 半音），而**移调不改变共振峰**，所以只是把成年猫放慢，没有变小变可爱。
 *
 * 同一份代码既能在 OfflineAudioContext 里离线渲染（做试听样本），也能在实时 AudioContext 里直接发声。
 */

export type SynthSpecies = 'cat' | 'dog' | 'ghost';

/** 合成参数：全部可调，方便真机上按听感微调。 */
export type SynthVoice = {
  /** 基频轮廓（时间比例 0..1 → Hz），至少两点。 */
  f0: Array<[number, number]>;
  /** 三个共振峰的轨迹（时间比例 0..1 → Hz）。F2 的滑动决定"喵/汪"的辨识度。 */
  formants: Array<Array<[number, number]>>;
  /** 各共振峰的 Q（越大越窄越"有腔调"）。 */
  q: number[];
  /** 各共振峰的相对增益。 */
  gains: number[];
  /** 总时长（秒）。 */
  dur: number;
  /** 幅度包络：起音/衰减时间（秒）。起音越慢越"软"，越快越"冲"。 */
  attack: number;
  release: number;
  /** 源里混多少噪声（0..1）：狗吠的"沙"感来自这个，猫几乎不需要。 */
  noise: number;
  /** 低通截止（Hz）：砍掉小喇叭放不好又刺耳的高频。 */
  lowpass: number;
  /** 呼噜/颤音的调幅频率（Hz），0=不调幅。 */
  tremoloHz: number;
  tremoloDepth: number;
  /** 起音处额外的一小段宽带噪声爆破（秒），0=没有。狗吠的"爆"感来自这个。 */
  onsetBurst?: number;
};

/**
 * 三个物种的基准音色。
 * ★数值取向都朝「小、软、中频」走——这是为那只劣质小喇叭定的，不是通用最优。
 */
const VOICES: Record<SynthSpecies, SynthVoice> = {
  // 小猫「喵」——参数取自实测文献（见文件末「参数出处」）：
  // F0 呈**拱形**（升到峰再落，首尾比峰值低 100-150Hz），实测家猫 mean F0 ≈ 500-660Hz、时长 ≈ 0.6-0.7s。
  // ★真正决定"像不像喵"的是 **F1 从 ~1300Hz 一路滑到 ~600Hz**（张嘴→闭嘴），F2/F3 按比例跟着走，
  // 这就是 /a/→/u/ 的双元音滑动。（我第一版把 F1 写成 620-780 是错的——那是人的元音，不是猫。）
  cat: {
    f0: [[0, 500], [0.25, 690], [0.6, 620], [1, 520]],
    formants: [
      [[0, 1290], [0.25, 1330], [1, 610]],  // F1 ★这条下滑就是"喵"
      [[0, 3550], [0.25, 3700], [1, 2680]], // F2
      [[0, 5200], [1, 4900]],               // F3（多半被 lowpass 削掉，留着撑音色厚度）
    ],
    q: [7, 8, 7],
    gains: [1, 0.5, 0.14], // F2/F3 压低：2-5kHz 正是小喇叭的刺耳共振区
    dur: 0.66,
    attack: 0.05, // 软起音：猫叫的"刺"有一大半来自太硬的起音
    release: 0.26,
    noise: 0.012,
    lowpass: 4600, // 保住 F2、砍掉更高的刺
    tremoloHz: 0,
    tremoloDepth: 0,
  },
  // 小奶狗「汪」——实测：时长 100-500ms、mean F0 ≈ 700Hz（比我第一版的 420 高得多）、
  // F0 呈**人字形**（快升快落）、**起音是一小段噪声爆破**再转谐波、全程叠宽带噪声。
  // 共振峰按小型犬取（约克夏实测 F1 891 / F2 1828，共振峰间距 ~1700Hz = 短声道 = 小狗）。
  dog: {
    f0: [[0, 620], [0.16, 830], [1, 470]],
    formants: [
      [[0, 780], [0.16, 900], [1, 720]],
      [[0, 1900], [0.2, 2050], [1, 1750]],
      [[0, 3300], [1, 3000]],
    ],
    q: [5, 6, 5],
    gains: [1, 0.55, 0.18],
    dur: 0.24, // 实测单声狗吠 100-500ms
    attack: 0.005, // 起音要冲，这是"汪"的爆发感
    release: 0.16,
    noise: 0.16, // 宽带噪声成分给出"沙"的质感（实测吠叫谐噪比只有 5-10dB）
    lowpass: 4800,
    tremoloHz: 0,
    tremoloDepth: 0,
    onsetBurst: 0.014, // ★实测吠叫是"先一小段爆破噪声再转谐波"，这一下决定"汪"够不够冲
  },
  // 小幽灵「呜」：柔和、无噪声、带轻微颤音，共振峰高而窄=小而空灵。
  ghost: {
    f0: [[0, 430], [0.3, 520], [1, 400]],
    formants: [
      [[0, 500], [1, 620]],
      [[0, 1100], [0.5, 1350], [1, 1000]],
      [[0, 2500], [1, 2400]],
    ],
    q: [9, 11, 9],
    gains: [1, 0.6, 0.18],
    dur: 0.5,
    attack: 0.09, // 飘进来
    release: 0.28,
    noise: 0,
    lowpass: 3400,
    tremoloHz: 5.5,
    tremoloDepth: 0.22,
  },
};

/**
 * 呼噜——★**不是"给高音载波打 25Hz 调幅"，而是声带本身就以 ~25Hz 振动**（等同人声的 vocal fry）。
 * 实测：基频 22-27Hz、谱质心 ≈ 270Hz、能量到 1.5kHz 基本滚完。
 * 所以这里直接把基频写成 25Hz 让锯齿波产生完整谐波列，再用低共振峰把质心压到 270Hz 附近。
 * （我第一版写成 130Hz 载波 + 25Hz 颤音是错的模型，听起来会像"抖动的低音"而不是呼噜。）
 */
const PURR: SynthVoice = {
  f0: [[0, 25], [0.5, 27], [1, 24]],
  formants: [[[0, 260], [1, 240]], [[0, 520], [1, 480]], [[0, 900], [1, 850]]],
  q: [4, 4, 3],
  gains: [1, 0.45, 0.16],
  dur: 1.15,
  attack: 0.12,
  release: 0.3,
  noise: 0.02,
  lowpass: 1500, // 实测能量到 1.5kHz 就滚完了
  tremoloHz: 0,  // 周期性已经由 25Hz 基频本身给出，不再另加调幅
  tremoloDepth: 0,
};

const lerpAt = (points: Array<[number, number]>, t: number): number => {
  if (t <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i += 1) {
    if (t <= points[i][0]) {
      const [t0, v0] = points[i - 1];
      const [t1, v1] = points[i];
      const k = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
      return v0 + (v1 - v0) * k;
    }
  }
  return points[points.length - 1][1];
};

/** 把一条轨迹写进 AudioParam（用 setValueAtTime 打点，兼容性最好）。 */
function applyTrack(
  param: AudioParam,
  points: Array<[number, number]>,
  start: number,
  dur: number,
  scale: number,
  steps = 24,
): void {
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    param.setValueAtTime(lerpAt(points, t) * scale, start + t * dur);
  }
}

export type SynthOptions = {
  /** 音高整体缩放（1=基准）。每次叫随机一点点，天然不重复。 */
  pitch?: number;
  /** 时长缩放（1=基准）。 */
  speed?: number;
  /** 用呼噜档（仅猫有意义）。 */
  purr?: boolean;
  /**
   * 柔和度 0..1：压低 F2/F3 增益 + 下移低通截止。
   * ★存在的理由=**"像不像"和"好不好听"在这台机器上是冲突的**：
   * 照实测参数合成的猫叫最像真猫，但 F2≈3000Hz 正落在这只微型喇叭的刺耳共振区
   * （实测谱质心 2405Hz，高于 Ben 认可过的任何一条）。这个旋钮就是在两者之间取舍，
   * 交给耳朵定，不由我替他定。0=完全照实测、1=最柔（也最不像真猫）。
   */
  soften?: number;
};

/**
 * 在给定的 AudioContext 上合成一声，接到 destination，于 `when` 起播。
 * 返回这一声的时长（秒），调用方据此排下一声。
 */
export function synthesizeCall(
  ctx: BaseAudioContext,
  destination: AudioNode,
  species: SynthSpecies,
  when: number,
  opts: SynthOptions = {},
): number {
  const raw = opts.purr && species === 'cat' ? PURR : VOICES[species];
  const soften = Math.min(1, Math.max(0, opts.soften ?? 0));
  const base: SynthVoice = soften === 0 ? raw : {
    ...raw,
    // F2/F3 越压越柔（F1 不动——它承载"喵"的辨识度，压了就不像了）
    gains: raw.gains.map((g, i) => (i === 0 ? g : g * (1 - 0.75 * soften))),
    lowpass: raw.lowpass * (1 - 0.45 * soften),
    attack: raw.attack * (1 + 0.6 * soften), // 起音再软一点
  };
  const pitch = opts.pitch ?? 1;
  const dur = base.dur * (opts.speed ?? 1);

  const out = ctx.createGain();
  out.gain.value = 0;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = base.lowpass;
  lp.Q.value = 0.7;
  out.connect(lp);
  lp.connect(destination);

  // —— 声源：锯齿波（谐波丰富，像声带脉冲）+ 可选噪声 ——
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  applyTrack(osc.frequency, base.f0, when, dur, pitch);

  // 共振峰：三个并联带通，各自跟着轨迹走
  const sourceGain = ctx.createGain();
  sourceGain.gain.value = 1;
  osc.connect(sourceGain);

  let noiseSrc: AudioBufferSourceNode | null = null;
  if (base.noise > 0) {
    const n = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur) + 1, ctx.sampleRate);
    const d = n.getChannelData(0);
    for (let i = 0; i < d.length; i += 1) d[i] = Math.random() * 2 - 1;
    noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = n;
    const ng = ctx.createGain();
    ng.gain.value = base.noise;
    noiseSrc.connect(ng);
    ng.connect(sourceGain);
  }

  base.formants.forEach((track, i) => {
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = base.q[i];
    applyTrack(bp.frequency, track, when, dur, pitch);
    const g = ctx.createGain();
    g.gain.value = base.gains[i];
    sourceGain.connect(bp);
    bp.connect(g);
    g.connect(out);
  });

  // —— 幅度包络：软起音 + 自然衰减 ——
  const peak = 0.9;
  out.gain.setValueAtTime(0, when);
  out.gain.linearRampToValueAtTime(peak, when + base.attack);
  const holdEnd = Math.max(when + base.attack, when + dur - base.release);
  out.gain.setValueAtTime(peak, holdEnd);
  // 用指数尾巴收（比线性自然），终值不能为 0
  out.gain.exponentialRampToValueAtTime(0.0008, when + dur);

  // 颤音/呼噜的调幅
  if (base.tremoloHz > 0) {
    const lfo = ctx.createOscillator();
    lfo.frequency.value = base.tremoloHz;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = base.tremoloDepth;
    lfo.connect(lfoGain);
    lfoGain.connect(out.gain);
    lfo.start(when);
    lfo.stop(when + dur);
  }

  // 起音爆破：一小段直通的宽带噪声（不过共振峰，要的就是"啪"那一下）
  if (base.onsetBurst && base.onsetBurst > 0) {
    const bl = Math.ceil(ctx.sampleRate * base.onsetBurst) + 1;
    const nb = ctx.createBuffer(1, bl, ctx.sampleRate);
    const bd = nb.getChannelData(0);
    for (let i = 0; i < bl; i += 1) bd[i] = (Math.random() * 2 - 1) * (1 - i / bl);
    const bs = ctx.createBufferSource();
    bs.buffer = nb;
    const bg = ctx.createGain();
    bg.gain.value = 0.5;
    bs.connect(bg);
    bg.connect(lp); // 只过低通，不过共振峰
    bs.start(when);
    bs.stop(when + base.onsetBurst);
  }

  osc.start(when);
  osc.stop(when + dur);
  noiseSrc?.start(when);
  noiseSrc?.stop(when + dur);
  return dur;
}

/**
 * 参数出处（都来自实测文献，不是我拍脑袋定的）：
 * - 猫叫时长/基频拱形：Schötz, van de Weijer & Eklund 2019（780 声喵、40 只猫）；
 *   Sedova et al. 2023 归纳的"时长约 0.6s、f0峰 0.6-0.8kHz、首尾比峰低 0.1-0.15kHz"。
 * - 猫的共振峰与"喵"的滑动：Nicastro 2004（家猫 F1 1458 / F2 3053，call 中点测）；
 *   Ekström et al. 2024（张嘴 F1 1305→闭嘴 F1 602，听者 75-93% 听成 [au]，且**只给 F1 就够**）。
 * - 狗吠形态：Lord, Feinstein & Coppinger 2009（爆破起音+人字形调频+全程宽带噪声，单声 100-500ms）；
 *   Yin & McCowan 2004（各情境 mean F0 686-860Hz、谐噪比 5-10dB）。
 * - 小型犬共振峰：Riede & Fitch 1999（约克夏 F1 891/F2 1828、共振峰间距 1703Hz；
 *   ★体型线索靠**共振峰间距**而不是基频，F1 单独与声道长度不显著相关）。
 * - 呼噜：Eklund, Peters & Duthie 2010（基频 22-27Hz、每相 ~13 个周期、相长 ~575ms）；
 *   Herbst et al. 2023（离体喉即可在 25-30Hz 自持振荡，机制等同人声 vocal fry）。
 * - "可爱"的两个旋钮：Fitch 1997 / Taylor et al. 2008 —— **共振峰上移=体型更小**（比基频可靠）；
 *   Nicastro 2004 —— 基频与"悦耳度"正相关、时长与之负相关，两者合起来解释 80% 的评分方差。
 */
