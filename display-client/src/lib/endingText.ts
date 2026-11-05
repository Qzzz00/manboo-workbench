/**
 * 结局对白分句工具。
 *
 * 按中文/英文常用句末标点 + 换行切分，保留非空句，过滤掉纯空白片段。
 * 用于 EndingScene 的逐句呈现。
 */

// 不能用 lookbehind 正则（Chrome 61 WebView 不支持 ES2018 正则，模块实例化即 SyntaxError）；
// 手写「分隔符后断开」扫描，语义与原 /(?<=[。！？!?~～…；;]|\n)/ 一致。
const SENTENCE_END_CHARS = '。！？!?~～…；;\n';

export function splitEndingText(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const sentences: string[] = [];
  let buf = '';
  for (const ch of normalized) {
    buf += ch;
    if (SENTENCE_END_CHARS.indexOf(ch) >= 0) {
      sentences.push(buf);
      buf = '';
    }
  }
  if (buf) sentences.push(buf);

  return sentences
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}
