// 语音情绪：LLM 输出的统一情绪枚举，作为客户端↔服务端的契约。
// LLM 只能从 EMOTIONS 里选；TTS 据此驱动语气：
//  - Qwen(DashScope)：映射成中文语气描述，拼进 instructions（客户端完成）。
//  - SeedTTS(火山)：映射成 audio.emotion 枚举（服务端 volcengine.cjs 完成）。
// ⚠️ 改动枚举值时，需同步 server/services/volcengine.cjs 里的 VOLC_EMOTION 映射。

export const EMOTIONS = [
  'neutral',
  'happy',
  'sad',
  'angry',
  'surprised',
  'shy',
  'gentle',
  'excited',
] as const;

export type Emotion = (typeof EMOTIONS)[number];

const EMOTION_SET = new Set<string>(EMOTIONS);

/** 把任意输入收敛为合法 Emotion；非法/缺失一律回退 neutral。 */
export function normalizeEmotion(raw: unknown): Emotion {
  if (typeof raw === 'string') {
    const value = raw.trim().toLowerCase();
    if (EMOTION_SET.has(value)) return value as Emotion;
  }
  return 'neutral';
}

// 情绪 → Qwen instructions 追加的中文语气描述。
// neutral 返回空串，表示沿用角色基线音色、不额外加情绪。
const QWEN_EMOTION_PHRASE: Record<Emotion, string> = {
  neutral: '',
  happy: '用开心、轻快的语气说',
  sad: '用低落、温柔的语气说',
  angry: '用生气、不耐烦的语气说',
  surprised: '用惊讶的语气说',
  shy: '用害羞、小声的语气说',
  gentle: '用温柔、体贴的语气说',
  excited: '用兴奋、激动的语气说',
};

/** 取该情绪对应的 Qwen 语气描述；neutral 返回空串。 */
export function emotionToQwenInstruction(emotion: Emotion): string {
  return QWEN_EMOTION_PHRASE[emotion] ?? '';
}
