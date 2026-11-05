// @vitest-environment node
/**
 * 可靠执行闭环第一批 · 第 4 步:核验、缺证据、退修与实际交付接通
 * (任务书 `docs/交接-1029-可靠执行第一批-步骤4-核验缺证据退修与交付.md` 验收①–⑦)。
 *
 * 真机三件要收口的:
 *   - 14:03 用户层随手记交回后「没给验收条件,核不了」卡死等人 → ②缺验收从委托提取默认条件;
 *   - 13:48「按通过结掉」被听成 verify → ⑤人判通过 ≠ 再核一遍;
 *   - 退修重派被闸挡 → 卡挂 doing 无人执行(C#9)→ ④卡回 confirm、执行记录 next=recover 带 wakeAt。
 *
 * 受控替身:CLI 真起「进程」(替身)、窗口走真引擎窗口通道(假壳回 read_reply)、接口走真引擎
 * api 通道(假 send 当场回话)、事务官自办走 /task/:id/receipt;模型替身按 system 分
 * 「理解中枢 / 交回核验 / 提取验收条件」三路。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService, type TasksService } from '../src/server/tasks.ts'
import { createExecutionLeaseStore } from '../src/server/executionLease.ts'
import { createUserLayerService, type UserLayerService } from '../src/server/userLayer.ts'
import { createCliAdapter } from '../src/server/engine/adapters/cli.ts'
import { createApiAdapter } from '../src/server/engine/adapters/api.ts'
import type { ArtifactCheckDeps } from '../src/server/dispatchVerify.ts'
import { engineHarness } from './helpers/engineHarness.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const PAGE = { origin: 'http://127.0.0.1:3080' }
const ACCEPTANCE = ['首行写成「工作台验收」']
const RECEIPT = '做完了:首行写成「工作台验收」。'

interface ServeOptions {
  /** 交回核验那一路模型:pass = 逐条过;fail = 逐条不过;down = 模型不在场;
   *  down-then-pass = 第一拍不在场(卡留「等你确认」),之后逐条过(「核一遍」那一档)。 */
  verify?: 'pass' | 'fail' | 'down' | 'down-then-pass'
  /** 提取验收条件那一路模型回的默认条件(缺席 = 模型不在场)。 */
  extract?: string[]
  /** 理解中枢那一路:她说的一句 → 命令清单。 */
  hubAnswers?: Record<string, Record<string, unknown>[]>
  /** 第二次起的命令行派发(resolveCli 报「没登录」)= 退修重派被挡。 */
  blockRedispatch?: boolean
  /** 窗口壳 send_text 这一下回错(换手也别家都派不出去的那一档)。 */
  blockWindow?: boolean
  /** 代跑的替身(缺省真 git/spawn;给了就整套换掉)。 */
  artifacts?: ArtifactCheckDeps
  /** 核验/恢复重试的间隔(用例调小)。 */
  retryMs?: number
  /** 用户层:配一格「素材管理」小组件;fix='good' 改好代码,'bad' 改坏清单。 */
  userLayer?: { fix: 'good' | 'bad' }
  /** 中转配了哪些家(接口那只手出现的前提;GPT 测试用)。 */
  relay?: boolean
  /** 复用上一个服务的目录与任务文件(重启接续那一档)。 */
  reuseHome?: string
}

interface Harness {
  url: string
  tasks: TasksService
  server: WorkbenchServer
  userLayer?: UserLayerService
  home: string
  verifyCalls: () => number
  readme: () => string
  setReadme: (text: string) => void
  projectId: () => Promise<string>
}

/** 四只手都经真引擎/真派发口,模型替身分三路;与生产同一装配。 */
async function serve(opts: ServeOptions = {}): Promise<Harness> {
  const home = opts.reuseHome ?? mkdtempSync(join(tmpdir(), 'wb-delivery-'))
  if (opts.reuseHome === undefined) dirs.push(home)
  let n = 0
  const tasks = createTasksService({ file: join(home, 'tasks.json'), now: () => Math.floor(Date.now() / 1000), newId: () => `t-${++n}` })
  let readme = '# 验收项目\n\n原始。\n'
  const projectDir = mkdtempSync(join(tmpdir(), 'wb-delivery-repo-'))
  dirs.push(projectDir)
  let verifyCalls = 0
  let cliReturned = false
  let pid = 60000

  // 假壳:send_text 记下记号;read_reply 立刻「读回」那句回话(尾巴是界面字,剥掉)。
  let windowBlocked = false
  const helper = {
    connected: () => true,
    supports: () => true,
    request: async (req: HelperRequest): Promise<Record<string, unknown>> => {
      if (req.op === 'send_text') {
        if (opts.blockRedispatch === true && windowBlocked) return { error: '没登录' }
        return { method: 'paste', submitted: true, submit_method: 'send_button', new_conversation: '新聊天' }
      }
      if (req.op === 'read_reply') {
        const marker = String((req as { marker?: string }).marker ?? '')
        return { found: true, busy: false, texts: [`【${marker}】一年有几个季节?`, RECEIPT, '复制'] }
      }
      return { found: false, busy: false }
    },
  }
  const engine = engineHarness({ helper })
  const request = async (req: HelperRequest): Promise<Record<string, unknown>> =>
    req.op === 'send_text' ? { method: 'ax_value', submitted: true, new_conversation: 'x' } : { found: false, busy: false }

  // 命令行手(Kimi):第一次真「起跑」写回执;blockRedispatch 时,首跑之后再 resolve 报没登录。
  const runCli = (cmd: { argv: readonly string[], cwd: string, logFile: string }) => {
    if (opts.userLayer !== undefined) {
      const widgetDir = join(cmd.cwd, '小组件', 'files')
      if (opts.userLayer.fix === 'bad') writeFileSync(join(widgetDir, 'widget.json'), '{ 坏清单', 'utf8')
      else writeFileSync(join(widgetDir, 'index.js'), 'module.exports = { FilesModule: () => "v2" }', 'utf8')
    }
    else {
      readme = readme.replace('# 验收项目', '# 工作台验收')
    }
    const text = opts.userLayer !== undefined
      ? '做完了:改了 小组件/files/index.js。'
      : '做完了:首行写成「工作台验收」。'
    writeFileSync(cmd.logFile, [
      JSON.stringify({ role: 'assistant', content: text }),
      JSON.stringify({ role: 'meta', type: 'session.resume_hint', session_id: `qa-kimi-${++pid}` }),
    ].join('\n'))
    writeFileSync(cmd.logFile.replace(/\.jsonl$/, ''), '')
    cliReturned = true
    return { pid: ++pid, exited: Promise.resolve({ code: 0 }) }
  }
  const resolveCli = () => {
    if (opts.blockRedispatch === true && cliReturned) return { found: false as const, family: 'kimi' as const, why: '没登录:请先运行 /login' }
    return { found: true as const, family: 'kimi' as const, bin: 'kimi-qa', source: 'path' as const }
  }
  engine.registry.register(createCliAdapter('kimi', { resolveCli, runCli, resultDir: home, now: () => new Date() }))
  // 接口手(GPT):当场回话(blockRedispatch 时也派不出去)。
  engine.registry.register(createApiAdapter('gpt', {
    send: (async () => opts.blockRedispatch === true ? { ok: false, reason: '中转没配这一家' } : { ok: true, reply: RECEIPT }) as never,
  }))
  const { createProjectsService } = await import('../src/server/projectsService.ts')
  const projects = createProjectsService({
    file: join(home, 'projects.json'),
    exec: async () => ({ ok: false, stdout: '' }),
    listDir: async () => [],
    isRepo: async () => false,
    codexHome: join(home, '.codex'),
    codexDeps: { listFiles: async () => [], readFirstLine: async () => undefined } as never,
    home,
    scanRoots: [],
  })
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { messages?: { role?: string, content?: string }[] }
    const system = String(body.messages?.[0]?.content ?? '')
    const saidText = String(body.messages?.at(-1)?.content ?? '')
    const commands = (list: Record<string, unknown>[]) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ commands: list }) } }] }), { status: 200 })
    const quote = saidText.includes('说:「') ? saidText.slice(saidText.lastIndexOf('说:「') + 3).replace(/」$/u, '') : saidText
    if (system.includes('交回核验')) {
      verifyCalls += 1
      if (opts.verify === 'down' || (opts.verify === 'down-then-pass' && verifyCalls === 1)) throw new Error('qa-down')
      const met = opts.verify !== 'fail'
      // 按提示词里「验收条件(逐条核)」那一节逐条回;用例注入了产物核对替身时给 test 类凭据(拖时间的代跑)。
      const section = /验收条件\(逐条核\):\n?([\s\S]*?)(?:\n独立工作区|\n执行者交回汇报)/u.exec(saidText)
      const conditions = section === null ? [] : [...(section[1] ?? '').matchAll(/^\d+\.\s*(.+)$/gum)].map(one => (one[1] as string).trim()).filter(one => one !== '')
      const items = (conditions.length > 0 ? conditions : [...ACCEPTANCE]).map(condition => ({
        condition,
        met,
        evidence: met ? RECEIPT : '',
        ...(/用例|测试|vitest|tsc/u.test(condition) && opts.artifacts !== undefined ? { artifact: { kind: 'test', command: 'npx vitest run tests/related.test.ts' } } : {}),
      }))
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) } }] }), { status: 200 })
    }
    if (system.includes('验收条件提取')) {
      if (opts.extract === undefined) throw new Error('qa-down')
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ acceptance: opts.extract }) } }] }), { status: 200 })
    }
    if (!system.includes('理解中枢')) throw new Error('qa-down')
    const hit = opts.hubAnswers?.[quote]
    if (hit === undefined) return commands([{ name: 'note', title: quote, status: 'todo' }])
    return commands(hit)
  }) as never

  let userLayer: UserLayerService | undefined
  if (opts.userLayer !== undefined) {
    const bodyDir = join(home, '本体')
    mkdirSync(join(bodyDir, 'lib'), { recursive: true })
    writeFileSync(join(bodyDir, 'lib', 'index.js'), '本体代码 v1', 'utf8')
    userLayer = createUserLayerService({ dir: join(home, '用户层'), bodyDir })
    await userLayer.ensure()
    const widgetDir = join(userLayer.dir, '小组件', 'files')
    mkdirSync(widgetDir, { recursive: true })
    writeFileSync(join(widgetDir, 'widget.json'), JSON.stringify({ contract: 1, id: 'files', name: '素材管理', replaces: 'files', export: 'FilesModule' }), 'utf8')
    writeFileSync(join(widgetDir, 'index.js'), 'module.exports = { FilesModule: () => "v1" }', 'utf8')
  }

  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => Math.floor(Date.now() / 1000) }),
    tickIntervalMs: 0, heartbeatMs: 0,
    tasks,
    projects,
    engine: engine.engine,
    engineRegistry: engine.registry,
    helper: { attach: () => {}, view: () => ({ connected: true, authorized: true }) as never, connected: () => true, onChange: () => {}, onEvent: () => {}, request },
    runCommand: async () => ({ ok: true, stdout: '"pid"=123' }),
    appInstalled: () => true,
    butlerSession: { open: async () => 'sess-v', say: async () => true },
    model: { endpoint: async () => ({ baseUrl: 'http://x/v1', key: 'k', model: 'm', ready: true }) } as never,
    fetchImpl,
    ...(userLayer === undefined ? {} : { userLayer }),
    dispatchRun: { pollMs: 30, lease: createExecutionLeaseStore({ file: join(home, 'leases.json') }) },
    ...(opts.relay !== true ? {} : { relayProviders: { view: () => ({ openai: true, doubao: true }), read: async () => ({ openai: true, doubao: true }), pump: () => undefined, refresh: async () => undefined } }),
    ...(opts.artifacts === undefined && opts.retryMs === undefined ? {} : { taskDelivery: { ...(opts.artifacts === undefined ? {} : { artifacts: opts.artifacts }), ...(opts.retryMs === undefined ? {} : { retryMs: opts.retryMs }) } }),
  })
  started.push(server)
  windowBlocked = true
  if (projects.adopt === undefined) throw new Error('这台没接 adopt')
  const project = await projects.adopt({ name: '验收项目', path: projectDir })
  return {
    url: server.url, tasks, server,
    ...(userLayer === undefined ? {} : { userLayer }),
    home,
    verifyCalls: () => verifyCalls,
    readme: () => readme,
    setReadme: (text) => { readme = text },
    projectId: async () => project.id,
  }
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...PAGE }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
}

async function waitFor(fn: () => Promise<unknown>, what: string, ms = 20000): Promise<never> {
  const until = Date.now() + ms
  for (;;) {
    if (await fn()) return undefined as never
    if (Date.now() > until) throw new Error(`超时:${what}`)
    await new Promise(r => setTimeout(r, 60))
  }
}

const cardOf = async (h: Harness, id: string) => (await h.tasks.list()).tasks.find(one => one.id === id)
const butlerNotes = async (h: Harness, id: string) => ((await cardOf(h, id))?.comments ?? []).filter(one => one.by === 'butler').map(one => one.text)

/** 建一张卡(带不带验收条件由调用方定)并派出去,等它交回(「等你确认」或已核完「完成」)。 */
async function dispatchCliAndReturn(h: Harness, said: string, withAcceptance = true): Promise<string> {
  const made = await post(h.url, '/butler/item', { text: said, entrance: 'desktop' })
  const id = String(made.body.id)
  await h.tasks.update(id, { projectId: await h.projectId(), ...(withAcceptance ? { acceptance: ACCEPTANCE } : {}) })
  if (h.server.dispatchItem === undefined) throw new Error('这台没露 dispatchItem')
  const started = await h.server.dispatchItem(id, { family: 'kimi', text: said, kind: 'code' })
  expect(started.ok).toBe(true)
  await waitFor(async () => ['confirm', 'done'].includes((await cardOf(h, id))?.status ?? ''), '交回进「等你确认」')
  return id
}

/** note 建卡 + 直派某个家(中枢命令解析只认窗口/CLI 家,api 那只手直派测)。 */
async function noteCard(h: Harness, said: string): Promise<string> {
  const made = await post(h.url, '/butler/item', { text: said, entrance: 'desktop' })
  if (made.status !== 200) throw new Error(`/butler/item => ${made.status} ${JSON.stringify(made.body)}`)
  return String(made.body.id)
}

describe('① 凡交回都核:CLI / 窗口 / 接口 / 事务官自办,同一产物同一验收口径', () => {
  const DISPATCH_SAID = '把首行写成「工作台验收」交给小K,做到什么算完:首行写成「工作台验收」'
  it('CLI 手交回 → 进核验,过 → 挪「完成」+ 执行记录 delivered', async () => {
    const h = await serve({ verify: 'pass' })
    const id = await dispatchCliAndReturn(h, DISPATCH_SAID)
    await waitFor(async () => (await cardOf(h, id))?.status === 'done', '核验通过挪「完成」')
    expect((await butlerNotes(h, id)).join('\n')).toContain('验收通过')
    expect((await h.tasks.readExecution(id))?.phase).toBe('delivered')
  }, 30000)

  it('窗口手交回 → 同样进核验(不再只认 CLI)', async () => {
    const h = await serve({
      verify: 'pass',
      hubAnswers: { [DISPATCH_SAID]: [{ name: 'dispatch', new: { title: DISPATCH_SAID }, to: 'muse', text: '问它:一年有几个季节?', acceptance: ACCEPTANCE }] },
    })
    await post(h.url, '/butler/item', { text: DISPATCH_SAID, entrance: 'desktop' })
    const id = 't-1'
    await waitFor(async () => ['confirm', 'done'].includes((await cardOf(h, id))?.status ?? ''), '窗口手交回')
    await waitFor(async () => (await cardOf(h, id))?.status === 'done', '核验通过挪「完成」')
    expect((await butlerNotes(h, id)).join('\n')).toContain('验收通过')
    expect((await h.tasks.readExecution(id))?.phase).toBe('delivered')
  }, 30000)

  it('接口手(API)当场回话 → 同样进核验', async () => {
    const h = await serve({ verify: 'pass', relay: true })
    const id = await noteCard(h, '问它:一年有几个季节?')
    await h.tasks.update(id, { acceptance: ACCEPTANCE })
    if (h.server.dispatchItem === undefined) throw new Error('这台没露 dispatchItem')
    const started = await h.server.dispatchItem(id, { family: 'gpt', text: '问它:一年有几个季节?', kind: 'chat' })
    expect(started.ok, started.note).toBe(true)
    await waitFor(async () => ['confirm', 'done'].includes((await cardOf(h, id))?.status ?? ''), '接口手交回')
    await waitFor(async () => (await cardOf(h, id))?.status === 'done', '核验通过挪「完成」')
    expect((await butlerNotes(h, id)).join('\n')).toContain('验收通过')
  }, 30000)

  it('事务官自办(/task/:id/receipt 报做完)→ 同样进核验', async () => {
    const h = await serve({ verify: 'pass' })
    const id = await noteCard(h, '把首行写成「工作台验收」')
    await h.tasks.update(id, { acceptance: ACCEPTANCE })
    const receipt = await post(h.url, '/task/receipt', { id, receipt: 'done', text: RECEIPT })
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(200)
    await waitFor(async () => (await cardOf(h, id))?.status === 'done', '核验通过挪「完成」')
    expect((await butlerNotes(h, id)).join('\n')).toContain('验收通过')
  }, 30000)
})

describe('② 缺验收不推人:从委托提取默认条件写卡(写明「由委托提取」)再核', () => {
  it('卡上没条件 → 模型从委托原话提取 → 写卡再核 → 过 → done;不挂 owner_ask 不推人', async () => {
    const h = await serve({ verify: 'pass', extract: ACCEPTANCE })
    const id = await dispatchCliAndReturn(h, '把 README 首行写成「工作台验收」', false)
    await waitFor(async () => (await cardOf(h, id))?.status === 'done', '提取条件 → 核验通过')
    const card = await cardOf(h, id)
    expect(card?.acceptance).toEqual(ACCEPTANCE)
    expect((await butlerNotes(h, id)).join('\n')).toContain('由委托提取')
    expect(card?.owner_ask).toBeUndefined()
    expect(card?.status).toBe('done')
  }, 30000)
})

describe('③ 缺证据先补证据:代跑耗时不阻塞交回那条 HTTP,结果异步回写', () => {
  it('代跑 400ms:交回那一刻 HTTP 已放行、无判词;跑完异步回写 → 通过挪「完成」', async () => {
    const sleeping: ArtifactCheckDeps = {
      readFile: async () => undefined,
      differs: async () => undefined,
      knownPath: async () => undefined,
      matchByName: async () => undefined,
      changedTestFiles: async () => [],
      runTest: async () => { await new Promise(r => setTimeout(r, 400)); return 'pass' },
    }
    const h = await serve({ verify: 'pass', artifacts: sleeping })
    // 核验模型对「相关用例全部通过」给 test 类凭据(用例注了产物替身才给),代跑由替身拖 400ms。
    const id = await noteCard(h, '把相关用例跑过后交给小K')
    await h.tasks.update(id, { projectId: await h.projectId(), acceptance: ['相关用例全部通过'] })
    if (h.server.dispatchItem === undefined) throw new Error('这台没露 dispatchItem')
    const t0 = Date.now()
    await h.server.dispatchItem(id, { family: 'kimi', text: '把相关用例跑过后交给小K', kind: 'code' })
    expect(Date.now() - t0).toBeLessThan(300)
    await waitFor(async () => ['confirm', 'done'].includes((await cardOf(h, id))?.status ?? ''), '交回进「等你确认」')
    // 交回那一刻:HTTP 早放行了,判词还没回写(代跑要 400ms)。
    expect((await butlerNotes(h, id)).join('\n')).not.toContain('验收通过')
    await waitFor(async () => (await cardOf(h, id))?.status === 'done', '异步回写:代跑过后挪「完成」')
  }, 30000)
})

describe('④ 退修派不出去不挂 doing:卡回「等你确认」,执行记录 next=recover 带 wakeAt', () => {
  it('核验不过 → 退修重派被挡(没登录)→ 卡不挂 doing、原因落卡、记录 recovering+recover+wakeAt', async () => {
    const h = await serve({ verify: 'fail', blockRedispatch: true, retryMs: 5000 })
    const id = await dispatchCliAndReturn(h, '把首行写成「工作台验收」交给小K,做到什么算完:首行写成「工作台验收」')
    await waitFor(async () => (await butlerNotes(h, id)).join('\n').includes('退修没派出去'), '退修重派被挡落卡')
    const card = await cardOf(h, id)
    expect(card?.status).toBe('confirm')
    const record = await h.tasks.readExecution(id)
    expect(record?.phase).toBe('recovering')
    expect(record?.next?.kind).toBe('recover')
    expect(typeof record?.next?.wakeAt).toBe('number')
    expect((await butlerNotes(h, id)).join('\n')).toContain('验收未过')
  }, 30000)
})

describe('⑤ 「按通过结掉」= 人判通过(done,不再核);「核一遍」才 verify', () => {
  it('她说「按通过结掉」→ move_status done:卡 done + 记「人判通过」,核验模型没被叫', async () => {
    const h = await serve({
      verify: 'down',
      hubAnswers: { 't-1 按通过结掉': [{ name: 'move_status', card_id: 't-1', status: 'done' }] },
    })
    const id = await dispatchCliAndReturn(h, '把首行写成「工作台验收」交给小K')
    await waitFor(async () => (await cardOf(h, id))?.status === 'confirm', '交回进「等你确认」')
    const callsBefore = h.verifyCalls()
    const said = await post(h.url, '/butler/item', { text: 't-1 按通过结掉', entrance: 'desktop' })
    expect(said.status).toBe(200)
    await waitFor(async () => (await cardOf(h, id))?.status === 'done', '人判通过 → 直接 done')
    expect((await butlerNotes(h, id)).join('\n')).toContain('人判通过')
    expect(h.verifyCalls()).toBe(callsBefore)
    expect((await h.tasks.readExecution(id))?.phase).toBe('delivered')
  }, 30000)

  it('她说「核一遍」→ verify 命令:走核验,过了才 done', async () => {
    const h = await serve({
      verify: 'down-then-pass',
      hubAnswers: { 't-1 核一遍': [{ name: 'verify', card_id: 't-1' }] },
    })
    const id = await dispatchCliAndReturn(h, '把首行写成「工作台验收」交给小K')
    await waitFor(async () => (await cardOf(h, id))?.status === 'confirm', '交回进「等你确认」')
    const callsBefore = h.verifyCalls()
    await post(h.url, '/butler/item', { text: 't-1 核一遍', entrance: 'desktop' })
    await waitFor(async () => (await cardOf(h, id))?.status === 'done', '核验通过 → done')
    expect(h.verifyCalls()).toBeGreaterThan(callsBefore)
  }, 30000)
})

describe('⑥ 重启后待核验的卡接着核(不靠一次 onDelivered 回调)', () => {
  it('核验模型不在场 → 卡留「等你确认」记待核;重启后从恢复记录接回核完 → done', async () => {
    const h1 = await serve({ verify: 'down', retryMs: 60_000 })
    const id = await dispatchCliAndReturn(h1, '把首行写成「工作台验收」交给小K,做到什么算完:首行写成「工作台验收」')
    await waitFor(async () => (await butlerNotes(h1, id)).join('\n').includes('核不了'), '如实说核不了')
    expect((await h1.tasks.readExecution(id))?.next?.kind).toBe('verify')
    const home = h1.home
    await h1.server.close()
    // 重启:同一任务文件,模型这回在场。
    const h2 = await serve({ verify: 'pass', reuseHome: home })
    await waitFor(async () => (await cardOf(h2, id))?.status === 'done', '重启后接着核 → done', 30000)
    expect((await butlerNotes(h2, id)).join('\n')).toContain('验收通过')
  }, 60000)
})

describe('⑦ 用户层交付:目标文件改了 + 那一格热装 ok 才记「交付」', () => {
  it('热装 ok → 交付(delivered);那一格装得不好 → 不记交付、卡留「等你确认」定时再核,改好自动接上', async () => {
    const h = await serve({ verify: 'pass', userLayer: { fix: 'bad' }, retryMs: 300 })
    expect(h.userLayer).toBeDefined()
    const made = await post(h.url, '/butler/item', { text: '把素材管理那格的提示语改成「记一句」', entrance: 'desktop' })
    const id = String(made.body.id)
    if (h.server.dispatchItem === undefined) throw new Error('这台没露 dispatchItem')
    const started = await h.server.dispatchItem(id, {
      family: 'kimi',
      text: '改用户层:把素材管理那格的提示语改成「记一句」',
      kind: 'code',
      ...(h.userLayer === undefined ? {} : { cwd: h.userLayer.dir }),
      cwdFixed: true,
    })
    expect(started.ok).toBe(true)
    await waitFor(async () => (await cardOf(h, id))?.status === 'confirm', '交回进「等你确认」')
    // 默认条件由委托提取(用户层那三句),不推人。
    await waitFor(async () => (await butlerNotes(h, id)).join('\n').includes('由委托提取'), '默认条件写卡')
    expect((await cardOf(h, id))?.acceptance).toEqual([
      '交回里点名的用户层目标文件确实改了',
      '目标那一格热装 ok(设置里这一格不红)',
      '她的原件与本体一份没动(越界守门干净)',
    ])
    // 这一格装得不好 → 不记交付:卡留「等你确认」,记录待核带 wakeAt。
    await waitFor(async () => (await butlerNotes(h, id)).join('\n').includes('装得不好'), '热装不过如实说')
    expect((await cardOf(h, id))?.status).toBe('confirm')
    expect((await h.tasks.readExecution(id))?.next?.kind).toBe('verify')
    expect(typeof (await h.tasks.readExecution(id))?.next?.wakeAt).toBe('number')
    // 她把文件改好(指纹变)→ 定时再核 → 交付。
    writeFileSync(join(h.userLayer?.dir ?? '', '小组件', 'files', 'widget.json'), JSON.stringify({ contract: 1, id: 'files', name: '素材管理', replaces: 'files', export: 'FilesModule' }), 'utf8')
    writeFileSync(join(h.userLayer?.dir ?? '', '小组件', 'files', 'index.js'), 'module.exports = { FilesModule: () => "v3" }', 'utf8')
    await waitFor(async () => (await cardOf(h, id))?.status === 'done', '热装恢复 → 交付 done')
    expect((await h.tasks.readExecution(id))?.phase).toBe('delivered')
    expect((await butlerNotes(h, id)).join('\n')).toContain('验收通过')
  }, 45000)

  it('热装 ok → 直接交付:改到目标组件、记「交付」', async () => {
    const h = await serve({ verify: 'pass', userLayer: { fix: 'good' }, retryMs: 300 })
    const made = await post(h.url, '/butler/item', { text: '把素材管理那格的提示语改成「记一句」', entrance: 'desktop' })
    const id = String(made.body.id)
    if (h.server.dispatchItem === undefined) throw new Error('这台没露 dispatchItem')
    await h.server.dispatchItem(id, {
      family: 'kimi',
      text: '改用户层:把素材管理那格的提示语改成「记一句」',
      kind: 'code',
      ...(h.userLayer === undefined ? {} : { cwd: h.userLayer.dir }),
      cwdFixed: true,
    })
    await waitFor(async () => (await cardOf(h, id))?.status === 'done', '用户层修复核验交付 → done')
    expect((await h.tasks.readExecution(id))?.phase).toBe('delivered')
    const view = await h.userLayer?.scan()
    expect(view?.widgets.find(one => one.id === 'files')?.status).toBe('ok')
  }, 45000)
})
