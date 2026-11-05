// @vitest-environment node
/**
 * 「让 Codex 把 X 做了」走到 8791 上的那几条(2026-09-21,参赛冲刺卡 ④)。
 *
 *   POST /butler/item                { text, assignee }  → 卡上落负责人,第一条消息里点名
 *   POST /butler/item/dispatch       进度回报            → 卡上「派给 Codex,进行中/完成/失败」
 *   POST /butler/item/dispatch/stop  停掉                → 杀 pid(**注入的**,不动真进程)
 *
 * **一个子进程都不起**:这一层本来就不 spawn —— 真正跑命令的是事务官,这里只记账与停。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchState } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { fakeHubModel, type FakeHubCommands } from './helpers/fakeHubModel.ts'

const NOW_SEC = Math.floor(Date.parse('2026-09-21T09:00:00Z') / 1000)

const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, any> }
}

async function state(url: string): Promise<WorkbenchState> {
  return await (await fetch(`${url}/state`)).json() as WorkbenchState
}

async function serve(answers: FakeHubCommands = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-dispatch-'))
  dirs.push(dir)
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${++n}` })
  const sent: string[] = []
  /** 被「停掉」那颗按钮杀过的 pid。**注入的** —— 用例绝不往本机进程发信号。 */
  const killed: number[] = []
  // 2026-10-29 入口归一:/butler/item 一律进理解中枢 —— 受控假模型按「说:「…」」里的原话回命令;
  // 点名(dispatch)还是只记(note)由用例按原语义喂。
  const model = fakeHubModel(answers)
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    tasks,
    model: model.service as never,
    fetchImpl: model.fetchImpl,
    // 中转上配了 OpenAI 那一档(受控替身):GPT 这家走接口那只手才出现在候选里(卡 GH,不摆空壳)。
    relayProviders: { pump: () => {}, view: () => ({ openai: true }), read: async () => ({ openai: true }), refresh: () => {} },
    killProcess: (pid: number) => { killed.push(pid) },
    butlerSession: {
      open: async (firstMessage: string) => { sent.push(firstMessage); return `s-${sent.length}` },
    },
  })
  started.push(server)
  return { url: server.url, server, tasks, sent, killed, seen: model.seen }
}

describe('建事项时点名要哪一家', () => {
  const SAID = '把首页的黄历接上'
  /**
   * ★ 2026-10-29 入口归一:同一句原话、有没有点名(事实块里「点了名「X」」那一行)由假模型分两种答法 ——
   * 点名 → dispatch 命令给那家(工作台直接派,不开 DSH 会话);没点名 / 认不得 → note 只记不派。
   */
  const dispatchIfNamed = (family: string, title: string) =>
    (body: string) => body.includes(`点了名「${family}」`)
      ? [{ name: 'dispatch', new: { title }, to: family, text: title }]
      : [{ name: 'note', title, status: 'todo' }]

  /**
   * ★ 2026-09-24(卡 F)起:点了名的活**由工作台直接派**,不再开一条 DSH 会话让它"按技能派"。
   * 这里没接壳、没接命令行、没接中转 —— 三只手都派不出去,卡要**如实挂阻塞**,原因写清,
   * **不改派别家顶上**,也**不开会话**。
   */
  it('assignee=codex → 卡上落负责人;工作台直接派,不开 DSH 会话;派不出去就如实挂阻塞', async () => {
    const { url, server, tasks, sent } = await serve({ [SAID]: dispatchIfNamed('codex', SAID) })
    const created = await post(url, '/butler/item', { text: SAID, assignee: 'codex', source: 'call' })
    expect(created.status).toBe(200)
    expect(sent).toEqual([])
    // 派发在后台跑:drain 到落定再读卡(不靠轮询时长碰运气)。
    await server.drainDispatches()
    const task = (await tasks.list()).tasks[0]
    expect(task?.assignee).toBe('codex')
    expect(task?.status).toBe('blocked')
    // 如实账:哪只手、为什么没派出去(这台没接壳 / 命令行 / 中转)。
    expect(task?.note ?? '').not.toBe('')
  })

  it('没点名 → assignee 整个缺席,也不开 DSH 会话', async () => {
    const { url, tasks, sent } = await serve({ [SAID]: dispatchIfNamed('codex', SAID) })
    const created = await post(url, '/butler/item', { text: SAID })
    expect(created.status).toBe(200)
    expect(created.body.assignee).toBeUndefined()
    expect((await tasks.list()).tasks[0]?.assignee).toBeUndefined()
    expect(sent).toEqual([])
  })

  it('assignee=dsh → 事务官自己办:模型出 note 只记,不派活、不开会话', async () => {
    const { url, tasks, sent } = await serve({ [SAID]: dispatchIfNamed('codex', SAID) })
    await post(url, '/butler/item', { text: SAID, assignee: 'dsh' })
    const task = (await tasks.list()).tasks[0]
    expect(task).toMatchObject({ title: SAID, status: 'todo' })
    // 自己办不进「负责人」那一格(那是派给别家才落的);只验不派、不开会话。
    expect(task?.assignee).toBeUndefined()
    expect(sent).toEqual([])
  })

  it('打字建事项没有「选一家」的控件 → 原话里的指派由模型出 dispatch 认出', async () => {
    const said = '让 Codex 把首页的黄历接上'
    const { url, server, tasks } = await serve({ [said]: [{ name: 'dispatch', new: { title: '把首页的黄历接上' }, to: 'codex', text: said }] })
    await post(url, '/butler/item', { text: said })
    await server.drainDispatches()
    expect((await tasks.list()).tasks[0]?.assignee).toBe('codex')
  })

  it('**提到名字不等于派活**:问一句话模型只出 note(不然它会去起一个子进程查额度)', async () => {
    const said = 'Codex 那边额度还剩多少'
    const { url, tasks } = await serve({ [said]: [{ name: 'note', title: said, status: 'todo' }] })
    await post(url, '/butler/item', { text: said })
    expect((await tasks.list()).tasks[0]?.assignee).toBeUndefined()
  })

  /**
   * 2026-09-22:这条原来举的例子是 `gpt`(那天它确实认不得)。GPT 现在是**认得的**一家了
   * (走接口那只手),所以例子换成一个真认不得的名字 —— 用例要验的是
   * 「模型认不得(不出 to)→ 当没点名、事项照建不退回」,不是「gpt 认不得」。
   */
  it('认不得的家(gemini)→ **当没点名**,事项照建不退回', async () => {
    const { url, tasks } = await serve({ [SAID]: dispatchIfNamed('codex', SAID) })
    const created = await post(url, '/butler/item', { text: SAID, assignee: 'gemini' })
    expect(created.status).toBe(200)
    expect(created.body.assignee).toBeUndefined()
    expect((await tasks.list()).tasks).toHaveLength(1)
  })

  it('★ 电话里说「让 GPT 写三个标题」→ 落成 assignee=gpt,直接派走接口那只手', async () => {
    const said = '让 GPT 写三个标题'
    const { url, server, tasks } = await serve({ [said]: [{ name: 'dispatch', new: { title: '写三个标题' }, to: 'gpt', text: said }] })
    const created = await post(url, '/butler/item', { text: said, assignee: 'gpt' })
    expect(created.status).toBe(200)
    await server.drainDispatches()
    // 卡上负责人是点名的那家;这台没真接中转,接口那只手如实没派成(不冒称成功)。
    const task = (await tasks.list()).tasks[0]
    expect(task?.assignee).toBe('gpt')
    expect(task?.status).toBe('blocked')
    expect(task?.note).toContain('派给 GPT 没派出去')
  })

  it('★ 没带 assignee 时,原话里的「叫豆包…」模型也认得出,落成 assignee=doubao', async () => {
    const said = '叫豆包把这段润色一下'
    const { url, server, tasks } = await serve({ [said]: [{ name: 'dispatch', new: { title: '把这段润色一下' }, to: 'doubao', text: said }] })
    await post(url, '/butler/item', { text: said })
    await server.drainDispatches()
    expect((await tasks.list()).tasks[0]?.assignee).toBe('doubao')
  })
})

describe('进度回报', () => {
  async function anItem() {
    const seat = await serve({
      // 建卡这一步走中枢:假模型只记不派(派与不派由后面 /butler/item/dispatch 那几条上报逐条验)。
      '加一个 README': [{ name: 'note', title: '加一个 README', status: 'todo' }],
    })
    const created = await post(seat.url, '/butler/item', { text: '加一个 README', assignee: 'codex' })
    // 2026-10-21 协作区:开始派之前便签上要写清「做到什么算完」(noteGate.dispatchGate)。
    await post(seat.url, '/task/update', { id: created.body.id, acceptance: ['仓库根有 README'] })
    return { ...seat, id: created.body.id as string }
  }

  it('running → 卡上「派给 Codex,进行中」,带 pid 与工作目录', async () => {
    const { url, tasks, id } = await anItem()
    const reported = await post(url, '/butler/item/dispatch', {
      id, family: 'codex', status: 'running', cwd: '/tmp/repo', pid: 4321,
    })
    expect(reported.status).toBe(200)
    expect(reported.body.note).toBe('派给 Codex,进行中')
    const task = (await tasks.list()).tasks.find(one => one.id === id)
    expect(task?.dispatch).toMatchObject({ family: 'codex', status: 'running', cwd: '/tmp/repo', pid: 4321 })
    expect(task?.dispatch?.ended_at).toBeUndefined()
  })

  it('done → 盖 ended_at,started_at 还是开跑那一刻(不被覆盖)', async () => {
    const { url, tasks, id } = await anItem()
    await post(url, '/butler/item/dispatch', { id, family: 'codex', status: 'running', cwd: '/tmp/repo', pid: 4321 })
    const startedAt = (await tasks.list()).tasks.find(one => one.id === id)?.dispatch?.started_at
    const done = await post(url, '/butler/item/dispatch', { id, family: 'codex', status: 'done', cwd: '/tmp/repo', note: '加好了' })
    expect(done.body.note).toBe('派给 Codex,完成')
    const dispatch = (await tasks.list()).tasks.find(one => one.id === id)?.dispatch
    expect(dispatch?.started_at).toBe(startedAt)
    expect(dispatch?.ended_at).toBeDefined()
  })

  it('failed → 收件箱里多一条「要我自己来吗」,带上原因原话', async () => {
    const { url, id } = await anItem()
    await post(url, '/butler/item/dispatch', { id, family: 'codex', status: 'running', cwd: '/tmp/repo', pid: 4321 })
    await post(url, '/butler/item/dispatch', { id, family: 'codex', status: 'failed', cwd: '/tmp/repo', note: '退出码 1:没登录' })
    const items = (await state(url)).butler_inbox?.items ?? []
    const failed = items.find(item => item.kind === 'dispatch')
    expect(failed?.title).toContain('Codex 没做成')
    expect(failed?.note).toContain('退出码 1:没登录')
    expect(failed?.note).toContain('要我自己来吗')
    expect(failed?.task_id).toBe(id)
    // 球那边据此画成 failed 那一档,而不是跟哨兵通知一样的中性色。
    expect(failed?.wait_reason).toBe('error')
  })

  it('还在跑的那次**不进收件箱**(卡面小标已经说了,再说一遍是噪音)', async () => {
    const { url, id } = await anItem()
    await post(url, '/butler/item/dispatch', { id, family: 'codex', status: 'running', cwd: '/tmp/repo', pid: 4321 })
    const items = (await state(url)).butler_inbox?.items ?? []
    expect(items.some(item => item.kind === 'dispatch')).toBe(false)
  })

  it('认不得的家 / 状态 / 空目录 → 400,卡上一个字不改', async () => {
    const { url, tasks, id } = await anItem()
    for (const body of [
      // 2026-09-22:这一格原来写的是 `gpt`(那天它确实认不得)。它现在是**认得的**一家了
      // (走接口那只手),所以换一个真认不得的名字 —— 用例要验的是"认不得",不是"gpt"。
      { id, family: 'gemini', status: 'running', cwd: '/tmp/repo' },
      { id, family: 'codex', status: '跑着呢', cwd: '/tmp/repo' },
      // 空目录:**命令行那只手**仍然必填(接口那只手另有一条用例)。
      { id, family: 'codex', status: 'running', cwd: '  ' },
    ]) {
      expect((await post(url, '/butler/item/dispatch', body)).status).toBe(400)
    }
    expect((await tasks.list()).tasks.find(one => one.id === id)?.dispatch).toBeUndefined()
  })

  /**
   * 接口那只手(2026-09-22)。事务官自己派完之后也可以走**这一条**回报
   * (与 `/dispatch/api` 那条同一份记录、同一块小标、同一个收件箱)。
   */
  it('★ hand=api 不要求工作目录 —— 它不碰文件', async () => {
    const { url, tasks, id } = await anItem()
    const reported = await post(url, '/butler/item/dispatch', {
      id, family: 'gpt', status: 'done', hand: 'api', note: '给你三个标题',
    })
    expect(reported.status).toBe(200)
    const stored = (await tasks.list()).tasks.find(one => one.id === id)?.dispatch
    expect(stored?.hand).toBe('api')
    expect(stored?.family).toBe('gpt')
    // ★ 不编一个目录出来。
    expect(stored?.cwd).toBeUndefined()
    expect(reported.body.note).toBe('派给 GPT,完成')
  })

  it('★ 接口那只手失败,照样进同一个收件箱', async () => {
    const { url, id } = await anItem()
    await post(url, '/butler/item/dispatch', {
      id, family: 'doubao', status: 'failed', hand: 'api', note: '服务器没配 豆包(火山方舟)',
    })
    const failed = ((await state(url)).butler_inbox?.items ?? []).find(item => item.kind === 'dispatch')
    expect(failed?.title).toContain('豆包办公 没做成')
    expect(failed?.note).toContain('服务器没配')
    expect(failed?.note).toContain('要我自己来吗')
  })

  it('第三只手的口子是通的:hand=window 存得下、读得回(feat/dispatch-into-client 走同一条路由)', async () => {
    const { url, tasks, id } = await anItem()
    await post(url, '/butler/item/dispatch', {
      id, family: 'claude', status: 'running', hand: 'window', cwd: '/tmp/repo', pid: 4321,
    })
    expect((await tasks.list()).tasks.find(one => one.id === id)?.dispatch?.hand).toBe('window')
  })

  it('认不出的手 → **按缺席读**(= 命令行),不退回整条', async () => {
    const { url, tasks, id } = await anItem()
    const reported = await post(url, '/butler/item/dispatch', {
      id, family: 'codex', status: 'running', hand: '隔空喊话', cwd: '/tmp/repo',
    })
    expect(reported.status).toBe(200)
    expect((await tasks.list()).tasks.find(one => one.id === id)?.dispatch?.hand).toBeUndefined()
  })

  it('没有这条事项 → 404', async () => {
    const { url } = await anItem()
    const res = await post(url, '/butler/item/dispatch', { id: '不存在', family: 'codex', status: 'running', cwd: '/tmp/repo' })
    expect(res.status).toBe(404)
  })
})

describe('停掉', () => {
  async function running() {
    const seat = await serve({
      '加一个 README': [{ name: 'note', title: '加一个 README', status: 'todo' }],
    })
    const created = await post(seat.url, '/butler/item', { text: '加一个 README', assignee: 'codex' })
    const id = created.body.id as string
    await post(seat.url, '/task/update', { id, acceptance: ['仓库根有 README'] })
    await post(seat.url, '/butler/item/dispatch', { id, family: 'codex', status: 'running', cwd: '/tmp/repo', pid: 4321 })
    return { ...seat, id }
  }

  it('杀那个 pid,卡上转成失败并写明是你停的', async () => {
    const { url, tasks, killed, id } = await running()
    const stopped = await post(url, '/butler/item/dispatch/stop', { id })
    expect(stopped.status).toBe(200)
    expect(killed).toEqual([4321])
    const dispatch = (await tasks.list()).tasks.find(one => one.id === id)?.dispatch
    expect(dispatch?.status).toBe('failed')
    expect(dispatch?.note).toContain('你在卡上停掉了它')
    expect(stopped.body.note).toContain('派给 Codex,失败')
  })

  it('没在跑 → 409,**不改卡上的状态**', async () => {
    const { url, tasks, killed } = await serve({
      '加一个 README': [{ name: 'note', title: '加一个 README', status: 'todo' }],
    })
    const created = await post(url, '/butler/item', { text: '加一个 README' })
    const id = created.body.id as string
    expect((await post(url, '/butler/item/dispatch/stop', { id })).status).toBe(409)
    expect(killed).toEqual([])
    expect((await tasks.list()).tasks.find(one => one.id === id)?.dispatch).toBeUndefined()
  })

  it('事务官没报 pid → 409 并说去会话里让它自己停,**不把还在跑的活标成停了**', async () => {
    const { url, tasks, killed } = await serve({
      '加一个 README': [{ name: 'note', title: '加一个 README', status: 'todo' }],
    })
    const created = await post(url, '/butler/item', { text: '加一个 README', assignee: 'codex' })
    const id = created.body.id as string
    await post(url, '/task/update', { id, acceptance: ['仓库根有 README'] })
    await post(url, '/butler/item/dispatch', { id, family: 'codex', status: 'running', cwd: '/tmp/repo' })
    const stopped = await post(url, '/butler/item/dispatch/stop', { id })
    expect(stopped.status).toBe(409)
    expect(String(stopped.body.error)).toContain('进程号')
    expect(killed).toEqual([])
    // 还在跑就还是 running —— 这一条是这件功能里最不能错的一处。
    expect((await tasks.list()).tasks.find(one => one.id === id)?.dispatch?.status).toBe('running')
  })
})
