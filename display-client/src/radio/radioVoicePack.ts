/**
 * 电台 DJ 的「应答叫声」音库与编排（纯函数，不碰 Web Audio / DOM，播放在 animalVoice.ts）。
 *
 * ★为什么不用 TTS：这几只 DJ 是猫/狗/幽灵，不会说人话（Ben：「小猫小狗是不会说人话的，
 * 只会有一些不用语调的叫声」）。角色的"回应"= 一声「我听到你了」，
 * 挂在「ASR 返回非空文本」那一刻——不等 LLM 回合，但必须等 ASR
 * （能量 VAD 分不出音乐和人声，不等 ASR 会对着音乐乱叫；见 RadioApp 的 onHeard 注释）。
 *
 * ★这里只有一个「应答池」，没有情绪→叫声的映射：应答是「听到了」而不是「我对你说的话有什么感受」，
 * 所以一律从应答池随机挑。情绪表达由动作/表情承担（onHeard → performCallUtterance）。
 *
 * 素材许可：全部 CC0（免署名/可商用/可再分发），来自 OpenGameArt，
 * 逐个提交页核实过 publicdomain/zero/1.0。出处见 public/radio/voices/CREDITS.md。
 */

import { cryVariantCount } from './animalCry.ts';

export type VoiceSpecies = 'cat' | 'dog' | 'ghost';

/**
 * ★发声方式按【角色的美术风格】分，不按物种分——这是 Ben 试听一圈后点出来的关键：
 * 「现在生成的猫的声音其实不像猫，但是很合适给幽灵小狗用，可能是因为幽灵小狗也很宝可梦吧」。
 *
 * - 黑猫 hijiki 是**写实画风**的猫 → 配方波叫声会违和，用他亲自挑过的真实录音（他评价"比较舒服"）
 * - 幽灵狗 / 小幽灵是**卡通造型** → 宝可梦式方波叫声正好对味，而且现场合成永不重复、零素材体积
 *
 * 换句话说：写实的角色配写实的声音，卡通的角色配风格化的声音。
 * 之前五轮全军覆没，就是因为我一直在给所有角色找同一种声音。
 */
export type VoiceMode = 'samples' | 'cry';

/** 角色 → 物种。未列出的角色没有叫声音库（回落 null，上层直接不发声）。 */
const SPECIES_BY_AVATAR: Record<string, VoiceSpecies> = {
  hijiki: 'cat',
  tororo: 'cat', // 换回小白猫时也能用（同为猫）
  ghostpuppy: 'dog',
  ghostie: 'ghost',
};

const BASE = '/radio/voices';

const MODE_BY_SPECIES: Record<VoiceSpecies, VoiceMode> = {
  cat: 'samples', // 写实黑猫：用 Ben 挑定的三条真实录音
  dog: 'cry',     // 幽灵狗：宝可梦式合成
  ghost: 'cry',   // 小幽灵：宝可梦式合成
};

/** 合成叫声用哪套音色（cry 模式才有意义）。幽灵狗用"猫"那条音高折线——
 * Ben 说它「不像猫但很适合幽灵小狗」，就按他的耳朵来，名字只是参数集的标签。 */
const CRY_VOICE_BY_SPECIES: Record<VoiceSpecies, 'cat' | 'dog' | 'ghost'> = {
  cat: 'cat',
  dog: 'cat',
  ghost: 'ghost',
};

/** 合成叫声的低通缩放（越小越暖）。真机试听后可调。 */
const CRY_TONE_SCALE = 1;

/** 合成档在 lastAck 里存的是"上次用了第几种叫法"，加个前缀与素材 URL 区分开。 */
export const CRY_EXCLUDE_PREFIX = 'cry:';

/**
 * 应答池：每次「听到你说完话」就从这里挑着叫。
 *
 * ★猫只留 3 条是 Ben 逐条试听后点名的（meow-demand / mew-purr / mew-soft）。
 * 被剔掉的 meow-short、meow-kitten、mwa 他明确说「比较尖锐，慎用」。
 * 注意 meow-kitten 的谱质心才 1294Hz（比留下的 meow-demand 1641Hz 还低），
 * **说明"尖锐"并不能只用谱质心预测**——别再拿亮度指标去替耳朵做判断。
 *
 * 池子小了会重复，靠 planAck 的**随机变速**补变化（见下），不靠堆素材。
 */
const ACK: Record<VoiceSpecies, string[]> = {
  cat: ['meow-demand.ogg', 'mew-purr.ogg', 'mew-soft.ogg'],
  dog: ['bark-1.ogg', 'bark-2.ogg', 'bark-3.ogg', 'bark-soft.ogg', 'barking-1.ogg', 'barking-2.ogg', 'howl.ogg'],
  ghost: ['cute-01.ogg', 'cute-02.ogg', 'cute-03.ogg', 'cute-04.ogg', 'cute-05.ogg', 'cute-06.ogg',
    'ooh.ogg', 'weird-01.ogg', 'weird-03.ogg', 'weird-04.ogg'],
};

/**
 * 一次应答叫几声 + 声与声之间的间隔(ms)。
 * ★狗要连叫：Ben「小狗的都还行，就是很简短，狗狗的可能是要分很多声结合在一起吧」——
 * 单独一声 0.2s 的「汪」确实像打嗝不像狗叫，真狗就是「汪汪汪」连成一串。
 * 猫/幽灵保持单声（猫连叫反而聒噪）。
 */
const BURST: Record<VoiceSpecies, { min: number; max: number; gapMs: [number, number] }> = {
  cat: { min: 1, max: 1, gapMs: [0, 0] },
  dog: { min: 2, max: 3, gapMs: [90, 190] },
  ghost: { min: 1, max: 1, gapMs: [0, 0] },
};

/** 随机变速幅度：±7%。同一条素材每次播放音高/长短都略有不同，少量素材也不显得复读。 */
const RATE_JITTER = 0.07;

/**
 * 一次应答的完整编排。两种来源二选一（见 MODE_BY_SPECIES）：
 * - samples：播素材文件（写实角色）
 * - cry：现场合成宝可梦式叫声（卡通角色），不占素材体积、每次都不一样
 */
export type AckPlan =
  | {
      kind: 'samples';
      /** 依次播放的叫声 URL（长度 ≥1）。 */
      clips: string[];
      /** 第 i 条相对第 i-1 条结束的间隔(ms)，长度与 clips 相同，首项恒为 0。 */
      gaps: number[];
      /** 第 i 条的播放倍速（1=原速）。 */
      rates: number[];
    }
  | {
      kind: 'cry';
      voice: 'cat' | 'dog' | 'ghost';
      /** 挑第几种叫法（"叫声词汇表"里的下标）——变化主要来自这里，不是音高抖动。 */
      variant: number;
      pitch: number;
      speed: number;
      toneScale: number;
    };

export function voiceModeFor(avatarId: string): VoiceMode | null {
  const sp = speciesForAvatar(avatarId);
  return sp ? MODE_BY_SPECIES[sp] : null;
}

export function speciesForAvatar(avatarId: string): VoiceSpecies | null {
  return SPECIES_BY_AVATAR[avatarId] ?? null;
}

/** 应答池的完整 URL 列表（该角色没有音库时空数组）。也是预热清单。 */
export function ackClipsFor(avatarId: string): string[] {
  const species = speciesForAvatar(avatarId);
  if (!species || MODE_BY_SPECIES[species] !== 'samples') return []; // 合成的角色没有素材要预热
  return ACK[species].map((f) => `${BASE}/${species}/${f}`);
}

/** 预热清单 = 应答池（现在只有这一个池子）。 */
export const allVoiceClipsFor = ackClipsFor;

/**
 * 编排一次应答。rand 注入便于测试（默认 Math.random）。
 * @param exclude 上一次应答的首条 URL——避免连着两次以同一声开头（重复感的最大来源）。
 * 没有音库返回 null（上层据此跳过发声，不报错）。
 */
export function planAck(
  avatarId: string,
  exclude?: string | null,
  rand: () => number = Math.random,
): AckPlan | null {
  const species = speciesForAvatar(avatarId);
  if (!species) return null;

  if (MODE_BY_SPECIES[species] === 'cry') {
    const voice = CRY_VOICE_BY_SPECIES[species];
    // ★变化的主体是"挑哪种叫法"（不同音高折线/音节数），音高时长抖动只是锦上添花——
    // Ben 反馈「就一两条」正是因为之前只有一条折线、光靠抖动听着还是同一声。
    // exclude 在合成档里存的是上次的变体下标（字符串形式），避免连着两次同一种叫法。
    const n = cryVariantCount(voice);
    const prev = exclude != null && exclude.startsWith(CRY_EXCLUDE_PREFIX)
      ? Number(exclude.slice(CRY_EXCLUDE_PREFIX.length))
      : -1;
    let variant = Math.min(n - 1, Math.floor(rand() * n));
    if (n > 1 && variant === prev) variant = (variant + 1) % n; // 撞上一次就顺延一个
    return {
      kind: 'cry',
      voice,
      variant,
      pitch: 0.94 + rand() * 0.12,
      speed: 0.92 + rand() * 0.16,
      toneScale: CRY_TONE_SCALE,
    };
  }

  const clips = ackClipsFor(avatarId);
  if (clips.length === 0) return null;

  const burst = BURST[species];
  const span = burst.max - burst.min + 1;
  const count = burst.min + Math.min(span - 1, Math.floor(rand() * span));

  const pickFrom = (avoid: string | null | undefined): string => {
    const pool = clips.length > 1 && avoid ? clips.filter((c) => c !== avoid) : clips;
    const src = pool.length > 0 ? pool : clips;
    return src[Math.min(src.length - 1, Math.floor(rand() * src.length))];
  };

  const out = { kind: 'samples' as const, clips: [] as string[], gaps: [] as number[], rates: [] as number[] };
  let prev: string | null | undefined = exclude;
  for (let i = 0; i < count; i += 1) {
    const clip = pickFrom(prev);
    prev = clip; // 串内也不连着重复同一条
    out.clips.push(clip);
    out.gaps.push(i === 0 ? 0 : burst.gapMs[0] + rand() * (burst.gapMs[1] - burst.gapMs[0]));
    out.rates.push(1 - RATE_JITTER + rand() * (RATE_JITTER * 2));
  }
  return out;
}

/**
 * ——宠物互动叫声（planAck 的姊妹）：按「心情」点名变体，而不是随机——
 * 应答池是「我听到你了」，一律随机；宠物反应是「我对你摸/喂的态度」，
 * 心情必须落在具体的叫法上（撒娇打颤≠嘟囔）。变体语义见 animalCry.ts 各变体注释。
 */
export type PetCryMood = 'happy' | 'delight' | 'curious' | 'grumble' | 'plead' | 'greet';

// 音色 → 心情 → 变体候选池（0 起始下标；注释里的编号是 1 起始，差 1）。
const PET_CRY_VARIANTS: Record<'cat' | 'dog' | 'ghost', Record<PetCryMood, number[]>> = {
  cat: { happy: [5, 1], delight: [5, 7], curious: [3], grumble: [4], plead: [6], greet: [7] },
  dog: { happy: [0], delight: [1], curious: [0], grumble: [0], plead: [1], greet: [1] }, // 备用写实汪（2 变体）
  ghost: { happy: [0, 3], delight: [4], curious: [2], grumble: [1], plead: [3], greet: [4] },
};

// 素材档（黑猫 3 条：0=meow-demand 1=mew-purr 2=mew-soft）：心情=选哪条+基准变速。
const PET_SAMPLE_MOOD: Record<PetCryMood, { clip: number; rate: number }> = {
  happy: { clip: 1, rate: 1.0 },
  delight: { clip: 0, rate: 1.02 },
  curious: { clip: 2, rate: 1.0 },
  grumble: { clip: 2, rate: 0.85 }, // 低落变速喵=高冷不耐烦
  plead: { clip: 0, rate: 0.92 },
  greet: { clip: 1, rate: 1.0 },
};

export function planPetCry(
  avatarId: string,
  mood: PetCryMood,
  rand: () => number = Math.random,
): AckPlan | null {
  const species = speciesForAvatar(avatarId);
  if (!species) return null;

  if (MODE_BY_SPECIES[species] === 'cry') {
    const voice = CRY_VOICE_BY_SPECIES[species];
    const pool = PET_CRY_VARIANTS[voice][mood];
    const n = cryVariantCount(voice);
    const pick = pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
    return {
      kind: 'cry',
      voice,
      variant: Math.min(n - 1, pick),
      pitch: 0.96 + rand() * 0.08,
      speed: 0.94 + rand() * 0.12,
      toneScale: CRY_TONE_SCALE,
    };
  }

  const clips = ackClipsFor(avatarId);
  if (clips.length === 0) return null;
  const m = PET_SAMPLE_MOOD[mood];
  return {
    kind: 'samples',
    clips: [clips[Math.min(clips.length - 1, m.clip)]],
    gaps: [0],
    rates: [m.rate - 0.03 + rand() * 0.06],
  };
}
