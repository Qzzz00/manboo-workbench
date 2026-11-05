/** 一言(hitokoto.cn)：免key直连(CORS *)。c=i 诗词类,限长24字装进一行卡宽。 */
export const HITOKOTO_URL = 'https://v1.hitokoto.cn/?c=i&max_length=24';

/** 解析一言响应为展示串；字段缺失/非法返回 null(整行隐藏)。from_who(作者)优先于 from(作品)。 */
export function parseHitokoto(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const d = json as { hitokoto?: unknown; from?: unknown; from_who?: unknown };
  const text = typeof d.hitokoto === 'string' ? d.hitokoto.trim() : '';
  if (!text) return null;
  const who = typeof d.from_who === 'string' ? d.from_who.trim() : '';
  const from = typeof d.from === 'string' ? d.from.trim() : '';
  const source = who || from;
  return source ? `「${text}」—— ${source}` : `「${text}」`;
}
