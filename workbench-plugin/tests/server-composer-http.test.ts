// @vitest-environment node
/**
 * 统一输入框的 HTTP 口(2026-09-24):/composer/options、/composer/choice、/composer/upload、
 * /butler/item 的新字段、「只出方案」那档的派活门、/approvals/answer 与 /state.approvals。
 *
 * ★ 2026-10-29 入口归一改写:/butler/item 一律进理解中枢(假模型按原话回命令),
 * 会话不再随建卡自开 —— 附件 / 引用 / @点名 / 档位作为**事实**进上下文包
 * (提示词里【这条请求附带的事实】块);「卡上记档与附件」「第一条消息拼路径」一类
 * 旧断言随旧路删除,改为断言 facts 块 + 卡照建(中枢 note)。档位仍是 composer 的粘性默认。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ComposerOptionsView, WorkbenchState } from '../src/protocol.ts'
import type { ButlerOpenExtras } from '../src/server/butlerItem.ts'
import { createApprovalBroker, createComposerService, PLAN_ONLY_DISPATCH_ERROR } from '../src/server/composer.ts'
import type { ModelCatalogLike } from '../src/server/composer.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { fakeHubModel } from './helpers/fakeHubModel.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const CATALOG: ModelCatalogLike = {
  default: { provider: 'workbench-relay', model: 'deepseek-v4-flash' },
  routableProviders: ['workbench-relay'],
  groups: [{ id: 'workbench-relay', name: '工作台', models: [{ id: 'deepseek-v4-flash', name: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro' }] }],
  failures: [],
}

async function serve(answers: Parameters<typeof fakeHubModel>[0] = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-composer-http-'))
  dirs.push(dir)
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), newId: () => `t-${++n}` })
  const composer = createComposerService({ choiceFile: join(dir, 'composer.json'), inboxDir: join(dir, 'in'), clis: () => new Set(['codex']) })
  const approvals = createApprovalBroker()
  const opened: { first: string, extras?: ButlerOpenExtras }[] = []
  const model = fakeHubModel(answers)
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService(),
    tickIntervalMs: 0,
    tasks,
    composer,
    approvals,
    butlerSession: {
      open: async (first, extras) => {
        opened.push({ first, ...(extras === undefined ? {} : { extras }) })
        return `sess-${opened.length}`
      },
      catalog: async () => CATALOG,
    },
    model: model.service as never,
    fetchImpl: model.fetchImpl,
  })
  started.push(server)
  return { url: server.url, tasks, composer, approvals, opened, inbox: join(dir, 'in'), model }
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

/**
 * 「他在页面上点的那一下」(2026-09-28,卡 BS)。「等你确认」那几个口现在只认她本人:
 * 页面 / 壳有浏览器痕迹、配对设备有设备令牌、电话工人有进程令牌;不带身份的程序调用 403。
 * 专钉这道门的用例在 `tests/server-herself-gate.test.ts`。
 */
async function herPost(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3080' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, any> }
}

async function upload(url: string, name: string, bytes: string, type = 'application/octet-stream') {
  const res = await fetch(`${url}/composer/upload?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'content-type': type }, body: Buffer.from(bytes) })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

describe('GET /composer/options', () => {
  it('一份数据:候选(含本机命令行那家)、三档、模型表、当前选择', async () => {
    const { url } = await serve()
    const res = await fetch(`${url}/composer/options`)
    expect(res.status).toBe(200)
    const body = await res.json() as ComposerOptionsView
    expect(body.agents.map(one => one.family)).toEqual(['dsh', 'codex'])
    expect(body.modes.map(one => one.id)).toEqual(['plan', 'ask', 'auto'])
    expect(body.mode).toBe('ask')
    expect(body.models.map(one => `${one.id}:${one.images}`)).toEqual(['deepseek-v4-flash:true', 'deepseek-v4-pro:false'])
    expect(body.model).toEqual({ provider: 'workbench-relay', id: 'deepseek-v4-flash' })
  })

  it('没接输入框服务 → 404', async () => {
    const server = await startWorkbenchServer({ port: 0, service: createWorkbenchService(), tickIntervalMs: 0 })
    started.push(server)
    expect((await fetch(`${server.url}/composer/options`)).status).toBe(404)
  })
})

describe('POST /composer/choice', () => {
  it('换档与换模型记成默认;「全权」不收', async () => {
    const { url, composer } = await serve()
    expect((await post(url, '/composer/choice', { mode: 'danger-full-access' })).status).toBe(400)
    const ok = await post(url, '/composer/choice', { mode: 'auto', model: { provider: 'workbench-relay', id: 'deepseek-v4-pro' } })
    expect(ok.status).toBe(200)
    expect(await composer.choice()).toEqual({ mode: 'auto', model: { provider: 'workbench-relay', id: 'deepseek-v4-pro' } })
  })
})

describe('POST /butler/item 的新字段', () => {
  it('图片 + 能看图的模型 → 附件路径、模式、引用都进中枢的事实块;卡照建;档记成默认', async () => {
    const { url, tasks, composer, inbox, model } = await serve({
      '这个页面改一下': [{ name: 'note', title: '这个页面改一下', status: 'todo' }],
      '照这张图改': [{ name: 'note', title: '照这张图改', status: 'todo' }],
    })
    const up = await upload(url, '截图.png', 'PNGDATA', 'image/png')
    expect(up.body).toMatchObject({ ok: true, id: '截图.png', image: true })
    const first = await post(url, '/butler/item', { text: '这个页面改一下' })
    const created = await post(url, '/butler/item', {
      text: '照这张图改',
      attachments: [{ id: '截图.png' }],
      mode: 'auto',
      refs: [{ kind: 'item', id: first.body.id as string }],
    })
    expect(created.status).toBe(200)
    // 入口归一:附件(解析后的路径)、引用都作为事实进上下文包,原话一字未改。
    const prompt = model.seen.prompts.at(-1) ?? ''
    expect(prompt).toContain('【这条请求附带的事实】')
    expect(prompt).toContain(join(inbox, '截图.png'))
    expect(prompt).toContain('事项「这个页面改一下」')
    expect(prompt).toContain('说:「照这张图改」')
    // 卡照建(中枢 note);会话不再随建卡自开。
    const task = (await tasks.list()).tasks.find(one => one.title === '照这张图改')
    expect(task).toBeDefined()
    // 档仍是 composer 的粘性默认(这次选了「自动办」,记成默认)。
    expect((await composer.choice()).mode).toBe('auto')
  })

  it('选了看不了图的模型 → 附件照样只走路径(事实块),选择记成默认', async () => {
    const { url, composer, inbox, model } = await serve({
      '看看': [{ name: 'note', title: '看看', status: 'todo' }],
    })
    await upload(url, 'a.png', 'x', 'image/png')
    await post(url, '/butler/item', { text: '看看', attachments: ['a.png'], model: { provider: 'workbench-relay', id: 'deepseek-v4-pro' } })
    const prompt = model.seen.prompts.at(-1) ?? ''
    // 入口归一后附件一律以路径作事实进包(不再有「图直接进第一条消息」那条路)。
    expect(prompt).toContain('【这条请求附带的事实】')
    expect(prompt).toContain(join(inbox, 'a.png'))
    expect((await composer.choice()).model).toEqual({ provider: 'workbench-relay', id: 'deepseek-v4-pro' })
  })

  it('只贴了附件、一个字没打 → 话就是「附件:<名字>」,中枢照建卡、标题不另编', async () => {
    const { url, tasks } = await serve({
      '附件:需求.pdf': [{ name: 'note', title: '附件:需求.pdf', status: 'todo' }],
    })
    await upload(url, '需求.pdf', '%PDF')
    const created = await post(url, '/butler/item', { text: '', attachments: ['需求.pdf'] })
    expect(created.status).toBe(200)
    expect((await tasks.list()).tasks[0]?.title).toBe('附件:需求.pdf')
  })

  it('附件找不到 → 整条不建', async () => {
    const { url, tasks } = await serve()
    const created = await post(url, '/butler/item', { text: '看这个', attachments: ['没有.png'] })
    expect(created.status).toBe(400)
    expect(created.body.error).toContain('没有.png')
    expect((await tasks.list()).tasks).toHaveLength(0)
  }, 10_000)

  it('什么都没带 → 用上次选的档(默认先问我);会话不再随建卡自开', async () => {
    const { url, opened, tasks } = await serve({
      '随便一件': [{ name: 'note', title: '随便一件', status: 'todo' }],
    })
    const created = await post(url, '/butler/item', { text: '随便一件' })
    expect(created.status).toBe(200)
    // 粘性档仍是 composer 的(默认「先问我」);入口归一后不开 DSH 会话。
    expect(opened).toHaveLength(0)
    expect((await tasks.list()).tasks.map(one => one.title)).toContain('随便一件')
  })
})

describe('「只出方案」那档不派活', () => {
  it('/butler/item 带 mode=plan、或粘性档是 plan:一律 409,口径与派活口同一句', async () => {
    const { url } = await serve({
      '想想怎么做导出': [{ name: 'note', title: '想想怎么做导出', status: 'todo' }],
    })
    const byBody = await post(url, '/butler/item', { text: '想想怎么做导出', mode: 'plan' })
    expect(byBody.status).toBe(409)
    expect(byBody.body.error).toBe(PLAN_ONLY_DISPATCH_ERROR)
    // 粘性档 plan:请求体不带 mode 同样挡(建卡前置都没有,一张卡不留)。
    await post(url, '/composer/choice', { mode: 'plan' })
    const bySticky = await post(url, '/butler/item', { text: '想想怎么做导出' })
    expect(bySticky.status).toBe(409)
    expect(bySticky.body.error).toBe(PLAN_ONLY_DISPATCH_ERROR)
  })
})

describe('审批', () => {
  it('挂上 → /state.approvals 看得见(配上卡)→ POST /approvals/answer 允许 → 回 allowed-once', async () => {
    const { url, tasks, approvals } = await serve()
    // 2026-10-29 入口归一:会话不随建卡自开 —— 这张卡直接带会话建(审批按「会话 → 事项」配卡)。
    const made = await tasks.create({ title: '改一下 hosts', direction: 'mine', conversation: { agent: 'dsh', session_id: 'sess-1' } })
    const asked = approvals.ask({ sessionId: 'sess-1', tool: 'bash', reason: '要写 /etc/hosts' })
    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(state.approvals).toEqual([expect.objectContaining({ id: asked.id, task_id: made.id, task_title: '改一下 hosts', tool: 'bash' })])
    const answered = await herPost(url, '/approvals/answer', { id: asked.id, allow: true })
    expect(answered.status).toBe(200)
    expect(await asked.answer).toBe('allowed-once')
    expect((await herPost(url, '/approvals/answer', { id: asked.id, allow: false })).status).toBe(409)
  })
})
