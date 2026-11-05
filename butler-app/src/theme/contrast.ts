/**
 * WCAG 2.x 对比度纯函数。给色板测试用:每对前景 / 背景都要过阈值(正文 4.5:1)。
 * 只认 #rgb / #rrggbb;rgba 与 var() 不在这里算。
 */
export function parseHex(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (m === null) throw new Error(`不是十六进制颜色:${hex}`);
  const s = m[1]!.length === 3 ? m[1]!.split('').map((c) => c + c).join('') : m[1]!;
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)) as [number, number, number];
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(fg: string, bg: string): number {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** 把 styles.css 里 :root { --ba-xxx: #hex; } 读成表;非十六进制的(env()、rgba)跳过。 */
export function readPalette(css: string): Record<string, string> {
  const root = /:root\s*\{([^}]*)\}/.exec(css);
  if (root === null) return {};
  const out: Record<string, string> = {};
  for (const m of root[1]!.matchAll(/--(ba-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,6})\s*;/g)) out[m[1]!] = m[2]!.toLowerCase();
  return out;
}
