/**
 * 简易 token 估算：
 * - CJK 字符 ≈ 1 token
 * - 其他字符 ≈ 0.25 token（按 4 字符 ≈ 1 token）
 * 该估算仅用于滚动窗口预算控制，不追求精确。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjkCount = 0;
  let otherCount = 0;
  for (const char of text) {
    // CJK Unified Ideographs, CJK Ext A, B, C, D, E, F, G, H, I
    // + Hiragana, Katakana, Hangul, Fullwidth forms
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(char)) {
      cjkCount += 1;
    } else {
      otherCount += 1;
    }
  }
  return Math.ceil(cjkCount + otherCount / 4);
}
