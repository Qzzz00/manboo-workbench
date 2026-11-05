// @vitest-environment node
/**
 * 电脑对话框切到理解中枢(A1,2026-10-28;设计 `docs/设计-理解中枢-模型出命令-2026-10-28.md` 第八节第 1 条)。
 *
 * `POST /butler/say` 带 `entrance:'desktop'` → 句子 + 上下文包 → 模型出命令 → 护栏 → 执行 → 回话。
 * 回归集里 10-28 那几句(取消、改目标、按卡号改名、改派不改名、补话落卡、「让小K把…修了」)在真服务上走一遍。
 * ★ 2026-10-29 删规矩第一批入口归一:不带 entrance 不再走旧路 —— 认不出的入口一律按 desktop 进中枢(A#7),
 * 旧形状的模型清单(没有命令表)当坏输出如实 502,一张卡不建、不冒称听懂。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'

const NOW_SEC = Math.floor(Date.parse('2026-10-28T05:00:00.000Z') / 1000)
const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

interface Harness { url: string, tasks: ReturnType<typeof createTasksService>, prompts: string[], replies: string[] }

/** 模型是排好队的假端点:每次请求按顺序吐一份回答,并记下它看到的提示。 */
async function serve(opts: { modelReady?: boolean } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'wb-hub-desktop-'))
  dirs.push(dir)
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${String(++n).padStart(8, '0')}` })
  const prompts: string[] = []
  const replies: string[] = []
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    prompts.push(String(init?.body))
    const content = replies.shift() ?? '{"commands":[{"name":"chat","reply":"在呢"}]}'
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }), { status: 200 })
  }) as never
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    tasks,
    model: { endpoint: async () => ({ baseUrl: 'http://x/v1', key: 'k', model: 'm', ready: opts.modelReady !== false }) } as never,
    fetchImpl,
    butlerSession: { open: async () => 'sess-hub', say: async () => true },
  })
  started.push(server)
  return { url: server.url, tasks, prompts, replies }
}

async function post(url: string, body: unknown) {
  const res = await fetch(`${url}/butler/say`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
}

const screen = (body: Record<string, unknown>): string => String((body.say as { screen?: string } | undefined)?.screen ?? '')

describe('电脑对话框 → 理解中枢', () => {
  it('13:03 取消:先问一次,点「取消它」才真取消;全程不出「不支持」', async () => {
    const h = await serve()
    const made = await h.tasks.create({ title: '旧排期卡', status: 'todo' })
    h.replies.push(JSON.stringify({ commands: [{ name: 'cancel', card_id: made.id }] }))
    const first = await post(h.url, { text: `把卡 ${made.id} 取消掉`, entrance: 'desktop' })
    expect(first.status).toBe(200)
    const ask = first.body.ask as { ask_id: string, question: string }
    expect(ask.question).toContain(made.id as string)
    expect((await h.tasks.list()).tasks[0]?.status).toBe('todo')
    const second = await post(h.url, { text: '确认', entrance: 'desktop', ctx: { confirmed: { ask_id: ask.ask_id, choice: 'yes' } } })
    expect(second.status).toBe(200)
    expect((await h.tasks.list()).tasks[0]?.status).toBe('canceled')
    expect(JSON.stringify([first.body, second.body])).not.toContain('不支持')
  })

  it('12:52 改目标状态:电脑这边也能把目标标成达成', async () => {
    const h = await serve()
    const goal = await h.tasks.createGoal({ title: '周五(10-23)把仓库交接给研发' })
    h.replies.push(JSON.stringify({ commands: [{ name: 'goal_status', goal_id: goal.id, status: 'reached' }] }))
    const out = await post(h.url, { text: '把「周五(10-23)把仓库交接给研发」那个目标标成达成。', entrance: 'desktop' })
    expect(out.status).toBe(200)
    expect((await h.tasks.list()).goals?.[0]?.status).toBe('reached')
    expect(screen(out.body)).toContain('达成')
    // 模型看得见这个目标(上下文包里有它)。
    expect(h.prompts[0]).toContain(goal.id as string)
  })

  it('09:36 按卡号改名:不锚 lastSay,卡号直接认', async () => {
    const h = await serve()
    const a = await h.tasks.create({ title: '刚才手机 App 那件改派给小K', status: 'todo' })
    h.replies.push(JSON.stringify({ commands: [{ name: 'rename', card_id: a.id, title: '查工作台 8791 空转热点' }] }))
    const out = await post(h.url, { text: `改错了:${a.id} 的标题改回「查工作台 8791 空转热点」`, entrance: 'desktop' })
    expect(out.status).toBe(200)
    expect((await h.tasks.list()).tasks[0]?.title).toBe('查工作台 8791 空转热点')
    expect(screen(out.body)).not.toContain('没拿着卡')
  })

  it('09:35 改派:手不行就说为什么,标题一个字不动', async () => {
    const h = await serve()
    const a = await h.tasks.create({ title: '修手机 App 重连竞态', status: 'blocked' })
    // 这台用例宿主没接任何一家:模型给的手认不出 → 那一条拒,如实说。
    h.replies.push(JSON.stringify({ commands: [{ name: 'reassign', card_id: a.id, to: '小K' }] }))
    const out = await post(h.url, { text: '刚才手机 App 那件,小G 的额度用完了,改派给小K。', entrance: 'desktop' })
    expect(out.status).toBe(200)
    expect((await h.tasks.list()).tasks[0]?.title).toBe('修手机 App 重连竞态')
    expect(screen(out.body)).toContain('小K')
  })

  it('13:16 补话:先落到卡上(留言),回话说下一轮带上', async () => {
    const h = await serve()
    const a = await h.tasks.create({ title: '修接续', status: 'doing' })
    h.replies.push(JSON.stringify({ commands: [{ name: 'supplement', card_id: a.id, text: '记得补电话入口的用例' }] }))
    const out = await post(h.url, { text: '给刚才派给小K那件补一句:记得补电话入口的用例', entrance: 'desktop' })
    expect(out.status).toBe(200)
    const card = (await h.tasks.list()).tasks[0]
    expect(JSON.stringify(card)).toContain('记得补电话入口的用例')
    expect(screen(out.body)).toContain('记在')
  })

  it('09:5x「让小K把…显示 0 的问题修了」:模型说派活就派活,不被词表分流成反馈', async () => {
    const h = await serve()
    h.replies.push(JSON.stringify({ commands: [{ name: 'dispatch', new: { title: '修事务官窗「在跑的事项」显示 0' }, text: '把事务官窗里「在跑的事项」显示 0 的问题修了' }] }))
    const out = await post(h.url, { text: '让小K把事务官窗里『在跑的事项』显示 0 的问题修了', entrance: 'desktop' })
    expect(out.status).toBe(200)
    expect(out.body.feedback).toBeUndefined()
    expect(screen(out.body)).not.toContain('反馈给开发者')
    // 卡建了(这台没接手,没派成 —— 照实说为什么)。
    expect((await h.tasks.list()).tasks.map(one => one.title)).toEqual(['修事务官窗「在跑的事项」显示 0'])
  })

  it('模型接不上 → 503,原话留在输入框;一张卡不建', async () => {
    const h = await serve({ modelReady: false })
    const out = await post(h.url, { text: '记一下周四发样片', entrance: 'desktop' })
    expect(out.status).toBe(503)
    expect(String(out.body.error)).toContain('没动')
    expect((await h.tasks.list()).tasks).toEqual([])
  })
})

describe('不带 entrance 也进中枢(2026-10-29 入口归一,A#7)', () => {
  it('旧形状的模型清单(没有命令表)= 坏输出,如实 502,一张卡不建', async () => {
    const h = await serve()
    h.replies.push(JSON.stringify({ addressed: true, items: [{ kind: '记', title: '周四发样片', risk: 'none', confidence: 0.9, why: 'qa' }] }))
    const out = await post(h.url, { text: '帮我记一件事,周四发样片,然后提醒我', ctx: { in_call: true } })
    expect(out.status).toBe(502)
    expect(String(out.body.error)).toContain('没动')
    expect((await h.tasks.list()).tasks).toEqual([])
  })

  it('认不出的 entrance 按 desktop 进中枢:命令照办', async () => {
    const h = await serve()
    h.replies.push(JSON.stringify({ commands: [{ name: 'note', title: '周四发样片', status: 'todo' }] }))
    const out = await post(h.url, { text: '帮我记一件事,周四发样片', entrance: '什么入口' })
    expect(out.status).toBe(200)
    expect(Array.isArray(out.body.items)).toBe(true)
    expect(out.body.hub).toBeDefined()
    expect((await h.tasks.list()).tasks.map(one => one.title)).toEqual(['周四发样片'])
  })
})
