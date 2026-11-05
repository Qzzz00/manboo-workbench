/**
 * 资讯与播客(2026-09-21,docs/功能盘点-还没做的-2026-09-21.md 第二节「资讯与播客(按项目与偏好)」
 * 与第三节「早报『按项目搜内容生成待办』」)。
 *
 * Ben 原话:「根据项目情况和偏好在手机端上做信息资讯和播客」「早报会按项目去搜内容、生成待办」。
 *
 * ## 一条管线,两个出口
 *
 * ```
 *  每个项目/账号的「关注什么」
 *        ↓ 搜索(中转 /v1/search,见 relay/server/search.cjs)
 *      一堆网页
 *        ↓ 去重(同一条新闻会被三家转载)
 *        ↓ 模型打分 + 一句「与我的项目有什么关系、要不要跟进」
 *      feed.json(保留 14 天)
 *        ├── 早报例程:每个项目最多 3 条 + 「要跟进」的**待办建议**(只建议,进收件箱等确认)
 *        └── 手机「资讯」页 + 每天一段播客(8792 TTS)
 * ```
 *
 * ## 三条纪律
 *
 * 1. **中转没配搜索,整块如实缺席**。不摆空壳、不用旧数据冒充今天、不让模型"凭印象"编几条
 *    资讯 —— 编出来的新闻是这个产品能犯的最坏的错(D13)。`FeedRunResult.error` 一路带到界面。
 * 2. **只建议,不建事项**。「要跟进」出的是收件箱里一条建议(kind:'feed'),Ben 点了才成事项。
 *    一个每天自动往看板里塞卡的东西,一周之后就没人看看板了。
 * 3. **反馈回写偏好**。「不看了」把那条的来源与主题记进 `muted_sources` / `muted_topics`,
 *    下一轮搜索前就把它们筛掉 —— 反馈要真的有用,不然只是个装饰性的按钮。
 *
 * ## 落盘
 *
 * - `~/.dsh/workbench/feed.json`:条目 + 播客记录,保留 14 天(FEED_KEEP_DAYS)。
 * - `~/.dsh/workbench/feed-config.json`:偏好(每项目关键词、每天几条、播客要不要、时长)。
 * - `~/.dsh/workbench/feed-podcast-<日期>.mp3`:那一天的口播。
 *   **扩展名按真实内容定**:卡里写的是 `.m4a`,但 8792 那条 `/api/tts` 回的是
 *   `audio/mpeg`(火山/DashScope 两条路都是 mp3),把 mp3 的字节写进 `.m4a` 是在文件名上撒谎,
 *   播放器认不认全凭运气。真换成 AAC 容器要在 8792 那边加转码,那是另一张卡。
 *   这是**可推翻**的取舍,写进了 docs/决策记录.md。
 *
 * 纯函数(去重、打分解析、挑早报三条、反馈回写、播客稿)全部导出,单测直接喂数据;
 * I/O 与外部依赖(搜索、模型、TTS)一律从参数进来。
 */
import { AIHOT_MORNING_MAX, AIHOT_PROJECT_ID, aihotItemsToFeed, dropSeenStories, parseAihotDaily } from './feedAihot.ts'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { localDateStr } from './brief.ts'
import { mp3DurationMs } from './mp3Duration.ts'

/** 留几天。14 天 = 卡里定的;再久就只是占磁盘,资讯过了两周没人回头看。 */
export const FEED_KEEP_DAYS = 14
/** 早报里每个项目最多几条(卡里定的 3)。与「每天搜几条」是两个上限,别混。 */
export const MORNING_PER_PROJECT = 3
/**
 * 一天最多提炼几条选题(2026-09-22 卡 ③,白板原话「每日搜 10 条相关资讯」)。
 *
 * **与 MAX_PER_PROJECT 是两个上限**:那个管"一个账号一天搜几条",这个管
 * "一天总共有几条能变成选题建议"。三个账号各搜 10 条,提炼出来的也只挑 10 条 ——
 * 收件箱里一天塞三十条选题,等于一条都没推荐。
 */
export const MAX_TOPICS_PER_DAY = 10
/** 偏好里「每天几条」的缺省与上限。 */
export const DEFAULT_PER_PROJECT = 5
export const MAX_PER_PROJECT = 10
/** 播客时长(分钟)的缺省与区间。卡里写的是 3–6 分钟。 */
export const DEFAULT_PODCAST_MINUTES = 4
export const PODCAST_MINUTES_RANGE = [3, 6] as const
/**
 * 一分钟口播大概多少字。**这个数是量出来的,不是拍的**:2026-09-21 在 Ben 那台机器上
 * 拿 8792 真合成了一段 126 字的稿子,`afinfo` 报 20.688 秒 → 6.1 字/秒 ≈ 365 字/分钟
 * (火山大模型音色、默认语速;换音色或语速会变)。
 *
 * 只用来给模型一个目标字数,**不拿它去报"这段几分几秒"** —— 真时长由手机上那个
 * `<audio>` 自己的 duration 说,算出来的数字会被当成真的(D13)。
 */
export const CHARS_PER_MINUTE = 365
/** 8792 的 /api/tts **单次**上限是 2000 字(butler-server/server/routes/api/tts.cjs)。 */
export const TTS_MAX_CHARS = 2000
/**
 * 一整段口播的字数上限。6 分钟 × 365 ≈ 2190 字,已经超过单次 2000 —— 所以长稿子要
 * **切成几段分别合成再把字节接起来**(splitScript / makePodcast)。
 * MPEG layer III 的帧是自描述的,同一个编码器出来的两段直接首尾相接就能连着播;
 * 8792 那条 DashScope 分支本来也是这么拼的(ttsChunker 的 Buffer.concat)。
 * 2600 给 6 分钟留了点余量,再长就不是"通勤时听一段"了。
 */
export const PODCAST_MAX_CHARS = 2600

/** —— 偏好 —— */

export interface FeedInterest {
  /** 项目 / 账号的 id(两种模板同一个字段,见 templates.ts 的 project_word)。 */
  project_id: string
  /** 显示名。落一份是为了项目临时读不到时界面还有名字可显示(不是事实源)。 */
  project_name: string
  /** 「关注什么」:引导里问出来的方向 + 用户在设置里改的关键词。空 = 这个项目不搜。 */
  keywords: string[]
  /** 这个项目每天最多几条;缺席走全局 per_project。 */
  limit?: number
  /** 「不看了」攒下来的来源(站名)。下一轮搜索的结果里直接筛掉。 */
  muted_sources?: string[]
  /** 「不看了」攒下来的主题词(从标题里取的)。命中就降权。 */
  muted_topics?: string[]
  /**
   * 「不要」按过的那几条选题建议的**链接**(规范化后的 key,见 normalizeUrl)。
   * 下一轮搜出同一个链接直接筛掉 —— 说过一次不要,不该明天再问一遍。
   *
   * 与 `muted_sources` / `muted_topics` **不是一回事**:那两样是"这个来源 / 这个主题
   * 我都不想看"(整片降权),这一样只针对**这一条**。把「不要这条选题」记成
   * "这个站以后都不看"是把他的话放大了,那是另一个按钮(「不看了」)干的事。
   */
  declined_urls?: string[]
  /** 「不要」按过的那几条的**标题** key(去标点,见 titleKey)。同一条稿子被转载时链接不同。 */
  declined_titles?: string[]
}

export interface FeedConfig {
  version: 1
  /** 总开关。关了就整条管线不跑(早报里那一段也整段不出)。 */
  enabled: boolean
  /** 每个项目每天最多几条。 */
  per_project: number
  /** 要不要每天早上那段播客。 */
  podcast: boolean
  /** 播报时长(分钟)。 */
  podcast_minutes: number
  /** ★ 早报以 AIHOT 日报为底(2026-10-14,卡 AC)。缺省开;关了就与接它之前逐字相同。 */
  aihot: boolean
  interests: FeedInterest[]
}

export const DEFAULT_FEED_CONFIG: FeedConfig = {
  version: 1,
  enabled: true,
  per_project: DEFAULT_PER_PROJECT,
  podcast: true,
  podcast_minutes: DEFAULT_PODCAST_MINUTES,
  aihot: true,
  interests: [],
}

export function defaultFeedFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/feed.json`
}

export function defaultFeedConfigFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/feed-config.json`
}

export function podcastFileName(date: string, ext = 'mp3'): string {
  return `feed-podcast-${date}.${ext}`
}

function clampInt(value: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof value === 'number' ? Math.round(value) : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isInteger(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}

/**
 * 「不要」最多记几条。满了丢最早的 —— 偏好是活的(同 muted_* 那条),
 * 半年前不要的那条选题不该永远压着一个搜索结果。
 */
export const DECLINED_KEEP = 200

function strings(value: unknown, max: number, itemMax = 40): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed === '' || out.includes(trimmed)) continue
    out.push(trimmed.slice(0, itemMax))
    if (out.length >= max) break
  }
  return out
}

/**
 * 解析 feed-config.json。**宽容**(同 parseRoutinesConfig):认不出的字段退回默认、不抛 ——
 * 配错一个字符串不该让工作台起不来,也不该让资讯整条停掉。
 */
export function parseFeedConfig(raw: unknown, fallback: FeedConfig = DEFAULT_FEED_CONFIG): FeedConfig {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const interests: FeedInterest[] = []
  if (Array.isArray(obj.interests)) {
    for (const item of obj.interests) {
      if (typeof item !== 'object' || item === null) continue
      const row = item as Record<string, unknown>
      const id = typeof row.project_id === 'string' ? row.project_id.trim() : ''
      if (id === '' || interests.some(i => i.project_id === id)) continue
      const limit = row.limit === undefined ? undefined : clampInt(row.limit, 1, MAX_PER_PROJECT, DEFAULT_PER_PROJECT)
      const mutedSources = strings(row.muted_sources, 50)
      const mutedTopics = strings(row.muted_topics, 50)
      // 「不要」记的是 key(规范化 URL / 去标点标题),比来源站名长,单条放到 200 字。
      const declinedUrls = strings(row.declined_urls, DECLINED_KEEP, 200)
      const declinedTitles = strings(row.declined_titles, DECLINED_KEEP, 200)
      interests.push({
        project_id: id,
        project_name: typeof row.project_name === 'string' ? row.project_name : id,
        keywords: strings(row.keywords, 12),
        ...(limit === undefined ? {} : { limit }),
        ...(mutedSources.length === 0 ? {} : { muted_sources: mutedSources }),
        ...(mutedTopics.length === 0 ? {} : { muted_topics: mutedTopics }),
        ...(declinedUrls.length === 0 ? {} : { declined_urls: declinedUrls }),
        ...(declinedTitles.length === 0 ? {} : { declined_titles: declinedTitles }),
      })
    }
  }
  return {
    version: 1,
    enabled: typeof obj.enabled === 'boolean' ? obj.enabled : fallback.enabled,
    aihot: typeof obj.aihot === 'boolean' ? obj.aihot : fallback.aihot,
    per_project: clampInt(obj.per_project, 1, MAX_PER_PROJECT, fallback.per_project),
    podcast: typeof obj.podcast === 'boolean' ? obj.podcast : fallback.podcast,
    podcast_minutes: clampInt(obj.podcast_minutes, PODCAST_MINUTES_RANGE[0], PODCAST_MINUTES_RANGE[1], fallback.podcast_minutes),
    interests: interests.length === 0 && !Array.isArray(obj.interests) ? fallback.interests : interests,
  }
}

/** —— 条目 —— */

export interface SearchResult {
  title: string
  url: string
  snippet: string
  source?: string
  published_at?: string
}

/**
 * 一条资讯**按这个账号的定位**提炼出来的选题(2026-09-22 卡 ③)。
 *
 * 白板原话:「按账号情况每日搜 10 条相关资讯,提炼为『选题 + 相关资讯』」。
 * 两个字段就是早报里念的那两句:念标题,再念一句为什么是现在。
 */
export interface FeedTopic {
  /** 选题标题。创作者点「加入选题池」之后它就是那张卡的标题、那个目录的名字。 */
  title: string
  /** 一句「为什么现在做」。不超过一句话,早报里跟着标题一起念。 */
  why_now: string
}

export interface FeedItem {
  /** 稳定 id = 规范化 URL 的 sha256 前 16 位。同一条新闻在两天之间是同一个 id,界面才不会闪。 */
  id: string
  project_id: string
  project_name: string
  title: string
  url: string
  source?: string
  published_at?: string
  /** 模型写的一句「与我的项目有什么关系」。模型没给就退回搜索结果的摘要,**绝不空着编一句**。 */
  why: string
  /** 0–5,与这个项目的相关度。解析不出来按 0(= 不进早报、不进播客)。 */
  score: number
  /** 模型判的「值得跟进」。只有它为 true 才会在收件箱里出一条建议。 */
  follow_up: boolean
  /**
   * 用账号定位提炼出来的那条选题(2026-09-22,运营模板下才有)。
   *
   * **没模型、没账号档案、模型没给,这一项就整个缺席**,收件箱里那一条退回普通资讯建议 ——
   * 编一个"看起来像选题"的标题是这条管线能犯的最坏的错(同 feed.ts 纪律①)。
   */
  topic?: FeedTopic
  /**
   * 用户的表态。没表态就缺席(缺席 ≠ 不感兴趣)。
   *
   * - `follow` / `mute`:资讯页上那两颗(「跟进」/「不看了」,后者会回写偏好);
   * - `decline`:选题建议上的「不要」—— 只针对这一条,记进 declined_urls / declined_titles;
   * - `adopted`:已经一键建成选题了。资讯页上照样看得见(它仍然是今天的一条资讯),
   *   但收件箱里不再问第二遍。
   */
  feedback?: 'follow' | 'mute' | 'decline' | 'adopted'
  /** 落进哪一天(本地日期)。 */
  date: string
  /** 落盘时刻(ms)。 */
  at: number
  /** ★ AIHOT 的事件页(同一件事多家报道聚成的那一条;2026-10-14 卡 AC):跨天判「同一件事」用。 */
  story_url?: string
}

/**
 * 一条资讯在这段音频里的起止(2026-10-13,卡「播客页联动」)。
 *
 * 维护者原话:「语音播放到哪一条的时候,被讲到的资讯卡片能有一个放大的效果」。
 * 手机按 `<audio>.currentTime` 在这张表里找当前那一段,那张卡放大 + 边框亮。
 *
 * **没有这张表的老播客照旧不亮**(整篇一次合成的那些):宁可不亮,
 * 也不按字数去猜「这会儿大概在讲第三条」—— 猜出来的高亮会在屏上明着错。
 */
export interface FeedPodcastSegment {
  /** 哪一条资讯(FeedItem.id)。 */
  item_id: string
  /** 从第几毫秒开始。 */
  start_ms: number
  /** 到第几毫秒结束。 */
  end_ms: number
  /**
   * 这一段的时长是**估的**(字节里量不出来:不是 MPEG、或者 8792 换了别的容器)。
   * 界面上不为它改样子,但如实带着 —— 取不到就说取不到(D13)。
   */
  estimated?: true
}

export interface FeedPodcast {
  date: string
  /** 口播稿全文。合成失败时只有它 —— 卡里定的「合成失败只有文字稿」。 */
  script: string
  /** 音频文件名(在 ~/.dsh/workbench 下)。没合成成功就缺席。 */
  file?: string
  /** 字节数。用来告诉界面"有没有东西可播",不拿它去推算时长(那是编数)。 */
  bytes?: number
  /**
   * 每条资讯讲到哪一段(2026-10-13)。按条目分段合成才有;
   * 模型没照格式分段、或者只有文字稿时**整格缺席**(手机照旧不亮)。
   */
  segments?: readonly FeedPodcastSegment[]
  /** 合成失败的一句人话。 */
  error?: string
  at: number
}

export interface FeedFile {
  version: 1
  items: FeedItem[]
  podcasts: FeedPodcast[]
  /** 上一次真跑管线的时刻(ms);0 = 还没跑过。 */
  last_run_at: number
  /** 上一次跑出来的问题(中转没配搜索、模型接不上)。成功时缺席。 */
  last_error?: string
}

export function emptyFeedFile(): FeedFile {
  return { version: 1, items: [], podcasts: [], last_run_at: 0 }
}

/** —— 纯函数:规范化与去重 —— */

/**
 * URL 规范化(只为去重用,**不改真正打开的那个地址**)。
 * 去掉协议差异、www.、末尾斜杠,以及一整批跟踪参数(同一条新闻被三家转载时,
 * 多半只有 utm_* 这些不一样)。认不出的 URL 原样回,不抛。
 */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./i, '').toLowerCase()
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|spm|from|share|ref|src)/i.test(key)) u.searchParams.delete(key)
    }
    const search = u.searchParams.toString()
    const path = u.pathname.replace(/\/+$/, '')
    return `${host}${path}${search === '' ? '' : `?${search}`}`
  }
  catch {
    return url.trim().toLowerCase()
  }
}

export function feedItemId(url: string): string {
  return createHash('sha256').update(normalizeUrl(url)).digest('hex').slice(0, 16)
}

/**
 * 标题去掉标点与空白,只为比"是不是同一条新闻"。
 * **导出**是因为「不要」那条记忆也按它认(同一条稿子被三家转载,链接不同、标题一样)。
 */
export function titleKey(title: string): string {
  return title.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()
}

/**
 * 去重。两条判据,先 URL 后标题:
 *   ① 规范化后的 URL 相同 —— 同一个链接带着不同的跟踪参数;
 *   ② 标题去标点后相同 —— 同一条稿子被三家转载,链接不同。
 * **先到的留下**(搜索结果本来就是按相关度排的)。
 */
export function dedupeResults(rows: readonly SearchResult[]): SearchResult[] {
  const seenUrl = new Set<string>()
  const seenTitle = new Set<string>()
  const out: SearchResult[] = []
  for (const row of rows) {
    if (row.url.trim() === '' || row.title.trim() === '') continue
    const u = normalizeUrl(row.url)
    const t = titleKey(row.title)
    if (seenUrl.has(u) || (t !== '' && seenTitle.has(t))) continue
    seenUrl.add(u)
    if (t !== '') seenTitle.add(t)
    out.push(row)
  }
  return out
}

/**
 * 「不看了」攒下来的那些:命中就筛掉。
 * - 来源:站名完全相同(不做模糊匹配 —— 把「财新」筛成「财新网」以外的东西会误伤);
 * - 主题:标题里包含那个词。
 */
export function filterMuted(rows: readonly SearchResult[], interest: FeedInterest): SearchResult[] {
  const sources = new Set(interest.muted_sources ?? [])
  const topics = interest.muted_topics ?? []
  return rows.filter((row) => {
    if (row.source !== undefined && sources.has(row.source)) return false
    return !topics.some(topic => row.title.includes(topic))
  })
}

/**
 * 「不要」过的那几条:**同链接或同标题**就筛掉(2026-09-22 卡 ③)。
 *
 * 与 filterMuted 分成两个函数、不合并:两者的语义差一个量级 —— 「不看了」说的是
 * "这个来源 / 这个主题整片别给我",「不要」说的只是"这一条不要"。合成一个函数之后,
 * 下一个人改其中一条判据时一定会顺手把另一条也放宽。
 */
export function filterDeclined(rows: readonly SearchResult[], interest: FeedInterest): SearchResult[] {
  const urls = new Set(interest.declined_urls ?? [])
  const titles = new Set(interest.declined_titles ?? [])
  if (urls.size === 0 && titles.size === 0) return [...rows]
  return rows.filter((row) => {
    if (urls.has(normalizeUrl(row.url))) return false
    const key = titleKey(row.title)
    return !(key !== '' && titles.has(key))
  })
}

/**
 * 一个项目这一轮搜什么。关键词两两一组太碎、全塞一条太宽,折中:
 * **一条查询 = 项目名 + 至多 4 个关键词**,多出来的关键词另起一条。
 * 没有关键词就一条都不搜 —— 「关注什么」没填,就不该替他猜。
 */
export function queriesOf(interest: FeedInterest): string[] {
  const keywords = interest.keywords.filter(k => k.trim() !== '')
  if (keywords.length === 0) return []
  const out: string[] = []
  for (let i = 0; i < keywords.length; i += 4) {
    out.push([interest.project_name, ...keywords.slice(i, i + 4)].join(' '))
  }
  return out
}

/** —— 纯函数:打分解析 —— */

export interface Scoring {
  /** 对应候选数组的下标。 */
  index: number
  score: number
  why: string
  follow_up: boolean
}

/**
 * 模型那一段回答 → 打分。模型被要求回一个 JSON 数组,但它可能:
 * 裹一层 ```json 代码块、前后多几句话、数字写成字符串、follow_up 写成「是」。
 * 这个函数把这些都认了,**认不出的那一条整条丢掉**(而不是给它一个猜出来的分数)。
 */
export function parseScoring(text: string, count: number): Scoring[] {
  const json = extractJsonArray(text)
  if (json === undefined) return []
  const out: Scoring[] = []
  for (const raw of json) {
    if (typeof raw !== 'object' || raw === null) continue
    const row = raw as Record<string, unknown>
    const index = typeof row.i === 'number' ? row.i : Number.parseInt(String(row.i ?? row.index ?? ''), 10)
    if (!Number.isInteger(index) || index < 0 || index >= count) continue
    if (out.some(item => item.index === index)) continue
    const rawScore = typeof row.score === 'number' ? row.score : Number.parseFloat(String(row.score ?? ''))
    const score = Number.isFinite(rawScore) ? Math.min(5, Math.max(0, Math.round(rawScore))) : 0
    const why = typeof row.why === 'string' ? row.why.trim() : ''
    const follow = row.follow_up
    const followUp = follow === true || follow === 'true' || follow === '是' || follow === 1
    out.push({ index, score, why, follow_up: followUp })
  }
  return out
}

/** 从一段夹带着解释的回答里抠出那个 JSON 数组。抠不出回 undefined(不猜)。 */
function extractJsonArray(text: string): unknown[] | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = fenced?.[1] ?? text
  const start = body.indexOf('[')
  const end = body.lastIndexOf(']')
  if (start === -1 || end <= start) return undefined
  try {
    const parsed = JSON.parse(body.slice(start, end + 1)) as unknown
    return Array.isArray(parsed) ? parsed : undefined
  }
  catch { return undefined }
}

/** 打分那一问怎么问。项目情况 + 候选条目,要求只回 JSON。 */
export function scoringPrompt(input: {
  projectName: string
  keywords: readonly string[]
  rows: readonly SearchResult[]
}): string {
  const list = input.rows
    .map((row, i) => `${i}. 《${row.title}》${row.source === undefined ? '' : `(${row.source})`}\n   ${row.snippet.slice(0, 300)}`)
    .join('\n')
  return [
    `我在做「${input.projectName}」,我关注的方向是:${input.keywords.join('、')}。`,
    '下面是今天搜到的候选资讯。请你逐条判断它跟我这个项目有没有关系、要不要跟进。',
    '',
    list,
    '',
    '只回一个 JSON 数组,不要任何别的文字。每个元素:',
    '{"i": 候选的序号, "score": 0-5 的整数(与我的项目相关度,5 = 直接相关必须知道), '
    + '"why": "一句话说清它跟我的项目有什么关系(不超过 40 字,说不清就写\'关系不大\')", '
    + '"follow_up": true/false(我是不是该为它做点什么)}',
    '不相关的条目也要给出来,给 0 分。不要编造条目里没有的事实。',
  ].join('\n')
}

/** —— 纯函数:挑条目 —— */

/**
 * 这一天、这个项目的条目,按分数高到低。被「不看了」或「不要」过的不出。
 *
 * `adopted`(已经建成选题了)**照样出** —— 它仍然是今天真搜到的一条资讯,
 * 资讯页上把它抹掉等于骗人;不再问第二遍的是收件箱那一档(见 topicSuggestions)。
 */
export function itemsOf(file: FeedFile, date: string, projectId?: string): FeedItem[] {
  return file.items
    .filter(item => item.date === date && item.feedback !== 'mute' && item.feedback !== 'decline'
      && (projectId === undefined || item.project_id === projectId))
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
}

/**
 * 早报要的那几条:每个项目最多 `per` 条,**0 分的不进**(不相关的东西不该占早报的篇幅)。
 * 返回按项目分组,组的顺序就是条目里项目第一次出现的顺序(稳定)。
 */
export function morningPicks(file: FeedFile, date: string, per = MORNING_PER_PROJECT): {
  project_id: string
  project_name: string
  items: FeedItem[]
}[] {
  const groups = new Map<string, { project_id: string, project_name: string, items: FeedItem[] }>()
  for (const item of itemsOf(file, date)) {
    if (item.score <= 0) continue
    const group = groups.get(item.project_id)
      ?? { project_id: item.project_id, project_name: item.project_name, items: [] }
    // AI 日报那一组是早报的底(卡 AC),给它多一点;项目组照旧 `per`。
    const cap = item.project_id === AIHOT_PROJECT_ID ? AIHOT_MORNING_MAX : per
    if (group.items.length < cap) group.items.push(item)
    groups.set(item.project_id, group)
  }
  return [...groups.values()].filter(group => group.items.length > 0)
}

/**
 * 「要跟进」的那些:模型判了 follow_up,或者用户自己点了「跟进」。
 *
 * **已经提炼成选题的那几条不在这里**(2026-09-22):它们在收件箱里已经有一条
 * 「选题建议」,这一档再出一遍就是同一条资讯问两次 —— 同一件事数两遍是这份收件箱
 * 一直在防的东西(见 butlerInbox.ts 的 PROJECTION_PREFIXES)。
 */
export function followUps(file: FeedFile, date: string): FeedItem[] {
  return itemsOf(file, date)
    .filter(item => item.topic === undefined)
    .filter(item => item.feedback === 'follow' || (item.follow_up && item.score > 0))
}

/**
 * 今天的「选题建议」:提炼出选题、而且还没被「不要」/ 没建成卡的那几条(2026-09-22)。
 * 按分数高到低,总数封顶 `max` —— 一天最多 10 条是卡里定的。
 */
export function topicSuggestions(file: FeedFile, date: string, max = MAX_TOPICS_PER_DAY): FeedItem[] {
  return itemsOf(file, date)
    .filter(item => item.topic !== undefined && item.feedback !== 'adopted')
    .slice(0, max)
}

/** —— 纯函数:早报念什么 —— */

/** 早报里念的一条。`from_topic` = 这一句是提炼出来的选题(不是原标题)。 */
export interface MorningFeedLine {
  title: string
  why: string
  source?: string
  url: string
  from_topic: boolean
}

export interface MorningFeedGroup {
  project_id: string
  project_name: string
  items: MorningFeedLine[]
}

/**
 * 早报念什么(2026-09-22 卡 ③ 第 3 条:「像听早报」)。
 *
 * **有选题就念选题 + 那一句「为什么现在做」,不念原始摘要**;没提炼出选题的
 * (没接模型、不是运营模板、模型没给)**退回原标题与原来那句「跟你这个项目有什么关系」** ——
 * 退回的是真话,不是一句编出来的选题(feed.ts 纪律①)。
 */
export function morningLines(file: FeedFile, date: string, per = MORNING_PER_PROJECT): MorningFeedGroup[] {
  return morningPicks(file, date, per).map(group => ({
    project_id: group.project_id,
    project_name: group.project_name,
    items: group.items.map((item): MorningFeedLine => ({
      title: item.topic?.title ?? item.title,
      why: item.topic?.why_now ?? item.why,
      ...(item.source === undefined ? {} : { source: item.source }),
      url: item.url,
      from_topic: item.topic !== undefined,
    })),
  }))
}

/** 保留 14 天:比 `date` 早 `keep` 天以上的条目与播客记录一并丢掉。 */
export function pruneFeed(file: FeedFile, today: string, keep = FEED_KEEP_DAYS): FeedFile {
  const cutoff = new Date(`${today}T00:00:00`)
  cutoff.setDate(cutoff.getDate() - (keep - 1))
  const min = localDateStr(cutoff.getTime())
  return {
    ...file,
    items: file.items.filter(item => item.date >= min),
    podcasts: file.podcasts.filter(p => p.date >= min),
  }
}

/** —— 纯函数:反馈回写偏好 —— */

/** 从标题里取一个主题词:最长的那一段中文 / 英文连续串,2–8 字。取不到就没有。 */
export function topicOf(title: string): string | undefined {
  const parts = title.match(/[一-龥]{2,8}|[A-Za-z][A-Za-z0-9.+-]{2,15}/g) ?? []
  let best: string | undefined
  for (const part of parts) if (best === undefined || part.length > best.length) best = part
  return best
}

/**
 * 「不看了」回写偏好:那条的来源与主题进这个项目的黑名单。
 * **纯函数**,回一份新的 config(调用方负责落盘)。已经在里头的不重复加;
 * 每项最多 50 条(parseFeedConfig 也是这个上限),满了就丢最早的 —— 偏好是活的,
 * 半年前不想看的东西不该永远压着。
 */
export function applyMute(config: FeedConfig, item: FeedItem): FeedConfig {
  const topic = topicOf(item.title)
  return {
    ...config,
    interests: config.interests.map((interest) => {
      if (interest.project_id !== item.project_id) return interest
      const sources = [...(interest.muted_sources ?? [])]
      if (item.source !== undefined && !sources.includes(item.source)) sources.push(item.source)
      const topics = [...(interest.muted_topics ?? [])]
      if (topic !== undefined && !topics.includes(topic)) topics.push(topic)
      return {
        ...interest,
        ...(sources.length === 0 ? {} : { muted_sources: sources.slice(-50) }),
        ...(topics.length === 0 ? {} : { muted_topics: topics.slice(-50) }),
      }
    }),
  }
}

/**
 * 「不要」回写偏好:这一条的链接 key 与标题 key 进这个项目的名单,下一轮搜到直接筛掉。
 *
 * **纯函数**,回一份新的 config(调用方负责落盘)。满 DECLINED_KEEP 条丢最早的。
 * 与 applyMute 的区别见 filterDeclined 的注释:这里**不碰** muted_sources / muted_topics。
 */
export function applyDecline(config: FeedConfig, item: FeedItem): FeedConfig {
  const urlKey = normalizeUrl(item.url)
  const title = titleKey(item.title)
  return {
    ...config,
    interests: config.interests.map((interest) => {
      if (interest.project_id !== item.project_id) return interest
      const urls = [...(interest.declined_urls ?? [])]
      if (!urls.includes(urlKey)) urls.push(urlKey)
      const titles = [...(interest.declined_titles ?? [])]
      if (title !== '' && !titles.includes(title)) titles.push(title)
      return {
        ...interest,
        ...(urls.length === 0 ? {} : { declined_urls: urls.slice(-DECLINED_KEEP) }),
        ...(titles.length === 0 ? {} : { declined_titles: titles.slice(-DECLINED_KEEP) }),
      }
    }),
  }
}

/** —— 纯函数:提炼选题 —— */

/** 账号档案里提炼选题要用的那三项(accounts.ts 的 `账号.md` 五字段里的前三个)。 */
export interface FeedAccountProfile {
  /** 定位。 */
  positioning?: string
  /** 目标人群 / 受众。 */
  audience?: string
  /** 内容风格。 */
  style?: string
}

/** 这份档案里一个字都没有 = 提炼不了(不拿"一个做小红书的账号"这种空话去问模型)。 */
export function hasProfile(profile: FeedAccountProfile | undefined): boolean {
  if (profile === undefined) return false
  return [profile.positioning, profile.audience, profile.style].some(one => one !== undefined && one.trim() !== '')
}

/**
 * 提炼那一问怎么问。**账号的定位 / 受众 / 风格在前,候选资讯在后** ——
 * 顺序就是白板上那句话的顺序:「按账号情况」提炼,不是按资讯本身提炼。
 *
 * 三条硬要求写进提示词里:① 只回 JSON;② 提不出就整条不给(宁缺毋滥);
 * ③ 不许编资讯里没有的事实 —— 编出来的选题会一路进选题池、进初稿、发出去。
 */
export function topicPrompt(input: {
  projectName: string
  profile: FeedAccountProfile
  rows: readonly FeedItem[]
}): string {
  const profile = [
    input.profile.positioning === undefined ? undefined : `定位:${input.profile.positioning}`,
    input.profile.audience === undefined ? undefined : `目标人群:${input.profile.audience}`,
    input.profile.style === undefined ? undefined : `内容风格:${input.profile.style}`,
  ].filter((one): one is string => one !== undefined)
  const list = input.rows
    .map((row, i) => `${i}. 《${row.title}》${row.source === undefined ? '' : `(${row.source})`}\n   ${row.why.slice(0, 200)}`)
    .join('\n')
  return [
    `我在做一个叫「${input.projectName}」的账号。`,
    ...profile,
    '',
    '下面是今天搜到的资讯。请按我这个账号的定位,把其中**能做成内容**的挑出来,各提炼成一条选题。',
    '',
    list,
    '',
    '只回一个 JSON 数组,不要任何别的文字。每个元素:',
    '{"i": 资讯的序号, "title": "选题标题(25 字以内,是我能直接拿去写的那句话,不是新闻标题)", '
    + '"why_now": "一句话说清为什么现在做这条(40 字以内)"}',
    '提炼不出选题的那条**整条不要给**,宁可少给几条;不要凑数。',
    '不要编资讯里没有的事实,不要在标题里写具体数字除非资讯里就有。',
  ].join('\n')
}

/** 提炼那一段回答 → 选题。认不出的整条丢掉(同 parseScoring 的纪律)。 */
export function parseTopics(text: string, count: number): { index: number, topic: FeedTopic }[] {
  const json = extractJsonArray(text)
  if (json === undefined) return []
  const out: { index: number, topic: FeedTopic }[] = []
  for (const raw of json) {
    if (typeof raw !== 'object' || raw === null) continue
    const row = raw as Record<string, unknown>
    const index = typeof row.i === 'number' ? row.i : Number.parseInt(String(row.i ?? row.index ?? ''), 10)
    if (!Number.isInteger(index) || index < 0 || index >= count) continue
    if (out.some(item => item.index === index)) continue
    const title = typeof row.title === 'string' ? row.title.trim() : ''
    const whyNow = typeof (row.why_now ?? row.why) === 'string' ? String(row.why_now ?? row.why).trim() : ''
    // 半条选题(只有标题没有理由,或反过来)**整条不要** —— 早报要念的是两句话。
    if (title === '' || whyNow === '') continue
    out.push({ index, topic: { title: title.slice(0, 60), why_now: whyNow.slice(0, 120) } })
  }
  return out
}

/**
 * 把提炼结果贴回条目上。**纯函数**,回一份新数组;没被提炼到的那几条原样(没有 topic)。
 */
export function applyTopics(rows: readonly FeedItem[], topics: readonly { index: number, topic: FeedTopic }[]): FeedItem[] {
  const byIndex = new Map(topics.map(one => [one.index, one.topic]))
  return rows.map((row, index) => {
    const topic = byIndex.get(index)
    return topic === undefined ? row : { ...row, topic }
  })
}

/**
 * 今天哪几条值得去提炼。**按项目轮着挑**(而不是先把第一个账号的十条挑满):
 * 两个账号各有好条目时,一个账号独占今天全部名额是最容易让人关掉这个功能的行为。
 * 0 分的不进(模型已经说了跟这个账号没关系)。总数封顶 `max`。
 */
export function pickTopicCandidates(
  groups: readonly FeedProjectGroup[],
  max = MAX_TOPICS_PER_DAY,
): { project_id: string, items: FeedItem[] }[] {
  const picked = new Map<string, FeedItem[]>()
  const queues = groups.map(group => ({
    id: group.project_id,
    rest: [...group.items].filter(item => item.score > 0).sort((a, b) => b.score - a.score),
  }))
  let total = 0
  let moved = true
  while (total < max && moved) {
    moved = false
    for (const queue of queues) {
      if (total >= max) break
      const next = queue.rest.shift()
      if (next === undefined) continue
      const list = picked.get(queue.id) ?? []
      list.push(next)
      picked.set(queue.id, list)
      total += 1
      moved = true
    }
  }
  return [...picked.entries()].map(([id, items]) => ({ project_id: id, items }))
}

/** —— 纯函数:播客稿 —— */

/**
 * 稿子里那个分段记号(2026-10-13,卡「播客页联动」)。
 *
 * **为什么要在稿子里加记号**:要让手机知道「这会儿在讲第几条」,就得按条目分段合成,
 * 而切段的依据只能来自写稿的那一头 —— 稿子出来之后再去认「哪一句讲的是哪条」要么靠关键词
 * 匹配(糊)、要么再问一次模型(多花一次钱)。让模型出稿时就标上,**一次问答什么都不多花**。
 *
 * 形状是 `[[n]]` 行首:`n` 是提示词里给它编的号(1 开始),`0` = 开头与结尾那几句(不属于任何一条)。
 * 记号**只进提示词与解析,不进落盘的稿子**(`splitPodcastScript` 会把它们摘掉),
 * 所以手机上那份文字稿里看不到方括号。
 *
 * 认不出一个记号 = **老稿子**:整篇当一段、不写 `segments`,手机照旧不亮(行为与加这张卡之前逐字相同)。
 */
export const PODCAST_MARK_RE = /^[ \t]*\[\[(\d+)\]\][ \t]*/
/**
 * **按行**找记号(切段用的就是它)。
 *
 * 为什么不按空行切:模型照格式分段时**不一定**留空行 —— 只换一行的那种,
 * 按空行切会把整篇当成一段,而第二个记号往后那几个就**留在正文里被念出来**
 * (「双左方括号二」)。那是这一版最容易出的丑,所以切点认的是「行首的记号」本身。
 */
const PODCAST_MARK_LINE_RE = /^[ \t]*\[\[(\d+)\]\][ \t]*/gm
/** 正文里残留的记号(模型把它写在句中了)。念出来就是噪音,一律摘掉。 */
const PODCAST_MARK_ANY_RE = /\[\[\d+\]\]/g

/** 口播稿那一问怎么问。事务官口吻:先说今天各项目的要点,再逐条。 */
export function podcastPrompt(input: {
  name: string
  minutes: number
  groups: readonly { project_name: string, items: readonly FeedItem[] }[]
}): string {
  // 编号与 `podcastItemIds` 同一个顺序(组内顺序、组间顺序都照原样),两处各编一遍迟早对不上。
  let n = 0
  const body = input.groups
    .map(group => [
      `【${group.project_name}】`,
      ...group.items.map((item) => {
        n += 1
        return `${n}. 《${item.title}》${item.source === undefined ? '' : `(${item.source})`}:${item.why}`
      }),
    ].join('\n'))
    .join('\n\n')
  const target = Math.min(PODCAST_MAX_CHARS, Math.round(input.minutes * CHARS_PER_MINUTE))
  return [
    `你是${input.name}的事务官。把下面这些今天搜到的资讯写成一段**念出来听**的口播稿。`,
    '',
    body,
    '',
    `要求:${target} 字左右(上限 ${PODCAST_MAX_CHARS} 字);开头先用两三句话说清今天各个项目各有什么要点,`,
    '然后一条一条说,每条说清"是什么"和"跟你这个项目有什么关系";',
    '结尾一句话收住。用口语,不要标题、不要序号、不要 Markdown、不要念网址,',
    '不要编稿子里没有的事实。',
    '',
    '**分段格式(照着做,程序要按它把音频切开)**:',
    '- 整篇分成几段,段与段之间空一行;',
    '- 每一段**行首**写一个记号:开头那几句写 `[[0]]`,结尾那句写 `[[0]]`;',
    '- 说上面第 n 条时,那一段行首写 `[[n]]`,**一段只说一条**,同一条不要分到两段里;',
    '- 记号只是给程序看的,正文里不要再出现方括号,也不要念出记号。',
    '',
    '直接给稿子正文(带记号),不要任何别的话。',
  ].join('\n')
}

/** 写稿时给模型编的号 → 条目 id。顺序与 {@link podcastPrompt} 列清单的顺序**必须一致**。 */
export function podcastItemIds(
  groups: readonly { items: readonly FeedItem[] }[],
): string[] {
  return groups.flatMap(group => group.items.map(item => item.id))
}

/** 分段之后的一块:要送去合成的那段话,以及它讲的是哪一条(开头 / 结尾那几句没有)。 */
export interface PodcastBlock {
  text: string
  /** 讲的是哪条资讯。`[[0]]`、认不出的号、没有记号的整篇都缺席。 */
  item_id?: string
}

/**
 * 把带记号的稿子拆成「落盘的稿子」+「一块一块去合成的话」。
 *
 * - **一个记号都没有** → 整篇一块、没有 `item_id`(老稿子那条路,行为不变);
 * - `[[0]]` 与认不出的号 → 那一块照样合成(话不能丢),只是不挂条目;
 * - 同一个号出现在相邻两块 → 并成一块(模型偶尔会把一条拆成两段,
 *   并起来之后那条资讯在音频里才是**一段连续的**,高亮不会闪两下);
 * - `script` 是摘掉记号、重新用空行接起来的全文 —— 手机上那份文字稿读的就是它。
 */
export function splitPodcastScript(text: string, ids: readonly string[]): { script: string, blocks: PodcastBlock[] } {
  /** 一块干净的话:摘掉残留记号、压掉多余空行。 */
  const clean = (body: string): string => body.replace(PODCAST_MARK_ANY_RE, '').replace(/\n{3,}/g, '\n\n').trim()
  /** 切点:每个行首记号的位置 + 它的号。 */
  const marks: { at: number, end: number, index: number }[] = []
  PODCAST_MARK_LINE_RE.lastIndex = 0
  for (let m = PODCAST_MARK_LINE_RE.exec(text); m !== null; m = PODCAST_MARK_LINE_RE.exec(text)) {
    marks.push({ at: m.index, end: m.index + m[0].length, index: Number(m[1]) })
  }
  // 一个记号都没有 = 老稿子:整篇一块、不挂条目(行为与加这张卡之前逐字相同)。
  if (marks.length === 0) {
    const whole = clean(text)
    return { script: whole, blocks: whole === '' ? [] : [{ text: whole }] }
  }
  const blocks: PodcastBlock[] = []
  /** 第一个记号之前那几句(模型多半不会写,写了也不能丢)。 */
  const head = clean(text.slice(0, (marks[0] as { at: number }).at))
  if (head !== '') blocks.push({ text: head })
  marks.forEach((mark, i) => {
    const stop = i + 1 < marks.length ? (marks[i + 1] as { at: number }).at : text.length
    const body = clean(text.slice(mark.end, stop))
    if (body === '') return
    const itemId = mark.index <= 0 ? undefined : ids[mark.index - 1]
    const last = blocks[blocks.length - 1]
    // 相邻同一条(含相邻两块都不挂条目的开头 / 结尾)并成一块。
    if (last !== undefined && last.item_id === itemId) last.text = `${last.text}\n\n${body}`
    else blocks.push({ text: body, ...(itemId === undefined ? {} : { item_id: itemId }) })
  })
  return { script: blocks.map(one => one.text).join('\n\n'), blocks }
}

/** 按字数估一段话几毫秒(量不出来时的退路,见 {@link CHARS_PER_MINUTE})。 */
export function estimatePodcastMs(chars: number): number {
  return Math.round((chars / CHARS_PER_MINUTE) * 60_000)
}

/** 合成好的一块:讲的是哪条、它那几段字节、原文多少字。 */
export interface PodcastSpan {
  item_id?: string
  bytes: readonly Buffer[]
  chars: number
}

/**
 * 一块一块的字节 → 每条资讯在整段音频里的起止。
 *
 * 时长**先量后估**:`mp3DurationMs` 从帧头里量得出来就用真数;量不出来(不是 MPEG、
 * 8792 哪天换了容器)才按字数估,并把那一段标 `estimated` —— 估的就说是估的。
 *
 * 开头 / 结尾那几块(没有 `item_id`)照样占时间、照样往后推,只是不出现在表里。
 */
export function segmentsOf(spans: readonly PodcastSpan[]): FeedPodcastSegment[] {
  const rows: FeedPodcastSegment[] = []
  let at = 0
  for (const span of spans) {
    const joined = span.bytes.length === 1 ? (span.bytes[0] as Buffer) : Buffer.concat([...span.bytes])
    const measured = joined.length === 0 ? undefined : mp3DurationMs(joined)
    const ms = measured ?? estimatePodcastMs(span.chars)
    const start = at
    at += ms
    if (span.item_id === undefined) continue
    rows.push({
      item_id: span.item_id,
      start_ms: start,
      end_ms: at,
      ...(measured === undefined ? { estimated: true as const } : {}),
    })
  }
  return rows
}

/**
 * 模型回的稿子 → 真正送去合成的那一段。
 * 去掉 Markdown 的标记与代码围栏(念出来会变成「井号井号」),压到 TTS 的字数上限。
 * **截断在句号上**,不在半句话中间切。
 */
export function cleanScript(text: string, max = PODCAST_MAX_CHARS): string {
  const stripped = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (stripped.length <= max) return stripped
  const cut = stripped.slice(0, max)
  const stop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('!'), cut.lastIndexOf('?'), cut.lastIndexOf('！'), cut.lastIndexOf('？'))
  return stop > max * 0.5 ? cut.slice(0, stop + 1) : cut
}

/**
 * 把一段稿子切成几块,每块不超过 `max` 字(8792 单次的上限)。
 * **只在句末切**(。!?、换行),切不动才硬切 —— 在半句话中间断开,听起来就是两段不相干的录音。
 * 短于上限就原样一块(绝大多数情况:3–5 分钟的稿子一次就发得完)。
 */
export function splitScript(text: string, max = TTS_MAX_CHARS): string[] {
  if (text.length <= max) return text === '' ? [] : [text]
  const parts: string[] = []
  let rest = text
  while (rest.length > max) {
    const head = rest.slice(0, max)
    let cut = Math.max(
      head.lastIndexOf('。'), head.lastIndexOf('!'), head.lastIndexOf('?'),
      head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('\n'),
    )
    // 切点太靠前(前半段都不到)说明这一段里压根没有句号,那就硬切,别把一块撑到两倍长。
    if (cut < max * 0.4) cut = max - 1
    parts.push(rest.slice(0, cut + 1).trim())
    rest = rest.slice(cut + 1).trim()
  }
  if (rest !== '') parts.push(rest)
  return parts
}

/** —— 纯函数:就一条资讯深聊(2026-10-13,卡「播客页重做」★3) —— */

/**
 * 深聊里的一个回合。`her` = 她说的,`butler` = 事务官上一次答的。
 *
 * **多轮靠手机把回合带上来**:这条路不开 DSH 会话、不建事项(那是派活那条路),
 * 一问一答就是一次模型调用 —— 最省的那条,也是出了门经房间代理能走的那条。
 */
export interface DigTurn {
  who: 'her' | 'butler'
  text: string
}

/** 一次最多把几个回合带进提示词。再往前的忘掉:一条资讯聊到第七轮早就不是在聊它了。 */
export const DIG_MAX_TURNS = 12

/** 把回合拼成提示词里那几行(只留最近 {@link DIG_MAX_TURNS} 个)。 */
function digTurnLines(turns: readonly DigTurn[]): string[] {
  return turns.slice(-DIG_MAX_TURNS).map(turn => `${turn.who === 'her' ? '她' : '你'}:${turn.text.trim()}`)
}

/** 这一条资讯的那几行事实(标题、来源、一句话为什么相关、链接)。**不编**:缺的那样整行不出现。 */
function digItemLines(item: FeedItem): string[] {
  return [
    `标题:《${item.title}》`,
    ...(item.source === undefined || item.source === '' ? [] : [`来源:${item.source}`]),
    ...(item.why === '' ? [] : [`你当初给她的那句「跟你有什么关系」:${item.why}`]),
    `链接:${item.url}`,
  ]
}

/**
 * 就这一条资讯答她一句。
 *
 * 她的话在前、交代在后 —— 与 `turnIntent.ts` 的 `answerNowPrompt` 同一个理由
 * (顺序反过来模型先读到的是我们的交代,容易把它当成任务)。
 */
export function digPrompt(input: { item: FeedItem, turns: readonly DigTurn[], said: string }): string {
  const history = digTurnLines(input.turns)
  return [
    input.said.trim(),
    '',
    '(以上是她刚说的一句话。你是她的事务官,你们正在**就下面这一条资讯**往下聊。',
    '',
    ...digItemLines(input.item),
    ...(history.length === 0 ? [] : ['', '刚才聊过的:', ...history]),
    '',
    '规矩:就这一条说,两三句话说完;不要列清单、不要写 Markdown、不要念链接与 id;',
    '她问的是这条资讯本身的事(是什么、为什么重要、对她的项目意味着什么、下一步可以做什么)就直接答;',
    '资讯里没有的事实**不要编** —— 原文里看不出来就说看不出来,并告诉她去哪看。)',
  ].join('\n')
}

/** 聊完那一句结论(她点「存成随手记」时先让模型收一句,她还能自己改)。 */
export function digConclusionPrompt(input: { item: FeedItem, turns: readonly DigTurn[] }): string {
  return [
    '把下面这段关于一条资讯的对话收成**一两句结论**。',
    '',
    ...digItemLines(input.item),
    '',
    '对话:',
    ...digTurnLines(input.turns),
    '',
    '规矩:只写结论本身(她聊完之后真正留下来的那句话),一两句;',
    '不要写「来源」「链接」那几行(程序会自己接上),不要写 Markdown、不要客套、不要反问;',
    '对话里没谈出结论就只写一句「这条还没聊出结论」。',
  ].join('\n')
}

/** —— 服务 —— */

export interface FeedSearchDep {
  (query: string, count: number): Promise<{ ok: true, results: SearchResult[] } | { ok: false, error: string }>
}

export interface FeedTtsResult { buffer: Buffer, contentType: string }

/**
 * 接 Aiboo AIDJ 的那一只手(2026-09-22,server/aidj.ts)。
 *
 * **接口写在这里、实现在那边**,方向只有一条:`aidj.ts` import 这个文件的 `topicOf`
 * 与 `FeedProjectGroup`,这个文件**不** import `aidj.ts`(否则两边互相 import)。
 */
export interface FeedAidjHook {
  /**
   * 今天 Aiboo 那期在不在。在 = 这一轮**不自己合成单人口播**(那是退路,不是主路)。
   * 取不到也要给一句人话,它会被拼进这一轮的 note。
   */
  ready(): Promise<{ ready: boolean, note?: string }>
  /** 把当天条目推给 Aiboo 当信源。**不抛**。 */
  push(groups: readonly FeedProjectGroup[], date: string): Promise<{ ok: boolean, note: string }>
}

export interface FeedServiceOptions {
  file: string
  configFile: string
  /** 播客音频落哪个目录(缺省与 feed.json 同目录)。 */
  audioDir?: string
  /** 发件目录:合成好的播客往这里放一份,工人就把它发到手机上(channel-worker/src/files/outbox.ts)。 */
  outboxDir?: string
  /** 项目 / 账号名单。资讯是"按项目"的,没有项目就没有资讯。 */
  projects: () => Promise<readonly { id: string, name: string }[]>
  /** 搜索(走中转 /v1/search)。缺席 = 这台机器没接搜索,项目那几条整块如实缺席(AI 日报照出)。 */
  search?: FeedSearchDep
  /**
   * ★ 拉一期 AIHOT 日报(2026-10-14,卡 AC):回 `aihot.news` 的 `/api/v1/dailies/{date}` 原样 JSON
   * (没出刊退 latest 由接线那头定)。缺席 / 抛错 = 这一轮没有 AI 日报,如实记一句,项目那几条照跑。
   */
  aihotDaily?: (date: string) => Promise<unknown>
  /** 问一次模型。缺席 = 不打分、不写稿。 */
  chat?: (prompt: string) => Promise<string>
  /** 合成一段语音(8792 /api/tts)。缺席 = 只有文字稿。 */
  tts?: (text: string) => Promise<FeedTtsResult>
  /** 事务官的称呼(写稿子用)。读不到就用「你」。 */
  ownerName?: () => Promise<string | undefined>
  /**
   * 一个账号的定位 / 受众 / 风格(2026-09-22 卡 ③)。**只有运营模板下才接**:
   * 接线的那一头(src/index.ts)按 `project_source === 'accounts'` 决定传不传,
   * 所以这个文件一个字都不认识"模板"这件事。
   *
   * 缺席、或这个账号一项都没填 → **这一轮不提炼选题**,收件箱里退回普通资讯建议。
   * 拿"一个小红书账号"这种空话去问模型,提炼出来的是通用鸡汤,不是她的选题。
   */
  accountProfile?: (projectId: string) => Promise<FeedAccountProfile | undefined>
  /**
   * 接 Aiboo 的 AIDJ 双主播节目(2026-09-22)。缺席 = 与接它之前逐字相同
   * (自己合成单人口播、不推信源)。
   */
  aidj?: FeedAidjHook
  now?: () => number
  onChanged?: () => void
}

export interface FeedRunResult {
  date: string
  /** 真落进 feed.json 的条目数。 */
  added: number
  /** 一句人话,进早报的 note。 */
  note: string
  /** 出了什么问题(中转没配搜索、模型接不上)。顺利时缺席。 */
  error?: string
  podcast?: FeedPodcast
}

export interface FeedProjectGroup {
  project_id: string
  project_name: string
  items: FeedItem[]
}

export interface FeedView {
  date: string
  groups: FeedProjectGroup[]
  /** 今天那段播客。没有就缺席。 */
  podcast?: FeedPodcast
  config: FeedConfig
  last_run_at: number
  last_error?: string
}

export interface FeedService {
  load(): Promise<void>
  config(): FeedConfig
  setConfig(patch: unknown): Promise<FeedConfig>
  view(date?: string): FeedView
  /** 跑一轮管线(早报前、或手工)。 */
  run(): Promise<FeedRunResult>
  /**
   * 「跟进 / 不看了 / 不要 / 已建成选题」。
   * - `mute` 回写 muted_sources / muted_topics(整片降权);
   * - `decline` 回写 declined_urls / declined_titles(**只针对这一条**)。
   */
  feedback(id: string, action: 'follow' | 'mute' | 'decline' | 'adopted'): Promise<{ ok: true } | { ok: false, error: string }>
  /**
   * 早报要念的那几条(每项目最多 3 条)。**有选题就念选题**,见 morningLines。
   */
  morning(date?: string): MorningFeedGroup[]
  /** 「要跟进」的那些,给收件箱出建议(**不含已提炼成选题的**)。 */
  followUps(date?: string): FeedItem[]
  /** 今天的「选题建议」,给收件箱出那一档(2026-09-22)。 */
  topicSuggestions(date?: string): FeedItem[]
  /** 按 id 取一条(一键建选题时要用它的标题、链接、账号)。没有就 undefined。 */
  item(id: string): FeedItem | undefined
  /** 那一天的播客音频在哪(绝对路径)。没有就 undefined。 */
  podcastPath(date?: string): string | undefined
}

async function writeAtomic(path: string, data: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, path)
}

/**
 * 落盘里那张 `segments`。**坏条逐条挑掉**:一条起止读不出来不该让整期播客的联动消失,
 * 但一张空表要整格缺席(空表与「没有这张表」在手机上是同一件事,别给它两种形状)。
 */
function parseSegments(raw: unknown): FeedPodcastSegment[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const rows: FeedPodcastSegment[] = []
  for (const value of raw) {
    if (typeof value !== 'object' || value === null) continue
    const row = value as Record<string, unknown>
    if (typeof row.item_id !== 'string' || row.item_id === '') continue
    if (typeof row.start_ms !== 'number' || typeof row.end_ms !== 'number') continue
    if (!Number.isFinite(row.start_ms) || !Number.isFinite(row.end_ms)) continue
    rows.push({
      item_id: row.item_id,
      start_ms: row.start_ms,
      end_ms: row.end_ms,
      ...(row.estimated === true ? { estimated: true as const } : {}),
    })
  }
  return rows.length === 0 ? undefined : rows
}

/** 落盘里那一段 `topic`。两个字段缺一个就整个不认(半条选题比没有更坏)。 */
function parseTopicField(raw: unknown): FeedTopic | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const row = raw as Record<string, unknown>
  const title = typeof row.title === 'string' ? row.title.trim() : ''
  const whyNow = typeof row.why_now === 'string' ? row.why_now.trim() : ''
  if (title === '' || whyNow === '') return undefined
  return { title, why_now: whyNow }
}

function parseFeedFile(raw: unknown): FeedFile {
  if (typeof raw !== 'object' || raw === null) return emptyFeedFile()
  const obj = raw as Record<string, unknown>
  const items: FeedItem[] = []
  if (Array.isArray(obj.items)) {
    for (const value of obj.items) {
      if (typeof value !== 'object' || value === null) continue
      const row = value as Record<string, unknown>
      if (typeof row.id !== 'string' || typeof row.url !== 'string' || typeof row.title !== 'string') continue
      if (typeof row.project_id !== 'string' || typeof row.date !== 'string') continue
      items.push({
        id: row.id,
        project_id: row.project_id,
        project_name: typeof row.project_name === 'string' ? row.project_name : row.project_id,
        title: row.title,
        url: row.url,
        ...(typeof row.source === 'string' ? { source: row.source } : {}),
        ...(typeof row.published_at === 'string' ? { published_at: row.published_at } : {}),
        ...(typeof row.story_url === 'string' ? { story_url: row.story_url } : {}),
        why: typeof row.why === 'string' ? row.why : '',
        score: typeof row.score === 'number' ? row.score : 0,
        follow_up: row.follow_up === true,
        ...(parseTopicField(row.topic) === undefined ? {} : { topic: parseTopicField(row.topic) as FeedTopic }),
        ...(row.feedback === 'follow' || row.feedback === 'mute' || row.feedback === 'decline' || row.feedback === 'adopted'
          ? { feedback: row.feedback }
          : {}),
        date: row.date,
        at: typeof row.at === 'number' ? row.at : 0,
      })
    }
  }
  const podcasts: FeedPodcast[] = []
  if (Array.isArray(obj.podcasts)) {
    for (const value of obj.podcasts) {
      if (typeof value !== 'object' || value === null) continue
      const row = value as Record<string, unknown>
      if (typeof row.date !== 'string' || typeof row.script !== 'string') continue
      const segments = parseSegments(row.segments)
      podcasts.push({
        date: row.date,
        script: row.script,
        ...(typeof row.file === 'string' ? { file: row.file } : {}),
        ...(typeof row.bytes === 'number' ? { bytes: row.bytes } : {}),
        ...(segments === undefined ? {} : { segments }),
        ...(typeof row.error === 'string' ? { error: row.error } : {}),
        at: typeof row.at === 'number' ? row.at : 0,
      })
    }
  }
  return {
    version: 1,
    items,
    podcasts,
    last_run_at: typeof obj.last_run_at === 'number' ? obj.last_run_at : 0,
    ...(typeof obj.last_error === 'string' ? { last_error: obj.last_error } : {}),
  }
}

/** 一句错误原文,截短;像令牌的长串抹掉(同 routines.ts 的 errorNote)。 */
function errorNote(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[A-Za-z0-9_-]{32,}/g, '…').slice(0, 200)
}

export function createFeedService(opts: FeedServiceOptions): FeedService {
  const now = opts.now ?? (() => Date.now())
  const audioDir = opts.audioDir ?? dirname(opts.file)
  let config: FeedConfig = DEFAULT_FEED_CONFIG
  let file: FeedFile = emptyFeedFile()
  /** 同一时刻只跑一轮。跑着的时候再来一次直接返回上一轮的 Promise —— 排队等于同一天搜两遍。 */
  let running: Promise<FeedRunResult> | undefined

  async function saveFile(): Promise<void> {
    await writeAtomic(opts.file, `${JSON.stringify(file, null, 2)}\n`)
  }

  async function saveConfig(): Promise<void> {
    await writeAtomic(opts.configFile, `${JSON.stringify(config, null, 2)}\n`)
  }

  function today(): string {
    return localDateStr(now())
  }

  /**
   * 偏好里的项目名单**跟着项目区走**:新项目自动加一条空关键词的偏好(不搜,等他填),
   * 项目没了就把那条丢掉。名字变了跟着改。
   * 关键词一个字都不替他猜 —— 「关注什么」是他的话,不是我们推断出来的。
   */
  async function syncInterests(): Promise<FeedInterest[]> {
    let projects: readonly { id: string, name: string }[] = []
    try { projects = await opts.projects() }
    catch { return config.interests }
    const byId = new Map(config.interests.map(item => [item.project_id, item]))
    const next: FeedInterest[] = projects.map((project) => {
      const existing = byId.get(project.id)
      return existing === undefined
        ? { project_id: project.id, project_name: project.name, keywords: [] }
        : { ...existing, project_name: project.name }
    })
    const changed = next.length !== config.interests.length
      || next.some((item, i) => config.interests[i]?.project_id !== item.project_id
        || config.interests[i]?.project_name !== item.project_name)
    if (changed) {
      config = { ...config, interests: next }
      try { await saveConfig() }
      catch { /* 存不下只影响下次重启,这一轮照跑 */ }
    }
    return next
  }

  /** 一个项目跑一轮:搜 → 去重 → 筛掉不看的 → 打分 → 回条目。 */
  async function runInterest(interest: FeedInterest, date: string, ms: number): Promise<{ items: FeedItem[], error?: string }> {
    const search = opts.search
    if (search === undefined) return { items: [], error: '这台机器还没接上搜索服务' }
    const queries = queriesOf(interest)
    if (queries.length === 0) return { items: [] }
    const limit = interest.limit ?? config.per_project
    const raw: SearchResult[] = []
    let error: string | undefined
    for (const query of queries) {
      const result = await search(query, Math.min(MAX_PER_PROJECT * 2, limit * 3))
      if (!result.ok) { error = result.error; continue }
      raw.push(...result.results)
    }
    // 三道筛子,顺序固定:去重 → 「不看了」(整片降权)→ 「不要」(只这一条)。
    const rows = filterDeclined(filterMuted(dedupeResults(raw), interest), interest).slice(0, limit * 3)
    if (rows.length === 0) return { items: [], ...(error === undefined ? {} : { error }) }

    // 打分。模型接不上就**不打分**,条目照样落(score 0、why 用搜索摘要)——
    // 有一堆没排过序的条目,比"今天什么都没有"更接近真相。
    let scorings: Scoring[] = []
    if (opts.chat !== undefined) {
      try {
        const answer = await opts.chat(scoringPrompt({ projectName: interest.project_name, keywords: interest.keywords, rows }))
        scorings = parseScoring(answer, rows.length)
      }
      catch (err) { error = error ?? `没能让模型给资讯打分:${errorNote(err)}` }
    }
    const byIndex = new Map(scorings.map(s => [s.index, s]))
    const scored = rows.map((row, index) => ({ row, score: byIndex.get(index) }))
    scored.sort((a, b) => (b.score?.score ?? 0) - (a.score?.score ?? 0))
    const items = scored.slice(0, limit).map(({ row, score }): FeedItem => ({
      id: feedItemId(row.url),
      project_id: interest.project_id,
      project_name: interest.project_name,
      title: row.title,
      url: row.url,
      ...(row.source === undefined ? {} : { source: row.source }),
      ...(row.published_at === undefined ? {} : { published_at: row.published_at }),
      why: score?.why !== undefined && score.why !== '' ? score.why : row.snippet.slice(0, 80),
      score: score?.score ?? 0,
      follow_up: score?.follow_up ?? false,
      date,
      at: ms,
    }))
    return { items, ...(error === undefined ? {} : { error }) }
  }

  /**
   * 把今天挑出来的那几条资讯提炼成选题(2026-09-22 卡 ③ 第 1 条)。
   *
   * 三道闸,少一道就退回不提炼(**绝不编一条选题**):
   *   ① 接了 `accountProfile`(= 运营模板);② 这个账号的档案里真有话;③ 接了模型。
   *
   * 回一句人话进这一轮的 note —— 自动动作要看得见(PRD §9)。**不抛**:
   * 提炼是资讯管线上的一层加工,它失败不该把今天的资讯一起拖没。
   */
  async function refineTopics(date: string): Promise<{ items: FeedItem[], note?: string }> {
    if (opts.accountProfile === undefined) return { items: file.items }
    // 今天一条资讯都没有 → 没什么可提炼的,一句话都不说(不是"提炼失败")。
    if (itemsOf(file, date).length === 0) return { items: file.items }
    // 模型接不上时**记一条带原因的**,而且这一问要问在挑条目**之前** —— 与 makePodcast
    // 同一条理由:模型没接上的时候条目全是 0 分、挑出来必然是空的,先判"没有够得上的条目"
    // 会把人往错的方向查(根因是模型,不是今天的资讯不行)。
    if (opts.chat === undefined) {
      return { items: file.items, note: '选题:模型服务还没接上,今天只有原始资讯' }
    }
    const candidates = pickTopicCandidates(morningPicks(file, date, config.per_project))
    if (candidates.length === 0) return { items: file.items }
    const byId = new Map<string, FeedTopic>()
    const problems: string[] = []
    let asked = 0
    for (const candidate of candidates) {
      const name = candidate.items[0]?.project_name ?? candidate.project_id
      let profile: FeedAccountProfile | undefined
      try { profile = await opts.accountProfile(candidate.project_id) }
      catch (err) { problems.push(`${name}:读不到账号档案(${errorNote(err)})`); continue }
      // 档案一项都没填 —— **如实跳过**,不拿空话去问模型。
      if (!hasProfile(profile)) { problems.push(`${name}:账号档案还没填定位/人群/风格,没提炼选题`); continue }
      try {
        const answer = await opts.chat(topicPrompt({
          projectName: name,
          profile: profile as FeedAccountProfile,
          rows: candidate.items,
        }))
        const topics = applyTopics(candidate.items, parseTopics(answer, candidate.items.length))
        for (const row of topics) if (row.topic !== undefined) byId.set(row.id, row.topic)
        asked += 1
      }
      catch (err) { problems.push(`${name}:没能提炼选题(${errorNote(err)})`) }
    }
    const items = file.items.map(item => (byId.has(item.id) ? { ...item, topic: byId.get(item.id) as FeedTopic } : item))
    const done = byId.size === 0
      ? (asked === 0 ? undefined : '选题:今天这些资讯里没提炼出能做的选题')
      : `选题:提炼出 ${byId.size} 条`
    const note = [done, ...problems].filter((one): one is string => one !== undefined && one !== '').join(';')
    return { items, ...(note === '' ? {} : { note }) }
  }

  /** 写稿 + 合成 + 放进发件目录。整段失败只留文字稿(卡里定的)。 */
  async function makePodcast(date: string, ms: number, aidjReady: boolean): Promise<FeedPodcast | undefined> {
    if (!config.podcast) return undefined
    // Aiboo 那期在 → **不自己合成**(卡里定的「不再自己合成单人口播」)。
    // 单人口播这一整套原样留着,只在 AIDJ 取不到时才跑 —— 它是退路。
    if (aidjReady) return undefined
    // 模型接不上时**记一条带原因的**,而不是静悄悄地没有播客。而且这一条要问在挑条目**之前**:
    // 模型没接上的时候条目全是 0 分、挑出来必然是空的,先判"没有够得上的条目"会把人
    // 往错的方向查 —— 根因是模型,不是今天没新闻。
    if (opts.chat === undefined) return { date, script: '', error: '模型服务还没接上,今天没有口播稿', at: ms }
    const groups = morningPicks(file, date, config.per_project)
    if (groups.length === 0) return undefined
    let name = '你'
    try { name = (await opts.ownerName?.()) ?? '你' }
    catch { /* 读不到称呼就用「你」 */ }
    let raw: string
    try {
      raw = cleanScript(await opts.chat(podcastPrompt({ name, minutes: config.podcast_minutes, groups })))
    }
    catch (error) {
      return { date, script: '', error: `没能写出今天的口播稿:${errorNote(error)}`, at: ms }
    }
    if (raw === '') return { date, script: '', error: '模型没回稿子', at: ms }
    /**
     * 按条目分段(2026-10-13,卡「播客页联动」)。记号认不出就整篇一块,
     * 落盘的 `script` 是摘掉记号之后的全文 —— 手机上那份文字稿读的是它。
     */
    const parsed = splitPodcastScript(raw, podcastItemIds(groups))
    const script = parsed.script
    if (opts.tts === undefined) {
      return { date, script, error: '这台机器上的语音后端没接上,今天只有文字稿', at: ms }
    }
    try {
      /**
       * 一块一块合成再把字节接起来。两层切:
       *   ① 按条目分段(上面那一步)—— 为的是量出每条资讯的起止;
       *   ② 每一块再按 8792 单次 2000 字的上限切(`splitScript`,见 PODCAST_MAX_CHARS)。
       *
       * **串行**:8792 那边的队列本来就是串行的,这里并发发过去只会排在同一条队里,还多占几条连接。
       * 代价是 TTS 调用从「整篇 1–2 次」变成「1 + 条目数」次(见交接「花掉什么」那一节)。
       */
      const buffers: Buffer[] = []
      let contentType = 'audio/mpeg'
      /** 每一块:讲的是哪条、这一块的字节从哪到哪、多少字(量不出时按字数估)。 */
      const spans: { item_id?: string, bytes: Buffer[], chars: number }[] = []
      for (const block of parsed.blocks) {
        const mine: Buffer[] = []
        for (const part of splitScript(block.text)) {
          const one = await opts.tts(part)
          buffers.push(one.buffer)
          mine.push(one.buffer)
          contentType = one.contentType
        }
        spans.push({ ...(block.item_id === undefined ? {} : { item_id: block.item_id }), bytes: mine, chars: block.text.length })
      }
      if (buffers.length === 0) return { date, script, error: '稿子是空的,没东西可合成', at: ms }
      const buffer = buffers.length === 1 ? (buffers[0] as Buffer) : Buffer.concat(buffers)
      const segments = segmentsOf(spans)
      // 扩展名按真实内容定(见文件头):audio/mpeg → mp3,别的按 / 后面那一段。
      const ext = /mpeg|mp3/i.test(contentType) ? 'mp3' : (contentType.split('/')[1]?.split(';')[0] ?? 'mp3')
      const fileName = podcastFileName(date, ext)
      const target = join(audioDir, fileName)
      await writeAtomic(target, buffer)
      // 往发件目录放一份,工人下一拍就把它发到手机上。放不进去不算失败 ——
      // 手机上那条播放条走的是 HTTP,发件只是"顺便也存一份到手机里"。
      if (opts.outboxDir !== undefined) {
        try {
          await mkdir(opts.outboxDir, { recursive: true })
          await copyFile(target, join(opts.outboxDir, fileName))
        }
        catch { /* 发不出去就只在电脑上 */ }
      }
      return {
        date,
        script,
        file: fileName,
        bytes: buffer.length,
        ...(segments.length === 0 ? {} : { segments }),
        at: ms,
      }
    }
    catch (error) {
      return { date, script, error: `语音合成失败,今天只有文字稿:${errorNote(error)}`, at: ms }
    }
  }

  async function runOnce(): Promise<FeedRunResult> {
    const ms = now()
    const date = today()
    if (!config.enabled) return { date, added: 0, note: '资讯这一块关着' }
    const interests = await syncInterests()
    const withKeywords = interests.filter(item => queriesOf(item).length > 0)
    const aihotOn = config.aihot && opts.aihotDaily !== undefined
    // 两边都没有:与接 AIHOT 之前逐字相同的两句实话。
    if (!aihotOn && withKeywords.length === 0) {
      return { date, added: 0, note: '还没有哪个项目填了「关注什么」,今天没搜' }
    }
    if (!aihotOn && opts.search === undefined) {
      const error = '这台机器还没接上搜索服务(中转的 /v1/search 没配),今天的资讯整块没有'
      file = { ...file, last_run_at: ms, last_error: error }
      try { await saveFile() } catch { /* 记一笔失败而已 */ }
      return { date, added: 0, note: error, error }
    }

    const problems: string[] = []
    /*
     * ★ **早报以 AIHOT 日报为底**(2026-10-14,卡 AC;维护者:「以 Aihot 现在每天的日报作为基础加上几项项目相关的内容」):
     * 先拉当天那一期,摊成「AI 日报」那一组,排在项目组前面。拉不到如实记一句,项目那几条照跑。
     */
    const aihotItems: FeedItem[] = []
    let aihotNote = ''
    if (aihotOn) {
      try {
        const parsed = parseAihotDaily(await (opts.aihotDaily as NonNullable<FeedServiceOptions['aihotDaily']>)(date))
        aihotItems.push(...aihotItemsToFeed(parsed.items, date, ms))
        aihotNote = aihotItems.length === 0 ? 'AI 日报:这一期一条都没读出来' : `AI 日报 ${aihotItems.length} 条`
        if (aihotItems.length === 0) problems.push('AI 日报:这一期一条都没读出来')
      }
      catch (err) {
        aihotNote = `AI 日报拉不到(${errorNote(err)})`
        problems.push(aihotNote)
      }
    }

    const projectItems: FeedItem[] = []
    if (withKeywords.length > 0 && opts.search === undefined) {
      problems.push('项目资讯:这台机器还没接上搜索服务(中转的 /v1/search 没配)')
    }
    else {
      for (const interest of withKeywords) {
        const result = await runInterest(interest, date, ms)
        projectItems.push(...result.items)
        if (result.error !== undefined) problems.push(`${interest.project_name}:${result.error}`)
      }
    }

    /*
     * ★ **按信息去重,不按来源**(卡 AC):之前几天出现过的那件事,今天换一家报道也不再出现;
     * 同一轮里项目搜到的与日报同一件事的也丢(日报在前,它是底)。判法在 feedAihot.sameStory。
     */
    const seenBefore = file.items.filter(item => item.date < date)
    const { kept: fresh, dropped } = dropSeenStories([...aihotItems, ...projectItems], seenBefore)

    // 今天这些项目的旧条目换成新的(同一天重跑不该出现两份);别的日子原样留着。
    const touched = new Set([...withKeywords.map(item => item.project_id), ...(aihotOn ? [AIHOT_PROJECT_ID] : [])])
    const kept = file.items.filter(item => !(item.date === date && touched.has(item.project_id)))
    // 用户已经表过态的那些,表态跟着 id 带过来 —— 重跑不该把「不看了」清掉。
    const stated = new Map(file.items.filter(item => item.feedback !== undefined).map(item => [item.id, item.feedback]))
    const merged = fresh.map((item) => {
      const feedback = stated.get(item.id)
      return feedback === undefined ? item : { ...item, feedback }
    })
    const error = problems.length === 0 ? undefined : problems.join(';')
    file = pruneFeed({
      ...file,
      items: [...kept, ...merged],
      last_run_at: ms,
      ...(error === undefined ? {} : { last_error: error }),
    }, date)
    if (error === undefined) delete file.last_error

    // 提炼选题(运营模板才有)。**在推给 Aiboo 与写口播稿之前** —— 早报与播客念的
    // 都是提炼之后的那两句(卡 ③ 第 3 条),放在后面等于念的还是原标题。
    const refined = await refineTopics(date)
    file = { ...file, items: refined.items }
    const topicNote = refined.note

    // Aiboo:① 把当天条目推过去当信源;② 问一句今天那期在不在(在就不自己合成)。
    // 两步都**不抛**,谁挂了都不连累这一轮资讯本身。
    const aidjNotes: string[] = []
    let aidjReady = false
    if (opts.aidj !== undefined) {
      try {
        const pushed = await opts.aidj.push(morningPicks(file, date, config.per_project), date)
        if (pushed.note !== '') aidjNotes.push(pushed.note)
      }
      catch (err) { aidjNotes.push(`没能把资讯推给 Aiboo:${errorNote(err)}`) }
      if (config.podcast) {
        try {
          const state = await opts.aidj.ready()
          aidjReady = state.ready
          if (state.note !== undefined && state.note !== '') aidjNotes.push(state.note)
        }
        catch (err) { aidjNotes.push(`没能问到 Aiboo 今天的播客:${errorNote(err)}`) }
      }
    }

    const podcast = await makePodcast(date, ms, aidjReady)
    if (podcast !== undefined) {
      file = { ...file, podcasts: [...file.podcasts.filter(p => p.date !== date), podcast] }
    }
    try { await saveFile() }
    catch (err) { problems.push(`落盘失败:${errorNote(err)}`) }
    opts.onChanged?.()

    const picked = morningPicks(file, date).reduce((n, group) => n + group.items.length, 0)
    const podcastNote = aidjReady
      ? ';播客:走 Aiboo 的双主播节目'
      : podcast === undefined
        ? (config.podcast ? ';播客:今天没有够得上的条目' : '')
        : (podcast.file === undefined ? `;播客:${podcast.error ?? '只有文字稿'}` : ';播客已合成')
    const droppedNote = dropped.length === 0 ? '' : `,去掉已经讲过的 ${dropped.length} 条`
    const projectNote = withKeywords.length === 0 ? '' : `${aihotNote === '' ? '' : ' + '}${withKeywords.length} 个项目搜到 ${projectItems.length} 条`
    const note = `资讯:${aihotNote}${projectNote}${droppedNote},早报能用 ${picked} 条${podcastNote}`
      + (topicNote === undefined ? '' : `;${topicNote}`)
      + (aidjNotes.length === 0 ? '' : `;${aidjNotes.join(';')}`)
      + (error === undefined ? '' : `;${error}`)
    return { date, added: merged.length, note, ...(error === undefined ? {} : { error }), ...(podcast === undefined ? {} : { podcast }) }
  }

  return {
    async load(): Promise<void> {
      try { config = parseFeedConfig(JSON.parse(await readFile(opts.configFile, 'utf8'))) }
      catch { config = DEFAULT_FEED_CONFIG }
      try { file = parseFeedFile(JSON.parse(await readFile(opts.file, 'utf8'))) }
      catch { file = emptyFeedFile() }
    },

    config: () => config,

    async setConfig(patch: unknown): Promise<FeedConfig> {
      const obj = (typeof patch === 'object' && patch !== null ? patch : {}) as Record<string, unknown>
      // 逐块合并:只给了 podcast 不该把 interests 冲没。
      const merged = { ...config, ...obj }
      if (!Array.isArray(obj.interests)) merged.interests = config.interests
      config = parseFeedConfig(merged, config)
      await saveConfig()
      opts.onChanged?.()
      return config
    },

    view(date = today()): FeedView {
      const groups = new Map<string, FeedProjectGroup>()
      for (const item of itemsOf(file, date)) {
        const group = groups.get(item.project_id)
          ?? { project_id: item.project_id, project_name: item.project_name, items: [] }
        group.items.push(item)
        groups.set(item.project_id, group)
      }
      const podcast = file.podcasts.find(p => p.date === date)
      return {
        date,
        groups: [...groups.values()],
        ...(podcast === undefined ? {} : { podcast }),
        config,
        last_run_at: file.last_run_at,
        ...(file.last_error === undefined ? {} : { last_error: file.last_error }),
      }
    },

    async run(): Promise<FeedRunResult> {
      if (running !== undefined) return running
      running = runOnce().finally(() => { running = undefined })
      return running
    },

    async feedback(id, action) {
      const item = file.items.find(row => row.id === id)
      if (item === undefined) return { ok: false, error: '没有这一条资讯(多半已经过了 14 天)' }
      file = { ...file, items: file.items.map(row => (row.id === id ? { ...row, feedback: action } : row)) }
      if (action === 'mute' || action === 'decline') {
        config = action === 'mute' ? applyMute(config, item) : applyDecline(config, item)
        try { await saveConfig() }
        catch { /* 偏好没写下只影响下一轮筛选,这一条照样收起来 */ }
      }
      try { await saveFile() }
      catch (error) { return { ok: false, error: `没能记下这次反馈:${errorNote(error)}` } }
      opts.onChanged?.()
      return { ok: true }
    },

    morning: (date = today()) => morningLines(file, date),
    followUps: (date = today()) => followUps(file, date),
    topicSuggestions: (date = today()) => topicSuggestions(file, date),
    item: (id: string) => file.items.find(row => row.id === id),
    podcastPath(date = today()): string | undefined {
      const podcast = file.podcasts.find(p => p.date === date)
      return podcast?.file === undefined ? undefined : join(audioDir, podcast.file)
    },
  }
}
