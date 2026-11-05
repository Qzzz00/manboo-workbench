// 流式文本 → 可以立刻拿去合成语音的完整句。
//
// ★为什么要按句切：TTS 一次云端往返约 0.5-1 秒。等整段答案（150 字）出完再合成，
// 玩家要多等一整轮；按句切就能「第一句还在念、第二句已经在合成」，把往返藏起来。
// ★为什么无标点也要强切：真实模型偶尔一口气不打标点，卡死在缓冲区里等于哑了。

/**
 * 句末标点。
 * 中文全角标点 + 英文 ? !（军师偶尔混英文），换行也算断句。
 * ★刻意不认英文句点 `.`：会误伤小数（Lv1.5）与缩写，切出一堆碎句。
 */
const END_RE = /[。！？!?\n]/;

/** 无标点时的强制断句长度。40 字约等于一次自然停顿，也在 TTS 单次请求的舒适区。 */
const FORCE_LEN = 40;

export function takeCompleteSentences(buffer: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let rest = buffer;

  for (;;) {
    const m = END_RE.exec(rest);
    if (m) {
      const cut = m.index + 1;
      const piece = rest.slice(0, cut);
      rest = rest.slice(cut);
      // 纯标点/纯空白不值得合成：浪费一次请求，且火山对空文本会直接报错。
      if (piece.replace(/[。！？!?\s\n]/g, '') !== '') sentences.push(piece.replace(/\n/g, ''));
      continue;
    }
    if (rest.length > FORCE_LEN) {
      sentences.push(rest.slice(0, FORCE_LEN));
      rest = rest.slice(FORCE_LEN);
      continue;
    }
    break;
  }
  return { sentences, rest };
}
