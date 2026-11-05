// 歌词解析（LRC + 翻译 LRC → 有序双语行）与当前行定位。
// 纯函数、无副作用——holoLyric.test.ts 锁死边界；前端播放器与后端透传共用一份解析。

export type LyricLine = { t: number /* ms */; text: string; trans?: string };

// [mm:ss.xx] / [mm:ss.xxx] / [mm:ss] 时间标签；一行可有多个。
const TAG = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
// 纯元数据标签行（无正文）：[ti:] [ar:] [al:] [by:] [offset:] 等。
const META_ONLY = /^\s*\[[a-zA-Z]+:[^\]]*\]\s*$/;
const INSTRUMENTAL = /纯音乐/;

/** 解析一段 LRC，返回 {t,text}[]（未排序、未过滤纯音乐）。 */
function parseRaw(text: string | null | undefined): Array<{ t: number; text: string }> {
  if (!text) return [];
  const out: Array<{ t: number; text: string }> = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine;
    if (!line.trim()) continue;
    if (META_ONLY.test(line)) continue;
    TAG.lastIndex = 0;
    const stamps: number[] = [];
    let m: RegExpExecArray | null;
    let lastEnd = 0;
    while ((m = TAG.exec(line))) {
      const min = Number(m[1]);
      const sec = Number(m[2]);
      const frac = m[3] ?? '';
      // 两位=百分秒、三位=毫秒；一位当十分秒。
      const ms = frac ? Math.round(Number(frac) * 10 ** (3 - frac.length)) : 0;
      stamps.push(min * 60_000 + sec * 1000 + ms);
      lastEnd = TAG.lastIndex;
    }
    if (!stamps.length) continue; // 无时间标签的行丢弃
    const content = line.slice(lastEnd).trim();
    if (!content) continue; // 只有时间标签、无正文
    for (const t of stamps) out.push({ t, text: content });
  }
  return out;
}

/**
 * 合并原文 LRC 与翻译 LRC。翻译按时间戳对齐（缺行不串位），
 * 输出按时间升序；识别「纯音乐」返回空数组。
 */
export function parseLyric(lrc: string | null | undefined, tlyric: string | null | undefined): LyricLine[] {
  const base = parseRaw(lrc);
  if (!base.length) return [];
  if (base.length === 1 && INSTRUMENTAL.test(base[0].text)) return [];
  // 只要有正文行含「纯音乐」且没有别的实义歌词，视为纯音乐。
  if (base.every((l) => INSTRUMENTAL.test(l.text))) return [];

  const transByTime = new Map<number, string>();
  for (const { t, text } of parseRaw(tlyric)) {
    if (!transByTime.has(t)) transByTime.set(t, text); // 同一时间取首个翻译
  }

  const lines: LyricLine[] = base.map(({ t, text }) => {
    const trans = transByTime.get(t);
    return trans ? { t, text, trans } : { t, text };
  });
  lines.sort((a, b) => a.t - b.t);
  return lines;
}

/** 返回 t<=positionMs 的最后一行下标；位置在首行之前或空歌词时 -1。 */
export function currentLyricIndex(lines: LyricLine[], positionMs: number): number {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].t <= positionMs) idx = i;
    else break;
  }
  return idx;
}
