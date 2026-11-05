// 通话字幕 → 本地情绪判断（规则版）。
//
// 背景：通话走火山云端一体化智能体（ASR+LLM+TTS），只回传字幕文字、没有情绪标签，
// 所以在客户端用关键词规则从她说的话里判情绪，喂给 AU solver 驱动表情/动作。
// 设计成可替换：上层只依赖 classifyCallEmotion 的签名，后续如升级为后端小模型
// 判情绪，替换实现即可（见 docs 无需——签名不变）。
//
// 原则：拿不准返回 null（保持当前表情，宁可不动不要乱动）。

import type { Emotion } from './emotion.ts';

export type CallEmotionResult = {
  emotion: Emotion;
  /** 情绪强度 [0.4, 1]，喂 AU solver 的 intensity */
  intensity: number;
};

// 每种情绪的关键词表。命中计分，得分最高且 ≥1 分的情绪胜出。
// 注意顺序无关；同分时按此处声明顺序取先者（更常见的情绪放前面）。
const LEXICON: Array<{ emotion: Emotion; words: string[] }> = [
  {
    emotion: 'happy',
    words: ['哈哈', '嘿嘿', '嘻嘻', '开心', '高兴', '太好了', '真棒', '好棒', '真好', '好呀', '耶', '好开心', '笑死', '有趣', '好玩'],
  },
  {
    emotion: 'excited',
    words: ['太棒了', '哇塞', '兴奋', '激动', '迫不及待', '期待', '好期待', '燃起来', '冲呀', '厉害了'],
  },
  {
    emotion: 'sad',
    words: ['难过', '伤心', '委屈', '呜呜', '呜…', '心疼', '好可惜', '遗憾', '想哭', '哭了', '唉'],
  },
  {
    emotion: 'angry',
    words: ['生气', '气死', '讨厌', '哼！', '哼，', '烦死', '可恶', '过分', '气人'],
  },
  {
    emotion: 'surprised',
    words: ['真的吗', '真的假的', '竟然', '居然', '天哪', '天啊', '没想到', '不会吧', '什么？', '诶？', '啊？', '惊讶', '吓我'],
  },
  {
    emotion: 'shy',
    words: ['害羞', '脸红', '不好意思', '讨厌啦', '人家', '羞死', '别看我'],
  },
  {
    emotion: 'gentle',
    words: ['别担心', '没关系', '慢慢来', '我陪着你', '陪着你', '抱抱', '辛苦了', '晚安', '乖', '放心', '别难过', '照顾好'],
  },
];

// 「讨厌啦」是撒娇（shy），别被 angry 的「讨厌」抢走：先判长词。
// 实现上按词长排序计分即可覆盖（长词命中后从文本中挖掉，避免重复计分）。

/**
 * 从她说的一句话判情绪。拿不准返回 null（上层保持当前表情不动）。
 */
export function classifyCallEmotion(text: string): CallEmotionResult | null {
  const raw = (text ?? '').trim();
  if (!raw) return null;

  // 所有词按长度降序做一轮匹配：长词优先命中并从文本挖掉（「讨厌啦」不再喂给「讨厌」）。
  const entries: Array<{ emotion: Emotion; word: string }> = [];
  for (const { emotion, words } of LEXICON) {
    for (const word of words) entries.push({ emotion, word });
  }
  entries.sort((a, b) => b.word.length - a.word.length);

  const scores = new Map<Emotion, number>();
  let remaining = raw;
  for (const { emotion, word } of entries) {
    let hits = 0;
    let idx = remaining.indexOf(word);
    while (idx !== -1) {
      hits += 1;
      remaining = remaining.slice(0, idx) + remaining.slice(idx + word.length);
      idx = remaining.indexOf(word);
    }
    if (hits > 0) scores.set(emotion, (scores.get(emotion) ?? 0) + hits);
  }
  if (scores.size === 0) return null;

  // 同分取 LEXICON 声明顺序在前者
  let best: Emotion | null = null;
  let bestScore = 0;
  for (const { emotion } of LEXICON) {
    const s = scores.get(emotion) ?? 0;
    if (s > bestScore) {
      best = emotion;
      bestScore = s;
    }
  }
  if (!best) return null;

  // 强度：基础 0.55，命中次数每次 +0.12；感叹号/波浪号每个 +0.06；封顶 1、保底 0.4。
  const bangs = (raw.match(/[!！~～]/g) ?? []).length;
  const intensity = Math.max(0.4, Math.min(1, 0.55 + (bestScore - 1) * 0.12 + bangs * 0.06));

  return { emotion: best, intensity };
}

// 情绪 → 动作组名的模糊匹配词根（Live2D 模型动作组常见命名）。
const MOTION_HINTS: Record<Emotion, RegExp | null> = {
  neutral: null,
  happy: /happy|joy|smile|laugh/i,
  excited: /excit|cheer|jump|happy/i,
  sad: /sad|cry|sob/i,
  angry: /angry|mad|rage/i,
  surprised: /surpris|shock/i,
  shy: /shy|blush/i,
  gentle: /gentle|nod/i,
};

/**
 * 在角色动作库（motion group 名）里找匹配该情绪的动作组，找不到返回 undefined。
 * 只做名称模糊匹配：模型没标情绪动作时宁可不播。
 */
export function findEmotionMotion(
  motions: Record<string, unknown> | undefined,
  emotion: Emotion,
): string | undefined {
  if (!motions) return undefined;
  const hint = MOTION_HINTS[emotion];
  if (!hint) return undefined;
  return Object.keys(motions).find((key) => hint.test(key));
}
