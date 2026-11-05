/**
 * **早报以 AIHOT 日报为底 + 跨天按「信息」去重**(2026-10-14 上午,卡 AC;维护者:
 * 「以 Aihot 现在每天的日报作为基础加上几项项目相关的内容,并且已经出现过的就不要再出现了,要做去重,
 * 要根据信息去重而不是信息源去重,免得同一个事情 A 报道过,B 再报道的时候又拉回来了」「现在做,不影响」)。
 *
 * ## AIHOT 是什么
 *
 * `https://aihot.news`(开源 `KKKKhazix/AIHOT`,MIT):AI 行业日报,每天 08:00 出刊;匿名只读、不要 key。
 * `GET /api/v1/dailies/{YYYY-MM-DD}` / `/dailies/latest` → `report{date, lead, sections[{label, items[{title, summary,
 * source{name}, links{aihot, original}}]}], flashes[{title, source, links, publishedAt}]}`(10-14 统筹真打过,夹具
 * `tests/fixtures/aihot-daily-2026-10-14.json` 就是那一期裁短的)。它自己已经把同一件事的多家报道聚成一条,
 * `links.aihot` 就是那件事的页。
 *
 * ## 两条纪律
 *
 *   ① **一个数都不编**:日报条目的 `why` 用它的摘要,`score` 固定写 {@link AIHOT_DAILY_SCORE}(= 「AIHOT 选进日报的」,
 *      不是模型打的相关度;只为过 `morningPicks` 的 `score > 0` 那道门),快讯 {@link AIHOT_FLASH_SCORE};
 *   ② **按信息去重,不按来源**:同一件事昨天 A 家报过、今天 B 家再报,不再出现。判「同一件事」三样任一:
 *      规范化 URL 相同、AIHOT 事件页相同、标题说的是一回事({@link sameStory}:去标点后相等 / 一个包着另一个 /
 *      二元组重合过半)。这是纯函数,离线用例喂数据。
 *
 * 这个文件没有 I/O:拉日报那一下在 `index.ts` 接线(fetch + User-Agent),`feed.ts` 只拿解析好的条目。
 */
import type { FeedItem } from './feed.ts'
import { feedItemId, normalizeUrl } from './feed.ts'

/** 早报里那一组的 id / 名字(与项目组并列,排在最前)。 */
export const AIHOT_PROJECT_ID = 'aihot-daily'
export const AIHOT_PROJECT_NAME = 'AI 日报'
/** 日报正文条目 / 快讯的分数(见文件头纪律 ①)。 */
export const AIHOT_DAILY_SCORE = 3
export const AIHOT_FLASH_SCORE = 2
/** 早报里 AI 日报那一组最多几条(项目组照旧 `MORNING_PER_PROJECT`)。 */
export const AIHOT_MORNING_MAX = 8
/** 快讯最多收几条(日报正文全收)。 */
export const AIHOT_FLASH_MAX = 4
/** 标题判「同一件事」:二元组重合比例的门。 */
export const SAME_STORY_JACCARD = 0.6
/** 拉哪一天:`dailies/{date}`,没出刊(404)退 `dailies/latest`。 */
export const AIHOT_BASE_URL = 'https://aihot.news'

export interface AihotDailyItem {
  title: string
  summary: string
  source?: string
  /** 原文链接;没有就用 AIHOT 自己那页。 */
  url: string
  /** AIHOT 的事件页(同一件事多家报道聚成的那一条)。 */
  aihot_url?: string
  published_at?: string
  /** 日报里的分节名(模型发布 / 产品发布 / 行业动态 / 论文研究 / 技巧与观点 / 快讯)。 */
  section: string
  kind: 'daily' | 'flash'
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

function itemOf(raw: unknown, section: string, kind: 'daily' | 'flash'): AihotDailyItem | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const row = raw as Record<string, unknown>
  const title = text(row.title)
  if (title === '') return undefined
  const links = (typeof row.links === 'object' && row.links !== null ? row.links : {}) as Record<string, unknown>
  const original = text(links.original)
  const aihot = text(links.aihot)
  const url = original !== '' ? original : aihot
  if (url === '') return undefined
  const source = (typeof row.source === 'object' && row.source !== null ? row.source : {}) as Record<string, unknown>
  const sourceName = text(source.name)
  const published = text(row.publishedAt)
  return {
    title,
    summary: text(row.summary),
    ...(sourceName === '' ? {} : { source: sourceName }),
    url,
    ...(aihot === '' ? {} : { aihot_url: aihot }),
    ...(published === '' ? {} : { published_at: published }),
    section,
    kind,
  }
}

/** 一期日报的回包 → 条目(正文全收、快讯最多 {@link AIHOT_FLASH_MAX} 条)。读不懂 → 空数组,**不抛**。 */
export function parseAihotDaily(raw: unknown): { date?: string, items: AihotDailyItem[] } {
  if (typeof raw !== 'object' || raw === null) return { items: [] }
  const report = ((raw as Record<string, unknown>).report ?? raw) as Record<string, unknown>
  if (typeof report !== 'object' || report === null) return { items: [] }
  const date = text(report.date)
  const items: AihotDailyItem[] = []
  if (Array.isArray(report.sections)) {
    for (const section of report.sections) {
      if (typeof section !== 'object' || section === null) continue
      const label = text((section as Record<string, unknown>).label) || '要闻'
      const rows = (section as Record<string, unknown>).items
      if (!Array.isArray(rows)) continue
      for (const row of rows) {
        const item = itemOf(row, label, 'daily')
        if (item !== undefined) items.push(item)
      }
    }
  }
  if (Array.isArray(report.flashes)) {
    let taken = 0
    for (const row of report.flashes) {
      if (taken >= AIHOT_FLASH_MAX) break
      const item = itemOf(row, '快讯', 'flash')
      if (item === undefined) continue
      items.push(item)
      taken += 1
    }
  }
  return { ...(date === '' ? {} : { date }), items }
}

/** 日报条目 → 早报的条目(`project_id` = {@link AIHOT_PROJECT_ID},`why` = 它的摘要,分数见文件头)。 */
export function aihotItemsToFeed(items: readonly AihotDailyItem[], date: string, ms: number): FeedItem[] {
  const seen = new Set<string>()
  const out: FeedItem[] = []
  for (const item of items) {
    const id = feedItemId(item.url)
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      project_id: AIHOT_PROJECT_ID,
      project_name: AIHOT_PROJECT_NAME,
      title: item.title,
      url: item.url,
      source: item.source === undefined ? 'AIHOT' : `${item.source} · AIHOT`,
      ...(item.published_at === undefined ? {} : { published_at: item.published_at }),
      why: item.summary !== '' ? item.summary.slice(0, 160) : `AI 日报「${item.section}」`,
      score: item.kind === 'daily' ? AIHOT_DAILY_SCORE : AIHOT_FLASH_SCORE,
      follow_up: false,
      date,
      at: ms,
      ...(item.aihot_url === undefined ? {} : { story_url: item.aihot_url }),
    })
  }
  return out
}

/**
 * 标题的「信息键」:去标点、去空白、全小写、全角转半角,再去掉几个常见虚词
 * (「把 API 价格又砍了一半」与「API 价格再砍一半」说的是一回事)。
 */
export const STORY_PARTICLES = /[的了把又再也就还都被让在和与及并或而]/gu
export function storyKey(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .replace(STORY_PARTICLES, '')
}

function bigrams(key: string): Set<string> {
  const chars = [...key]
  const out = new Set<string>()
  for (let i = 0; i + 1 < chars.length; i += 1) out.add(`${chars[i]}${chars[i + 1]}`)
  return out
}

/**
 * **两条是不是同一件事**(按信息,不按来源)。三样任一:
 *   · 规范化 URL 相同(同一篇被转载,只差跟踪参数);
 *   · AIHOT 事件页相同(它已经把多家报道聚成一条);
 *   · 标题说的是一回事:信息键相等,或一个包着另一个(短的那个至少 8 个字),或二元组重合 ≥ {@link SAME_STORY_JACCARD}。
 */
export function sameStory(
  a: { title: string, url: string, story_url?: string },
  b: { title: string, url: string, story_url?: string },
): boolean {
  if (normalizeUrl(a.url) === normalizeUrl(b.url)) return true
  if (a.story_url !== undefined && b.story_url !== undefined && a.story_url === b.story_url) return true
  const ka = storyKey(a.title)
  const kb = storyKey(b.title)
  if (ka === '' || kb === '') return false
  if (ka === kb) return true
  const [short, long] = [...ka].length <= [...kb].length ? [ka, kb] : [kb, ka]
  if ([...short].length >= 8 && long.includes(short)) return true
  const ba = bigrams(ka)
  const bb = bigrams(kb)
  if (ba.size === 0 || bb.size === 0) return false
  let both = 0
  for (const g of ba) if (bb.has(g)) both += 1
  const union = ba.size + bb.size - both
  return union > 0 && both / union >= SAME_STORY_JACCARD
}

/**
 * **跨天与跨组去重**:`fresh` 按顺序走,与 `seen`(之前几天已经出现过的)或前面已经留下的任一条是同一件事就丢。
 * 回留下的与丢掉的(丢掉的进日志 / note,不悄悄少条目)。
 */
export function dropSeenStories<T extends { title: string, url: string, story_url?: string }>(
  fresh: readonly T[],
  seen: readonly { title: string, url: string, story_url?: string }[],
): { kept: T[], dropped: T[] } {
  const kept: T[] = []
  const dropped: T[] = []
  for (const item of fresh) {
    const dup = seen.some(old => sameStory(item, old)) || kept.some(old => sameStory(item, old))
    if (dup) dropped.push(item)
    else kept.push(item)
  }
  return { kept, dropped }
}
