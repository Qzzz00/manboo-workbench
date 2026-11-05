// @vitest-environment node
/**
 * 8791 上「派活的眼睛」那几条路(2026-09-25,卡 O)—— 按验收那几条走:
 *
 * 1. 体检表:`GET /agents/caps`、`POST /agents/caps/check`、`POST /agents/login`(只认回环、只认 Claude / Codex);
 * 2. ★Claude 命令行没登录时交代一件写代码的活(没点名):**明说 + 入口**,不假装派出去,一个字都不送进聊天窗
 *    (★ 2026-10-29 入口归一后由理解中枢核手:没登录 → 建卡 + 卡上「没派:…」停待办,不挂「阻塞」档;
 *    登好后没有自动重派(E#2),她重说一句点名的才接着派 —— 见文件内该组注记);
 * 3. ★确认点里带余额(假额度):「派给 Claude(本周还剩约 62%)」(★ 2026-10-29:E#3 审批已删,中枢点名直派,
 *    这一份余额人话改由 /dispatch/choices 选项表钉,同一组第二条);
 * 4. 上限的配置(`/butler/budget`)、到上限停下来问的三个选择(`/butler/item/budget`)
 *    (★ 2026-10-29:「事务官自己办」的会话入口换成卡上点派 /item/drive,预算机制本身不变);
 * 5. ★外层「停掉这一件」(`/butler/item/stop`)真的调了停止键(会话的 cancel)。
 *
 * 壳、命令行、DSH 会话全是假的:一扇真窗口、一个真进程都不碰;看板 / 规矩表在临时目录里。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProjectsState, WorkbenchState } from '../src/protocol.ts'
import type { CapFacts } from '../src/server/agentCaps.ts'
import { createAgentCaps } from '../src/server/agentCaps.ts'
import type { WindowQuotaReader } from '../src/server/agentQuota.ts'
import { createWindowQuotaReader } from '../src/server/agentQuota.ts'
import { createApprovalBroker } from '../src/server/composer.ts'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createBudgetStore } from '../src/server/itemBudget.ts'
import { createExecutionLeaseStore } from '../src/server/executionLease.ts'
import type { DshSessionUsage } from '../src/server/dshSessionFeed.ts'
import type { ProjectsService } from '../src/server/projectsService.ts'
import { createRulesService } from '../src/server/rules.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { engineHarness } from './helpers/engineHarness.ts'
import { fakeHubModel } from './helpers/fakeHubModel.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const MANUAL_RULE = '派活默认分工:写代码的活派 Claude(他的主力,额度 Max 二十倍);综合、要审美的活派 Codex;Lapis(仓库 Echo)的活派 Kimi。问他派给谁时,这几家都要列成选项,默认项按这个分工选;他点名了就听他的。'

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, any> }
}
async function get(url: string, path: string) {
  const res = await fetch(`${url}${path}`)
  return { status: res.status, body: await res.json() as Record<string, any> }
}

function fakeProjects(): ProjectsService {
  const state: ProjectsState = {
    projects: [{ id: 'p-wb', name: '工作台', stage: 'dev' as never, path: '/Users/example/Documents/GitHub/desktop-workbench', links: [], session_count: 0, idle: false }],
    pending: [], scan_errors: [], scanned_at: '',
  } as unknown as ProjectsState
  return { getProjectsState: async () => state, getLayout: async () => undefined } as unknown as ProjectsService
}

async function serve(opts: { claudeLogin?: 'yes' | 'no', approvals?: boolean, usage?: DshSessionUsage, windowQuota?: WindowQuotaReader, answers?: Parameters<typeof fakeHubModel>[0], drive?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-dispatch-eyes-http-'))
  dirs.push(dir)
  let n = 0
  // 卡号加本次唯一前缀:执行占用登记(可靠执行闭环第 1 步)是模块级的,同文件前一个用例派过同号卡会串占。
  const uid = Math.random().toString(36).slice(2, 8)
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), newId: () => `t-${uid}-${++n}` })
  const rules = createRulesService({ file: join(dir, 'rules.json'), agents: { apply: async () => ({ ok: true }), revert: async () => ({ ok: true }) } })
  await rules.load()
  await rules.add({ text: MANUAL_RULE, channel: 'butler' })
  const service = createWorkbenchService({})
  // 假额度是本次刚采到的数；采集时刻与缺时间的未知额度分开。
  const quotaReadAt = new Date().toISOString()
  // Claude 本周 62%(5 小时 88%);Codex 5 小时 80%。
  service.setQuota('claude', { kind: 'quota', as_of: quotaReadAt, windows: [{ label: '5h', left_pct: 88 }, { label: '周', left_pct: 62 }] })
  service.setQuota('codex', { kind: 'quota', as_of: quotaReadAt, windows: [{ label: '5h', left_pct: 80 }] })
  const helperCalls: HelperRequest[] = []
  const logins: string[] = []
  const loginState: { claude: 'yes' | 'no' } = { claude: opts.claudeLogin ?? 'no' }
  const facts = (): CapFacts['cli'] => ({ claude: { found: true, login: loginState.claude }, codex: { found: true, login: 'yes' } })
  const timers: (() => void)[] = []
  const caps = createAgentCaps({
    installed: () => true,
    helper: () => ({ connected: true, authorized: true, newConversation: true, readReply: true }),
    // 这台假机器只有 Claude / Codex 两份命令行(`facts()` 也只定义这两家)——Kimi 那台**根本没装**:
    // 从前 `() => true` 把 Kimi 也「探到了」,没装的机器就把 Kimi 列进了「能换的几家」。
    cliFound: family => family !== 'kimi',
    cliLogin: async family => ({ login: facts()[family]?.login ?? 'unknown' }),
    now: () => new Date('2026-09-25T15:00:00Z'),
    setTimer: (fn) => { timers.push(fn); return timers.length },
    clearTimer: () => {},
  })
  await caps.check()
  const cancels: string[] = []
  const store = createBudgetStore(join(dir, 'budget.json'))
  await store.load()
  const approvals = opts.approvals === true ? createApprovalBroker() : undefined
  // 命令行那只手在引擎的登记表里(2026-10-03):`http.ts` 拿 `dispatchRun` 那几样往这个登记处登;写代码的活只走它。
  const engineRig = engineHarness({ connected: () => false })
  // 2026-10-29 入口归一:POST /butler/item 一律进理解中枢,接假模型按原话回命令(命令表见 hub/commands.ts)。
  const model = fakeHubModel(opts.answers ?? {})
  const server = await startWorkbenchServer({
    port: 0,
    service,
    engine: engineRig.engine,
    engineRegistry: engineRig.registry,
    tickIntervalMs: 0,
    heartbeatMs: 0,
    tasks,
    rules,
    projects: fakeProjects(),
    model: model.service as never,
    fetchImpl: model.fetchImpl,
    ...(opts.drive === true ? { items: { driveFile: join(dir, 'drive.json') } as never } : {}),
    ...(approvals === undefined ? {} : { approvals }),
    agentCaps: caps,
    loginLauncher: async (family) => { logins.push(family); return { ok: true, note: `开了一个窗口跑 ${family} 自己的登录` } },
    appInstalled: () => true,
    ...(opts.windowQuota === undefined ? {} : { windowQuota: opts.windowQuota }),
    itemBudget: { store, usage: () => opts.usage },
    butlerSession: {
      open: async () => 's-new',
      say: async () => true,
      cancel: async (sessionId) => { cancels.push(sessionId); return { ok: true, running: false } },
    },
    helper: {
      attach: () => {},
      view: () => ({ connected: true, authorized: true }) as never,
      connected: () => true,
      onChange: () => {},
      onEvent: () => {},
      request: async (req: HelperRequest) => { helperCalls.push(req); return { found: false, busy: false } },
    },
    runCommand: async () => ({ ok: true, stdout: '"pid"=123' }),
    // 租约给每次 serve 自己的一份:vitest 缺省是 per-process 共享的 tmp 文件(leaseFile 在 VITEST 下被忽略),
    // runCli 替身进程永远不死,前一个用例在真项目目录上持有的租约不会放,会把后一个用例的同 cwd 派发挡在「占着」门外。
    dispatchRun: { runCli: () => ({ pid: 777, exited: new Promise(() => {}), }), alive: () => true, readFile: async () => undefined, resultDir: dir, lease: createExecutionLeaseStore({ file: join(dir, 'leases.json') }) },
  })
  started.push(server)
  return { server, url: server.url, tasks, helperCalls, logins, cancels, approvals, store, timers, setClaudeLogin: (value: 'yes' | 'no') => { loginState.claude = value } }
}

async function waitFor<T>(read: () => Promise<T>, ok: (value: T) => boolean, tries = 100): Promise<T> {
  let value = await read()
  for (let i = 0; i < tries && !ok(value); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 20))
    value = await read()
  }
  return value
}

/**
 * 假模型答案(2026-10-29 入口归一):交代写代码的活 → 中枢 dispatch 点名 Claude(规矩默认那家)。
 * Claude 没登录时核手不过 → 建卡 + 「没派:…」停待办;登录后同一句直派。
 */
const NO_LOGIN_ANSWERS = {
  '修一下首页球的显示问题': [{ name: 'dispatch', new: { title: '修一下首页球的显示问题' }, to: 'claude', text: '修一下首页球的显示问题' }],
  '修一下工作台首页球的显示问题': [{ name: 'dispatch', new: { title: '修一下工作台首页球的显示问题' }, to: 'claude', text: '修一下工作台首页球的显示问题' }],
} as const satisfies Parameters<typeof fakeHubModel>[0]

describe('体检表', () => {
  it('GET /agents/caps 与 /state.agent_caps 同一份:六家各三格', async () => {
    const { url } = await serve()
    const caps = await get(url, '/agents/caps')
    expect(caps.status).toBe(200)
    expect(caps.body.agents.map((one: { family: string }) => one.family)).toEqual(['claude', 'codex', 'kimi', 'doubao', 'muse', 'manus'])
    const claude = caps.body.agents[0]
    expect(claude.cells.edit.fix.label).toBe('帮我接上')
    const state = (await get(url, '/state')).body as WorkbenchState
    expect(state.agent_caps?.line).toBe(caps.body.line)
    expect(state.item_budget).toEqual({ cny: 0.5, minutes: 10 })
  })

  it('POST /agents/login:只认 Claude / Codex;开窗口的那一下交给它自己的登录命令', async () => {
    const { url, logins } = await serve()
    expect((await post(url, '/agents/login', { family: 'kimi' })).status).toBe(400)
    const ok = await post(url, '/agents/login', { family: 'claude' })
    expect(ok.status).toBe(200)
    expect(ok.body.note).toContain('自己的登录')
    expect(logins).toEqual(['claude'])
    expect((await get(url, '/agents/caps')).body.login_wait.family).toBe('claude')
  })

  /**
   * ★ 2026-09-30 维护者拍板把「带我过去」全删(见 `docs/决策记录.md` 末尾那一条)。
   * `POST /agents/show`(把那家叫到台前)**整条口没有了** —— 工作台不替她动别家的窗,
   * 该她自己去点的那一步如实写成一句话摆在那一格里。这一条钉的就是「那条口真的不在了」:
   * 哪一家都一样回 404(不是 400「family 不对」,也不是 403「只能在这台电脑上」)。
   */
  it('POST /agents/show 整条口没有了 → 一律 404(2026-09-30 维护者拍板全删「带我过去」)', async () => {
    const { url } = await serve()
    for (const family of ['claude', 'muse', 'manus', 'kimi']) {
      expect((await post(url, '/agents/show', { family })).status, family).toBe(404)
    }
    expect((await post(url, '/agents/show', {})).status).toBe(404)
  })

  /**
   * ★ **「事务官自己做」那一支整条口没有了**(2026-09-28,卡 BS2,设计 C1:事务官不干活)。
   *
   * 三选一只剩 continue / stop / switch。从前只有源码里一句注释记着这件事
   * (`http.ts` 那一处),没有像 `/agents/show` 那样的整条口回归 ——
   * 于是哪天有人「顺手把它加回来」没有一条用例会红。这一条就是那道网。
   */
  it('POST /butler/item/self 整条口没有了 → 一律 404(卡 BS2:事务官不干活)', async () => {
    const { url } = await serve()
    expect((await post(url, '/butler/item/self', { id: 't-1' })).status).toBe(404)
    expect((await post(url, '/butler/item/self', {})).status).toBe(404)
  })
})

describe('★Claude 命令行没登录时交代一件写代码的活', () => {
  /*
   * ★ 2026-10-29 入口归一(批 4):入口语义变了 —— 中枢先核手:点名的手(规矩默认 = Claude)没登录接不了,
   * 建卡 + 卡上写「没派:…」停待办;不挂「阻塞」档、不弹审批(那是旧派发口的行为)。
   * 与 dispatch-unreadable-say-now.test.ts 同一处置;「明说 + 登录键 + 能换 Codex」那一份人话在
   * /dispatch/choices 的选项表里(下一组用例钉),这里钉入口侧:不假装派出去、聊天窗一个字都没送。
   */
  it('没点名 → 按规矩默认 Claude;Claude 没登录 → 不派、卡留待办写「没派:…」、认项目;聊天窗一个字都没送、不挂审批', async () => {
    const { url, tasks, helperCalls } = await serve({ claudeLogin: 'no', approvals: true, answers: NO_LOGIN_ANSWERS })
    const created = await post(url, '/butler/item', { text: '修一下首页球的显示问题' })
    expect(created.status).toBe(200)
    expect(created.body.ok).toBe(true)
    // 没派出去:不给 dispatch_ok;回话与卡上那句如实写为什么没派。
    expect(created.body.dispatch_ok).toBeUndefined()
    expect(String(created.body.note)).toContain('没派')
    expect(String(created.body.note)).toContain('Claude')
    const task = (await tasks.list()).tasks[0]
    expect(task).toMatchObject({ status: 'todo', project_id: 'p-wb' })
    expect(String(task?.note ?? '')).toContain('没派')
    // 不挂「阻塞」档(旧派发口行为已随入口归一删除),也不挂「允许这一次」审批。
    expect(task?.dispatch_block).toBeUndefined()
    expect(task?.block_reason).toBeUndefined()
    expect(helperCalls.filter(one => one.op === 'send_text')).toEqual([])
    expect(((await get(url, '/state')).body as WorkbenchState).approvals ?? []).toEqual([])
  })

  /*
   * 旧版这一步钉的是「卡挂阻塞 → 登录 → 工作台自己查到 → 自动接着派」。E#2(待办有负责人 ≠ 开工)与
   * 批 4 之后没有自动重派:卡留待办等她明确委托。新流程:点「帮我接上」登好 → 她重说一句点名的,
   * 中枢 dispatch(回指同一张卡)照派。
   */
  it('★他点「帮我接上」、登好了:她重说一句点名的,同一张卡接着派出去', async () => {
    const { url, tasks, logins, timers, setClaudeLogin } = await serve({
      claudeLogin: 'no',
      approvals: true,
      answers: {
        '修一下首页球的显示问题': NO_LOGIN_ANSWERS['修一下首页球的显示问题'],
        // 她重说一句点名的、回指同一张卡(卡号在上下文包里,替身从包里现取):中枢核手通过,照派。
        '那张派给 Claude 开工': body => {
          const cardId = /【板上的卡】[\s\S]*?-\s+(t-[a-z0-9-]+)「/.exec(body)?.[1]
          return cardId === undefined ? undefined : [{ name: 'dispatch', card_id: cardId, to: 'claude', text: '修一下首页球的显示问题' }]
        },
      },
    })
    const created = await post(url, '/butler/item', { text: '修一下首页球的显示问题' })
    const first = (await tasks.list()).tasks[0]
    expect(first).toMatchObject({ status: 'todo' })
    expect(String(first?.note ?? '')).toContain('没派')
    expect((await post(url, '/agents/login', { family: 'claude' })).status).toBe(200)
    expect(logins).toEqual(['claude'])
    // 他在 Claude 自己的登录页上登好了;工作台下一拍登录轮询自己查到(体检那份缓存随之刷新)。
    setClaudeLogin('yes')
    timers.at(-1)?.()
    const again = await post(url, '/butler/item', { text: '那张派给 Claude 开工' })
    expect(again.status).toBe(200)
    expect(again.body.dispatch_ok).toBe(true)
    const task = await waitFor(async () => (await tasks.list()).tasks.find(one => one.id === created.body.id), one => one?.dispatch?.status === 'running' && one.status === 'doing', 500)
    expect(task?.dispatch).toMatchObject({ family: 'claude', hand: 'cli', status: 'running' })
    expect(task?.dispatch_block).toBeUndefined()
    expect(task?.status).toBe('doing')
    // 没有第二张卡。
    expect((await tasks.list()).tasks).toHaveLength(1)
  })

  it('点了名的写代码的活也认项目(「让 Claude 修一下工作台首页的球」→ 挂到工作台那个项目上,知道在哪个仓库里改)', async () => {
    const { url, tasks } = await serve({ claudeLogin: 'no', approvals: true, answers: NO_LOGIN_ANSWERS })
    const created = await post(url, '/butler/item', { text: '修一下工作台首页球的显示问题', assignee: 'claude' })
    expect(created.body).toMatchObject({ ok: true })
    expect(created.body.dispatch_ok).toBeUndefined()
    const task = (await tasks.list()).tasks[0]
    expect(task?.project_id).toBe('p-wb')
    // Claude 没登录:不派,卡留待办写「没派」。
    expect(task).toMatchObject({ status: 'todo' })
    expect(String(task?.note ?? '')).toContain('没派')
  })
})

describe('★确认点里带余额', () => {
  /*
   * ★ 2026-10-29 入口归一:E#3「派给 X(剩…)」审批已删 —— 中枢点名直派,不再挂「先问我」审批行;
   * 余额那一份人话仍在卡 O 的 /dispatch/choices 选项表里。这里钉新语义:派出去了、没有审批行、余额照写。
   */
  it('Claude 登着:中枢点名直派,不挂审批行;「本周还剩约 62%」写在 choices 选项表那一句里', async () => {
    const { url, tasks } = await serve({ claudeLogin: 'yes', approvals: true, answers: NO_LOGIN_ANSWERS })
    const created = await post(url, '/butler/item', { text: '修一下首页球的显示问题' })
    expect(created.body.dispatch_ok).toBe(true)
    const task = await waitFor(async () => (await tasks.list()).tasks[0], one => one?.dispatch?.status === 'running')
    expect(task?.dispatch).toMatchObject({ family: 'claude', hand: 'cli', status: 'running' })
    expect(task?.status).toBe('doing')
    // 「派给 X(剩…)」审批没有了。
    expect(((await get(url, '/state')).body as WorkbenchState).approvals ?? []).toEqual([])
    // 余额那一份在卡 O 的选项表里原样在(给卡 N 与界面读的那一句)。
    const view = await get(url, `/dispatch/choices?item=${String(created.body.id)}&kind=code`)
    expect(view.status).toBe(200)
    expect(String(view.body.line)).toContain('本周还剩约 62%')
    const claude = (view.body.options as { family: string, balance?: { text?: string } }[]).find(one => one.family === 'claude')
    expect(claude?.balance?.text).toBe('本周还剩约 62%')
    const codex = (view.body.options as { family: string, balance?: { text?: string } }[]).find(one => one.family === 'codex')
    expect(codex?.balance?.text).toBe('5 小时窗口还剩约 80%')
  })

  it('GET /dispatch/choices?item=:选项表(给卡 N 与界面)', async () => {
    const { url } = await serve({
      claudeLogin: 'yes',
      answers: { '看看 Lapis 这周的进展写个摘要': [{ name: 'note', title: '看看 Lapis 这周的进展写个摘要', status: 'todo' }] },
    })
    const created = await post(url, '/butler/item', { text: '看看 Lapis 这周的进展写个摘要', kind: 'chat' })
    const view = await get(url, `/dispatch/choices?item=${String(created.body.id)}`)
    expect(view.status).toBe(200)
    expect(view.body.kind).toBe('chat')
    expect(view.body.default).toBe('kimi')
    // 卡 BS2(2026-09-28):选项表里只有别家,「事务官自己做」那一项拿掉了。
    expect(view.body.options.some((one: { family: string }) => one.family === 'dsh')).toBe(false)
  })
})

describe('上限与「停掉这一件」', () => {
  it('/butler/budget:读、改(坏值 400)', async () => {
    const { url, store } = await serve()
    expect((await get(url, '/butler/budget')).body).toEqual({ cny: 0.5, minutes: 10 })
    expect((await post(url, '/butler/budget', { cny: 0, minutes: 10 })).status).toBe(400)
    const saved = await post(url, '/butler/budget', { cny: 1, minutes: 15 })
    expect(saved.body.note).toContain('1 元或 15 分钟')
    expect(store.get()).toEqual({ cny: 1, minutes: 15 })
  })

  /*
   * ★ 2026-10-29 入口归一:旧 /butler/item kind:'chat' 的「事务官自己办」入口随词表快路径删除。
   * 「交给事务官」现在的入口是卡上点派(POST /item/drive → driveNow → startButlerOnItem,会话挂上、卡挪「进行中」)。
   * 预算机制本身(卡上「花了多少 / 上限多少」、外层停掉调取消键)不变,这里换入口钉同一行为。
   */
  it('★事务官自己在办的一件:卡上带「花了多少 / 上限多少」;外层「停掉这一件」调了停止键,卡回「待办」写清花了多少', async () => {
    const usage: DshSessionUsage = { model: 'deepseek-v4-flash', steps: 12, run_ms: 3 * 60_000, running: true, tokenUsage: { cacheReadTokens: 1_000_000, uncachedInputTokens: 10_000, outputTokens: 10_000, cacheWriteTokens: 0 } }
    const { url, tasks, cancels } = await serve({ usage, drive: true })
    // 「交给事务官」:卡上负责人写事务官,点派开那条会话。
    const created = await tasks.create({ title: '帮我查一下明天的天气', status: 'todo', assignee: 'dsh' })
    const id = String(created.id)
    expect((await post(url, '/item/drive', { task_id: id })).status).toBe(200)
    const task = await waitFor(async () => (await get(url, '/state')).body as WorkbenchState, one => one.tasks?.tasks.find(t => t.id === id)?.conversation !== undefined)
    expect(task.tasks?.tasks.find(t => t.id === id)?.budget).toMatchObject({ limit_cny: 0.5, limit_minutes: 10, spent_cny: 0.14, run_minutes: 3, requests: 12, state: 'running' })
    const stopped = await post(url, '/butler/item/stop', { id })
    expect(stopped.status).toBe(200)
    expect(cancels).toEqual(['s-new'])
    const after = (await tasks.list()).tasks.find(t => t.id === id)
    expect(after?.status).toBe('todo')
    expect(after?.note).toBe('你停掉了这一件:花了约 0.14 元、跑了 3 分钟。改过的东西留着;要接着做就在卡上再交代一句')
    expect(after?.budget?.state).toBe('stopped')
  })

  it('/butler/item/budget:到上限停下来之后他说继续 → 上限加一档、卡回「进行中」', async () => {
    const usage: DshSessionUsage = { model: 'deepseek-v4-flash', steps: 40, run_ms: 11 * 60_000, running: true }
    const { url, tasks, server } = await serve({ usage, drive: true })
    // 同上进中枢后的入口:卡写事务官、点派开会话。
    const created = await tasks.create({ title: '帮我查一下明天的天气', status: 'todo', assignee: 'dsh' })
    const id = String(created.id)
    expect((await post(url, '/item/drive', { task_id: id })).status).toBe(200)
    await waitFor(async () => (await get(url, '/state')).body as WorkbenchState, one => one.tasks?.tasks.find(t => t.id === id)?.conversation !== undefined)
    expect(await server.itemBudget?.tick()).toBe(1)
    const paused = ((await get(url, '/state')).body as WorkbenchState).tasks?.tasks.find(t => t.id === id)
    expect(paused?.budget?.state).toBe('paused')
    expect(paused?.status).toBe('blocked')
    expect(paused?.note).toContain('到上限了,先停下来了')
    const cont = await post(url, '/butler/item/budget', { id, choice: 'continue' })
    expect(cont.status).toBe(200)
    const resumed = ((await get(url, '/state')).body as WorkbenchState).tasks?.tasks.find(t => t.id === id)
    expect(resumed?.budget).toMatchObject({ state: 'running', extended: 1, limit_cny: 1, limit_minutes: 20 })
    expect(resumed?.status).toBe('doing')
    expect((await post(url, '/butler/item/budget', { id, choice: 'later' })).status).toBe(400)
  })
})

describe('额度覆盖派活名单里的每一家(统筹 09-25:Muse、Manus、豆包额度那里不许什么都没有)', () => {
  it('★/state.agent_quota 与 GET /agents/quota:每家一行、三格之一;现读一遍窗口 → Manus 积分成了数、Muse 说清为什么读不到', async () => {
    const reads: string[] = []
    /**
     * 壳的钟:**这会儿往前 20 分钟**(原来钉死在 2026-09-25T15:00:00Z)。
     *
     * 2026-10-02(卡 QA):过了 2 小时那条线,额度那一格就不出百分比了(「读不到最新的,上次 …」)——
     * 钉死在一年多以前的读数在这条真接线的用例里全部过线,这一条要钉的「现读一遍 → Manus 积分成了数」
     * 就钉不住了。改成相对此刻,用例既不看墙上的钟、又落在线以内。
     */
    const readAt = new Date(Date.now() - 20 * 60_000)
    const windowQuota = createWindowQuotaReader({
      helper: () => ({ connected: true, authorized: true, readTexts: true }),
      now: () => readAt,
      request: async (req) => {
        if (req.op !== 'read_texts') return { ok: false, error: '未知 op' }
        reads.push(req.bundle_id)
        if (req.bundle_id === 'im.manus.desktop') {
          // 壳只回命中的那一小段:顶栏里一个通知角标「3」(靠左)、右上角那一格积分「1,234」。
          return { ok: true, result: { matches: [{ id: 'credits', text: '3', x: 980, y: 18 }, { id: 'credits', text: '1,234', x: 1130, y: 18 }], window: { w: 1200, h: 800 } } }
        }
        if (req.bundle_id === 'com.bot.pc.doubao') {
          // 豆包办公的「订阅与额度管理」那一页开着(卡 QD):两扇窗各一组三段,靠 y 配组。
          return { ok: true, result: { matches: [
            { id: 'page', text: '订阅与额度管理', x: 520, y: 212 },
            { id: 'window_5h', text: '当前时段', x: 420, y: 400 },
            { id: 'used', text: '已用 <1%', x: 860, y: 400 },
            { id: 'reset_rel', text: '4 小时 45 分钟后重置', x: 420, y: 446 },
            { id: 'window_7d', text: '近 7 天', x: 420, y: 500 },
            { id: 'used', text: '已用 <1%', x: 860, y: 500 },
          ], window: { w: 1200, h: 800 } } }
        }
        return { ok: false, error: '找不到窗口:com.meta.endo 没在运行' }
      },
    })
    const { url } = await serve({ windowQuota })
    const before = (await get(url, '/state')).body as WorkbenchState
    const rows = new Map((before.agent_quota ?? []).map(one => [one.id, one]))
    for (const id of ['doubao', 'muse', 'manus']) {
      expect(rows.get(id)?.state, id).toMatch(/^(numbers|unlimited|unconnected)$/)
      expect(rows.get(id)?.line, id).not.toBe('')
    }
    // ★卡 QD:豆包办公**不再是「不限」**,读到那一页才有数(这会儿还没读完一轮)。
    expect(rows.get('doubao')?.state).not.toBe('unlimited')
    // ★ 2026-09-30 维护者拍板全删「带我过去」:这一行不再挂键,该他自己去开哪一页写在那句话里。
    expect(rows.get('manus')).toMatchObject({ state: 'unconnected' })
    expect(rows.get('manus')?.fix).toBeUndefined()
    expect(rows.get('manus')?.line).toContain('在 Manus 里回到首页,右上角那一格就是积分')

    const checked = await post(url, '/agents/quota/check', {})
    expect(checked.status).toBe(200)
    // /state 顺手泵过一轮(10 分钟节流),「重新查一遍」又现读一轮:**只读要从窗口上读的那几家**
    // (2026-10-04 卡「Grok 读已用」起多了 Grok Bot —— 它那个数在账号菜单那一行上,
    // 从开集那条路搬到了窗口型;这一份壳回「找不到窗口」,那一格照旧说得清为什么)。
    expect([...new Set(reads)].sort()).toEqual(['com.anysphere.sand', 'com.bot.pc.doubao', 'com.meta.endo', 'im.manus.desktop'])
    const after = new Map((checked.body.agents as { id: string }[]).map(one => [one.id, one]))
    // 那一句后面还跟着「截至 HH:MM」(卡 QS 写时刻、卡 QA 统一成「截至」;这里只查前半句)。
    expect(after.get('manus')).toMatchObject({ state: 'numbers', left: { text: '1,234', unit: '积分', amount: 1234 } })
    expect((after.get('manus') as unknown as { line: string }).line).toContain('剩 1,234 积分')
    expect(after.get('muse')).toMatchObject({
      state: 'unconnected',
      // 原来这一行是「…读不了它窗口上的额度」+ 一颗「打开 Muse」;2026-09-30 键全删了,那句话接在后面。
      line: '没接上:Muse 没开着,读不了它窗口上的额度 —— 在 Muse 的设置里打开「使用情况」,那扇窗留在你这会儿看着的桌面上,工作台看一眼就记下',
    })
    expect((after.get('muse') as { fix?: unknown }).fix).toBeUndefined()
    expect(after.get('claude')).toMatchObject({ state: 'numbers', line: '本周还剩约 62%' })
    // ★卡 QD:豆包办公那一页读到了 → 两扇窗(5h / 周)各剩 99%,那一句说最紧的那一扇。
    expect(after.get('doubao')).toMatchObject({
      state: 'numbers',
      left_pct: 99,
      // 重置时刻 = 读到那一刻 + 页面上写的「4 小时 45 分钟后」(壳的钟改成相对此刻之后跟着算)。
      windows: [
        { label: '5h', left_pct: 99, reset_at: new Date(readAt.getTime() + (4 * 60 + 45) * 60_000).toISOString() },
        { label: '周', left_pct: 99 },
      ],
    })
    expect((after.get('doubao') as unknown as { line: string }).line).toContain('5 小时窗口还剩约 99%')
    const again = await get(url, '/agents/quota')
    expect(again.body.agents).toEqual(checked.body.agents)
  })
})
