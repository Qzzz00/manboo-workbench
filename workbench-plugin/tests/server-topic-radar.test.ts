// @vitest-environment node
/**
 * 选题雷达(2026-09-22 卡 ③):资讯 → 按账号定位提炼成「选题 + 一句为什么现在做」→
 * 收件箱里一条「选题建议」→ 一键进选题池(来源落 `选题/<名>/来源.md`),「不要」记住这一条。
 *
 * 四块,与卡里第 4 条「用例」一一对应:
 *   ① 提炼函数(纯 + 服务两层):**提不出就不给**,一个字都不编;
 *   ② 去重与「不要」记忆:同链接 / 同标题不再推,而且 `decline ≠ mute`;
 *   ③ 一键建选题:真起 8791、真落盘、真建目录与 `来源.md`;
 *   ④ 早报念的是选题那两句,不是原始摘要。
 */
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchLayout } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createTemplateService } from '../src/server/templateStore.ts'
import { TOPIC_DIR } from '../src/templates.ts'
import { deriveButlerInbox } from '../src/server/butlerInbox.ts'
import { appendTopicSource, TOPIC_SOURCE_FILE } from '../src/server/topicAssets.ts'
import {
  applyDecline, applyTopics, createFeedService, filterDeclined, followUps, hasProfile,
  itemsOf, morningLines, parseFeedConfig, parseTopics, pickTopicCandidates, topicPrompt,
  topicSuggestions, MAX_TOPICS_PER_DAY,
  type FeedAccountProfile, type FeedConfig, type FeedFile, type FeedItem, type FeedInterest,
  type FeedProjectGroup, type FeedService, type SearchResult,
} from '../src/server/feed.ts'
import { loadStarterLayoutTemplate } from './helpers/starterLayer.ts'

const OPS_TEMPLATE = await loadStarterLayoutTemplate()

const TODAY = '2026-09-22'
const NOW = Date.parse(`${TODAY}T07:30:00`)
const NOW_SEC = Math.floor(NOW / 1000)

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})
function tmpDir(prefix = 'wb-topic-radar-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function item(over: Partial<FeedItem> = {}): FeedItem {
  return {
    id: 'i1', project_id: 'p1', project_name: '小食堂', title: '标题', url: 'https://a.example/1',
    why: '有关系', score: 3, follow_up: false, date: TODAY, at: 1, ...over,
  }
}
function file(items: FeedItem[]): FeedFile {
  return { version: 1, items, podcasts: [], last_run_at: 0 }
}
function group(id: string, items: FeedItem[]): FeedProjectGroup {
  return { project_id: id, project_name: items[0]?.project_name ?? id, items }
}

// ———————————————————————— ① 提炼函数 ————————————————————————

const PROFILE: FeedAccountProfile = { positioning: '一个人也值得好好吃饭', audience: '一人食的上班族', style: '口播 + 实拍,不露脸' }

describe('提炼:问法', () => {
  it('账号的定位 / 人群 / 风格都进提示词,而且排在资讯前面', () => {
    const prompt = topicPrompt({ projectName: '小食堂', profile: PROFILE, rows: [item({ title: '预制菜新国标落地' })] })
    expect(prompt).toContain('一个人也值得好好吃饭')
    expect(prompt).toContain('一人食的上班族')
    expect(prompt).toContain('口播 + 实拍,不露脸')
    expect(prompt.indexOf('一个人也值得好好吃饭')).toBeLessThan(prompt.indexOf('预制菜新国标落地'))
  })

  it('三条硬要求都写进去了:只回 JSON、提不出就不给、不许编', () => {
    const prompt = topicPrompt({ projectName: '小食堂', profile: PROFILE, rows: [item()] })
    expect(prompt).toContain('只回一个 JSON 数组')
    expect(prompt).toContain('整条不要给')
    expect(prompt).toContain('不要编资讯里没有的事实')
  })

  it('档案里一个字都没有 = 提炼不了(不拿空话去问模型)', () => {
    expect(hasProfile(undefined)).toBe(false)
    expect(hasProfile({})).toBe(false)
    expect(hasProfile({ positioning: '  ' })).toBe(false)
    expect(hasProfile({ style: '口播' })).toBe(true)
  })
})

describe('提炼:解析', () => {
  it('认代码块、认字符串序号', () => {
    const answer = '好的:\n```json\n' + JSON.stringify([{ i: '1', title: '一个人吃饭要不要买预制菜', why_now: '新国标这周刚落地' }]) + '\n```'
    expect(parseTopics(answer, 3)).toEqual([{ index: 1, topic: { title: '一个人吃饭要不要买预制菜', why_now: '新国标这周刚落地' } }])
  })

  it('半条选题(只有标题没有理由,或反过来)整条丢掉——早报要念的是两句话', () => {
    const answer = JSON.stringify([
      { i: 0, title: '只有标题' },
      { i: 1, why_now: '只有理由' },
      { i: 2, title: '  ', why_now: '空标题' },
    ])
    expect(parseTopics(answer, 3)).toEqual([])
  })

  it('越界的序号、重复的序号、认不出的一律丢掉,不猜一个', () => {
    const answer = JSON.stringify([
      { i: 9, title: '越界', why_now: '越界' },
      { i: 0, title: '甲', why_now: '甲的理由' },
      { i: 0, title: '乙', why_now: '乙的理由' },
      '一句话',
    ])
    expect(parseTopics(answer, 2).map(one => one.topic.title)).toEqual(['甲'])
  })

  it('模型回的不是 JSON 数组时一条都不给(不编)', () => {
    expect(parseTopics('我觉得可以做一期一人食预制菜的选题', 2)).toEqual([])
  })

  it('applyTopics:没被提炼到的那几条原样,身上没有 topic', () => {
    const rows = [item({ id: 'a' }), item({ id: 'b' })]
    const out = applyTopics(rows, [{ index: 1, topic: { title: '选题', why_now: '现在' } }])
    expect(out[0]?.topic).toBeUndefined()
    expect(out[1]?.topic).toEqual({ title: '选题', why_now: '现在' })
    // 纯函数:原数组没被改
    expect(rows[1]?.topic).toBeUndefined()
  })
})

describe('提炼:挑哪几条去提炼', () => {
  it('0 分的不进(模型已经说了跟这个账号没关系)', () => {
    const picked = pickTopicCandidates([group('p1', [item({ id: 'a', score: 4 }), item({ id: 'b', score: 0 })])])
    expect(picked[0]?.items.map(one => one.id)).toEqual(['a'])
  })

  it('两个账号轮着挑,不让一个账号独占今天全部名额', () => {
    const many = (prefix: string, n: number): FeedItem[] =>
      Array.from({ length: n }, (_, i) => item({ id: `${prefix}${i}`, project_id: prefix, score: 5 - i }))
    const picked = pickTopicCandidates([group('p1', many('p1', 8)), group('p2', many('p2', 8))], 4)
    expect(picked.map(one => one.items.length)).toEqual([2, 2])
  })

  it('总数封顶一天 10 条', () => {
    const many = Array.from({ length: 30 }, (_, i) => item({ id: `x${i}`, score: 3 }))
    const picked = pickTopicCandidates([group('p1', many)])
    expect(picked.reduce((n, one) => n + one.items.length, 0)).toBe(MAX_TOPICS_PER_DAY)
  })

  it('一个账号内部按分数高到低', () => {
    const picked = pickTopicCandidates([group('p1', [item({ id: 'low', score: 1 }), item({ id: 'high', score: 5 })])])
    expect(picked[0]?.items.map(one => one.id)).toEqual(['high', 'low'])
  })
})

// ———————————————————————— ① 提炼:服务这一层 ————————————————————————

const RESULTS: SearchResult[] = [
  { title: '预制菜新国标本周落地', url: 'https://news.example/1?utm_source=wx', snippet: '正文……', source: '某报' },
  { title: '预制菜新国标本周落地!', url: 'https://copy.example/1', snippet: '转载', source: '某号' },
  { title: '一人食小家电销量翻倍', url: 'https://news.example/2', snippet: '正文……', source: '某财经' },
  { title: '完全无关的球赛', url: 'https://news.example/3', snippet: '球赛', source: '某体育' },
]

interface Stub { prompts: string[], dir: string }

function makeFeed(over: {
  profile?: FeedAccountProfile | undefined
  withProfileDep?: boolean
  chat?: boolean
} = {}): { feed: FeedService, stub: Stub } {
  const dir = tmpDir('wb-topic-feed-')
  const stub: Stub = { prompts: [], dir }
  const feed = createFeedService({
    file: join(dir, 'feed.json'),
    configFile: join(dir, 'feed-config.json'),
    projects: async () => [{ id: 'p1', name: '小食堂' }],
    search: async () => ({ ok: true, results: RESULTS }),
    ...(over.chat === false ? {} : {
      chat: async (prompt) => {
        stub.prompts.push(prompt)
        if (prompt.includes('提炼')) {
          // **按提示词里真有的那一条回**(而不是恒回 i:0):否则"不要过之后重跑一轮"那个用例里,
          // 桩会把同一个选题贴到另一条资讯上,用例就测不出真东西了。
          const hit = [...prompt.matchAll(/^(\d+)\. 《(.*?)》/gm)].find(one => one[2]?.includes('预制菜'))
          return hit === undefined
            ? '[]'
            : '```json\n' + JSON.stringify([
              { i: Number(hit[1]), title: '一个人吃饭,预制菜到底能不能买', why_now: '新国标这周刚落地,大家正搜这件事' },
            ]) + '\n```'
        }
        return JSON.stringify([
          { i: 0, score: 5, why: '你的人群天天在问预制菜', follow_up: true },
          { i: 1, score: 3, why: '一人食器具跟你的内容沾边' },
          { i: 2, score: 0, why: '关系不大' },
        ])
      },
    }),
    ...(over.withProfileDep === false ? {} : { accountProfile: async () => over.profile }),
    now: () => NOW,
    // 播客不参与这张卡,关掉免得多一次模型调用。
  })
  return { feed, stub }
}

const KEYWORDS = { podcast: false, interests: [{ project_id: 'p1', project_name: '小食堂', keywords: ['一人食', '预制菜'] }] }

describe('提炼:整条管线(运营模板)', () => {
  it('资讯按账号定位提炼成选题,落盘、进收件箱那一档,note 里如实说提了几条', async () => {
    const { feed, stub } = makeFeed({ profile: PROFILE })
    await feed.load()
    await feed.setConfig(KEYWORDS)
    const run = await feed.run()

    expect(stub.prompts.some(p => p.includes('一人食的上班族'))).toBe(true)
    expect(run.note).toContain('选题:提炼出 1 条')

    const saved = JSON.parse(await readFile(join(stub.dir, 'feed.json'), 'utf8')) as FeedFile
    const refined = saved.items.filter(one => one.topic !== undefined)
    expect(refined).toHaveLength(1)
    expect(refined[0]?.topic).toEqual({ title: '一个人吃饭,预制菜到底能不能买', why_now: '新国标这周刚落地,大家正搜这件事' })

    // 选题建议那一档拿到它
    expect(feed.topicSuggestions().map(one => one.topic?.title)).toEqual(['一个人吃饭,预制菜到底能不能买'])
    // **同一条不会在「要跟进」里再出现一遍**
    expect(feed.followUps()).toEqual([])
  })

  it('没接模型:一条选题都不编,note 如实说,收件箱退回普通资讯建议', async () => {
    const { feed } = makeFeed({ profile: PROFILE, chat: false })
    await feed.load()
    await feed.setConfig(KEYWORDS)
    const run = await feed.run()
    expect(run.note).toContain('模型服务还没接上,今天只有原始资讯')
    expect(feed.topicSuggestions()).toEqual([])
    // 没打分 → 没有 follow_up,但条目照样在(有一堆没排过序的条目比"今天什么都没有"接近真相)
    expect(feed.view().groups[0]?.items.length).toBeGreaterThan(0)
  })

  it('账号档案还没填:如实跳过,不拿"一个小红书账号"这种空话去问模型', async () => {
    const { feed, stub } = makeFeed({ profile: {} })
    await feed.load()
    await feed.setConfig(KEYWORDS)
    const run = await feed.run()
    expect(run.note).toContain('账号档案还没填定位/人群/风格,没提炼选题')
    expect(stub.prompts.some(p => p.includes('提炼'))).toBe(false)
    expect(feed.topicSuggestions()).toEqual([])
  })

  it('不是运营模板(没接 accountProfile):与加这张卡之前逐字相同', async () => {
    const { feed, stub } = makeFeed({ withProfileDep: false })
    await feed.load()
    await feed.setConfig(KEYWORDS)
    const run = await feed.run()
    expect(run.note).not.toContain('选题')
    expect(stub.prompts.some(p => p.includes('提炼'))).toBe(false)
    expect(feed.topicSuggestions()).toEqual([])
    // 「要跟进」那一档照旧有东西 —— 这张卡没把旧出口堵掉
    expect(feed.followUps().map(one => one.title)).toEqual(['预制菜新国标本周落地'])
  })
})

// ———————————————————————— ② 去重与「不要」记忆 ————————————————————————

describe('「不要」:只针对这一条', () => {
  const interest: FeedInterest = { project_id: 'p1', project_name: '小食堂', keywords: ['预制菜'] }

  it('同链接(带不同跟踪参数)与同标题(被转载)都筛掉', () => {
    const declined = applyDecline({ ...parseFeedConfig({}), interests: [interest] }, item({
      title: '预制菜新国标本周落地', url: 'https://news.example/1?utm_source=wx',
    }))
    const kept = filterDeclined(RESULTS, declined.interests[0] as FeedInterest)
    expect(kept.map(one => one.url)).toEqual(['https://news.example/2', 'https://news.example/3'])
  })

  it('`decline` 不等于 `mute`:不把"这个站以后都不看"记下来', () => {
    const base: FeedConfig = { ...parseFeedConfig({}), interests: [interest] }
    const after = applyDecline(base, item({ source: '某报' })).interests[0] as FeedInterest
    expect(after.declined_urls).toHaveLength(1)
    expect(after.muted_sources).toBeUndefined()
    expect(after.muted_topics).toBeUndefined()
  })

  it('别的账号那一条偏好一个字不动', () => {
    const other: FeedInterest = { project_id: 'p2', project_name: '别的号', keywords: [] }
    const after = applyDecline({ ...parseFeedConfig({}), interests: [interest, other] }, item())
    expect(after.interests[1]).toEqual(other)
  })

  it('「不要」过的那一条当天就从资讯流里收起来', () => {
    const rows = [item({ id: 'a' }), item({ id: 'b', feedback: 'decline' })]
    expect(itemsOf(file(rows), TODAY).map(one => one.id)).toEqual(['a'])
  })

  it('落盘一圈回来还认得(parseFeedConfig 收得下 declined_*)', () => {
    const parsed = parseFeedConfig({
      interests: [{ project_id: 'p1', declined_urls: ['news.example/1'], declined_titles: ['预制菜新国标本周落地'] }],
    })
    expect(parsed.interests[0]?.declined_urls).toEqual(['news.example/1'])
    expect(parsed.interests[0]?.declined_titles).toEqual(['预制菜新国标本周落地'])
  })
})

describe('「不要」:下一轮真的不再推', () => {
  it('点过「不要」之后重跑一轮,同一条(以及它的转载)都不再出现', async () => {
    const { feed, stub } = makeFeed({ profile: PROFILE })
    await feed.load()
    await feed.setConfig(KEYWORDS)
    await feed.run()

    const suggested = feed.topicSuggestions()[0] as FeedItem
    expect(await feed.feedback(suggested.id, 'decline')).toEqual({ ok: true })

    // 偏好真的落盘了
    const savedConfig = JSON.parse(await readFile(join(stub.dir, 'feed-config.json'), 'utf8')) as FeedConfig
    expect(savedConfig.interests[0]?.declined_urls).toEqual(['news.example/1'])

    // 搜索桩照样回那四条,但这一条(与它的转载)已经进不来了
    await feed.run()
    const titles = feed.view().groups.flatMap(one => one.items.map(row => row.title))
    expect(titles).not.toContain('预制菜新国标本周落地')
    expect(titles).toContain('一人食小家电销量翻倍')
    expect(feed.topicSuggestions().map(one => one.topic?.title)).not.toContain('一个人吃饭,预制菜到底能不能买')
  })
})

// ———————————————————————— ③ 收件箱里那一档 ————————————————————————

describe('收件箱:选题建议', () => {
  const topicItem = item({
    id: 'f1', title: '预制菜新国标本周落地', source: '某报',
    topic: { title: '一个人吃饭,预制菜到底能不能买', why_now: '新国标这周刚落地' },
  })

  it('标题是选题本身,note 是账号名 + 一句为什么现在做 + 出处', () => {
    const view = deriveButlerInbox({ sessions: [], topics: [topicItem] })
    const entry = view.items.find(one => one.kind === 'topic')
    expect(entry?.title).toBe('一个人吃饭,预制菜到底能不能买')
    expect(entry?.note).toBe('小食堂·新国标这周刚落地(某报)')
    expect(entry?.url).toBe('https://a.example/1')
    expect(entry?.topic).toEqual({ feed_id: 'f1', project_id: 'p1', project_name: '小食堂' })
  })

  it('没提炼出选题的条目不混进这一档', () => {
    const view = deriveButlerInbox({ sessions: [], topics: [item({ id: 'f2' })] })
    expect(view.items.filter(one => one.kind === 'topic')).toEqual([])
  })

  it('没接资讯服务时整档不出,别的档一条都没多', () => {
    const view = deriveButlerInbox({ sessions: [] })
    expect(view.items).toEqual([])
  })

  it('同一条资讯不会同时出现在「资讯」与「选题建议」两档里', () => {
    const raw = file([{ ...topicItem, follow_up: true }])
    const view = deriveButlerInbox({ sessions: [], feed: followUps(raw, TODAY), topics: topicSuggestions(raw, TODAY) })
    expect(view.items.filter(one => one.kind === 'feed')).toEqual([])
    expect(view.items.filter(one => one.kind === 'topic')).toHaveLength(1)
  })
})

// ———————————————————————— ④ 早报念什么 ————————————————————————

describe('早报:念选题那两句', () => {
  it('有选题就念选题 + 一句为什么现在做,不念原始摘要', () => {
    const lines = morningLines(file([item({
      score: 5, why: '你的人群天天在问预制菜',
      topic: { title: '一个人吃饭,预制菜到底能不能买', why_now: '新国标这周刚落地' },
    })]), TODAY)
    expect(lines[0]?.items[0]).toMatchObject({
      title: '一个人吃饭,预制菜到底能不能买',
      why: '新国标这周刚落地',
      from_topic: true,
    })
  })

  it('没提炼出选题的退回原标题与原来那句关系——退回的是真话,不是编的选题', () => {
    const lines = morningLines(file([item({ score: 5, title: '一人食小家电销量翻倍', why: '跟你的内容沾边' })]), TODAY)
    expect(lines[0]?.items[0]).toMatchObject({
      title: '一人食小家电销量翻倍',
      why: '跟你的内容沾边',
      from_topic: false,
    })
  })

  it('0 分的那条一样不进早报(这张卡没放宽那条口径)', () => {
    const lines = morningLines(file([item({ id: 'zero', score: 0, title: '球赛' })]), TODAY)
    expect(lines).toEqual([])
  })

  it('服务的 morning() 给出来的就是这几行', async () => {
    const { feed } = makeFeed({ profile: PROFILE })
    await feed.load()
    await feed.setConfig(KEYWORDS)
    await feed.run()
    const morning = feed.morning()
    expect(morning[0]?.items[0]).toMatchObject({
      title: '一个人吃饭,预制菜到底能不能买',
      why: '新国标这周刚落地,大家正搜这件事',
      from_topic: true,
    })
    // 第二条没提炼到 → 退回原标题
    expect(morning[0]?.items[1]).toMatchObject({ title: '一人食小家电销量翻倍', from_topic: false })
  })
})

// ———————————————————————— ⑤ 一键建选题 ————————————————————————

describe('来源.md', () => {
  it('追加一行;同一个链接不记第二遍;人自己写的东西一个字不碰', async () => {
    const dir = tmpDir('wb-topic-src-')
    const first = await appendTopicSource(dir, { title: '预制菜新国标本周落地', url: 'https://news.example/1', source: '某报', why: '刚落地', date: TODAY })
    expect(first).toMatchObject({ ok: true, added: true })
    const again = await appendTopicSource(dir, { title: '换了个标题', url: 'https://news.example/1', date: TODAY })
    expect(again).toMatchObject({ ok: true, added: false })
    const text = await readFile(join(dir, TOPIC_SOURCE_FILE), 'utf8')
    expect(text.match(/https:\/\/news\.example\/1/g)).toHaveLength(1)
    expect(text).toContain('# 来源')
    expect(text).toContain('· 某报 · 刚落地')
  })
})

async function serveWithFeed(opts: { withCwd?: boolean } = {}): Promise<{
  url: string, cwd: string, feed: FeedService, suggested: FeedItem
}> {
  const dir = tmpDir('wb-topic-http-')
  const cwd = join(dir, '运营')
  mkdirSync(cwd, { recursive: true })
  const { feed } = makeFeed({ profile: PROFILE })
  await feed.load()
  await feed.setConfig(KEYWORDS)
  await feed.run()
  const suggested = feed.topicSuggestions()[0] as FeedItem

  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${++n}` })
  let layout: WorkbenchLayout | undefined = { modules: [], butler: { corner: 'br', min: false } }
  const template = createTemplateService({
    file: join(dir, 'template.json'),
    backupsDir: join(dir, 'backups'),
    readLayout: () => Promise.resolve(layout),
    writeLayout: (next) => { layout = next; return Promise.resolve() },
    // 2026-10-23(分层二刀二):ops 模板的内容在用户层起步层,本体只剩 product —— 用例里注入这一份。
    templates: () => [OPS_TEMPLATE],
    ...(opts.withCwd === false ? {} : { butlerCwd: () => cwd }),
  })
  await template.load()
  await template.apply('ops')
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    tasks,
    template,
    feed,
  })
  started.push(server)
  return { url: server.url, cwd, feed, suggested }
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

describe('POST /feed/adopt:一键加入选题池', () => {
  it('建一条 kind:topic 的卡、建目录、来源落 来源.md、收件箱里不再问第二遍', async () => {
    const { url, cwd, feed, suggested } = await serveWithFeed()
    const adopted = await post(url, '/feed/adopt', { id: suggested.id })
    expect(adopted.status).toBe(200)
    expect(adopted.body.title).toBe('一个人吃饭,预制菜到底能不能买')
    expect(adopted.body.note).toBeUndefined()

    const dir = join(cwd, TOPIC_DIR, '一个人吃饭,预制菜到底能不能买')
    expect(adopted.body.dir).toBe(dir)
    const source = await readFile(join(dir, TOPIC_SOURCE_FILE), 'utf8')
    // **记的是资讯原标题与原链接**(这条选题是从哪来的),不是选题标题
    expect(source).toContain('预制菜新国标本周落地')
    expect(source).toContain('https://news.example/1?utm_source=wx')

    // 卡在看板上,挂在这个账号下,卡面上写着为什么现在做与来源
    const board = await (await fetch(`${url}/state`)).json() as { tasks?: { tasks: { title: string, kind?: string, project_id?: string, desc?: string }[] } }
    const card = board.tasks?.tasks.find(one => one.title === '一个人吃饭,预制菜到底能不能买')
    expect(card?.kind).toBe('topic')
    expect(card?.project_id).toBe('p1')
    expect(card?.desc).toContain('新国标这周刚落地')
    expect(card?.desc).toContain('https://news.example/1?utm_source=wx')

    // 已建成 → 收件箱那一档收起来,但资讯流里它还在(它仍然是今天真搜到的一条)
    expect(feed.topicSuggestions()).toEqual([])
    expect(feed.view().groups.flatMap(one => one.items.map(row => row.id))).toContain(suggested.id)
  })

  it('没配工作目录:卡照建,目录建不出来的原因如实带在回执里(不静默吞掉)', async () => {
    const { url, suggested } = await serveWithFeed({ withCwd: false })
    const adopted = await post(url, '/feed/adopt', { id: suggested.id })
    expect(adopted.status).toBe(200)
    expect(adopted.body.id).toBeTypeOf('string')
    expect(adopted.body.dir).toBeUndefined()
    expect(adopted.body.note).toContain('还没配工作目录')
  })

  it('没有这一条资讯 → 404,不建空卡', async () => {
    const { url } = await serveWithFeed()
    const adopted = await post(url, '/feed/adopt', { id: '不存在' })
    expect(adopted.status).toBe(404)
    const board = await (await fetch(`${url}/state`)).json() as { tasks?: { tasks: unknown[] } }
    expect(board.tasks?.tasks).toEqual([])
  })

  it('/feed/feedback 收 decline,但不收 adopted(那是 /feed/adopt 自己记的)', async () => {
    const { url, suggested } = await serveWithFeed()
    expect((await post(url, '/feed/feedback', { id: suggested.id, action: 'decline' })).status).toBe(200)
    const bad = await post(url, '/feed/feedback', { id: suggested.id, action: 'adopted' })
    expect(bad.status).toBe(400)
    expect(String(bad.body.error)).toContain('follow / mute / decline')
  })
})
