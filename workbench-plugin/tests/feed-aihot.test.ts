// @vitest-environment node
/**
 * **早报以 AIHOT 日报为底 + 按信息去重**(2026-10-14 上午,卡 AC)。
 *
 * 维护者:「以 Aihot 现在每天的日报作为基础加上几项项目相关的内容,并且已经出现过的就不要再出现了,要做去重,
 * 要根据信息去重而不是信息源去重,免得同一个事情 A 报道过,B 再报道的时候又拉回来了」。
 *
 * 钉四件:① 真那一期日报(夹具)解析成条目,字段齐、一个数都不编;② 「同一件事」按标题 / URL / AIHOT 事件页判,
 * 不按来源;③ 整条管线:AI 日报那一组排最前、项目搜到的与它同一件事的丢掉、昨天出现过的今天不再出现、
 * 没接搜索也照出 AI 日报;④ 拉不到如实缺席、不拦项目那几条。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFeedService, type FeedService, type SearchResult } from '../src/server/feed.ts'
import {
  AIHOT_PROJECT_ID, AIHOT_DAILY_SCORE, AIHOT_FLASH_SCORE, aihotItemsToFeed, dropSeenStories, parseAihotDaily, sameStory, storyKey,
} from '../src/server/feedAihot.ts'

const DAILY = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'aihot-daily-2026-10-14.json'), 'utf8')) as unknown

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

describe('① 一期日报 → 条目', () => {
  it('夹具那一期:正文 8 条 + 快讯 2 条,标题 / 摘要 / 来源 / 原文 / 事件页都在', () => {
    const { date, items } = parseAihotDaily(DAILY)
    expect(date).toBe('2026-10-14')
    expect(items).toHaveLength(10)
    const first = items[0]!
    expect(first.title).toContain('Gemini 4 Argon')
    expect(first.summary.length).toBeGreaterThan(10)
    expect(first.source).toContain('Google')
    expect(first.url).toMatch(/^https?:\/\//)
    expect(first.aihot_url).toMatch(/^https:\/\/aihot\.news\/items\//)
    expect(first.section).toBe('模型发布/更新')
    expect(items.filter(one => one.kind === 'flash')).toHaveLength(2)
  })

  it('读不懂的回包 → 空数组不抛;条目进早报:分数固定、why 是它的摘要、来源带 AIHOT', () => {
    expect(parseAihotDaily(undefined).items).toEqual([])
    expect(parseAihotDaily({ report: { sections: 'x' } }).items).toEqual([])
    const feed = aihotItemsToFeed(parseAihotDaily(DAILY).items, '2026-10-14', 1)
    expect(feed[0]).toMatchObject({ project_id: AIHOT_PROJECT_ID, project_name: 'AI 日报', score: AIHOT_DAILY_SCORE, follow_up: false, date: '2026-10-14' })
    expect(feed[0]!.why).toBe(parseAihotDaily(DAILY).items[0]!.summary.slice(0, 160))
    expect(feed[0]!.source).toMatch(/AIHOT$/)
    expect(feed.find(one => one.score === AIHOT_FLASH_SCORE)).toBeDefined()
  })
})

describe('② 同一件事按信息判,不按来源', () => {
  const a = { title: 'Google 发布 Gemini 4 Argon:面向复杂工程与科研任务的前沿模型', url: 'https://blog.google/x', story_url: 'https://aihot.news/items/abc' }
  it('A 家报过的事 B 家再报(标题换了说法、链接不同)→ 同一件事', () => {
    expect(sameStory(a, { title: '谷歌发布 Gemini 4 Argon 前沿模型,面向复杂工程与科研任务', url: 'https://36kr.com/y' })).toBe(true)
    expect(sameStory(a, { title: 'Google 发布 Gemini 4 Argon！', url: 'https://other.example/z' })).toBe(true)
    // 同一篇被转载,只差跟踪参数
    expect(sameStory(a, { title: '随便', url: 'https://blog.google/x?utm_source=wx' })).toBe(true)
    // AIHOT 事件页相同
    expect(sameStory(a, { title: '完全不一样的标题', url: 'https://c.example/1', story_url: 'https://aihot.news/items/abc' })).toBe(true)
  })
  it('不是一回事的不误伤', () => {
    expect(sameStory(a, { title: 'Apple 发布 7 英寸智能音箱 HomeView', url: 'https://apple.com/h' })).toBe(false)
    expect(sameStory({ title: 'AI', url: 'https://a/1' }, { title: 'AI 2', url: 'https://a/2' })).toBe(false)
  })
  it('信息键:去标点空白、全角转半角、小写', () => {
    expect(storyKey('Google 发布 Gemini 4 Argon！')).toBe(storyKey('google发布gemini4argon'))
    expect(storyKey('ＡＩ 时代')).toBe('ai时代')
  })
  it('跨天与跨组去重:昨天出现过的、前面已经留下的,都丢;丢掉的交回来', () => {
    const seen = [{ title: 'DeepSeek 把 API 价格又砍了一半', url: 'https://news.example/1' }]
    const fresh = [
      { title: 'DeepSeek API 价格再砍一半!', url: 'https://b.example/1' },
      { title: '桌面 Agent 产品盘点', url: 'https://news.example/2' },
      { title: '桌面 Agent 产品盘点(转载)', url: 'https://c.example/2' },
    ]
    const { kept, dropped } = dropSeenStories(fresh, seen)
    expect(kept.map(one => one.url)).toEqual(['https://news.example/2'])
    expect(dropped).toHaveLength(2)
  })
})

/* ──────── ③ 整条管线 ──────── */

const TODAY = '2026-10-14'
const NOW = Date.parse(`${TODAY}T08:30:00`)
const YESTERDAY = '2026-10-13'

const PROJECT_RESULTS: SearchResult[] = [
  // 与 AI 日报头条同一件事(B 家报道)
  { title: '谷歌发布 Gemini 4 Argon 前沿模型,面向复杂工程与科研任务', url: 'https://36kr.com/gemini4', snippet: '谷歌今日发布……', source: '36氪' },
  { title: '办公 Agent 的落地场景越来越具体', url: 'https://news.example/agent-office', snippet: '多工单调度……', source: '掘金' },
  { title: '完全无关的体育新闻', url: 'https://news.example/sport', snippet: '球赛', source: '某体育' },
]

function makeFeed(over: { search?: boolean, aihot?: 'ok' | 'down' | 'off', now?: () => number } = {}): { feed: FeedService, dir: string, asked: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'wb-feed-aihot-'))
  dirs.push(dir)
  const asked: string[] = []
  const feed = createFeedService({
    file: join(dir, 'feed.json'),
    configFile: join(dir, 'feed-config.json'),
    projects: async () => [{ id: 'p1', name: '工作台' }],
    ...(over.search === false ? {} : { search: async () => ({ ok: true, results: PROJECT_RESULTS }) }),
    chat: async (prompt) => {
      if (prompt.includes('口播稿')) return '[[0]]早上好。\n\n[[1]]第一条。\n\n[[0]]就这些。'
      return '```json\n' + JSON.stringify([
        { i: 0, score: 4, why: '同一件事' },
        { i: 1, score: 3, why: '办公 Agent 与我们相关' },
        { i: 2, score: 0, why: '无关' },
      ]) + '\n```'
    },
    ...(over.aihot === 'off' ? {} : {
      aihotDaily: async (date) => {
        asked.push(date)
        if (over.aihot === 'down') throw new Error('连不上 aihot.news')
        return DAILY
      },
    }),
    now: over.now ?? (() => NOW),
  })
  return { feed, dir, asked }
}

describe('③ 整条管线:AI 日报为底 + 项目几条 + 按信息去重', () => {
  it('★AI 日报那一组排最前、最多 8 条;项目搜到的与日报同一件事的那条丢掉;no-score 的照旧不进', async () => {
    const { feed, asked } = makeFeed()
    await feed.load()
    await feed.setConfig({ interests: [{ project_id: 'p1', project_name: '工作台', keywords: ['Agent 调度'] }] })
    const result = await feed.run()
    expect(asked).toEqual([TODAY])
    const groups = feed.view(TODAY).groups
    expect(groups[0]?.project_id).toBe(AIHOT_PROJECT_ID)
    expect(groups[0]?.items.length).toBe(10)
    const project = groups.find(g => g.project_id === 'p1')
    // 与日报头条同一件事(谷歌 Gemini 4 Argon)那条丢掉;0 分那条照旧落盘(进不了早报,`morningPicks` 另有门)。
    expect(project?.items.map(i => i.title)).toEqual(['办公 Agent 的落地场景越来越具体', '完全无关的体育新闻'])
    expect(result.note).toContain('AI 日报')
    expect(result.note).toContain('去掉')
  })

  it('★昨天出现过的今天不再出现(同一件事换一家报道也不):第二天的日报里重复的那几条被丢', async () => {
    const clock = { ms: Date.parse(`${YESTERDAY}T08:30:00`) }
    const { feed } = makeFeed({ now: () => clock.ms })
    await feed.load()
    await feed.setConfig({ interests: [{ project_id: 'p1', project_name: '工作台', keywords: ['Agent 调度'] }] })
    await feed.run()
    const day1 = feed.view(YESTERDAY).groups.flatMap(g => g.items.length)
    expect(day1.reduce((a, b) => a + b, 0)).toBeGreaterThan(0)
    // 第二天:日报一字不差(同一期)→ 全是昨天出现过的 → 一条都不再出现;项目那条「办公 Agent」也昨天出过
    clock.ms = NOW
    const result = await feed.run()
    const today = feed.view(TODAY).groups
    expect(today.find(g => g.project_id === AIHOT_PROJECT_ID)).toBeUndefined()
    expect(today.find(g => g.project_id === 'p1')).toBeUndefined()
    expect(result.note).toContain('去掉')
    // 昨天那些照旧在昨天那一天里
    expect(feed.view(YESTERDAY).groups.length).toBeGreaterThan(0)
  })

  it('★没接搜索也照出 AI 日报(不再整块缺席);拉不到日报如实记一句、项目那几条照出', async () => {
    const noSearch = makeFeed({ search: false })
    await noSearch.feed.load()
    const r1 = await noSearch.feed.run()
    expect(noSearch.feed.view(TODAY).groups[0]?.project_id).toBe(AIHOT_PROJECT_ID)
    expect(r1.note).toContain('AI 日报')

    const down = makeFeed({ aihot: 'down' })
    await down.feed.load()
    await down.feed.setConfig({ interests: [{ project_id: 'p1', project_name: '工作台', keywords: ['Agent 调度'] }] })
    const r2 = await down.feed.run()
    expect(down.feed.view(TODAY).groups.find(g => g.project_id === AIHOT_PROJECT_ID)).toBeUndefined()
    expect(down.feed.view(TODAY).groups.find(g => g.project_id === 'p1')?.items.length).toBe(3)
    expect(r2.note).toContain('连不上 aihot.news')
  })

  it('开关:config.aihot = false → 不拉、不出那一组;老配置缺席当开', async () => {
    const { feed, asked } = makeFeed()
    await feed.load()
    expect(feed.config().aihot).toBe(true)
    await feed.setConfig({ aihot: false, interests: [{ project_id: 'p1', project_name: '工作台', keywords: ['Agent 调度'] }] })
    await feed.run()
    expect(asked).toEqual([])
    expect(feed.view(TODAY).groups.find(g => g.project_id === AIHOT_PROJECT_ID)).toBeUndefined()
  })
})
