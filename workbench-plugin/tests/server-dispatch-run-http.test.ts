// @vitest-environment node
/**
 * 8791 上的派活入口(2026-09-24,卡 F「手机远程派活六家」):
 *
 *   POST /butler/item { text, assignee }  点了名 → **工作台直接派**(不开 DSH 会话);
 *                                         ★ 2026-10-29 入口归一(E#3):「先问我」档 named 派活的
 *                                         审批已删 —— 点名即直接派,没有「要你批一下」那一问
 *   POST /dispatch/run { item_id, app }   对一张已经建好的卡派活(事务官 / 卡 B 落地都走它)
 *
 * 壳是**假的**(一个真窗口都不碰):`send_text` 回送成了,`read_reply` 回读到了。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApprovalBroker } from '../src/server/composer.ts'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import { engineHarness } from './helpers/engineHarness.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createRulesService } from '../src/server/rules.ts'
import { OBSERVATIONS } from './fixtures/rulesObservations.ts'
import { fakeHubModel, type FakeHubCommands } from './helpers/fakeHubModel.ts'

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

async function serve(opts: { approvals?: boolean, rules?: boolean, answers?: FakeHubCommands } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-dispatch-run-http-'))
  dirs.push(dir)
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), newId: () => `t-${++n}` })
  const helperCalls: HelperRequest[] = []
  const approvals = opts.approvals === true ? createApprovalBroker() : undefined
  // 卡 K 的规矩表(落在临时目录;AGENTS.md 那一段写进内存)。
  const rules = opts.rules === true
    ? createRulesService({ file: join(dir, 'rules.json'), agents: { apply: async () => ({ ok: true }), revert: async () => ({ ok: true }) }, observations: async () => OBSERVATIONS })
    : undefined
  if (rules !== undefined) await rules.load()
  // 与真的 helperChannel 同一个约定:壳回 ok:true 时 resolve 的是 result 本身(见 server-dispatch-real-helper)。
  const request = async (req: HelperRequest): Promise<Record<string, unknown>> => {
    helperCalls.push(req)
    if (req.op === 'send_text') return { method: 'ax_value', submitted: req.submit === true, new_conversation: '新聊天' }
    return { found: false, busy: false }
  }
  /*
   * ★ 2026-10-02(卡「引擎接线与删复制品」):派活送话与盯窗读回话后面都是**一条引擎**
   * (窗口那条通道骑在这一份假壳上)。`helperCalls` 照旧记着发给壳的每一条 req。
   */
  const engine = engineHarness({ helper: { connected: () => true, supports: () => true, request } })
  // 2026-10-29 入口归一:/butler/item 进理解中枢 —— 假模型按「说:「…」」里的原话回命令(点名 → dispatch)。
  const model = fakeHubModel(opts.answers ?? {})
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({}),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    tasks,
    model: model.service as never,
    fetchImpl: model.fetchImpl,
    ...(approvals === undefined ? {} : { approvals }),
    ...(rules === undefined ? {} : { rules }),
    engine: engine.engine,
    engineRegistry: engine.registry,
    helper: {
      attach: () => {},
      view: () => ({ connected: true, authorized: true }) as never,
      connected: () => true,
      onChange: () => {},
      onEvent: () => {},
      request,
    },
    // 「那家在跑」:lsappinfo 那一问回一个 pid(假的,一个进程都不起)。
    runCommand: async () => ({ ok: true, stdout: '"pid"=123' }),
    // 「那家装了」:一律当装着(不看这台机器的 /Applications —— 维护者卸了 Manus 这几条就红过,用例得与机器无关)。
    appInstalled: () => true,
  })
  started.push(server)
  return { server, url: server.url, tasks, helperCalls, approvals, rules }
}

async function waitFor<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  let value = await read()
  for (let i = 0; i < 100 && !ok(value); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 20))
    value = await read()
  }
  return value
}

describe('POST /butler/item 点了名', () => {
  /**
   * ★ 2026-10-29 入口归一(E#3):点名即直接派 —— 「先问我」档 named 派活先挂「派给 X(剩…)」审批
   * 那一问已随旧路删除(原审批两条用例随之删除):模型出点名 dispatch → 工作台当场直接派。
   */
  it('★电话里来的(source:call)→ 直接派:新对话里送话并按发送,卡「进行中」,回执里一句 dispatch_note', async () => {
    const said = '[派活测试] 一年有几个季节?'
    const { url, tasks, helperCalls } = await serve({
      approvals: true,
      answers: { [said]: [{ name: 'dispatch', new: { title: said }, to: 'kimi', text: said }] },
    })
    const created = await post(url, '/butler/item', { text: said, assignee: 'kimi', source: 'call' })
    expect(created.status).toBe(200)
    expect(created.body).toMatchObject({ ok: true, dispatch_ok: true })
    expect(String(created.body.dispatch_note)).toContain('Kimi')
    // 先写派活记录、再挪状态:等到两样都落定再看(负载高时两步之间有空隙)。
    const task = await waitFor(async () => (await tasks.list()).tasks[0], one => one?.client_dispatch !== undefined && one.status === 'doing')
    expect(task?.status).toBe('doing')
    expect(task?.client_dispatch).toMatchObject({ family: 'kimi', reply_state: 'waiting', submitted: true })
    const send = helperCalls.find(one => one.op === 'send_text')
    expect(send).toMatchObject({ op: 'send_text', bundle_id: 'com.moonshot.kimichat', submit: true, new_conversation: true })
    expect(task?.conversation).toBeUndefined()
  })
})

describe('他的规矩(卡 K)也管工作台自己派出去的活', () => {
  it('★做界面的活:送进窗口的那段话末尾带「这件活要守的规矩」(有「不要蓝」)', async () => {
    const said = '[派活测试] 让 Codex 做一个登录按钮的小网页,放在 /tmp/x 里'
    const { url, helperCalls, rules } = await serve({
      rules: true,
      answers: { [said]: [{ name: 'dispatch', new: { title: said }, to: 'codex', text: said }] },
    })
    await rules?.importFromMemory()
    await post(url, '/butler/item', { text: said, assignee: 'codex', source: 'call' })
    const send = await waitFor(async () => helperCalls.find(one => one.op === 'send_text') as { text?: string } | undefined, one => one !== undefined)
    expect(send?.text?.startsWith('【工作台派活 ')).toBe(true)
    expect(send?.text).toContain('【他的规矩:这件活要守的')
    expect(send?.text).toContain('不要蓝')
  })
})

describe('POST /dispatch/run', () => {
  it('app 认不出 → 400;卡不存在 → 404', async () => {
    const { url, tasks } = await serve()
    const created = await tasks.create({ title: 'x', direction: 'mine', status: 'todo' })
    expect((await post(url, '/dispatch/run', { item_id: created.id, app: 'gemini' })).status).toBe(400)
    expect((await post(url, '/dispatch/run', { item_id: 'nope', app: 'kimi' })).status).toBe(404)
  })

  it('★对一张已经建好的卡派活:用卡上那句原话,回包里是哪只手 + 给人念的那一句', async () => {
    const { url, tasks, helperCalls } = await serve()
    const created = await tasks.create({ title: '[派活测试] 中秋节是几月几日', direction: 'mine', status: 'todo' })
    const r = await post(url, '/dispatch/run', { item_id: created.id, app: 'doubao' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, hand: 'window' })
    const send = helperCalls.find(one => one.op === 'send_text') as { text?: string, bundle_id?: string }
    expect(send.bundle_id).toBe('com.bot.pc.doubao')
    expect(send.text).toContain('[派活测试] 中秋节是几月几日')
  })

  it('★进程内的 dispatchItem 露在服务对象上(卡 B 落地派第一件用)', async () => {
    const { server, tasks } = await serve()
    expect(typeof server.dispatchItem).toBe('function')
    const created = await tasks.create({ title: 'x', direction: 'mine', status: 'todo' })
    const r = await server.dispatchItem?.(created.id as string, { family: 'claude', text: '[派活测试] 看一眼' })
    expect(r).toMatchObject({ ok: true, hand: 'window' })
  })
})

describe('POST /dispatch/run 带技能(卡 S)', () => {
  it('★窗口与接口那几家收到 skills:当场 400、说清读不了技能目录,一个字都不送、卡不动', async () => {
    const { url, tasks, helperCalls } = await serve()
    const created = await tasks.create({ title: '把 X 项目做一份研究简报', direction: 'mine', status: 'todo' })
    let refused = 0
    for (const app of ['doubao', 'gpt', 'manus']) {
      const r = await post(url, '/dispatch/run', { item_id: created.id, app, skills: ['huashu-report'] })
      if (r.status === 400 && String(r.body.error).startsWith('app 要是')) continue // 这台没接上这一家,前一道门已拦
      expect(r.status).toBe(400)
      expect(r.body.error).toContain('读不了技能目录')
      refused += 1
    }
    expect(refused).toBeGreaterThanOrEqual(2)
    expect(helperCalls.filter(one => one.op === 'send_text')).toEqual([])
    expect((await tasks.list()).tasks[0]?.status).toBe('todo')
  })

  it('不认得的技能 / 不是数组 / 带技能却说是聊天的活 → 400', async () => {
    const { url, tasks } = await serve()
    const created = await tasks.create({ title: 'x', direction: 'mine', status: 'todo' })
    const unknown = await post(url, '/dispatch/run', { item_id: created.id, app: 'claude', skills: ['huashu-mac-use'] })
    expect(unknown.status).toBe(400)
    expect(unknown.body.error).toContain('huashu-mac-use')
    expect((await post(url, '/dispatch/run', { item_id: created.id, app: 'claude', skills: 'huashu-report' })).status).toBe(400)
    expect((await post(url, '/dispatch/run', { item_id: created.id, app: 'claude', skills: ['huashu-report'], kind: 'chat' })).status).toBe(400)
  })

  it('Claude 带技能:按改文件那一类走,不进聊天窗(这张卡没挂项目 → 如实说不知道在哪个仓库里改)', async () => {
    const { url, tasks, helperCalls } = await serve()
    const created = await tasks.create({ title: '把 X 项目做一份研究简报', direction: 'mine', status: 'todo' })
    const r = await post(url, '/dispatch/run', { item_id: created.id, app: 'claude', skills: ['huashu-report'] })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(false)
    expect(helperCalls.filter(one => one.op === 'send_text')).toEqual([])
    expect(r.body.block?.kind).toBe('code')
  })

  it('不带 skills / 空表:跟以前一字不变(窗口照派)', async () => {
    const { url, tasks } = await serve()
    const created = await tasks.create({ title: '[派活测试] 中秋节是几月几日', direction: 'mine', status: 'todo' })
    const r = await post(url, '/dispatch/run', { item_id: created.id, app: 'doubao', skills: [] })
    expect(r.body).toMatchObject({ ok: true, hand: 'window' })
  })

  it('GET /dispatch/choices?skills=:按改文件那一类,读不了技能的家标成不能派(Kimi 2026-10-22 起在能读的那几家之列)', async () => {
    const { url, tasks } = await serve()
    const created = await tasks.create({ title: '把 X 项目做一份研究简报', direction: 'mine', status: 'todo' })
    const view = await (await fetch(`${url}/dispatch/choices?item=${String(created.id)}&skills=huashu-report`)).json() as { kind: string, options: { family: string, ok: boolean }[] }
    expect(view.kind).toBe('code')
    for (const option of view.options) {
      if (['claude', 'codex', 'kimi'].includes(option.family)) expect(option.ok).toBe(true)
      else expect(option.ok).toBe(false)
    }
    expect((await fetch(`${url}/dispatch/choices?item=${String(created.id)}&skills=nope`)).status).toBe(400)
  })
})
