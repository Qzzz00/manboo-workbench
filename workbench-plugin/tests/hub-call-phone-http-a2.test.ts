// @vitest-environment node
/**
 * A2(2026-10-28):电话与手机文字在真服务上走同一个理解中枢。
 *
 * - `/butler/say` 带 `entrance:'call'`(或老工人的 `phone` + `ctx.in_call`)→ 中枢 call;`phone` / `phone_text` → 中枢 phone;
 * - 回包形状与电脑那条一致(say_id / items / say{screen,spoken} / ask?),电话工人与手机照旧消费;
 * - 新口 `GET /butler/hub/context`、`POST /butler/hub/execute`(电话工人的工具表打这里)。
 * 回归集里入口为电话 / 手机的行在这里各走一遍。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'

const NOW_SEC = Math.floor(Date.parse('2026-10-28T07:00:00.000Z') / 1000)
const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

interface Harness { url: string, tasks: ReturnType<typeof createTasksService>, prompts: string[], replies: string[] }

async function serve(extra: Record<string, unknown> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'wb-hub-a2-'))
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
    model: { endpoint: async () => ({ baseUrl: 'http://x/v1', key: 'k', model: 'm', ready: true }) } as never,
    fetchImpl,
    butlerSession: { open: async () => 'sess-hub', say: async () => true },
    ...extra,
  })
  started.push(server)
  return { url: server.url, tasks, prompts, replies }
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
}

const say = (body: Record<string, unknown>) => body.say as { screen: string, spoken: string }

describe('/butler/say:电话与手机进中枢', () => {
  it('10-22 电话「帮我建一个待办事项:周四下午给客户发样片」→ 只建一张待办卡;不问「收不回来」;电话那份不念卡号', async () => {
    const h = await serve()
    h.replies.push(JSON.stringify({ commands: [{ name: 'note', title: '周四下午给客户发样片', status: 'todo' }] }))
    const out = await post(h.url, '/butler/say', { text: '帮我建一个待办事项:周四下午给客户发样片', entrance: 'call' })
    expect(out.status).toBe(200)
    expect(out.body.hub).toBeDefined()
    expect(h.prompts[0]).toContain('【入口与时间】call')
    const board = (await h.tasks.list()).tasks
    expect(board.map(one => [one.title, one.status])).toEqual([['周四下午给客户发样片', 'todo']])
    expect(board[0]?.dispatch).toBeUndefined()
    expect(out.body.ask).toBeUndefined()
    expect(JSON.stringify(out.body)).not.toContain('收不回来')
    expect(say(out.body).spoken).not.toMatch(/t-\d{8}/u)
    expect(typeof out.body.say_id).toBe('string')
    expect(Array.isArray(out.body.items)).toBe(true)
  })

  it('10-22 14:35 电话「好的,先放着,下午3点再提醒我。不要再发啦」→ 只记一条提醒,不派、不发;结果进 say 账', async () => {
    const h = await serve()
    h.replies.push(JSON.stringify({ commands: [{ name: 'note', title: '下午3点提醒我', status: 'todo' }, { name: 'chat', reply: '好,先放着,不再发了。' }] }))
    const out = await post(h.url, '/butler/say', { text: '好的,先放着,下午3点再提醒我。不要再发啦,哎呀我的妈。', entrance: 'call' })
    expect(out.status).toBe(200)
    const board = (await h.tasks.list()).tasks
    expect(board.map(one => one.title)).toEqual(['下午3点提醒我'])
    expect(board[0]?.dispatch).toBeUndefined()
    expect(say(out.body).spoken).toContain('不再发了')
    // 下一句的上下文包看得见这句与它的结果(以前账上只记了原话)。
    const next = await fetch(`${h.url}/butler/hub/context?entrance=call`)
    const got = await next.json() as { context: { says: { said: string, results?: string[] }[] } }
    expect(got.context.says.at(-1)?.results?.length).toBe(2)
  })

  it('老工人(entrance:phone + ctx.in_call)也认成 call', async () => {
    const h = await serve()
    const out = await post(h.url, '/butler/say', { text: '你好', entrance: 'phone', ctx: { in_call: true } })
    expect(out.status).toBe(200)
    expect(out.body.hub).toBeDefined()
    expect(h.prompts[0]).toContain('【入口与时间】call')
  })

  it('手机文字:phone 与老包的 phone_text 都认成 phone', async () => {
    for (const entrance of ['phone', 'phone_text']) {
      const h = await serve()
      const out = await post(h.url, '/butler/say', { text: '在吗', entrance })
      expect(out.status).toBe(200)
      expect(out.body.hub).toBeDefined()
      expect(h.prompts[0]).toContain('【入口与时间】phone')
    }
  })

  it('手机:取消先问,手机卡上点「取消它」(ctx.confirmed)才真取消', async () => {
    const h = await serve()
    const made = await h.tasks.create({ title: '旧排期卡', status: 'todo' })
    h.replies.push(JSON.stringify({ commands: [{ name: 'cancel', card_id: made.id }] }))
    const first = await post(h.url, '/butler/say', { text: `把卡 ${made.id} 取消掉`, entrance: 'phone' })
    const ask = first.body.ask as { ask_id: string }
    expect((await h.tasks.list()).tasks[0]?.status).toBe('todo')
    const second = await post(h.url, '/butler/say', { text: '取消它', entrance: 'phone', ctx: { confirmed: { ask_id: ask.ask_id, choice: '取消它' } } })
    expect(second.status).toBe(200)
    expect((await h.tasks.list()).tasks[0]?.status).toBe('canceled')
  })

  it('电话改目标状态(以前只有工人那件工具会):与电脑同一张表', async () => {
    const h = await serve()
    const goal = await h.tasks.createGoal({ title: '周五(10-23)把仓库交接给研发' })
    h.replies.push(JSON.stringify({ commands: [{ name: 'goal_status', goal_id: goal.id, status: 'reached' }] }))
    const out = await post(h.url, '/butler/say', { text: '把交接给研发那个目标标成达成', entrance: 'call' })
    expect(out.status).toBe(200)
    expect((await h.tasks.list()).goals?.[0]?.status).toBe('reached')
  })

  it('电话 / 手机不过 productFeedback 词表:模型说派活就是派活', async () => {
    const h = await serve()
    h.replies.push(JSON.stringify({ commands: [{ name: 'note', title: '修事务官窗「在跑的事项」显示 0', status: 'todo' }] }))
    const out = await post(h.url, '/butler/say', { text: '事务官窗里『在跑的事项』显示 0,这个问题记一下回头修', entrance: 'phone' })
    expect(out.status).toBe(200)
    expect(out.body.feedback).toBeUndefined()
    expect(out.body.hub).toBeDefined()
  })

  it('电话里「…然后换个女声」:整句交模型,音色是命令表里的 voice,前面的待办不被吞', async () => {
    const h = await serve()
    h.replies.push(JSON.stringify({ commands: [{ name: 'note', title: '周四下午给客户发样片', status: 'todo' }, { name: 'voice', gender: 'female' }] }))
    const out = await post(h.url, '/butler/say', { text: '帮我建一个待办:周四下午给客户发样片,然后换个女声', entrance: 'call' })
    expect(out.status).toBe(200)
    expect(h.prompts).toHaveLength(1)
    expect((await h.tasks.list()).tasks.map(one => one.title)).toEqual(['周四下午给客户发样片'])
    expect((out.body.hub as { commands: { name: string }[] }).commands.map(one => one.name)).toEqual(['note', 'voice'])
  })
})

describe('/butler/hub/execute 与 /butler/hub/context', () => {
  it('电话里记的规矩记在「电话」名下(不是电脑)', async () => {
    const added: { channel: string }[] = []
    const rules = { add: async (input: { channel: string }) => { added.push(input); return { ok: true } }, brief: () => undefined }
    const h = await serve({ rules })
    const out = await post(h.url, '/butler/hub/execute', { entrance: 'call', said: '以后派活先跟我说一声', commands: [{ name: 'remember', text: '派活先跟我说一声', scope: 'dispatch' }] })
    expect(out.status).toBe(200)
    expect(added.map(one => one.channel)).toEqual(['call'])
  })

  it('执行口:工人给命令 → 8791 收、护栏、执行;不调模型', async () => {
    const h = await serve()
    const out = await post(h.url, '/butler/hub/execute', { entrance: 'call', said: '记一下周四发样片', commands: [{ name: 'note', title: '周四发样片', status: 'todo' }] })
    expect(out.status).toBe(200)
    expect(h.prompts).toEqual([])
    expect((await h.tasks.list()).tasks.map(one => one.title)).toEqual(['周四发样片'])
    // 契约(统筹 10-28 定):200 = { say_id, results, say }。
    expect(Object.keys(out.body).sort()).toEqual(['results', 'say', 'say_id'])
    expect((out.body.results as { command: string, ok: boolean }[])[0]).toMatchObject({ command: 'note', ok: true })
  })

  it('执行口:取消回 ask,带 ask_id 点头才办;入口不对 400', async () => {
    const h = await serve()
    const made = await h.tasks.create({ title: '旧排期卡', status: 'todo' })
    const first = await post(h.url, '/butler/hub/execute', { entrance: 'call', said: '取消旧排期卡', commands: [{ name: 'cancel', card_id: made.id }] })
    const ask = (first.body.results as { ask?: { ask_id?: string } }[])[0]?.ask as { ask_id: string }
    expect(ask.ask_id).toBeTruthy()
    expect((await h.tasks.list()).tasks[0]?.status).toBe('todo')
    const second = await post(h.url, '/butler/hub/execute', { entrance: 'call', said: '取消吧', confirmed: { ask_id: ask.ask_id, choice: '取消它' } })
    expect(second.status).toBe(200)
    expect((await h.tasks.list()).tasks[0]?.status).toBe('canceled')
    const bad = await post(h.url, '/butler/hub/execute', { entrance: 'fax', said: 'x', commands: [] })
    expect(bad.status).toBe(400)
  })

  it('执行口也过「回指对上多张就问」:工人模型挑了其中一张 → 改成问一句,不改派', async () => {
    const h = await serve()
    await post(h.url, '/butler/hub/execute', { entrance: 'call', said: '记一下修手机 App 远程连回电脑时 LiveKit 重连竞态', commands: [{ name: 'note', title: '修手机 App 远程连回电脑时 LiveKit 重连竞态', status: 'todo' }] })
    await post(h.url, '/butler/hub/execute', { entrance: 'call', said: '记一下手机 App 首页离线排查', commands: [{ name: 'note', title: '手机 App 首页离线排查', status: 'todo' }] })
    const out = await post(h.url, '/butler/hub/execute', { entrance: 'call', said: '刚才手机 App 那件改名叫重连竞态', commands: [{ name: 'rename', card_id: 't-00000002', title: '重连竞态' }] })
    expect(out.status).toBe(200)
    expect((out.body.results as { command: string }[]).map(one => one.command)).toEqual(['ask'])
    expect((await h.tasks.list()).tasks.map(one => one.title)).not.toContain('重连竞态')
  })

  it('上下文包:与 /butler/say 同一份拼法;执行口落的账下一回合看得见', async () => {
    const h = await serve()
    await post(h.url, '/butler/hub/execute', { entrance: 'call', said: '记一下周四发样片', commands: [{ name: 'note', title: '周四发样片', status: 'todo' }] })
    const res = await fetch(`${h.url}/butler/hub/context?entrance=call&said=${encodeURIComponent('样片那件')}`)
    expect(res.status).toBe(200)
    const got = await res.json() as { context: { entrance: string, cards: { id: string }[], says: { said: string }[] }, text: string }
    expect(got.context.entrance).toBe('call')
    expect(got.context.cards.map(one => one.id)).toEqual(['t-00000001'])
    expect(got.context.says.map(one => one.said)).toEqual(['记一下周四发样片'])
    expect(got.text).toContain('【板上的卡】')
  })
})
