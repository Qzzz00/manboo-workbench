// @vitest-environment node
/**
 * 资讯与播客的**端到端假数据**(2026-09-21,任务卡验收第 5 条):
 *
 *   一份假搜索结果 → feed.json → 早报三条 → 播客稿 → 假 TTS 文件到手机收件(发件目录)
 *
 * 外部三样全部打桩(搜索、模型、TTS),别的都是真的:真起 8791、真落盘、真走 HTTP。
 * 另外盯住五条路由的门与「没接资讯 → 404」。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchState } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createFeedService, podcastFileName, type FeedService, type SearchResult } from '../src/server/feed.ts'
import { createRoutinesService } from '../src/server/routines.ts'

const dirs: string[] = []
const started: WorkbenchServer[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-feed-'))
  dirs.push(dir)
  return dir
}

const TODAY = '2026-09-21'
const NOW = Date.parse(`${TODAY}T07:30:00`)

/** 假搜索结果:四条,其中两条是同一篇稿子被两家转载(去重要把它并掉)。 */
const FAKE_RESULTS: SearchResult[] = [
  { title: 'DeepSeek 把 API 价格又砍了一半', url: 'https://news.example/1?utm_source=wx', snippet: '官方公告说……', source: '机器之心', published_at: '2026-09-20T09:00:00Z' },
  { title: 'DeepSeek 把 API 价格又砍了一半!', url: 'https://other.example/copy', snippet: '转载', source: '某号' },
  { title: '桌面 Agent 产品盘点', url: 'https://news.example/2', snippet: '十款桌面 Agent……', source: '晚点' },
  { title: '完全无关的体育新闻', url: 'https://news.example/3', snippet: '球赛', source: '某体育' },
]

interface Stub {
  searched: string[]
  prompts: string[]
  ttsTexts: string[]
  dir: string
}

function makeFeed(over: { search?: boolean, tts?: boolean } = {}): { feed: FeedService, stub: Stub } {
  const dir = tempDir()
  const stub: Stub = { searched: [], prompts: [], ttsTexts: [], dir }
  const feed = createFeedService({
    file: join(dir, 'feed.json'),
    configFile: join(dir, 'feed-config.json'),
    outboxDir: join(dir, 'channel-outbox'),
    projects: async () => [{ id: 'p1', name: '桌面工作台' }, { id: 'p2', name: '小红书号' }],
    ...(over.search === false ? {} : {
      search: async (query) => {
        stub.searched.push(query)
        // 「小红书号」那个项目没填关键词 → 根本不会搜到这里
        return { ok: true, results: FAKE_RESULTS }
      },
    }),
    chat: async (prompt) => {
      stub.prompts.push(prompt)
      if (prompt.includes('口播稿')) {
        return '早上好。今天桌面工作台这边有两件事值得知道。第一,DeepSeek 又降价了,你们的中转成本要重算。第二,晚点盘了一遍桌面 Agent。就这些。'
      }
      // 打分:第 0 条 5 分要跟进、第 1 条 3 分、第 2 条 0 分
      return '```json\n' + JSON.stringify([
        { i: 0, score: 5, why: '你们的中转就是转这家,成本要重算', follow_up: true },
        { i: 1, score: 3, why: '同类产品盘点,看看别人怎么做' },
        { i: 2, score: 0, why: '关系不大' },
      ]) + '\n```'
    },
    ...(over.tts === false ? {} : {
      tts: async (text) => {
        stub.ttsTexts.push(text)
        return { buffer: Buffer.from('FAKE-AUDIO-BYTES'), contentType: 'audio/mpeg' }
      },
    }),
    ownerName: async () => 'Ben',
    now: () => NOW,
  })
  return { feed, stub }
}

async function serve(feed?: FeedService) {
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => Math.floor(NOW / 1000) }),
    tickIntervalMs: 0,
    ...(feed === undefined ? {} : { feed }),
  })
  started.push(server)
  return server.url
}

async function post(url: string, path: string, body?: unknown): Promise<{ status: number, body: Record<string, unknown> }> {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

const KEYWORDS = {
  interests: [
    { project_id: 'p1', project_name: '桌面工作台', keywords: ['DeepSeek', '桌面 Agent'] },
    { project_id: 'p2', project_name: '小红书号', keywords: [] },
  ],
}

describe('端到端:假搜索结果 → feed.json → 早报三条 → 播客稿 → 假 TTS 文件到发件目录', () => {
  it('整条跑通,每一段的产物都对得上', async () => {
    const { feed, stub } = makeFeed()
    await feed.load()
    await feed.setConfig(KEYWORDS)

    const run = await feed.run()

    // ① 搜索:只搜填了关键词的那个项目,项目名 + 关键词拼成一条查询
    expect(stub.searched).toEqual(['桌面工作台 DeepSeek 桌面 Agent'])

    // ② feed.json:四条里去掉一条转载,剩三条,真落盘
    const saved = JSON.parse(await readFile(join(stub.dir, 'feed.json'), 'utf8')) as { items: unknown[] }
    expect(saved.items).toHaveLength(3)
    expect(run.added).toBe(3)

    // ③ 早报:每个项目最多 3 条,0 分的那条体育新闻不进
    const morning = feed.morning()
    expect(morning).toHaveLength(1)
    expect(morning[0]?.project_name).toBe('桌面工作台')
    expect(morning[0]?.items.map(i => i.title)).toEqual([
      'DeepSeek 把 API 价格又砍了一半',
      '桌面 Agent 产品盘点',
    ])
    expect(morning[0]?.items[0]?.why).toBe('你们的中转就是转这家,成本要重算')

    // ④ 「要跟进」出的是**建议**(收件箱那一档的原料),不是事项
    expect(feed.followUps().map(i => i.title)).toEqual(['DeepSeek 把 API 价格又砍了一半'])

    // ⑤ 播客稿:模型的那一问里带着今天的条目与目标字数;稿子落进 view
    const podcastPrompt = stub.prompts.find(p => p.includes('口播稿'))
    expect(podcastPrompt).toContain('Ben')
    expect(podcastPrompt).toContain('DeepSeek 把 API 价格又砍了一半')
    // 4 分钟 × 365 字(真机量出来的语速,见 feed.ts 的 CHARS_PER_MINUTE)
    expect(podcastPrompt).toContain('1460 字左右')
    expect(feed.view().podcast?.script).toContain('早上好')

    // ⑥ 合成:送去 TTS 的就是那段稿子;音频落电脑 + 发件目录(工人下一拍就发到手机)
    expect(stub.ttsTexts[0]).toContain('早上好')
    const name = podcastFileName(TODAY)
    expect(await readFile(join(stub.dir, name), 'utf8')).toBe('FAKE-AUDIO-BYTES')
    expect(await readdir(join(stub.dir, 'channel-outbox'))).toEqual([name])
    expect(feed.view().podcast?.file).toBe(name)
  })

  it('早报例程把资讯那几行拼进开工汇报正文,并把两轮的 note 都记下来', async () => {
    const { feed } = makeFeed()
    await feed.load()
    await feed.setConfig(KEYWORDS)

    const dir = tempDir()
    const sent: string[] = []
    const routines = createRoutinesService({
      configFile: join(dir, 'routines.json'),
      stateFile: join(dir, 'routines-state.json'),
      now: () => NOW,
      session: { open: async (m: string) => { sent.push(m); return 'sess-1' } },
      feedBeforeMorning: async () => {
        const result = await feed.run()
        return { note: result.note, groups: feed.morning(result.date) }
      },
    })
    await routines.load()
    routines.attach({ readState: async () => createWorkbenchService().getState() })

    const result = await routines.run('morning')
    if (!result.ok) throw new Error(result.reason)
    expect(result.run.status).toBe('ok')
    // 汇报正文里有资讯那一段(项目名 + 条目 + 那一句为什么相关)
    expect(result.run.report).toContain('【桌面工作台】今天看到:')
    expect(result.run.report).toContain('《DeepSeek 把 API 价格又砍了一半》(机器之心):你们的中转就是转这家,成本要重算')
    // 0 分的那条不进
    expect(result.run.report).not.toContain('体育')
    // 发进会话的第一条消息就是同一份正文
    expect(sent[0]).toContain('【桌面工作台】今天看到:')
    // note 里如实写了这一轮搜到几条
    expect(result.run.note).toContain('资讯:1 个项目搜到 3 条')
  })

  it('资讯搜炸了不连累开工汇报:汇报照发,note 里如实说', async () => {
    const dir = tempDir()
    const sent: string[] = []
    const routines = createRoutinesService({
      configFile: join(dir, 'routines.json'),
      stateFile: join(dir, 'routines-state.json'),
      now: () => NOW,
      session: { open: async (m: string) => { sent.push(m); return 'sess-1' } },
      feedBeforeMorning: async () => { throw new Error('中转连不上') },
    })
    await routines.load()
    routines.attach({ readState: async () => createWorkbenchService().getState() })
    const result = await routines.run('morning')
    if (!result.ok) throw new Error(result.reason)
    expect(result.run.status).toBe('ok')
    expect(sent).toHaveLength(1)
    expect(result.run.note).toContain('资讯自取出错:中转连不上')
  })

  it('中转没配搜索:整块如实缺席,早报正文里一个字的资讯都没有', async () => {
    const { feed } = makeFeed({ search: false })
    await feed.load()
    await feed.setConfig(KEYWORDS)
    const run = await feed.run()
    expect(run.error).toContain('搜索服务')
    expect(feed.morning()).toEqual([])
    expect(feed.view().groups).toEqual([])
    expect(feed.view().podcast).toBeUndefined()
  })

  it('合成失败只有文字稿,发件目录里什么都没有', async () => {
    const { feed, stub } = makeFeed({ tts: false })
    await feed.load()
    await feed.setConfig(KEYWORDS)
    await feed.run()
    const podcast = feed.view().podcast
    expect(podcast?.script).toContain('早上好')
    expect(podcast?.file).toBeUndefined()
    expect(podcast?.error).toContain('语音后端')
    await expect(readdir(join(stub.dir, 'channel-outbox'))).rejects.toThrow()
  })
})

describe('HTTP 五条路由', () => {
  it('GET /feed 回今天的分组与偏好;POST /feed/run 跑一轮', async () => {
    const { feed } = makeFeed()
    await feed.load()
    await feed.setConfig(KEYWORDS)
    const url = await serve(feed)

    const before = await (await fetch(`${url}/feed`)).json() as { groups: unknown[], date: string }
    expect(before.groups).toEqual([])
    expect(before.date).toBe(TODAY)

    expect((await post(url, '/feed/run')).status).toBe(200)
    const after = await (await fetch(`${url}/feed`)).json() as { groups: { items: unknown[] }[] }
    expect(after.groups[0]?.items).toHaveLength(3)
  })

  it('GET /feed/podcast 回音频字节;没有那一天就 404 说清楚', async () => {
    const { feed } = makeFeed()
    await feed.load()
    await feed.setConfig(KEYWORDS)
    await feed.run()
    const url = await serve(feed)

    const res = await fetch(`${url}/feed/podcast`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(await res.text()).toBe('FAKE-AUDIO-BYTES')

    const missing = await fetch(`${url}/feed/podcast?date=2026-09-01`)
    expect(missing.status).toBe(404)
    expect((await missing.json() as { error: string }).error).toContain('没有合成好的播客')
  })

  it('POST /feed/feedback 收「不看了」并回写偏好;/state 那一档跟着变', async () => {
    const { feed } = makeFeed()
    await feed.load()
    await feed.setConfig(KEYWORDS)
    await feed.run()
    const url = await serve(feed)

    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    const suggestion = state.butler_inbox?.items.find(item => item.kind === 'feed')
    expect(suggestion?.title).toBe('DeepSeek 把 API 价格又砍了一半')
    expect(suggestion?.note).toContain('桌面工作台·你们的中转就是转这家')
    expect(suggestion?.url).toBe('https://news.example/1?utm_source=wx')

    const id = feed.view().groups[0]!.items[0]!.id
    expect((await post(url, '/feed/feedback', { id, action: 'mute' })).status).toBe(200)
    expect(feed.config().interests[0]?.muted_sources).toEqual(['机器之心'])
    const after = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(after.butler_inbox?.items.some(item => item.kind === 'feed')).toBe(false)
  })

  it('POST /feed/feedback 校验:id 与 action 不对就 400,不假装记下了', async () => {
    const { feed } = makeFeed()
    await feed.load()
    const url = await serve(feed)
    expect((await post(url, '/feed/feedback', { id: '', action: 'mute' })).status).toBe(400)
    expect((await post(url, '/feed/feedback', { id: 'x', action: '删掉' })).status).toBe(400)
    expect((await post(url, '/feed/feedback', { id: 'x', action: 'mute' })).status).toBe(404)
  })

  it('POST /feed/config 逐块合并,/feed 回显', async () => {
    const { feed } = makeFeed()
    await feed.load()
    await feed.setConfig(KEYWORDS)
    const url = await serve(feed)
    expect((await post(url, '/feed/config', { podcast: false, podcast_minutes: 6 })).status).toBe(200)
    const view = await (await fetch(`${url}/feed`)).json() as { config: { podcast: boolean, podcast_minutes: number, interests: { keywords: string[] }[] } }
    expect(view.config.podcast).toBe(false)
    expect(view.config.podcast_minutes).toBe(6)
    expect(view.config.interests[0]?.keywords).toEqual(['DeepSeek', '桌面 Agent'])
  })

  it('没接资讯服务:五条路由一律 404「资讯未启用」,收件箱里那一档整档不出', async () => {
    const url = await serve()
    for (const path of ['/feed', '/feed/podcast']) {
      const res = await fetch(`${url}${path}`)
      expect(res.status).toBe(404)
      expect((await res.json() as { error: string }).error).toBe('资讯未启用')
    }
    for (const path of ['/feed/run', '/feed/config', '/feed/feedback']) {
      expect((await post(url, path, {})).status).toBe(404)
    }
    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(state.butler_inbox?.items.some(item => item.kind === 'feed')).toBe(false)
  })
})
