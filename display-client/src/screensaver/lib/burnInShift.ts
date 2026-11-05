import { useEffect, useState } from 'react';

/**
 * OLED 防烧屏：每隔 intervalMs 让整屏内容做一次微小位移（±maxPx）。
 * Pixel 10 Pro 是高亮 LTPO OLED，长时间静态高对比 UI 有烧屏风险。
 * 返回一个 CSS transform 字符串，挂到最外层容器上（配合 CSS transition 平滑过渡）。
 */
export function useBurnInShift(intervalMs = 60_000, maxPx = 8): string {
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setIdx((i) => (i + 1) % SHIFT_PATTERN.length);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  const [dx, dy] = SHIFT_PATTERN[idx];
  return `translate(${dx * maxPx}px, ${dy * maxPx}px)`;
}

// 缓慢绕一圈的位移序列（单位为 maxPx 的倍数），避免任何像素长期承担同一高亮内容。
const SHIFT_PATTERN: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];
