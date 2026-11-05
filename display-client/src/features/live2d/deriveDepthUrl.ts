/**
 * 从背景图 URL 推导深度图 URL（按命名约定 <name>.depth.png）
 * @param bgUrl 背景图 URL（可含 query/hash）
 * @returns 深度图 URL 或 null（无扩展名/blob/data/空值）
 */
export function deriveDepthUrl(bgUrl: string): string | null {
  if (!bgUrl) return null;

  // 过滤 blob: / data:
  if (bgUrl.startsWith('blob:') || bgUrl.startsWith('data:')) {
    return null;
  }

  // 剥离 query (?...) 和 hash (#...)
  const cleanUrl = bgUrl.split('?')[0].split('#')[0];
  if (!cleanUrl) return null;

  // 提取路径的最后一个 . 之后部分（扩展名）
  const lastSlash = cleanUrl.lastIndexOf('/');
  const filename = lastSlash === -1 ? cleanUrl : cleanUrl.substring(lastSlash + 1);
  const lastDot = filename.lastIndexOf('.');

  // 无扩展名 → null
  if (lastDot === -1) return null;

  // 替换扩展名为 .depth.png
  const dir = cleanUrl.substring(0, lastSlash + 1);
  const nameWithoutExt = filename.substring(0, lastDot);
  return `${dir}${nameWithoutExt}.depth.png`;
}
