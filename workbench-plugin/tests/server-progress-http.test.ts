// @vitest-environment node
/**
 * 8791 上的「一件事一份、进度靠证据」(2026-09-25,卡 N):
 *
 *   /state                     卡上挂 `progress`(现在到哪 · 依据 · 什么时候看的)与 `mover`(现在该谁动);
 *                              证据里冒出来的待排卡在「等你确认」里问「要加上吗」
 *   /progress*、/item/drive    进度核对与负责人驱动的口
 *   POST /butler/item          ★ 2026-10-29 入口归一(A#24 删):不再有「到哪了」当场答 / 挂已有卡的词表岔口,
 *                              这句话与其它话一样进理解中枢(见文件内该节注记);进度核对服务还在,只缺入口调用
 *   /task/update               负责人放宽到人那三档(me / colleague / other)+ 补充
 *
 * 进度核对是假的(一个模型、一个会话文件都不碰):回固定的结论。看板、审批经纪人是真的。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskProgressView, WorkbenchState } from '../src/protocol.ts'
import { createApprovalBroker } from '../src/server/composer.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import type { ProgressService } from '../src/server/progress.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { fakeHubModel } from './helpers/fakeHubModel.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, any> }
}

async function state(url: string): Promise<WorkbenchState> {
  return await (await fetch(`${url}/state`)).json() as WorkbenchState
}

const SITE: TaskProgressView = {
  line: '11 屏已做完,逐屏文案稿在等你审',
  state: 'found',
  basis: [{ kind: 'session', source: 'Codex 里「制作参赛网页」那段对话', ref: '/x/rollout-01a0ccd1.jsonl', at: '2026-09-24T12:17:00Z', quote: '11 屏按网页顺序排列' }],
  // 核对时刻用「现在」:卡是用真时钟建的,比卡还旧的进度不下发(2026-10-12,progressOnCard),写死 09-25 这一份会被当成旧的藏起来。
  checked_at: new Date().toISOString(),
  waiting_on: 'me',
  by: 'model',
}

/** 假的进度核对:卡 id → 固定结论。 */
function fakeProgress(cards: Map<string, TaskProgressView>, calls: string[]): ProgressService {
  return {
    load: async () => {},
    // 起服务时把重启前挂着的那几问挂回来(卡 U8)。这一组验的是路由,所以只记一笔。
    resume: async () => { calls.push('resume') },
    evaluate: async (input) => {
      calls.push(`evaluate:${input.trigger}:${(input.taskIds ?? []).join(',')}`)
      const ids = input.taskIds ?? [...cards.keys()]
      return { cards: ids.length, spend_cny: 0, by: 'model', results: ids.map(id => ({ task_id: id, title: id, progress: cards.get(id) ?? { line: '还没看到进展,要你说一句', state: 'none', basis: [], checked_at: '2026-09-25T07:10:00Z', by: 'rules' } })), proposed: [] }
    },
    ask: async (query) => {
      calls.push(`ask:${query}`)
      return query.includes('参赛网页')
        ? { ok: true, line: '「参赛网页架构收尾」:11 屏已做完,逐屏文案稿在等你审(依据:Codex 里「制作参赛网页」那段对话 · 9月24日 20:17)', results: [] }
        : { ok: false, line: '看板上没认出你说的是哪一件', results: [] }
    },
    said: async (taskId, text) => { calls.push(`said:${taskId}:${text}`); return { ok: true, note: '记下了。' } },
    cardViews: () => cards,
    runState: () => ({ running: false, today_cny: 0.03, cap_cny: 0.5, sessions: 'allowed' }),
    beforeMorning: async () => ({ lines: [] }),
  }
}

async function serve(opts: { items?: boolean, driver?: boolean, answers?: Parameters<typeof fakeHubModel>[0] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-progress-http-'))
  dirs.push(dir)
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), newId: () => `t-${++n}` })
  const approvals = createApprovalBroker()
  const cards = new Map<string, TaskProgressView>()
  const calls: string[] = []
  const opened: string[] = []
  // 2026-10-29 入口归一:POST /butler/item 不再有「到哪了」岔口(A#24 删),一律进理解中枢,接假模型。
  const model = fakeHubModel(opts.answers ?? {})
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({}),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    tasks,
    approvals,
    butlerSession: { open: async (first: string) => { opened.push(first); return `session-${opened.length}` } } as never,
    model: model.service as never,
    fetchImpl: model.fetchImpl,
    ...(opts.items === false ? {} : { items: { progress: fakeProgress(cards, calls), ...(opts.driver === true ? { driveFile: join(dir, 'drive.json') } : {}) } }),
  })
  started.push(server)
  return { server, url: server.url, tasks, approvals, cards, calls, opened }
}

describe('/state:卡上挂「现在到哪」与「现在该谁动」', () => {
  it('接了 items:每张卡都有 mover,核过的有 progress,/state.progress 是评估器此刻的样子', async () => {
    const h = await serve()
    const site = await h.tasks.create({ title: '参赛网页架构收尾', assignee: 'codex' })
    const mine = await h.tasks.create({ title: '9/28 把材料整理好放同事桌上', assignee: 'me', due: '2026-09-28' })
    h.cards.set(site.id as string, SITE)
    const s = await state(h.url)
    const byId = (id: string) => s.tasks?.tasks.find(task => task.id === id)
    expect(byId(site.id as string)?.progress?.line).toBe('11 屏已做完,逐屏文案稿在等你审')
    expect(byId(site.id as string)?.mover).toEqual({ who: 'butler', line: '排着,等派给 Codex', assignee: 'codex' })
    expect(byId(mine.id as string)?.mover?.line).toBe('你来 · 截止 9/28')
    expect(s.progress).toEqual({ running: false, today_cny: 0.03, cap_cny: 0.5, sessions: 'allowed' })
    // 没办完的停在哪(2026-10-12):与 mover 同一处现算。刚建的卡:最后一条证据是她交代的那一下。
    expect(byId(site.id as string)?.standing).toMatchObject({ case: 'queued', waiting_on: 'nobody', next: '排着,等派给 Codex', idle_days: 0 })
    expect(byId(site.id as string)?.standing?.last?.source).toBe('her')
    expect(byId(mine.id as string)?.standing).toMatchObject({ case: 'waiting_her', waiting_on: 'her' })
  })

  it('没接 items(既有那一大批用例):卡上一个字不多', async () => {
    const h = await serve({ items: false })
    await h.tasks.create({ title: '参赛网页架构收尾', assignee: 'codex' })
    const s = await state(h.url)
    expect(s.tasks?.tasks[0]?.mover).toBeUndefined()
    expect(s.tasks?.tasks[0]?.standing).toBeUndefined()
    expect(s.progress).toBeUndefined()
    expect((await post(h.url, '/progress/check', {})).status).toBe(404)
  })

  it('证据里冒出来的待排卡:标题是名词短语,问句在 note 里,不进「等你」(2026-09-27,卡 WY)', async () => {
    const h = await serve()
    await h.tasks.create({ title: '换真截图', status: 'backlog', origin: 'evidence' })
    const s = await state(h.url)
    const ask = s.butler_inbox?.items.find(item => item.kind === 'confirm')
    expect(ask?.title).toBe('换真截图')
    expect(ask?.note).toBe('对话里提到还要做的 · 要不要加')
    expect(ask?.status).toBe('backlog')
    // 它是提议,不是「他不点头就卡住」的事:球下「等你 n」里没有它。
    expect(s.waiting?.items.some(item => item.text.includes('换真截图'))).toBe(false)
  })
})

describe('/progress 那几个口', () => {
  it('核一轮 / 他问 / 他说一句,都转给进度核对', async () => {
    const h = await serve()
    const site = await h.tasks.create({ title: '参赛网页架构收尾', assignee: 'codex' })
    expect((await post(h.url, '/progress/check', { task_id: site.id })).body.ok).toBe(true)
    expect((await post(h.url, '/progress/ask', { text: '参赛网页到哪了?' })).body.line).toContain('11 屏已做完')
    expect((await post(h.url, '/progress/said', { task_id: site.id, text: '文案我下午看' })).body.note).toBe('记下了。')
    expect((await post(h.url, '/progress/said', { task_id: site.id })).status).toBe(400)
    expect(h.calls).toEqual([`evaluate:ask:${site.id}`, 'ask:参赛网页到哪了?', `said:${site.id}:文案我下午看`])
    const got = await (await fetch(`${h.url}/progress`)).json() as { state: unknown }
    expect(got.state).toEqual({ running: false, today_cny: 0.03, cap_cny: 0.5, sessions: 'allowed' })
  })
})

describe('/butler/item', () => {
  /*
   * ★ 2026-10-29 入口归一(A#24 删):「XX 到哪了」不再有入口岔口(itemIdentity.isProgressQuestion 与
   * progressService 当场答那一条删除)—— 这句话与其它话一样进理解中枢,模型按上下文包里的事实出 chat 答。
   * 进度核对服务还在(下面 /progress 那几个口照旧),但没有入口再为它当场调一次。
   */
  it('「参赛网页到哪了」:进中枢由模型按事实答(chat),不建卡、不开事务官会话、入口不再调进度核对', async () => {
    const h = await serve({ answers: { '参赛网页到哪了?': [{ name: 'chat', reply: '「参赛网页架构收尾」:11 屏已做完,逐屏文案稿在等你审。' }] } })
    const res = await post(h.url, '/butler/item', { text: '参赛网页到哪了?' })
    expect(res.status).toBe(200)
    expect(res.body.note).toContain('11 屏已做完,逐屏文案稿在等你审')
    expect(h.opened).toEqual([])
    expect(h.calls).not.toContain('ask:参赛网页到哪了?')
    expect((await h.tasks.list()).tasks).toHaveLength(0)
  })

  it('认不出是哪一张的「XX 到哪了」:照旧进中枢,模型照实说认不出(不开事务官会话)', async () => {
    const h = await serve({ answers: { '天气预报到哪了?': [{ name: 'chat', reply: '看板上没认出你说的是哪一件 —— 你说是哪一件?' }] } })
    const res = await post(h.url, '/butler/item', { text: '天气预报到哪了?' })
    expect(res.status).toBe(200)
    expect(res.body.note).toContain('没认出')
    expect(h.opened).toEqual([])
  })

  /*
   * 旧语义(看板上已经有这件 → 挂到那张上、记进描述)随 sameItemFor 词表删除;新语义里由模型回指那张卡
   * 出 supplement(执行层把这句落卡上的评论),一张卡不多建、负责人不动。
   */
  it('看板上已经有这件:中枢 supplement 落到那张上,不再建一张,负责人不改', async () => {
    const h = await serve({ answers: { '额度显示那里修一下,微信那格别算进去': [{ name: 'supplement', card_id: 't-1', text: '额度显示那里修一下,微信那格别算进去' }] } })
    const quota = await h.tasks.create({ title: '额度显示 / 会话读取', assignee: 'claude', desc: '负责:Claude\n不阻塞' })
    const res = await post(h.url, '/butler/item', { text: '额度显示那里修一下,微信那格别算进去' })
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(quota.id)
    const board = (await h.tasks.list()).tasks
    expect(board).toHaveLength(1)
    expect(board[0]?.comments?.map(one => one.text)).toContain('额度显示那里修一下,微信那格别算进去')
    expect(board[0]?.assignee).toBe('claude')
  })
})

describe('/task/update:负责人放宽到人那三档', () => {
  it('me / colleague / other + 补充;认不出的 400', async () => {
    const h = await serve()
    const card = await h.tasks.create({ title: '参赛文案' })
    expect((await post(h.url, '/task/update', { id: card.id, assignee: 'colleague', assignee_note: '9/29 回来写' })).status).toBe(200)
    const after = (await h.tasks.list()).tasks[0]
    expect([after?.assignee, after?.assignee_note]).toEqual(['colleague', '9/29 回来写'])
    expect((await post(h.url, '/task/update', { id: card.id, assignee: 'boss' })).status).toBe(400)
    expect((await post(h.url, '/task/update', { id: card.id, assignee_note: null })).status).toBe(200)
    expect((await h.tasks.list()).tasks[0]?.assignee_note).toBeUndefined()
  })
})

describe('负责人驱动接在 8791 上', () => {
  /*
   * ★ 2026-10-29 删规矩第一批 E#2:待办挂负责人的卡「不问、不自动派」——「这张派给 Codex 开工?」那一问
   * 整个删掉(审批经纪人那一格驱动也不再使用)。驱动这一拍只剩记档:卡保持待办,问与派都没有。
   * 开工只来自她明确委托(她说的 → 中枢 dispatch;她在卡上点的 → driveNow),在
   * task-execution-entrances / dispatch-unreadable-say-now 里钉。
   */
  it('写着 Codex 的待办卡:不问、不派,卡留待办;mover 写「排着,等派给 Codex」(E#2,「派给 X 开工?」已删)', async () => {
    const h = await serve({ driver: true })
    const card = await h.tasks.create({ title: '参赛网页架构收尾', assignee: 'codex' })
    h.cards.set(card.id as string, SITE)
    // 看板一变就补一拍(/task 路由里 kick):改一下标题触发。
    await post(h.url, '/task/update', { id: card.id, title: '参赛网页架构收尾' })
    // 给驱动留一拍。
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(h.approvals.list()).toEqual([])
    const after = (await h.tasks.list()).tasks[0]
    expect(after).toMatchObject({ status: 'todo', assignee: 'codex' })
    expect(after?.dispatch).toBeUndefined()
    const s = await state(h.url)
    expect(s.tasks?.tasks[0]?.mover?.line).toBe('排着,等派给 Codex')
  })
})
