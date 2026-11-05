/**
 * 待机哼唱的曲目表——全部公有领域，无版权风险。
 * 每首都截成 8–25 秒的一小段：待机哼唱是「随口来一段」，不是完整演唱。
 */
import type { Score } from './score.ts';
import { DEFAULT_HUM_PROFILE, type HumVoiceProfile } from './humPlan.ts';

const TWINKLE: Score = {
  id: 'twinkle', title: '小星星', bpm: 92,
  notes: [
    { pitch: 60, beats: 1 }, { pitch: 60, beats: 1 }, { pitch: 67, beats: 1 }, { pitch: 67, beats: 1 },
    { pitch: 69, beats: 1 }, { pitch: 69, beats: 1 }, { pitch: 67, beats: 2 }, { pitch: null, beats: 0.5 },
    { pitch: 65, beats: 1 }, { pitch: 65, beats: 1 }, { pitch: 64, beats: 1 }, { pitch: 64, beats: 1 },
    { pitch: 62, beats: 1 }, { pitch: 62, beats: 1 }, { pitch: 60, beats: 2 }, { pitch: null, beats: 1 },
    { pitch: 67, beats: 1 }, { pitch: 67, beats: 1 }, { pitch: 65, beats: 1 }, { pitch: 65, beats: 1 },
    { pitch: 64, beats: 1 }, { pitch: 64, beats: 1 }, { pitch: 62, beats: 2 },
  ],
};

const TWO_TIGERS: Score = {
  id: 'twoTigers', title: '两只老虎', bpm: 104,
  notes: [
    { pitch: 60, beats: 1 }, { pitch: 62, beats: 1 }, { pitch: 64, beats: 1 }, { pitch: 60, beats: 1 },
    { pitch: 60, beats: 1 }, { pitch: 62, beats: 1 }, { pitch: 64, beats: 1 }, { pitch: 60, beats: 1 },
    { pitch: 64, beats: 1 }, { pitch: 65, beats: 1 }, { pitch: 67, beats: 2 }, { pitch: null, beats: 0.5 },
    { pitch: 64, beats: 1 }, { pitch: 65, beats: 1 }, { pitch: 67, beats: 2 }, { pitch: null, beats: 1 },
    { pitch: 67, beats: 0.75 }, { pitch: 69, beats: 0.25 }, { pitch: 67, beats: 0.75 }, { pitch: 65, beats: 0.25 },
    { pitch: 64, beats: 1 }, { pitch: 60, beats: 2 },
  ],
};

const AULD_LANG_SYNE: Score = {
  id: 'auldLangSyne', title: '友谊地久天长', bpm: 84,
  notes: [
    { pitch: 60, beats: 1 }, { pitch: 65, beats: 1.5 }, { pitch: 64, beats: 0.5 }, { pitch: 65, beats: 1 },
    { pitch: 69, beats: 1 }, { pitch: 67, beats: 1.5 }, { pitch: 65, beats: 0.5 }, { pitch: 65, beats: 1 },
    { pitch: 69, beats: 1 }, { pitch: 72, beats: 2 }, { pitch: null, beats: 0.5 },
    { pitch: 74, beats: 1 }, { pitch: 72, beats: 1.5 }, { pitch: 69, beats: 0.5 }, { pitch: 69, beats: 1 },
    { pitch: 65, beats: 1 }, { pitch: 67, beats: 2 },
  ],
};

export const HUM_TUNES: Score[] = [TWINKLE, TWO_TIGERS, AULD_LANG_SYNE];

/**
 * 每角色的哼唱音色。
 * ★formantScale 才是「体型/年龄感」的旋钮——声道越短共振峰越高，大脑据此判定角色更小。
 * transpose 只是把同一个人唱高唱低，单独调它不会让角色听起来更可爱
 * （animalSynth.ts 开头记录过这个坑）。两个旋钮都要动。
 */
const PROFILES: Record<string, Partial<HumVoiceProfile>> = {
  yumi: { transpose: 2, formantScale: 1.1 },
  ellen: { transpose: 0, formantScale: 1.0 },
  bingtang: { transpose: 3, formantScale: 1.15 },
  strawberryBunny: { transpose: 4, formantScale: 1.2, vibratoCents: 30 },
  rabbitHole: { transpose: 2, formantScale: 1.12 },
  fuxuan: { transpose: -1, formantScale: 0.95, vibratoHz: 5 },
  huohuo: { transpose: 4, formantScale: 1.18 },
  shuangsheng: { transpose: 1, formantScale: 1.05 },
  seethrough: { transpose: 0, formantScale: 1.0, breathiness: 0.12 },
};

export function humProfileFor(avatarId: string): HumVoiceProfile {
  return { ...DEFAULT_HUM_PROFILE, ...(PROFILES[avatarId] ?? {}) };
}

export function pickHumTune(rng: () => number = Math.random): Score {
  const i = Math.min(HUM_TUNES.length - 1, Math.floor(rng() * HUM_TUNES.length));
  return HUM_TUNES[i];
}
