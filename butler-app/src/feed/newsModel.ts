/**
 * 手机「资讯」页的只读契约与纯函数(2026-09-21)。
 *
 * 服务端那一份在 workbench-plugin/src/server/feed.ts,这里是**它的只读子集**
 * (字段名一字不改,同 api/protocol.ts 对 /state 的做法);手机不认识的字段一律忽略,
 * 服务端多给不会坏。
 *
 * 名字上的一个坑:这个 App 里 `useFeed` 早就被**事项状态流**占了(hooks.ts),
 * 跟这里说的「资讯」不是一回事。所以这一族一律叫 news*(useNews / NewsPage),
 * 只有目录名按任务卡叫 feed/。
 */
import { canPlay, type AidjProgram, type AidjView } from './aidjModel';

export interface NewsItem {
  id: string;
  project_id: string;
  project_name: string;
  title: string;
  url: string;
  source?: string;
  published_at?: string;
  /** 事务官那一句「跟你这个项目有什么关系」。 */
  why: string;
  score: number;
  follow_up: boolean;
  feedback?: 'follow' | 'mute';
  date: string;
  at: number;
}

export interface NewsGroup {
  project_id: string;
  project_name: string;
  items: NewsItem[];
}

/**
 * 一条资讯在这段音频里的起止(2026-10-13,卡「播客页重做」)。
 * 服务端那一份在 workbench-plugin/src/server/feed.ts(`FeedPodcastSegment`)。
 */
export interface NewsPodcastSegment {
  item_id: string;
  start_ms: number;
  end_ms: number;
  /** 这一段的时长是估的(字节里量不出来)。界面上不为它改样子,但如实带着。 */
  estimated?: true;
}

export interface NewsPodcast {
  date: string;
  script: string;
  /** 合成成功才有。没有 = 今天只有文字稿。 */
  file?: string;
  bytes?: number;
  /**
   * 讲到哪条就是哪条(2026-10-13)。按条目分段合成的那些才有;
   * **老播客整格缺席 → 一张卡都不亮**(宁可不亮,也不按字数猜「这会儿大概在讲第三条」)。
   */
  segments?: readonly NewsPodcastSegment[];
  error?: string;
  at: number;
}

export interface NewsInterest {
  project_id: string;
  project_name: string;
  keywords: string[];
  limit?: number;
  muted_sources?: string[];
  muted_topics?: string[];
}

export interface NewsConfig {
  version: 1;
  enabled: boolean;
  per_project: number;
  podcast: boolean;
  podcast_minutes: number;
  interests: NewsInterest[];
}

export interface NewsView {
  date: string;
  groups: NewsGroup[];
  podcast?: NewsPodcast;
  config: NewsConfig;
  last_run_at: number;
  /** 今天为什么没有(中转没配搜索、模型接不上)。原样显示,不改写、不粉饰。 */
  last_error?: string;
}

/** 空视图。**不是"今天没有资讯"**,是"还没问到" —— 两者在界面上说的话不一样。 */
export const EMPTY_NEWS: NewsView = {
  date: '',
  groups: [],
  config: { version: 1, enabled: true, per_project: 5, podcast: true, podcast_minutes: 4, interests: [] },
  last_run_at: 0,
};

/** 一条的副标题:来源 · 发布时间。两样都没有就空串(不占位)。 */
export function metaLine(item: NewsItem): string {
  const parts: string[] = [];
  if (item.source !== undefined && item.source !== '') parts.push(item.source);
  const day = dayOf(item.published_at);
  if (day !== undefined) parts.push(day);
  return parts.join(' · ');
}

/** ISO / `2026-09-20` → `9月20日`。认不出就整个不显示(不编一个日期)。 */
export function dayOf(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/**
 * 空列表时那一句话。三种情形说三句不同的话 —— 「中转没配搜索」与「今天确实没搜到」
 * 在用户那儿是两件完全不同的事,一句「暂无资讯」把它们糊在一起等于什么都没说。
 */
export function emptyNote(view: NewsView, asked: boolean): string {
  if (!asked) return '正在拿今天的资讯…';
  if (view.last_error !== undefined && view.last_error !== '') return view.last_error;
  if (view.config.interests.every((i) => i.keywords.length === 0)) {
    return '还没告诉事务官每个项目要关注什么。去「设置 → 资讯偏好」写几个关键词,明天早上就有了。';
  }
  if (view.last_run_at === 0) return '今天还没搜过。早报之前它会自己搜一轮,也可以在设置里手动跑一次。';
  return '今天没搜到跟你的项目有关的东西。';
}

/** 播客那一条横幅说什么。回 undefined = 这一条整条不摆(没有播客就没有播放条)。 */
export function podcastNote(podcast: NewsPodcast | undefined): string | undefined {
  if (podcast === undefined) return undefined;
  if (podcast.file !== undefined) return '今天的资讯播客';
  return podcast.error ?? '今天只有文字稿';
}

/** 今天那期播客从哪儿听:Aiboo 的双主播节目,或工作台自己合成的那段。 */
export type PlayablePodcast =
  | { kind: 'aidj'; program: AidjProgram }
  | { kind: 'local'; podcast: NewsPodcast };

/**
 * **今天那期播客能不能听、从哪儿听** —— 只在这里判一遍。
 *
 * 资讯那一页摆哪条播放条、首页球下那一排里资讯那颗亮不亮小点,认的都是它:
 * 两处各判一遍早晚出「首页亮着点、进去没得听」。
 *
 * 顺序同资讯那一页:Aiboo 那期能播(今天的、有口播段)→ 它;否则工作台那段有音频 → 它;
 * 只有文字稿不算能听。服务端 `/feed` 只给当天那一期(feed.ts 按 date 取),AIDJ 不是今天的是 `stale`,
 * 所以这里不再比日期。
 */
export function playablePodcast(view: NewsView | undefined, aidj: AidjView | null | undefined): PlayablePodcast | null {
  if (aidj !== null && aidj !== undefined && canPlay(aidj) && aidj.program !== undefined) return { kind: 'aidj', program: aidj.program };
  if (view?.podcast?.file !== undefined) return { kind: 'local', podcast: view.podcast };
  return null;
}

/**
 * **这会儿在讲哪一条**(2026-10-13,卡「播客页重做」★1)。
 *
 * 维护者原话:「语音播放到哪一条的时候,被讲到的资讯卡片能有一个放大的效果表示现在正在讲的是这一条」。
 *
 * 只在这里判一遍 —— 页面上那张卡放大、自动滚到可见,认的都是它。
 * 没有 `segments`(老播客)、还没开始播、正好落在开头 / 结尾那几句上 → `undefined`,**谁都不亮**。
 * `currentMs` 落在某一段的 `[start_ms, end_ms)` 里才算,边界用左闭右开:
 * 相邻两段共用同一个毫秒时不会有一瞬间两张卡一起亮。
 */
export function speakingItemId(
  segments: readonly NewsPodcastSegment[] | undefined,
  currentMs: number,
): string | undefined {
  if (segments === undefined || !Number.isFinite(currentMs) || currentMs < 0) return undefined;
  for (const one of segments) {
    if (currentMs >= one.start_ms && currentMs < one.end_ms) return one.item_id;
  }
  return undefined;
}

/** 这期播客一共讲了几条、当前是第几条(播放器上那一行「第 2 / 5 条」)。讲到开头结尾时 `at` 缺席。 */
export function speakingPosition(
  segments: readonly NewsPodcastSegment[] | undefined,
  currentMs: number,
): { at?: number; total: number } {
  const total = segments?.length ?? 0;
  if (total === 0) return { total: 0 };
  const id = speakingItemId(segments, currentMs);
  if (id === undefined) return { total };
  const index = (segments as readonly NewsPodcastSegment[]).findIndex(one => one.item_id === id);
  return index < 0 ? { total } : { at: index + 1, total };
}

/** 本地把一条标成「跟进 / 不看了」之后的视图(等服务端那一拍回来之前先动起来)。 */
export function withFeedback(view: NewsView, id: string, action: 'follow' | 'mute'): NewsView {
  const groups = view.groups
    .map((group) => ({
      ...group,
      items: action === 'mute'
        ? group.items.filter((item) => item.id !== id)
        : group.items.map((item) => (item.id === id ? { ...item, feedback: action } : item)),
    }))
    .filter((group) => group.items.length > 0);
  return { ...view, groups };
}
