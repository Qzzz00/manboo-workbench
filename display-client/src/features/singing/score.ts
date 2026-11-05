/**
 * 乐谱：哼和唱共用的唯一「曲子」表示。换声源不换曲子——
 * 同一份 Score 既能被 HumVoice 实时哼出来，也能挂预烤素材变成 ClipVoice（P3）。
 */

export type Note = {
  /** MIDI 音高，60=中央C；null=休止符 */
  pitch: number | null;
  /** 时值（拍） */
  beats: number;
  /** 哼唱=元音（'m'/'a'/'u'），唱词=字。P2 只哼，此字段暂不消费。 */
  syllable?: string;
};

export type Score = {
  id: string;
  title: string;
  bpm: number;
  notes: Note[];
};

/** 音域下/上限：低于 36(C2) 或高于 96(C7) 的人声都不现实，多半是数据写错。 */
const MIN_PITCH = 36;
const MAX_PITCH = 96;

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** 音分 → 频率倍率。100 音分 = 半音，1200 音分 = 八度。 */
export function centsToRatio(cents: number): number {
  return Math.pow(2, cents / 1200);
}

export function scoreDurationSec(score: Score): number {
  const secPerBeat = 60 / score.bpm;
  return score.notes.reduce((sum, n) => sum + n.beats, 0) * secPerBeat;
}

/** 返回错误信息数组；空数组=合法。不抛异常——曲库校验要能一次报全部问题。 */
export function validateScore(score: Score): string[] {
  const errors: string[] = [];
  if (!score.id) errors.push('id 不能为空');
  if (!(score.bpm > 0)) errors.push('bpm 必须 > 0');
  if (!score.notes || score.notes.length === 0) {
    errors.push('notes 不能为空');
    return errors;
  }
  score.notes.forEach((n, i) => {
    if (!(n.beats > 0)) errors.push(`notes[${i}].beats 必须 > 0`);
    if (n.pitch !== null && !(n.pitch >= MIN_PITCH && n.pitch <= MAX_PITCH)) {
      errors.push(`notes[${i}].pitch 必须在 ${MIN_PITCH}..${MAX_PITCH} 之间或为 null`);
    }
  });
  return errors;
}
