// @vitest-environment node
/**
 * 「就一条资讯深聊」那四条窄路(2026-10-13,卡「播客页重做」★3 / ★4)。
 *
 * 盯住的几条:
 *   - **文字与按住说话走同一条路**:手机把识别出来的字当她打的字发过来,这里一个岔口都不多;
 *   - **结论回电脑**:随手记末尾那一行、事项卡 desc 那一行的记号**只认 protocol.ts 一处**
 *     (写在这儿、读在月历 / 看板,两处各拼一遍迟早对不上);
 *   - 没接模型 / 没接随手记 / 没接看板,各自**如实回一句**,不摆空壳也不编答案(D13);
 *   - 「打电话聊」只往内存里记一格,进下一通电话的人设 —— **工人一行都不用改**。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FEED_NOTE_SOURCE_PREFIX, FEED_TASK_SOURCE_PREFIX, feedNoteTextOf, feedSourceParts, feedTaskDescOf,
} from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createFeedService, type FeedService, type SearchResult } from '../src/server/feed.ts'
import { createFeedDigContext, FEED_DIG_SECTION, FEED_DIG_TTL_MS } from '../src/server/feedDig.ts'
import { createNotesService } from '../src/server/notes.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { channelPersonaSections, buildChannelSystemMessage } from '../src/server/channel.ts'

const dirs: string[] = []
const started: WorkbenchServer[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-dig-'))
  dirs.push(dir)
  return dir
}

const TODAY = '2026-10-13'
const NOW = Date.parse(`${TODAY}T07:30:00`)

const RESULTS: SearchResult[] = [
  { title: 'DeepSeek 又降价了', url: 'https://news.example/1', snippet: '官方公告', source: '机器之心' },
]

/** 跑一轮,拿到今天那条资讯的 id。 */
async function makeFeed(dir: string): Promise<{ feed: FeedService, id: string }> {
  const feed = createFeedService({
    file: join(dir, 'feed.json'),
    configFile: join(dir, 'feed-config.json'),
    projects: async () => [{ id: 'p1', name: '桌面工作台' }],
    search: async () => ({ ok: true, results: RESULTS }),
    chat: async prompt => (prompt.includes('口播稿') ? '' : '[{"i":0,"score":5,"why":"你们的中转就是转这家,成本要重算"}]'),
    now: () => NOW,
  })
  await feed.load()
  await feed.setConfig({ interests: [{ project_id: 'p1', project_name: '桌面工作台', keywords: ['DeepSeek'] }] })
  await feed.run()
  const id = feed.view().groups[0]?.items[0]?.id as string
  expect(id).toBeTruthy()
  return { feed, id }
}

interface ServeOptions {
  feed?: FeedService
  notes?: boolean
  tasks?: boolean
  quickAnswer?: (prompt: string) => Promise<string>
  dig?: ReturnType<typeof createFeedDigContext>
}

async function serve(dir: string, over: ServeOptions = {}) {
  const prompts: string[] = []
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => Math.floor(NOW / 1000) }),
    tickIntervalMs: 0,
    ...(over.feed === undefined ? {} : { feed: over.feed }),
    ...(over.notes === false ? {} : { notes: createNotesService({ file: join(dir, 'notes.json') }) }),
    ...(over.tasks === false ? {} : { tasks: createTasksService({ file: join(dir, 'tasks.json'), now: () => Math.floor(NOW / 1000) }) }),
    ...(over.quickAnswer === undefined
      ? { quickAnswer: async (prompt: string) => { prompts.push(prompt); return '这家降价对你的中转成本是实打实的一刀。' } }
      : { quickAnswer: over.quickAnswer }),
    ...(over.dig === undefined ? {} : { feedDig: over.dig }),
  })
  started.push(server)
  return { url: server.url, prompts }
}

async function post(url: string, path: string, body?: unknown): Promise<{ status: number, body: Record<string, unknown> }> {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

describe('来源那一行只认一处记号', () => {
  it('随手记:结论在前、来源在后,拆回来还是那两样', () => {
    const text = feedNoteTextOf({ said: '这条要盯,下周重算成本', title: 'DeepSeek 又降价了', url: 'https://news.example/1' })
    expect(text.startsWith('这条要盯,下周重算成本')).toBe(true)
    expect(text).toContain(`${FEED_NOTE_SOURCE_PREFIX}《DeepSeek 又降价了》 https://news.example/1`)
    expect(feedSourceParts(text)).toEqual({
      said: '这条要盯,下周重算成本',
      source: '《DeepSeek 又降价了》 https://news.example/1',
    })
  })

  it('事项卡 desc:来源 + 链接 + 摘要;结论是卡的标题,不在 desc 里重复', () => {
    const desc = feedTaskDescOf({ title: 'DeepSeek 又降价了', url: 'https://news.example/1', why: '成本要重算' })
    expect(desc).toBe(`${FEED_TASK_SOURCE_PREFIX}《DeepSeek 又降价了》 https://news.example/1 · 成本要重算`)
    expect(feedSourceParts(desc).source).toBe('《DeepSeek 又降价了》 https://news.example/1 · 成本要重算')
    expect(feedSourceParts(desc).said).toBeUndefined()
  })

  it('没有那一行的照旧只有正文(她手填的、老卡上的)', () => {
    expect(feedSourceParts('就是一句话')).toEqual({ said: '就是一句话' })
    expect(feedSourceParts(undefined)).toEqual({})
  })
})

describe('POST /feed/dig:就这一条答一句', () => {
  it('她那一句在前、这条资讯的事实在后;回话原样给手机', async () => {
    const dir = tempDir()
    const { feed, id } = await makeFeed(dir)
    const { url, prompts } = await serve(dir, { feed })
    const got = await post(url, '/feed/dig', { id, text: '这对我的成本有多大影响?' })
    expect(got.status).toBe(200)
    expect(got.body.said).toBe('这家降价对你的中转成本是实打实的一刀。')
    expect(got.body.item_id).toBe(id)
    const prompt = prompts[0] as string
    expect(prompt.startsWith('这对我的成本有多大影响?')).toBe(true)
    expect(prompt).toContain('《DeepSeek 又降价了》')
    expect(prompt).toContain('https://news.example/1')
    expect(prompt).toContain('你们的中转就是转这家,成本要重算')
  })

  it('刚才那几轮带得上去(多轮);形状不对的那几条挑掉,不拒整条请求', async () => {
    const dir = tempDir()
    const { feed, id } = await makeFeed(dir)
    const { url, prompts } = await serve(dir, { feed })
    const got = await post(url, '/feed/dig', {
      id,
      text: '那下一步呢?',
      turns: [
        { who: 'her', text: '这条讲的是什么' },
        { who: 'butler', text: '降价一半' },
        { who: '谁', text: '形状不对' },
        { who: 'her', text: '' },
      ],
    })
    expect(got.status).toBe(200)
    const prompt = prompts[0] as string
    expect(prompt).toContain('她:这条讲的是什么')
    expect(prompt).toContain('你:降价一半')
    expect(prompt).not.toContain('形状不对')
  })

  it('`want: conclusion` 换成收一句结论那一问', async () => {
    const dir = tempDir()
    const { feed, id } = await makeFeed(dir)
    const { url, prompts } = await serve(dir, { feed })
    const got = await post(url, '/feed/dig', { id, want: 'conclusion', turns: [{ who: 'her', text: '要盯' }] })
    expect(got.status).toBe(200)
    expect(prompts[0]).toContain('收成**一两句结论**')
  })

  it('这一条不在了 → 404;没接资讯 → 404;模型没接上 → 409 如实说', async () => {
    const dir = tempDir()
    const { feed, id } = await makeFeed(dir)
    const live = await serve(dir, { feed })
    expect((await post(live.url, '/feed/dig', { id: 'nope', text: 'x' })).status).toBe(404)
    expect((await post(live.url, '/feed/dig', { text: 'x' })).status).toBe(400)

    const bare = await serve(tempDir())
    expect((await post(bare.url, '/feed/dig', { id, text: 'x' })).status).toBe(404)

    const dir2 = tempDir()
    const second = await makeFeed(dir2)
    const noModel = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService({ now: () => Math.floor(NOW / 1000) }),
      tickIntervalMs: 0,
      feed: second.feed,
    })
    started.push(noModel)
    const refused = await post(noModel.url, '/feed/dig', { id: second.id, text: 'x' })
    expect(refused.status).toBe(409)
    expect(String(refused.body.error)).toContain('模型服务还没接上')
  })

  it('模型抛了 / 回空:502 说原因,不摆一个空答案', async () => {
    const dir = tempDir()
    const { feed, id } = await makeFeed(dir)
    const blew = await serve(dir, { feed, quickAnswer: async () => { throw new Error('relay 502') } })
    const got = await post(blew.url, '/feed/dig', { id, text: 'x' })
    expect(got.status).toBe(502)
    expect(String(got.body.error)).toContain('relay 502')

    const dir2 = tempDir()
    const second = await makeFeed(dir2)
    const empty = await serve(dir2, { feed: second.feed, quickAnswer: async () => '   ' })
    expect((await post(empty.url, '/feed/dig', { id: second.id, text: 'x' })).status).toBe(502)
  })
})

describe('POST /feed/dig/note:结论回电脑随手记', () => {
  it('记下来,末尾带来源那一行', async () => {
    const dir = tempDir()
    const { feed, id } = await makeFeed(dir)
    const { url } = await serve(dir, { feed })
    const got = await post(url, '/feed/dig/note', { id, text: '这条要盯,下周重算成本' })
    expect(got.status).toBe(200)
    const note = got.body.note as { text: string }
    expect(note.text).toBe(feedNoteTextOf({ said: '这条要盯,下周重算成本', title: 'DeepSeek 又降价了', url: 'https://news.example/1' }))
    // 真进了快照(电脑那边看得见)。
    const state = await (await fetch(`${url}/state`)).json() as { notes?: { text: string }[] }
    expect(state.notes?.[0]?.text).toContain(FEED_NOTE_SOURCE_PREFIX)
  })

  it('空结论 400;没接随手记 404', async () => {
    const dir = tempDir()
    const { feed, id } = await makeFeed(dir)
    const { url } = await serve(dir, { feed })
    expect((await post(url, '/feed/dig/note', { id, text: '  ' })).status).toBe(400)

    const dir2 = tempDir()
    const second = await makeFeed(dir2)
    const bare = await serve(dir2, { feed: second.feed, notes: false })
    const got = await post(bare.url, '/feed/dig/note', { id: second.id, text: '要盯' })
    expect(got.status).toBe(404)
    expect(String(got.body.error)).toContain('随手记未启用')
  })
})

describe('POST /feed/dig/task:结论做成事项卡', () => {
  it('标题是结论,desc 带来源于 + 链接 + 摘要,挂在那条资讯的项目上', async () => {
    const dir = tempDir()
    const { feed, id } = await makeFeed(dir)
    const { url } = await serve(dir, { feed })
    const got = await post(url, '/feed/dig/task', { id, title: '重算中转成本' })
    expect(got.status).toBe(200)
    const state = await (await fetch(`${url}/state`)).json() as {
      tasks?: { tasks: { id: string, title: string, desc?: string, project_id?: string }[] }
    }
    const card = state.tasks?.tasks.find(one => one.id === got.body.id)
    expect(card?.title).toBe('重算中转成本')
    expect(card?.project_id).toBe('p1')
    expect(card?.desc).toBe(feedTaskDescOf({
      title: 'DeepSeek 又降价了',
      url: 'https://news.example/1',
      why: '你们的中转就是转这家,成本要重算',
    }))
    // 看板上悬浮读回来的就是那条资讯。
    expect(feedSourceParts(card?.desc).source).toContain('《DeepSeek 又降价了》')
  })

  it('空标题 400;没接看板 404', async () => {
    const dir = tempDir()
    const { feed, id } = await makeFeed(dir)
    const { url } = await serve(dir, { feed })
    expect((await post(url, '/feed/dig/task', { id, title: ' ' })).status).toBe(400)

    const dir2 = tempDir()
    const second = await makeFeed(dir2)
    const bare = await serve(dir2, { feed: second.feed, tasks: false })
    expect((await post(bare.url, '/feed/dig/task', { id: second.id, title: 'x' })).status).toBe(404)
  })
})

describe('POST /feed/dig/call:下一通电话知道她要聊哪条', () => {
  it('记一格 → 进人设那一段 → 取过就没了', async () => {
    const dir = tempDir()
    const { feed, id } = await makeFeed(dir)
    const dig = createFeedDigContext({ now: () => NOW })
    const { url } = await serve(dir, { feed, dig })
    const got = await post(url, '/feed/dig/call', { id, turns: [{ who: 'her', text: '这条讲的是什么' }, { who: 'butler', text: '降价一半' }] })
    expect(got.status).toBe(200)
    expect(dig.peek()?.title).toBe('DeepSeek 又降价了')
    // 她说过的那几句带上去,事务官答的那几句不带(电话里由它自己接着说)。
    expect(dig.peek()?.said).toEqual(['这条讲的是什么'])

    const block = dig.takeBlock() as string
    expect(block).toContain(FEED_DIG_SECTION)
    expect(block).toContain('《DeepSeek 又降价了》')
    expect(block).toContain('这条讲的是什么')
    // 取一次就清:它管的是接下来那一通,不是从此以后每一通。
    expect(dig.takeBlock()).toBeUndefined()
  })

  it('过了十分钟当没有(记住了却没打电话,不许凭空多出一段)', () => {
    let ms = NOW
    const dig = createFeedDigContext({ now: () => ms })
    dig.set({ title: '甲', url: 'https://a.example/1' })
    ms += FEED_DIG_TTL_MS + 1
    expect(dig.peek()).toBeUndefined()
    expect(dig.takeBlock()).toBeUndefined()
  })

  it('没接这一格 → 404,但文字与按住说话照样能聊', async () => {
    const dir = tempDir()
    const { feed, id } = await makeFeed(dir)
    const { url } = await serve(dir, { feed })
    expect((await post(url, '/feed/dig/call', { id })).status).toBe(404)
    expect((await post(url, '/feed/dig', { id, text: 'x' })).status).toBe(200)
  })

  it('认不出的深聊操作 404', async () => {
    const dir = tempDir()
    const { feed, id } = await makeFeed(dir)
    const { url } = await serve(dir, { feed })
    expect((await post(url, '/feed/dig/whatever', { id })).status).toBe(404)
  })
})

describe('通话人设里那一段', () => {
  it('带上就多一段 always、整段拼回去逐字就是 system_message;缺席 = 与加它之前逐字相同', () => {
    const block = createFeedDigContext({ now: () => NOW })
    block.set({ title: 'DeepSeek 又降价了', url: 'https://news.example/1', source: '机器之心', why: '成本要重算' })
    const text = block.takeBlock() as string
    const withDig = channelPersonaSections({ rememberTool: 'r', doingTool: 'd', handTool: 'h', digBlock: text })
    const without = channelPersonaSections({ rememberTool: 'r', doingTool: 'd', handTool: 'h' })
    const mine = withDig.find(one => one.name === FEED_DIG_SECTION)
    expect(mine?.always).toBe(true)
    expect(withDig.filter(one => one.name !== FEED_DIG_SECTION).map(one => one.text)).toEqual(without.map(one => one.text))
    // 分段拼回去逐字就是那一整段(与 persona-sections-1003 那条对照同一条规矩)。
    expect(withDig.map(one => one.text).join('\n')).toBe(
      buildChannelSystemMessage({ rememberTool: 'r', doingTool: 'd', handTool: 'h', digBlock: text }),
    )
  })
})
