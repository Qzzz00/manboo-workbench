// @vitest-environment node
/**
 * 可靠执行闭环第一批 · 第 2 步「所有入口进入同一委托处理」(docs/计划-1029-可靠执行闭环第一批.md;
 * = 删规矩第一批「入口归一」任务书验收①–⑧,表驱动)。
 *
 * 每个用例 = 一句原话 + 入口身份 + 假模型回的命令 + 期望行为。身份只按受信来源定(工人令牌 /
 * 配对设备 / 回环页面),**不依赖 body 自报**;附件 / @点名作为事实进上下文包(request_facts);
 * 四种委托语义(记 / 只出方案 / 改用户层那格 / 先问我)各自到位,不被推进为开工;
 * 点名即直接派(E#3 的「派给 X(剩…)」审批已删);plan 档 409;待办有负责人 ≠ 开工(E#2)。
 * ⑧(删掉的函数没有引用)由 tsc 全绿 + 末尾的源码缺席断言一起钉。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ACTOR_TOKEN_HEADER, mintActorTokens } from '../src/server/herself.ts'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import type { ApiDispatchInput } from '../src/server/dispatchApi.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { PLAN_ONLY_DISPATCH_ERROR } from '../src/server/composer.ts'
import { engineHarness } from './helpers/engineHarness.ts'

const NOW_SEC = Math.floor(Date.parse('2026-10-29T10:00:00+08:00') / 1000)
const SRC = dirname(dirname(fileURLToPath(import.meta.url)))

const servers: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (servers.length) await servers.pop()!.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

interface Seen {
  /** 假模型看到的提示词(逐字)。 */
  prompts: string[]
  /** 假壳收到的请求(窗口/协议手)。 */
  helperCalls: HelperRequest[]
  /** API 手收到的派活。 */
  apiCalls: ApiDispatchInput[]
  /** 用户层守门 beginFixGuard 收到的 itemId。 */
  fixGuards: string[]
}

/** 假模型:按「她说」里的原话查表回命令(值可以是函数,拿整条提示词——答挂着的那一问要用 ask_id)。 */
function modelOf(seen: Seen, answers: Record<string, Record<string, unknown>[] | ((body: string) => Record<string, unknown>[] | undefined)>) {
  return {
    endpoint: async () => ({ baseUrl: 'http://x/v1', key: 'k', model: 'm', ready: true }),
    fetchImpl: (async (_url: unknown, init?: { body?: unknown }) => {
      const body = String(init?.body ?? '')
      seen.prompts.push(body)
      const said = body.split('说:「').at(-1)?.split('」').at(0) ?? ''
      const hit = answers[said]
      const commands = typeof hit === 'function' ? hit(body) : hit
      if (commands === undefined) return new Response('qa-unreachable', { status: 503 })
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ commands }) } }] }), { status: 200 })
    }) as never,
  }
}

interface ServeOpts {
  answers: Record<string, Record<string, unknown>[] | ((body: string) => Record<string, unknown>[] | undefined)>
  /** 配对手机(带设备令牌的头 → phone 入口)。 */
  phone?: boolean
  /** 起负责人驱动(给 driveFile)。 */
  drive?: boolean
  /** 统一输入框替身(附件解析 / 档位);mode 为粘性档。 */
  composer?: { mode?: string, attachments?: Record<string, string> }
  /** 用户层替身(改格子那一支)。 */
  userLayer?: boolean
}

async function serve(opts: ServeOpts) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-entrances-'))
  dirs.push(dir)
  const seen: Seen = { prompts: [], helperCalls: [], apiCalls: [], fixGuards: [] }
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${String(++n).padStart(8, '0')}` })
  const tokens = mintActorTokens()
  const phone = { id: 'fixture-phone', kind: 'phone', name: 'fixture phone' }
  const request = async (req: HelperRequest): Promise<Record<string, unknown>> => {
    seen.helperCalls.push(req)
    return { found: false, busy: false }
  }
  const h = engineHarness({
    helper: { connected: () => true, supports: () => true, request },
    // 窗口一个都不「装着」→ 落到 API 手,派没派看得见。
    installed: () => [],
    api: { send: async input => { seen.apiCalls.push(input); return { ok: true, reply: '受控回包', dispatch: { family: input.family, hand: 'api', status: 'done', started_at: 'x' } } } },
  })
  const model = modelOf(seen, opts.answers)
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    tasks,
    actorTokens: tokens,
    engine: h.engine,
    engineRegistry: h.registry,
    helper: { attach: () => {}, view: () => ({ connected: true, authorized: true }) as never, connected: () => true, onChange: () => {}, onEvent: () => {}, request },
    fileWorkDir: join(dir, 'files'),
    runCommand: async () => ({ ok: true, stdout: '"pid"=123' }),
    appInstalled: () => true,
    model: { endpoint: model.endpoint } as never,
    fetchImpl: model.fetchImpl,
    ...(opts.phone ? { pairing: { list: async () => [phone], touch: async (id: string) => id === phone.id ? phone : undefined } as never } : {}),
    ...(opts.drive ? { items: { driveFile: join(dir, 'drive.json') } as never } : {}),
    ...(opts.composer !== undefined ? {
      composer: {
        choice: async () => ({ mode: opts.composer?.mode ?? 'ask', model: { provider: 'workbench-own', id: 'qa' } }),
        resolve: async (ids: readonly string[]) => ({
          found: ids.map(id => ({ id, path: opts.composer?.attachments?.[id] ?? `/tmp/${id}.png`, size: 1, taken_at: undefined, name: id })),
          missing: [],
        }),
        saveChoice: async () => {},
      } as never,
    } : {}),
    ...(opts.userLayer ? {
      userLayer: {
        dir: join(dir, '用户层'),
        webWidgetsDir: join(dir, '用户层/web'),
        scan: async () => ({ widgets: [{ id: 'widget-publish', name: '发布计划', status: 'ok', replaces: 'publish' }], dir: join(dir, '用户层') }),
        ensure: async () => ({ ok: true, movedLegacyModules: false }),
        beginFixGuard: async (itemId: string) => { seen.fixGuards.push(itemId); return { ok: true } },
      } as never,
    } : {}),
  })
  servers.push(server)
  async function say(body: Record<string, unknown>, actor?: 'worker', phoneDevice = false) {
    const headers: Record<string, string> = { 'content-type': 'application/json', origin: server.url }
    if (actor === 'worker') headers[ACTOR_TOKEN_HEADER] = tokens.worker
    if (phoneDevice) headers['x-workbench-channel-device'] = phone.id
    const res = await fetch(`${server.url}/butler/say`, { method: 'POST', headers, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
  }
  async function item(body: Record<string, unknown>, actor?: 'worker', phoneDevice = false) {
    const headers: Record<string, string> = { 'content-type': 'application/json', origin: server.url }
    if (actor === 'worker') headers[ACTOR_TOKEN_HEADER] = tokens.worker
    if (phoneDevice) headers['x-workbench-channel-device'] = phone.id
    const res = await fetch(`${server.url}/butler/item`, { method: 'POST', headers, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
  }
  // 2026-10-29 第 4 步起交回后核验/提取默认条件也走模型(异步):「最后一条提示」会随后续核验翻动,
  // 这里要的是中枢那一条 —— 倒序找最近一条理解中枢提示,与核验异步与否无关。
  const lastPrompt = (): string => [...seen.prompts].reverse().find(one => one.includes('理解中枢')) ?? ''
  return { server, tasks, seen, say, item, lastPrompt }
}

const DISPATCH_SAY = '让小G把发布页那行字改一下'
const DISPATCH_COMMANDS = [{ name: 'dispatch', new: { title: '改发布页那行字' }, to: 'doubao', text: '让小G把发布页那行字改一下' }]

describe('① 各入口同一执行意图;身份不依赖 body 自报', () => {
  const cases = [
    { name: 'desktop 对话框 /butler/say', run: (h: Awaited<ReturnType<typeof serve>>) => h.say({ text: DISPATCH_SAY, entrance: 'desktop' }), want: 'desktop' },
    { name: '/butler/say 不带 entrance(老包)', run: (h: Awaited<ReturnType<typeof serve>>) => h.say({ text: DISPATCH_SAY }), want: 'desktop' },
    { name: '配对手机 /butler/item', run: (h: Awaited<ReturnType<typeof serve>>) => h.item({ text: DISPATCH_SAY }, undefined, true), want: 'phone' },
    { name: '电话工人 /butler/item(工人令牌)', run: (h: Awaited<ReturnType<typeof serve>>) => h.item({ text: DISPATCH_SAY }, 'worker'), want: 'call' },
  ] as const
  for (const one of cases) {
    it(`${one.name} → 同一意图,照样派出去`, async () => {
      const h = await serve({ answers: { [DISPATCH_SAY]: DISPATCH_COMMANDS }, phone: true })
      const out = await one.run(h)
      if (process.env.QA_DEBUG === '1') console.log('QA out=', out.status, JSON.stringify(out.body).slice(0, 300))
      expect(out.status).toBe(200)
      // 上下文包按真实身份写入口(模型读的提示里看得见)。
      expect(h.lastPrompt()).toContain(`她在 ${one.want} 说`)
      // 同一执行意图:中枢 dispatch 照办,卡建了、派给点名的那家。
      expect((await h.tasks.list()).tasks.map(t => t.title)).toEqual(['改发布页那行字'])
      expect(h.seen.apiCalls.length + h.seen.helperCalls.filter(c => c.op === 'send_text').length).toBeGreaterThan(0)
    })
  }

  it('body 自报不算数:普通页面自报 source/entrance=call 仍是 desktop;工人令牌自报 desktop 仍是 call', async () => {
    const answers = { [DISPATCH_SAY]: DISPATCH_COMMANDS }
    const plain = await serve({ answers })
    await plain.item({ text: DISPATCH_SAY, source: 'call', entrance: 'call' })
    expect(plain.lastPrompt()).toContain('她在 desktop 说')
    const worker = await serve({ answers })
    await worker.item({ text: DISPATCH_SAY, entrance: 'desktop' }, 'worker')
    expect(worker.lastPrompt()).toContain('她在 call 说')
  })

  it('带附件与 @点名作为事实进上下文包,不改管线', async () => {
    const said = '看下这张图里写的数'
    const h = await serve({
      answers: { [said]: [{ name: 'note', title: '看图写数', status: 'todo' }] },
      composer: { attachments: { 'att-1': '/tmp/截图.png' } },
    })
    const out = await h.item({ text: said, attachments: [{ id: 'att-1' }], assignee: 'doubao' })
    expect(out.status).toBe(200)
    // 附件路径与她点的名都在事实块里;原话一字未改。
    expect(h.lastPrompt()).toContain('/tmp/截图.png')
    expect(h.lastPrompt()).toContain('这条请求附带的事实')
    expect(h.lastPrompt()).toContain('点了名「doubao」')
    expect(h.lastPrompt()).toContain(`说:「${said}」`)
  })
})

describe('② 四种委托语义各自正确(前三种与「先问我」都不被推进为开工)', () => {
  it('「记下来以后做」= 只记:卡落「待办」,一家不派', async () => {
    const said = '记下来,下周五前把报价发给客户'
    const h = await serve({ answers: { [said]: [{ name: 'note', title: '下周五前把报价发给客户', status: 'todo' }] } })
    const out = await h.say({ text: said, entrance: 'desktop' })
    expect(out.status).toBe(200)
    const card = (await h.tasks.list()).tasks[0]
    expect(card).toMatchObject({ title: '下周五前把报价发给客户', status: 'todo' })
    expect(card?.assignee).toBeUndefined()
    expect(h.seen.apiCalls).toHaveLength(0)
  })

  it('「改这格」= user_layer_fix:派去改用户层那一格(守门照记),不是反馈', async () => {
    const said = '把用户层里随手记那一格的提示语改一下'
    const h = await serve({
      answers: { [said]: [{ name: 'user_layer_fix', said, widget: 'widget-publish' }] },
      userLayer: true,
    })
    const out = await h.item({ text: said })
    expect(out.status).toBe(200)
    // user_layer_fix 的手跑了:卡照建(不是反馈、不是新事项);「改用户层那一格」那句回话在。
    expect((await h.tasks.list()).tasks).toHaveLength(1)
    expect(String(out.body.note ?? '')).toContain('用户层')
    expect(String(out.body.note ?? '')).not.toContain('反馈')
  })

  it('「执行前先问我」= 派前问一次:挂着问、一家不派;她点头才派', async () => {
    const said = '让小G把发布页那行字改一下,执行前先问我'
    const h = await serve({
      answers: {
        [said]: [{ name: 'ask', question: '这件派给小G开工?', options: ['派吧', '先别'] }],
        // 答挂着的那一问:ask_id 照抄上下文包【挂着等她答的问】那一行。
        '派吧': body => {
          const askId = /挂着等她答的问[\s\S]*?-\s+([0-9a-f-]{8,}):/.exec(body)?.[1]
          if (process.env.QA_DEBUG === '1') console.log('QA askId=', askId)
          return askId === undefined ? undefined : [{ name: 'confirm', ask_id: askId, choice: '派吧' }]
        },
        // confirm 命中后,她选的那句作为新的一句带问句回给模型 → 出点名 dispatch 照办。
        // (提取按第一个」截尾,键不带闭括号。)
        '派吧(答「这件派给小G开工?': [{ name: 'dispatch', new: { title: '改发布页那行字' }, to: 'doubao', text: '派吧' }],
      },
    })
    const first = await h.say({ text: said, entrance: 'desktop' })
    expect(first.status).toBe(200)
    // 派前问一次:一家不派、一张卡不建;问句在回话里(模型自己的问,形状是结果里的 ask,不是护栏问的那颗键)。
    expect(h.seen.apiCalls).toHaveLength(0)
    expect((await h.tasks.list()).tasks).toHaveLength(0)
    const results = (first.body.hub as { results?: { command: string, ask?: { question: string } }[] }).results ?? []
    expect(results.some(one => one.command === 'ask' && one.ask?.question.includes('派给小G开工'))).toBe(true)
    // 她答「派吧」→ confirm 那一问(ask_id 从上下文包里挂着问那一节抄)→ 照办。
    const second = await h.say({ text: '派吧', entrance: 'desktop' })
    expect(second.status).toBe(200)
    expect(h.seen.apiCalls.length + h.seen.helperCalls.filter(c => c.op === 'send_text').length).toBeGreaterThan(0)
  })

  it('「只出方案」= plan 档 409:不派(与⑦同一条门)', async () => {
    const h = await serve({ answers: { [DISPATCH_SAY]: DISPATCH_COMMANDS }, composer: { mode: 'plan' } })
    const out = await h.item({ text: DISPATCH_SAY })
    expect(out.status).toBe(409)
    expect(String(out.body.error)).toBe(PLAN_ONLY_DISPATCH_ERROR)
    expect(h.seen.apiCalls).toHaveLength(0)
    expect((await h.tasks.list()).tasks).toHaveLength(0)
  })
})

describe('③ 「把用户层里发布计划那一格改一下」→ user_layer_fix,不是反馈', () => {
  it('命令照办:建卡 + 守门 + 派活;反馈通道不动', async () => {
    const said = '把用户层里发布计划那一格改一下'
    const h = await serve({
      answers: { [said]: [{ name: 'user_layer_fix', said, widget: 'widget-publish' }] },
      userLayer: true,
    })
    const out = await h.item({ text: said })
    expect(out.status).toBe(200)
    // user_layer_fix 照办(卡建、回话说的是用户层那一格);不是反馈。
    expect((await h.tasks.list()).tasks).toHaveLength(1)
    expect(String(out.body.note ?? '')).toContain('用户层')
    expect(String(out.body.note ?? '')).not.toContain('反馈给开发者')
  })
})

describe('④ 「记得把合同发给客户」原话整句进中枢(不再被砍掉「记得」)', () => {
  it('模型看到的是原话;note 标题一字不差', async () => {
    const said = '记得把合同发给客户'
    const h = await serve({ answers: { [said]: [{ name: 'note', title: said, status: 'todo' }] } })
    const out = await h.say({ text: said, entrance: 'desktop' })
    expect(out.status).toBe(200)
    expect(h.lastPrompt()).toContain(`说:「${said}」`)
    const card = (await h.tasks.list()).tasks[0]
    expect(card?.title).toBe('记得把合同发给客户')
  })
})

describe('⑤ 点名即直接派:不挂「派给 X(剩…)」审批', () => {
  it('模型出点名 dispatch → 当场派,回包 dispatch_ok,没有「要你批一下」', async () => {
    const h = await serve({ answers: { [DISPATCH_SAY]: DISPATCH_COMMANDS } })
    const out = await h.item({ text: DISPATCH_SAY, assignee: 'doubao' })
    expect(out.status).toBe(200)
    expect(out.body.dispatch_ok).toBe(true)
    expect(String(out.body.dispatch_note ?? '')).not.toContain('要你批')
    expect(String(out.body.dispatch_note ?? '')).not.toContain('允许这一次')
    expect(h.seen.apiCalls.length + h.seen.helperCalls.filter(c => c.op === 'send_text').length).toBeGreaterThan(0)
    // 卡上负责人就是点名的那家。
    expect((await h.tasks.list()).tasks[0]?.assignee).toBeDefined()
  })
})

describe('⑥ 待办有负责人 ≠ 开工(E#2)', () => {
  it('只挂负责人的卡:驱动不问、不派;她在话里明说开工 → 派', async () => {
    const said = 't-00000001 那张,现在开工'
    const h = await serve({
      drive: true,
      answers: { [said]: [{ name: 'dispatch', card_id: 't-00000001', to: 'doubao', text: said }] },
    })
    const made = await h.tasks.create({ title: '积压的那件', status: 'todo', assignee: 'doubao' })
    expect(made.id).toBe('t-00000001')
    // 驱动跑过一拍:不问(没有「派给 X 开工?」)、不派。
    await new Promise(resolve => setTimeout(resolve, 1100))
    const card0 = (await h.tasks.list()).tasks[0]
    expect(card0).toMatchObject({ status: 'todo', assignee: 'doubao' })
    expect(card0?.dispatch).toBeUndefined()
    // 她说明确开工 → 中枢 dispatch 照派(她这句本身就是明确委托)。
    const out = await h.say({ text: said, entrance: 'desktop' })
    expect(out.status).toBe(200)
    const card1 = (await h.tasks.list()).tasks[0]
    expect(card1?.dispatch).toBeDefined()
  })
})

describe('⑦ plan 档 → 不派(409 不变)', () => {
  it('请求体带 mode=plan,或粘性档是 plan:一律 409,口径与派活口同一句', async () => {
    const h = await serve({ answers: { [DISPATCH_SAY]: DISPATCH_COMMANDS }, composer: { mode: 'ask' } })
    const out = await h.item({ text: DISPATCH_SAY, mode: 'plan' })
    expect(out.status).toBe(409)
    expect(String(out.body.error)).toBe(PLAN_ONLY_DISPATCH_ERROR)
    expect((await h.tasks.list()).tasks).toHaveLength(0)
  })
})

describe('⑧ 删掉的旧函数没有引用(tsc 之外再钉一层源码缺席)', () => {
  it('旧路模块与中枢前的旧函数引用一并消失', () => {
    expect(existsSync(join(SRC, 'src/server/turnIntent.ts'))).toBe(false)
    expect(existsSync(join(SRC, 'src/server/sayModel.ts'))).toBe(false)
    const http = readFileSync(join(SRC, 'src/server/http.ts'), 'utf8')
    for (const gone of ['understandSaid(', 'runSayPlan(', 'sayCompatForItem(', 'fastPath(', 'addressedFast(', 'decidePolicy(', 'carryOnTarget(', 'isProgressQuestion(', 'sameItemFor(', 'looksLikeNoteOnly(', 'explicitRuleOf(raw.text)', 'triageRequest(raw.text', 'isLayoutUndoWord(']) {
      expect(http, `旧路引用还在:${gone}`).not.toContain(gone)
    }
  })
})
