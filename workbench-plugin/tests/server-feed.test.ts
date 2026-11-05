// @vitest-environment node
/**
 * 资讯与播客(2026-09-21,server/feed.ts)。
 *
 * 分两半:
 *   ① **纯函数**——去重、「不看了」筛选、查询拼法、打分解析、挑早报三条、保留 14 天、
 *      反馈回写偏好、口播稿清洗。这一半一行 I/O 都不碰。
 *   ② **服务**——搜索/模型/TTS 三个依赖全部打桩,落盘在临时 HOME。
 *      重点盯住三条纪律:中转没配搜索时整块如实缺席、只建议不建事项(followUps 出的是条目)、
 *      「不看了」真的回写偏好并在下一轮把那家筛掉。
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyMute, cleanScript, createFeedService, dedupeResults, feedItemId, filterMuted, followUps,
  morningPicks, normalizeUrl, parseFeedConfig, parseScoring, podcastFileName, pruneFeed, queriesOf,
  splitScript, topicOf, DEFAULT_FEED_CONFIG, PODCAST_MAX_CHARS,
  type FeedFile, type FeedItem, type FeedInterest, type SearchResult,
} from '../src/server/feed.ts'

async function tmpDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'feed-'))
}

function result(over: Partial<SearchResult> = {}): SearchResult {
  return { title: '标题', url: 'https://a.example/1', snippet: '摘要', ...over }
}

function item(over: Partial<FeedItem> = {}): FeedItem {
  return {
    id: 'i1', project_id: 'p1', project_name: '工作台', title: '标题', url: 'https://a.example/1',
    why: '有关系', score: 3, follow_up: false, date: '2026-09-21', at: 1, ...over,
  }
}

function file(over: Partial<FeedFile> = {}): FeedFile {
  return { version: 1, items: [], podcasts: [], last_run_at: 0, ...over }
}

describe('规范化与去重', () => {
  it('跟踪参数与 www./末尾斜杠不影响"是不是同一条"', () => {
    expect(normalizeUrl('https://www.A.example/x/?utm_source=weixin&id=3'))
      .toBe(normalizeUrl('http://a.example/x?id=3'))
  })

  it('同一条新闻被三家转载(链接不同、标题相同)只留一条', () => {
    const rows = dedupeResults([
      result({ title: 'DeepSeek 发新模型', url: 'https://a.example/1' }),
      result({ title: 'DeepSeek 发新模型!', url: 'https://b.example/2' }),
      result({ title: '别的事', url: 'https://c.example/3' }),
    ])
    expect(rows.map(r => r.url)).toEqual(['https://a.example/1', 'https://c.example/3'])
  })

  it('同一个链接带不同跟踪参数只留一条,先到的留下', () => {
    const rows = dedupeResults([
      result({ title: '甲', url: 'https://a.example/1' }),
      result({ title: '乙', url: 'https://a.example/1?utm_source=x' }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.title).toBe('甲')
  })

  it('没标题或没链接的条目进不来', () => {
    expect(dedupeResults([result({ title: ' ' }), result({ url: '' })])).toEqual([])
  })

  it('feedItemId 跟着规范化后的地址走,同一条新闻两天是同一个 id', () => {
    expect(feedItemId('https://a.example/x/?utm_source=q')).toBe(feedItemId('https://www.a.example/x'))
  })
})

describe('「不看了」的筛选与回写', () => {
  const interest: FeedInterest = {
    project_id: 'p1', project_name: '工作台', keywords: ['事务官'],
    muted_sources: ['某号'], muted_topics: ['元宇宙'],
  }

  it('来源完全相同才筛(不做模糊匹配,免得误伤)', () => {
    const rows = filterMuted([
      result({ url: 'https://a/1', source: '某号' }),
      result({ url: 'https://a/2', source: '某号网' }),
    ], interest)
    expect(rows.map(r => r.url)).toEqual(['https://a/2'])
  })

  it('标题里带着被屏蔽的主题词就筛掉', () => {
    const rows = filterMuted([result({ title: '元宇宙又火了', url: 'https://a/3' })], interest)
    expect(rows).toEqual([])
  })

  it('applyMute 把那条的来源与主题记进这个项目的黑名单,别的项目不动', () => {
    const config = {
      ...DEFAULT_FEED_CONFIG,
      interests: [
        { project_id: 'p1', project_name: '工作台', keywords: [] },
        { project_id: 'p2', project_name: '另一个', keywords: [] },
      ],
    }
    const next = applyMute(config, item({ title: '元宇宙房地产大涨', source: '某号' }))
    expect(next.interests[0]?.muted_sources).toEqual(['某号'])
    expect(next.interests[0]?.muted_topics).toEqual([topicOf('元宇宙房地产大涨')])
    expect(next.interests[1]?.muted_sources).toBeUndefined()
  })
})

describe('查询拼法', () => {
  it('没关键词就一条都不搜(不替他猜关注什么)', () => {
    expect(queriesOf({ project_id: 'p1', project_name: '工作台', keywords: [] })).toEqual([])
  })

  it('项目名 + 至多 4 个关键词一条,多出来的另起一条', () => {
    const queries = queriesOf({ project_id: 'p1', project_name: '工作台', keywords: ['a', 'b', 'c', 'd', 'e'] })
    expect(queries).toEqual(['工作台 a b c d', '工作台 e'])
  })
})

describe('打分解析', () => {
  it('认裸 JSON、认代码块、认前后多余的话', () => {
    const wrapped = '好的,结果如下:\n```json\n[{"i":0,"score":4,"why":"直接相关","follow_up":true}]\n```\n还有别的话'
    expect(parseScoring(wrapped, 2)).toEqual([{ index: 0, score: 4, why: '直接相关', follow_up: true }])
  })

  it('数字写成字符串、follow_up 写成「是」也认', () => {
    expect(parseScoring('[{"i":"1","score":"3","why":"x","follow_up":"是"}]', 2))
      .toEqual([{ index: 1, score: 3, why: 'x', follow_up: true }])
  })

  it('下标越界、重复、认不出的一律整条丢掉,不给一个猜出来的分数', () => {
    expect(parseScoring('[{"i":9,"score":5},{"i":0,"score":1,"why":"a"},{"i":0,"score":5}]', 2))
      .toEqual([{ index: 0, score: 1, why: 'a', follow_up: false }])
    expect(parseScoring('我觉得都挺相关的', 3)).toEqual([])
  })

  it('分数夹在 0..5', () => {
    expect(parseScoring('[{"i":0,"score":99},{"i":1,"score":-4}]', 2).map(s => s.score)).toEqual([5, 0])
  })
})

describe('挑条目', () => {
  const f = file({
    items: [
      item({ id: 'a', score: 5, follow_up: true }),
      item({ id: 'b', score: 4 }),
      item({ id: 'c', score: 1 }),
      item({ id: 'd', score: 0 }),
      item({ id: 'e', score: 5, feedback: 'mute' }),
      item({ id: 'f', project_id: 'p2', project_name: '另一个', score: 2 }),
      item({ id: 'g', score: 5, date: '2026-09-20' }),
    ],
  })

  it('每个项目最多 3 条,0 分的与「不看了」的不进', () => {
    const groups = morningPicks(f, '2026-09-21')
    expect(groups.map(g => g.project_id)).toEqual(['p1', 'p2'])
    expect(groups[0]?.items.map(i => i.id)).toEqual(['a', 'b', 'c'])
    expect(groups[1]?.items.map(i => i.id)).toEqual(['f'])
  })

  it('「要跟进」= 模型判的 follow_up 或用户自己点的跟进', () => {
    const withFollow = file({ items: [...f.items, item({ id: 'h', score: 0, feedback: 'follow' })] })
    expect(followUps(withFollow, '2026-09-21').map(i => i.id).sort()).toEqual(['a', 'h'])
  })

  it('保留 14 天:再早的条目与播客记录一起丢掉', () => {
    const old = file({
      items: [item({ id: 'x', date: '2026-09-07' }), item({ id: 'y', date: '2026-09-08' })],
      podcasts: [{ date: '2026-09-07', script: 's', at: 0 }, { date: '2026-09-21', script: 's', at: 0 }],
    })
    const pruned = pruneFeed(old, '2026-09-21')
    expect(pruned.items.map(i => i.id)).toEqual(['y'])
    expect(pruned.podcasts.map(p => p.date)).toEqual(['2026-09-21'])
  })
})

describe('口播稿清洗', () => {
  it('去掉 Markdown 标记(念出来会变成「井号井号」)', () => {
    expect(cleanScript('## 今天的要点\n- **重点**:一句话')).toBe('今天的要点\n重点:一句话')
  })

  it('超了上限截在句号上,不在半句话中间切', () => {
    const text = `${'甲'.repeat(60)}。${'乙'.repeat(60)}。${'丙'.repeat(60)}`
    const cut = cleanScript(text, 130)
    expect(cut.endsWith('。')).toBe(true)
    expect(cut.length).toBeLessThanOrEqual(130)
  })
})

describe('切段合成(6 分钟的稿子超过 8792 单次的 2000 字)', () => {
  it('短稿子原样一块', () => {
    expect(splitScript('就一句话。', 2000)).toEqual(['就一句话。'])
    expect(splitScript('', 2000)).toEqual([])
  })

  it('长稿子在句末切,每块不超上限,接起来还是原文', () => {
    const text = `${'甲'.repeat(80)}。${'乙'.repeat(80)}。${'丙'.repeat(80)}。`
    const parts = splitScript(text, 100)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(100)
    for (const part of parts.slice(0, -1)) expect(part.endsWith('。')).toBe(true)
    expect(parts.join('')).toBe(text)
  })

  it('一整段里压根没有句号时硬切,不会把一块撑到两倍长', () => {
    const parts = splitScript('啊'.repeat(250), 100)
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(100)
    expect(parts.join('')).toBe('啊'.repeat(250))
  })
})

describe('parseFeedConfig', () => {
  it('认不出的字段退回默认,不抛', () => {
    expect(parseFeedConfig('这不是对象')).toEqual(DEFAULT_FEED_CONFIG)
    expect(parseFeedConfig({ per_project: 999, podcast_minutes: 1 }).per_project).toBe(10)
    expect(parseFeedConfig({ podcast_minutes: 1 }).podcast_minutes).toBe(3)
    expect(parseFeedConfig({ podcast_minutes: 99 }).podcast_minutes).toBe(6)
  })

  it('同一个 project_id 只留一条,关键词去重', () => {
    const config = parseFeedConfig({
      interests: [
        { project_id: 'p1', project_name: 'A', keywords: ['x', 'x', ' '] },
        { project_id: 'p1', project_name: '重复的' },
      ],
    })
    expect(config.interests).toHaveLength(1)
    expect(config.interests[0]?.keywords).toEqual(['x'])
  })
})

/** —— 服务 —— */

interface Harness {
  dir: string
  searched: string[]
  prompts: string[]
  ttsTexts: string[]
}

async function makeService(over: {
  search?: 'off' | 'ok' | 'fail'
  chat?: 'off' | 'ok'
  tts?: 'off' | 'ok' | 'fail'
  results?: SearchResult[]
  projects?: { id: string, name: string }[]
  config?: unknown
} = {}) {
  const dir = await tmpDir()
  const harness: Harness = { dir, searched: [], prompts: [], ttsTexts: [] }
  const configFile = join(dir, 'feed-config.json')
  if (over.config !== undefined) await writeFile(configFile, JSON.stringify(over.config))
  const rows = over.results ?? [
    result({ title: '模型降价了', url: 'https://a.example/1', source: '机器之心' }),
    result({ title: '同一条稿子', url: 'https://b.example/2', source: '某号' }),
  ]
  const service = createFeedService({
    file: join(dir, 'feed.json'),
    configFile,
    outboxDir: join(dir, 'outbox'),
    projects: async () => over.projects ?? [{ id: 'p1', name: '工作台' }],
    ...(over.search === 'off' ? {} : {
      search: async (query) => {
        harness.searched.push(query)
        return over.search === 'fail'
          ? { ok: false, error: '这台服务器还没配搜索服务' }
          : { ok: true, results: rows }
      },
    }),
    ...(over.chat === 'off' ? {} : {
      chat: async (prompt) => {
        harness.prompts.push(prompt)
        if (prompt.includes('口播稿')) return '今天两个要点。第一,模型降价了。'
        return JSON.stringify(rows.map((_, i) => ({ i, score: 5 - i, why: `第 ${i} 条有关系`, follow_up: i === 0 })))
      },
    }),
    ...(over.tts === 'off' ? {} : {
      tts: async (text) => {
        harness.ttsTexts.push(text)
        if (over.tts === 'fail') throw new Error('volcengine TTS HTTP 429 concurrency')
        return { buffer: Buffer.from('FAKE-MP3'), contentType: 'audio/mpeg' }
      },
    }),
    now: () => Date.parse('2026-09-21T07:00:00+08:00'),
  })
  await service.load()
  return { service, harness }
}

const WITH_KEYWORDS = {
  version: 1, enabled: true, per_project: 5, podcast: true, podcast_minutes: 4,
  interests: [{ project_id: 'p1', project_name: '工作台', keywords: ['事务官', '桌面'] }],
}

describe('createFeedService', () => {
  it('还没有哪个项目填了「关注什么」:一条都不搜,如实说', async () => {
    const { service, harness } = await makeService()
    const run = await service.run()
    expect(harness.searched).toEqual([])
    expect(run.added).toBe(0)
    expect(run.note).toContain('还没有哪个项目填了')
  })

  it('中转没配搜索:整块如实缺席,不编条目,last_error 一路带到 view()', async () => {
    const { service } = await makeService({ search: 'off', config: WITH_KEYWORDS })
    const run = await service.run()
    expect(run.error).toContain('搜索服务')
    expect(run.added).toBe(0)
    const view = service.view()
    expect(view.groups).toEqual([])
    expect(view.last_error).toContain('搜索服务')
  })

  it('搜索回 503 那句人话原样带上来,条目仍然是 0(不拿旧数据冒充今天)', async () => {
    const { service } = await makeService({ search: 'fail', config: WITH_KEYWORDS })
    const run = await service.run()
    expect(run.error).toContain('还没配搜索服务')
    expect(service.view().groups).toEqual([])
  })

  it('一条完整的路:搜 → 去重 → 打分 → 落盘 → 早报三条 → 播客写稿合成到发件目录', async () => {
    const { service, harness } = await makeService({ config: WITH_KEYWORDS })
    const run = await service.run()
    expect(harness.searched).toEqual(['工作台 事务官 桌面'])
    expect(run.added).toBe(2)

    const view = service.view()
    expect(view.groups).toHaveLength(1)
    expect(view.groups[0]?.items.map(i => i.title)).toEqual(['模型降价了', '同一条稿子'])
    expect(view.groups[0]?.items[0]?.why).toBe('第 0 条有关系')

    // 早报三条 + 只建议不建事项(followUps 出的是条目,不是 tasks)
    expect(service.morning().map(g => g.items.length)).toEqual([2])
    expect(service.followUps().map(i => i.title)).toEqual(['模型降价了'])

    // 播客:写了稿、合成了、落到发件目录
    expect(view.podcast?.file).toBe(podcastFileName('2026-09-21'))
    expect(view.podcast?.script).toContain('今天两个要点')
    expect(harness.ttsTexts[0]).toContain('今天两个要点')
    expect(await readFile(join(harness.dir, 'outbox', podcastFileName('2026-09-21')), 'utf8')).toBe('FAKE-MP3')
    expect(service.podcastPath()).toBe(join(harness.dir, podcastFileName('2026-09-21')))

    // 真落盘了(不是只活在内存里)
    const saved = JSON.parse(await readFile(join(harness.dir, 'feed.json'), 'utf8')) as FeedFile
    expect(saved.items).toHaveLength(2)
  })

  it('稿子超过单次上限时切几段合成再把字节接起来', async () => {
    // 六句各 400 字 = 2406 字:没到整段上限(2600),但超过了 8792 单次的 2000。
    const long = Array.from({ length: 6 }, (_, i) => `${String.fromCharCode(0x7532 + i).repeat(400)}。`).join('')
    const dir = await tmpDir()
    const calls: string[] = []
    const service = createFeedService({
      file: join(dir, 'feed.json'),
      configFile: join(dir, 'feed-config.json'),
      projects: async () => [{ id: 'p1', name: '工作台' }],
      search: async () => ({ ok: true, results: [result()] }),
      chat: async prompt => (prompt.includes('口播稿') ? long : '[{"i":0,"score":5,"why":"有关系"}]'),
      tts: async (text) => { calls.push(text); return { buffer: Buffer.from(`[${text.length}]`), contentType: 'audio/mpeg' } },
      now: () => Date.parse('2026-09-21T07:00:00+08:00'),
    })
    await service.load()
    await service.setConfig(WITH_KEYWORDS)
    await service.run()
    expect(calls.length).toBe(2)
    expect(calls.every(text => text.length <= 2000)).toBe(true)
    expect(calls.join('')).toBe(long.slice(0, PODCAST_MAX_CHARS))
    expect(service.view().podcast?.bytes).toBe(`[${calls[0]!.length}][${calls[1]!.length}]`.length)
  })

  it('合成失败只有文字稿,而且说得出为什么', async () => {
    const { service } = await makeService({ config: WITH_KEYWORDS, tts: 'fail' })
    await service.run()
    const podcast = service.view().podcast
    expect(podcast?.file).toBeUndefined()
    expect(podcast?.script).toContain('今天两个要点')
    expect(podcast?.error).toContain('语音合成失败')
    expect(service.podcastPath()).toBeUndefined()
  })

  it('偏好里关掉播客:稿子也不写(不白烧他的额度)', async () => {
    const { service, harness } = await makeService({ config: { ...WITH_KEYWORDS, podcast: false } })
    await service.run()
    expect(service.view().podcast).toBeUndefined()
    expect(harness.prompts.some(p => p.includes('口播稿'))).toBe(false)
  })

  it('模型接不上:条目照落(score 0、why 退回搜索摘要),而不是"今天什么都没有"', async () => {
    const { service } = await makeService({ config: WITH_KEYWORDS, chat: 'off' })
    const run = await service.run()
    expect(run.added).toBe(2)
    expect(service.view().groups[0]?.items[0]?.score).toBe(0)
    expect(service.view().groups[0]?.items[0]?.why).toBe('摘要')
    // 0 分的不进早报
    expect(service.morning()).toEqual([])
    // 播客那一条要说清楚是「模型没接上」,不能说成「今天没有够得上的条目」(那是另一件事)
    expect(run.note).toContain('模型服务还没接上,今天没有口播稿')
  })

  it('「不看了」:这一条收起来、回写偏好,下一轮那家来源直接筛掉', async () => {
    const { service } = await makeService({ config: WITH_KEYWORDS })
    await service.run()
    const target = service.view().groups[0]?.items.find(i => i.source === '机器之心')
    expect(target).toBeDefined()
    expect(await service.feedback(target!.id, 'mute')).toEqual({ ok: true })
    expect(service.view().groups[0]?.items.some(i => i.id === target!.id)).toBe(false)
    expect(service.config().interests[0]?.muted_sources).toEqual(['机器之心'])

    // 下一轮:同一批搜索结果,那家被筛掉了
    await service.run()
    expect(service.view().groups[0]?.items.map(i => i.source)).toEqual(['某号'])
  })

  it('「跟进」进得了收件箱那一档,而且重跑不会把表态清掉', async () => {
    const { service } = await makeService({ config: WITH_KEYWORDS })
    await service.run()
    const second = service.view().groups[0]?.items[1]
    await service.feedback(second!.id, 'follow')
    expect(service.followUps().map(i => i.id)).toContain(second!.id)
    await service.run()
    expect(service.view().groups[0]?.items.find(i => i.id === second!.id)?.feedback).toBe('follow')
  })

  it('反馈一条不存在的(过了 14 天)如实说,不假装记下了', async () => {
    const { service } = await makeService({ config: WITH_KEYWORDS })
    expect(await service.feedback('没这条', 'mute')).toEqual({ ok: false, error: expect.stringContaining('没有这一条') })
  })

  it('偏好里的项目跟着项目区走:新项目自动补一条空关键词的,关键词不替他猜', async () => {
    const { service } = await makeService({
      config: WITH_KEYWORDS,
      projects: [{ id: 'p1', name: '工作台(改名了)' }, { id: 'p2', name: '新项目' }],
    })
    await service.run()
    const interests = service.config().interests
    expect(interests.map(i => i.project_id)).toEqual(['p1', 'p2'])
    expect(interests[0]?.project_name).toBe('工作台(改名了)')
    expect(interests[0]?.keywords).toEqual(['事务官', '桌面']) // 原有的没被冲掉
    expect(interests[1]?.keywords).toEqual([])
  })

  it('setConfig 逐块合并:只改播客开关不该把关键词冲没', async () => {
    const { service } = await makeService({ config: WITH_KEYWORDS })
    const next = await service.setConfig({ podcast: false })
    expect(next.podcast).toBe(false)
    expect(next.interests[0]?.keywords).toEqual(['事务官', '桌面'])
  })

  it('总开关关着:一条都不搜', async () => {
    const { service, harness } = await makeService({ config: { ...WITH_KEYWORDS, enabled: false } })
    const run = await service.run()
    expect(harness.searched).toEqual([])
    expect(run.note).toContain('关着')
  })
})
