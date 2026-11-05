/**
 * 「电话里把视频弹到眼前」(2026-10-12,周三演示「出图进可灵」那条链路的末尾)。
 *
 * 维护者原话:「看到视频之后推到手机端上,再打个电话过来,并且可以在手机上(通话过程中)看到视频。
 * 播放器以弹窗形式弹到通话页面上,给个关闭的 icon。」
 *
 * 这个文件只放两个纯函数(没有 React、不碰原生),通话中那一层照它做事:
 *   · {@link inCallVideoOffer}:电脑推过来的几张卡里,哪一个该现在自己弹出来 ——
 *     **只有视频自己弹**(别的照旧等挂了电话再摆 {@link ../files/FileAskCard} 那张卡),
 *     **弹过一次就不再弹**(她关掉的不要回来);
 *   · {@link playableFileSrc}:存进「文档 / 事务官」的那个文件 → 一个 WebView 里 `<video>` 吃得下的地址
 *     (Capacitor 的 `convertFileSrc`,与 App 同源;拿不到就缺席,不编一个)。
 */
import { kindOfName, type FileAsk, type FileAskHit } from './fileFetch';

export interface InCallVideoPick {
  ask: FileAsk;
  hit: FileAskHit;
}

/** 这个候选是不是一段视频。`kind` 是网络上来的,**名字是真相**:两样认任一样。 */
export function isVideoHit(hit: FileAskHit): boolean {
  return hit.kind === 'video' || kindOfName(hit.name) === 'video';
}

/**
 * 通话中该自己弹的那一个(没有就 null)。`shownIds` 是已经弹过 / 关过的取件单号。
 *
 * 挑的是「第一张卡里的第一段视频」:同一张卡上既有分镜又有成片时挑成片 —— 电话里要看的是片子。
 */
export function inCallVideoOffer(
  asks: readonly FileAsk[],
  shownIds: ReadonlySet<string>,
): InCallVideoPick | null {
  for (const ask of asks) {
    for (const hit of ask.hits) {
      if (!isVideoHit(hit) || shownIds.has(hit.offer)) continue;
      return { ask, hit };
    }
  }
  return null;
}

/** `Capacitor.convertFileSrc` 那一下。测试里换掉。 */
export type ConvertFileSrc = (uri: string) => string;

function defaultConvert(uri: string): string {
  try {
    const capacitor = (globalThis as { Capacitor?: { convertFileSrc?: ConvertFileSrc } }).Capacitor;
    return capacitor?.convertFileSrc?.(uri) ?? uri;
  } catch {
    return uri;
  }
}

/**
 * 存下来的那个文件 → 能放的地址。**只认原生给的 `file://` 地址**:
 * 浏览器里(vite dev)那条退路是「浏览器的下载」,盘上没有路径,这里就该缺席 ——
 * 那时候弹窗如实说一句,不摆一个放不出东西的框。
 *
 * 文件夹名是中文(「文档 / 事务官」):非 ASCII 编一遍再交给 WebView。
 */
export function playableFileSrc(
  file: { uri?: string; path?: string } | undefined,
  convert: ConvertFileSrc = defaultConvert,
): string | undefined {
  if (file?.uri === undefined || file.uri === '') return undefined;
  const src = convert(file.uri);
  if (src === '') return undefined;
  return src.replace(/[^\x20-\x7e]/g, (ch) => encodeURIComponent(ch));
}
