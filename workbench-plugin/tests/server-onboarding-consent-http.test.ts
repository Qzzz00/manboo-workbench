// @vitest-environment node
/**
 * 引导答案的对话凭据门(2026-09-23 统筹从零重装自跑引导发现的 I / H / K / 系统授权 / E)。
 *
 * 回合表按真机会话日志(session-af097617)里的原话回放:
 *   - I:他只说了「工作台这个项目」,她就 answer(read_scan_roots=true)、再去 /onboarding/scan —— 现在 409,扫描 403;
 *   - H:①′ 布局复述「那我先给你摆成产品研发那一套,对吗?」→「对」→ 她拿它记 branch.mode —— 现在 409;
 *   - K:「那我是开口说,还是发文字给你?」→「没有了」→ 她收 habits —— 现在 409 要她追问;
 *   - 系统授权:授权阶段 turns 带 system_auth;POST /onboarding/system-auth 没问出口 409、他点头才打开设置页;
 *   - E:/onboarding/scan/status 只报引导发起的那一次。
 * serve() 与 server-onboarding-say-http.test.ts 同源,多注入项目区 / 壳 / 体检三件桩。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ProjectsState } from '../src/protocol.ts'
import { createAuthorizationService } from '../src/server/authorization.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createOnboardingService } from '../src/server/onboarding.ts'
import { createOnboardingTurns } from '../src/server/onboardingTurns.ts'
import { FILE_ACCESS_WHY, FULL_PLAN, OPENING_LINE, SYSTEM_AUTH_WHY } from '../src/server/onboardingStages.ts'
import type { ProjectsService, ScanProgress } from '../src/server/projectsService.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { PRODUCT_TEMPLATE, setWorkbenchTemplateSource } from '../src/templates.ts'
import { loadStarterLayoutTemplate } from './helpers/starterLayer.ts'

const ops = await loadStarterLayoutTemplate()
beforeAll(() => {
  setWorkbenchTemplateSource({
    all: () => [PRODUCT_TEMPLATE, ops],
    byId: (id: string) => (id === PRODUCT_TEMPLATE.id ? PRODUCT_TEMPLATE : id === ops.id ? ops : undefined),
  })
})
afterAll(() => {
  setWorkbenchTemplateSource({
    all: () => [PRODUCT_TEMPLATE],
    byId: (id: string) => (id === PRODUCT_TEMPLATE.id ? PRODUCT_TEMPLATE : undefined),
  })
})

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const NOW_SEC = Math.floor(Date.parse('2026-09-23T10:30:00Z') / 1000)

async function post(url: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}
async function getJson(url: string, path: string) {
  const res = await fetch(`${url}${path}`)
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

const EMPTY_STATE: ProjectsState = { projects: [], pending: [], scan_errors: [], scanned_at: '2026-09-23T10:30:00.000Z' }

async function serve() {
  const root = mkdtempSync(join(tmpdir(), 'wb-onboarding-consent-'))
  dirs.push(root)
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'docs', '记忆', '项目'), { recursive: true })
  writeFileSync(join(repo, 'README.md'), 'x\n')
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
  const agentsFile = join(root, 'AGENTS.md')
  writeFileSync(agentsFile, '# 事务官\n')
  const authorization = createAuthorizationService({ file: join(repo, 'docs', '记忆', '授权.md') })
  let n = 0
  const tasks = createTasksService({ file: join(root, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${++n}` })
  const adopted: { name: string, path: string }[] = []
  const onboarding = createOnboardingService({
    plan: FULL_PLAN,
    file: join(root, 'onboarding.json'), repoRoot: repo, agentsFile, authorization, tasks,
    now: () => new Date(NOW_SEC * 1000),
    projects: { adopt: async (input) => { adopted.push(input); return { id: 'desktop-workbench' } } },
  })
  await onboarding.load()
  const turns = createOnboardingTurns({ now: () => new Date(NOW_SEC * 1000) })

  // 项目区桩:getProjectsState 是项目区自己那一份;scanForOnboarding / locate 是引导发起的,推进进度。
  let progress: ScanProgress = { scanning: false, done: 0 }
  const areaScans = { n: 0 }
  const projects: ProjectsService = {
    getProjectsState: async () => { areaScans.n += 1; return EMPTY_STATE },
    confirmStatus: async () => true,
    setDdl: async () => true,
    addRule: async () => {},
    getLayout: async () => undefined,
    setLayout: async () => {},
    invalidateScanCache: () => {},
    scanProgress: () => ({ ...progress }),
    locate: async (query) => {
      progress = { scanning: false, done: 0, finished_at: '2026-09-23T10:31:00.000Z' }
      return { matches: query === 'desktop-workbench' ? [{ name: 'desktop-workbench', path: '/Users/x/Documents/GitHub/desktop-workbench' }] : [], errors: [] }
    },
    scanForOnboarding: async () => {
      progress = { scanning: false, done: 1, total: 1, finished_at: '2026-09-23T10:32:00.000Z' }
      return EMPTY_STATE
    },
  }

  // 壳桩:连着、辅助功能没开。request_accessibility 记下来。
  const helperRequests: unknown[] = []
  let axGranted = false
  const helper = {
    attach: () => {},
    view: () => ({ connected: true, authorized: axGranted }),
    connected: () => true,
    request: async (req: unknown) => { helperRequests.push(req); return {} },
    onChange: () => {},
    onEvent: () => {},
  }
  // 体检桩:只要 openPane(与 composeState 会碰的 pump / setupRequired)。
  const openedPanes: string[] = []
  const setup = {
    pump: () => {},
    setupRequired: () => false,
    openPane: async (pane: string) => { openedPanes.push(pane); return { ok: true } },
  }

  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    tasks,
    remoteAddress: () => '127.0.0.1',
    isRemoteAllowed: () => true,
    onboarding,
    authorization,
    onboardingTurns: turns,
    projects,
    helper: helper as never,
    setup: setup as never,
    butlerSession: { open: async () => 'sess-ob', say: async () => true },
  })
  started.push(server)
  return {
    url: server.url, repo, turns, onboarding, adopted, helperRequests, openedPanes, areaScans,
    grantAx: () => { axGranted = true },
  }
}

const assistant = (text: string) => ({ type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } } })
const user = (text: string) => ({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } })

/** 按真机那一段对话走到 ② 分岔(2026-09-23 起称呼之后就是分岔),每一步都有「问出口 + 他答」。 */
async function walkToBranch(fx: Awaited<ReturnType<typeof serve>>) {
  await post(fx.url, '/onboarding/session', {})
  fx.turns.handleEvent('sess-ob', assistant(OPENING_LINE))
  fx.turns.handleEvent('sess-ob', user('叫我 Ben'))
  expect((await post(fx.url, '/onboarding/answer', { stage: 'opening', key: 'nickname', value: 'Ben' })).status).toBe(200)
  fx.turns.handleEvent('sess-ob', assistant('我叫你 Ben,对吗?'))
  fx.turns.handleEvent('sess-ob', user('对'))
}

const BRANCH_SEED = '你现在是已经有在做的事,还是想从一个新点子开始?'
const TEMPLATE_ASK = '你说的这件事,更像是做产品研发,还是做自媒体运营?我按这个给你把工作台摆好。'

/** ② 分岔问出口、他答「已经有在做的」;①′ 布局顺着问出口、他答「做产品」。走到 ②′。 */
async function answerBranchAndTemplate(fx: Awaited<ReturnType<typeof serve>>) {
  fx.turns.handleEvent('sess-ob', assistant(BRANCH_SEED))
  fx.turns.handleEvent('sess-ob', user('已经有在做的,一个桌面工作台'))
  expect((await post(fx.url, '/onboarding/answer', { stage: 'branch', key: 'mode', value: 'existing' })).status).toBe(200)
  fx.turns.handleEvent('sess-ob', assistant(TEMPLATE_ASK))
  fx.turns.handleEvent('sess-ob', user('做产品'))
  expect((await post(fx.url, '/onboarding/answer', { stage: 'template', key: 'template', value: 'product' })).status).toBe(200)
}

describe('H:确认上一题的「对」不能被当成下一题的答案', () => {
  it('新顺序:称呼复述「我叫你 Ben,对吗?」→「对」→ 记 branch.mode 被 409;问出口分岔之后才收', async () => {
    const fx = await serve()
    await walkToBranch(fx)
    const blocked = await post(fx.url, '/onboarding/answer', { stage: 'branch', key: 'mode', value: 'existing' })
    expect(blocked.status).toBe(409)
    expect(String(blocked.body.error)).toContain('别把他对上一题的「对」当成这一题的答案')
    expect(String(blocked.body.error)).toContain(BRANCH_SEED)
    expect(fx.onboarding.detail().stage).toBe('branch')

    fx.turns.handleEvent('sess-ob', assistant(BRANCH_SEED))
    fx.turns.handleEvent('sess-ob', user('已经有在做的'))
    expect((await post(fx.url, '/onboarding/answer', { stage: 'branch', key: 'mode', value: 'existing' })).status).toBe(200)
    expect(fx.onboarding.detail().stage).toBe('template')
  })

  it('新顺序:分岔里他顺口说「我有个产品在做」,她当场记 template=product → 409;布局那一问问出口才收', async () => {
    const fx = await serve()
    await walkToBranch(fx)
    fx.turns.handleEvent('sess-ob', assistant(BRANCH_SEED))
    fx.turns.handleEvent('sess-ob', user('已经有了,我有个产品在做'))
    expect((await post(fx.url, '/onboarding/answer', { stage: 'branch', key: 'mode', value: 'existing' })).status).toBe(200)
    const blocked = await post(fx.url, '/onboarding/answer', { stage: 'template', key: 'template', value: 'product' })
    expect(blocked.status).toBe(409)
    expect(String(blocked.body.error)).toContain('更像是做产品研发')
    expect(fx.onboarding.detail().stage).toBe('template')

    // 复述确认那一句也算问出口了(问句里有「产品研发」)。
    fx.turns.handleEvent('sess-ob', assistant('你说的这个产品,那我先给你摆成做产品研发那一套,对吗?'))
    fx.turns.handleEvent('sess-ob', user('对'))
    expect((await post(fx.url, '/onboarding/answer', { stage: 'template', key: 'template', value: 'product' })).status).toBe(200)
    expect(fx.onboarding.detail().stage).toBe('projects')
  })

  it('页面上他自己按的按钮(带 Origin)不要凭据;没绑回合表 / 电话那条路带 heard 照样认', async () => {
    const fx = await serve()
    await walkToBranch(fx)
    // 他在首次流程里点了「已有项目」那颗按钮。
    const byButton = await post(fx.url, '/onboarding/answer', { stage: 'branch', key: 'mode', value: 'existing' }, { origin: fx.url })
    expect(byButton.status).toBe(200)
    // 电话那条路:布局问出口了,他答「做产品」→ 收。
    const tpl = await post(fx.url, '/onboarding/answer', {
      stage: 'template', key: 'template', value: 'product',
      heard: { asked: TEMPLATE_ASK, reply: '做产品' },
    })
    expect(tpl.status).toBe(200)
    // 电话那条路:工人带 heard。确认上一题的「对」照样被拦。
    const phone = await post(fx.url, '/onboarding/answer', {
      stage: 'projects', key: 'read_scan_roots', value: true,
      heard: { asked: '好,已有项目的路子。你想先把哪个项目交给我?', reply: '工作台这个项目' },
    })
    expect(phone.status).toBe(409)
  })
})

describe('I:先斩后奏的授权 —— 没问出口、他没点头,read_scan_roots 记不成可以,扫描也就 403', () => {
  it('他只报了项目名,她就记 read_scan_roots=true → 409「先问后看」;/onboarding/scan 带 name 仍 403', async () => {
    const fx = await serve()
    await walkToBranch(fx)
    await answerBranchAndTemplate(fx)
    fx.turns.handleEvent('sess-ob', assistant('明白,那我先只录一个。那个在做着的项目,叫什么名字?'))
    fx.turns.handleEvent('sess-ob', user('工作台这个项目'))

    const blocked = await post(fx.url, '/onboarding/answer', { stage: 'projects', key: 'read_scan_roots', value: true })
    expect(blocked.status).toBe(409)
    expect(String(blocked.body.error)).toContain('先问后看')
    // 2026-09-24:拦下来时教她的那一问换成「找它、读它一起问」的新句子。
    expect(String(blocked.body.error)).toContain('为了找到它、读读它的说明和最近的记录,我得看一眼你放代码的目录,只读不改,可以吗?')
    const scan = await post(fx.url, '/onboarding/scan', { name: '工作台' })
    expect(scan.status).toBe(403)
    expect(fx.onboarding.detail().answered.projects ?? []).not.toContain('read_scan_roots')

    // 他说不行:记「可以」照样拦,记 false 放行。
    fx.turns.handleEvent('sess-ob', assistant('为了找到它、读读它的说明和最近的记录,我得看一眼你放代码的目录,只读不改,可以吗?'))
    fx.turns.handleEvent('sess-ob', user('不用,你直接问我吧'))
    expect((await post(fx.url, '/onboarding/answer', { stage: 'projects', key: 'read_scan_roots', value: true })).status).toBe(409)

    // 先问后看:问出口、他点头 → 收;扫描放行;找到的 path 带进 project → 项目区认领同一行。
    fx.turns.handleEvent('sess-ob', assistant('那我再问一次:为了找到它、读读它的说明和最近的记录,我得看一眼你放代码的目录,只读不改,可以吗?'))
    fx.turns.handleEvent('sess-ob', user('可以'))
    expect((await post(fx.url, '/onboarding/answer', { stage: 'projects', key: 'read_scan_roots', value: true })).status).toBe(200)
    const located = await post(fx.url, '/onboarding/scan', { name: 'desktop-workbench' })
    expect(located.status).toBe(200)
    expect(located.body.located).toEqual([{ name: 'desktop-workbench', path: '/Users/x/Documents/GitHub/desktop-workbench' }])
    expect(String(located.body.note)).toContain('project.path')
    const recorded = await post(fx.url, '/onboarding/answer', {
      stage: 'projects', key: 'project',
      value: { name: '工作台', one_liner: '桌面事务官', path: '/Users/x/Documents/GitHub/desktop-workbench' },
    })
    expect(recorded.status).toBe(200)
    expect(fx.adopted).toEqual([{ name: '工作台', path: '/Users/x/Documents/GitHub/desktop-workbench' }])
    const index = readFileSync(join(fx.repo, 'docs', '记忆', '项目', '索引.md'), 'utf8')
    expect(index).toContain('| 工作台 | 桌面事务官 |')
    expect(index).toContain('`/Users/x/Documents/GitHub/desktop-workbench`')
    expect(index).not.toContain('| 待定 |')
    expect(readFileSync(join(fx.repo, 'docs', '记忆', '项目', '工作台.md'), 'utf8')).toContain('- **路径**:`/Users/x/Documents/GitHub/desktop-workbench`')
  })
})

describe('E:扫描进度只报引导 / 她主动发起的那一次', () => {
  it('项目区自己扫(GET /state)不动 scan/status;引导的全量扫描走 scanForOnboarding,不走项目区那一份', async () => {
    const fx = await serve()
    await getJson(fx.url, '/state')
    expect((await getJson(fx.url, '/onboarding/scan/status')).body).toEqual({ scanning: false, done: 0 })
    await walkToBranch(fx)
    await answerBranchAndTemplate(fx)
    fx.turns.handleEvent('sess-ob', assistant('为了找到它、读读它的说明和最近的记录,我得看一眼你放代码的目录,只读不改,可以吗?'))
    fx.turns.handleEvent('sess-ob', user('可以,你帮我找找'))
    await post(fx.url, '/onboarding/answer', { stage: 'projects', key: 'read_scan_roots', value: true })
    const before = fx.areaScans.n
    expect((await post(fx.url, '/onboarding/scan', {})).status).toBe(200)
    expect(fx.areaScans.n).toBe(before)
    expect((await getJson(fx.url, '/onboarding/scan/status')).body).toMatchObject({ scanning: false, done: 1, total: 1 })
    expect((await getJson(fx.url, '/onboarding/turns')).body.scan).toMatchObject({ done: 1, total: 1 })
  })
})

/** 走到 ③ 授权(②′ 用 done 收掉)。 */
async function walkToAuthorization(fx: Awaited<ReturnType<typeof serve>>) {
  await walkToBranch(fx)
  await answerBranchAndTemplate(fx)
  expect((await post(fx.url, '/onboarding/answer', { stage: 'projects', key: 'done', value: true })).status).toBe(200)
  expect(fx.onboarding.detail().stage).toBe('authorization')
}

describe('系统授权(辅助功能)在 ③ 授权阶段出现', () => {
  it('turns 带 system_auth(ask / why / open);没问出口 POST /onboarding/system-auth 409;他点头才弹框 + 打开设置页', async () => {
    const fx = await serve()
    expect((await getJson(fx.url, '/onboarding/turns')).body.system_auth).toMatchObject({ accessibility: 'missing', ask: false })
    await walkToAuthorization(fx)
    const view = (await getJson(fx.url, '/onboarding/turns')).body.system_auth
    expect(view).toEqual({
      accessibility: 'missing',
      ask: true,
      why: SYSTEM_AUTH_WHY,
      open: { method: 'POST', path: '/setup/open', body: { pane: 'accessibility' } },
      // 2026-10-13 多出来的第二样授权:完全磁盘访问(手机看文件要它)。
      // 这台假机器没接体检服务 ⇒ 'unknown'(判断不了),引导那一条看到 unknown 就整个不提。
      file_access: 'unknown',
      file_access_why: FILE_ACCESS_WHY,
      file_access_open: { method: 'POST', path: '/setup/open', body: { pane: 'all_files' } },
    })
    expect((await getJson(fx.url, '/onboarding/system-auth')).body).toMatchObject({ ask: true })

    fx.turns.handleEvent('sess-ob', assistant('接下来是我能做什么。先说清楚:删文件、改代码、碰凭据这些我永远不会请求。'))
    fx.turns.handleEvent('sess-ob', user('好'))
    const blocked = await post(fx.url, '/onboarding/system-auth', {})
    expect(blocked.status).toBe(409)
    expect(fx.openedPanes).toEqual([])
    expect(fx.helperRequests).toEqual([])

    fx.turns.handleEvent('sess-ob', assistant(`${SYSTEM_AUTH_WHY}我现在帮你把那一页打开,可以吗?`))
    fx.turns.handleEvent('sess-ob', user('可以'))
    const opened = await post(fx.url, '/onboarding/system-auth', {})
    expect(opened.status).toBe(200)
    expect(fx.helperRequests).toEqual([{ op: 'request_accessibility' }])
    expect(fx.openedPanes).toEqual(['accessibility'])

    // 开好了:ask 撤掉,再按一次只说「已经开着了」。
    fx.grantAx()
    expect((await getJson(fx.url, '/onboarding/turns')).body.system_auth).toMatchObject({ accessibility: 'granted', ask: false })
    expect((await post(fx.url, '/onboarding/system-auth', {})).body).toMatchObject({ ok: true, already: true })
  })

  it('③ 授权那一段的第一条消息里讲清为什么要、怎么触发', async () => {
    const fx = await serve()
    await walkToAuthorization(fx)
    const detail = (await getJson(fx.url, '/onboarding')).body as { next: { goals: string[] } }
    const goal = detail.next.goals.find(line => line.includes('系统授权')) ?? ''
    expect(goal).toContain(SYSTEM_AUTH_WHY)
    expect(goal).toContain('POST /onboarding/system-auth')
    expect(goal).toContain('GET /onboarding/system-auth')
  })
})

describe('K:问出口的一项答非所问,收这一段之前要追问', () => {
  it('「开口说还是发文字」→「没有了」→ habits.done 409;按默认记 channel 之后才收', async () => {
    const fx = await serve()
    await walkToAuthorization(fx)
    const auth: [string, unknown, string][] = [
      ['write_docs', true, '第一件,写你的记忆文件,顺手还能提交一份版本。这个算可以、要问,还是不可以?'],
      ['write_commit', true, '第一件,写你的记忆文件,顺手还能提交一份版本。这个算可以、要问,还是不可以?'],
      ['write_api', true, '第二件:调工作台的写接口——建事项、往收件箱塞一条、挪看板。给不给?'],
      ['read_client_files', false, '最后一件:Claude、Codex、Kimi 里记着的东西,能读吗?'],
    ]
    for (const [key, value, asked] of auth) {
      fx.turns.handleEvent('sess-ob', assistant(asked))
      fx.turns.handleEvent('sess-ob', user(value === false ? '不用' : '给'))
      expect((await post(fx.url, '/onboarding/answer', { stage: 'authorization', key, value })).status).toBe(200)
    }
    expect(fx.onboarding.detail().stage).toBe('habits')
    fx.turns.handleEvent('sess-ob', assistant('那我是开口说,还是发文字给你?'))
    fx.turns.handleEvent('sess-ob', user('没有了'))
    const blocked = await post(fx.url, '/onboarding/answer', { stage: 'habits', key: 'done', value: true })
    expect(blocked.status).toBe(409)
    expect(String(blocked.body.error)).toContain('追问一次')
    expect(String(blocked.body.error)).toContain('文字为主(默认,他没明说)')
    expect((await post(fx.url, '/onboarding/answer', { stage: 'habits', key: 'channel', value: '文字为主(默认,他没明说)' })).status).toBe(200)
    expect((await post(fx.url, '/onboarding/answer', { stage: 'habits', key: 'done', value: true })).status).toBe(200)
    expect(fx.onboarding.detail().stage).toBe('persona')
  })
})

/*
 * 2026-09-23 新顺序端到端(维护者第二轮真机:「为什么一开始是布局而不是从新点子或已有项目,这反了啊」):
 * ① 称呼 → ② 分岔(中性一句)→ ①′ 布局(顺着他说的事问)→ ②′ 按布局走。电脑(DSH 会话回合表)与电话(工人带 heard)两条路。
 */
describe('新顺序端到端:称呼 → 分岔 → 布局 → ②′', () => {
  it('电脑那条路:开会话念开场白,每一段第一条消息 / turns 的种子句都按新顺序换,运营 + 新点子走到 ②′ 新号再到 ③', async () => {
    const fx = await serve()
    const opened = await post(fx.url, '/onboarding/session', {})
    expect(opened.body).toMatchObject({ stage: 'opening', seed: OPENING_LINE })
    fx.turns.handleEvent('sess-ob', assistant(OPENING_LINE))
    fx.turns.handleEvent('sess-ob', user('叫我小林'))
    const named = await post(fx.url, '/onboarding/answer', { stage: 'opening', key: 'nickname', value: '小林' })
    expect(named.body).toMatchObject({ ok: true, stage: 'branch' })
    expect((named.body.next as { seed: string }).seed).toBe(BRANCH_SEED)
    expect((await getJson(fx.url, '/onboarding/turns')).body).toMatchObject({ stage: 'branch', seed: BRANCH_SEED })

    fx.turns.handleEvent('sess-ob', assistant(`好的小林。${BRANCH_SEED}`))
    fx.turns.handleEvent('sess-ob', user('想从一个新点子开始,想做个讲咖啡的号'))
    const branched = await post(fx.url, '/onboarding/answer', { stage: 'branch', key: 'mode', value: 'fresh' })
    expect(branched.body).toMatchObject({ ok: true, stage: 'template' })
    expect((branched.body.next as { seed: string }).seed).toContain('你说的这件事')
    // 他在分岔里说了「做个号」,她不许当场替他选运营。
    expect((await post(fx.url, '/onboarding/answer', { stage: 'template', key: 'template', value: 'ops' })).status).toBe(409)

    fx.turns.handleEvent('sess-ob', assistant('你说的这个讲咖啡的号,更像是做产品研发,还是做自媒体运营?'))
    fx.turns.handleEvent('sess-ob', user('自媒体'))
    const tpl = await post(fx.url, '/onboarding/answer', { stage: 'template', key: 'template', value: 'ops' })
    expect(tpl.body).toMatchObject({ ok: true, stage: 'projects' })
    expect((tpl.body.next as { seed: string }).seed).toContain('新号')
    const brief = await getJson(fx.url, '/onboarding/brief')
    expect((brief.body.keys as { name: string }[]).map(key => key.name)).toContain('account')
    expect((brief.body.keys as { name: string }[]).map(key => key.name)).not.toContain('read_scan_roots')
    expect(fx.onboarding.detail().plan.slice(0, 4)).toEqual(['opening', 'branch', 'template', 'projects'])

    expect((await post(fx.url, '/onboarding/answer', { stage: 'projects', key: 'done', value: true })).status).toBe(200)
    expect(fx.onboarding.detail().stage).toBe('authorization')
  })

  it('电话那条路(heard):同一个顺序;称呼的「对」不算分岔,分岔里的「做产品」不算布局;产品 + 已有走到 ②′ 问交哪个项目', async () => {
    const fx = await serve()
    const say = (stage: string, key: string, value: unknown, asked: string, reply: string) =>
      post(fx.url, '/onboarding/answer', { stage, key, value, heard: { asked, reply } })

    expect((await say('opening', 'nickname', 'Ben', OPENING_LINE, '叫我 Ben')).body).toMatchObject({ ok: true, stage: 'branch' })
    expect((await getJson(fx.url, '/onboarding/brief')).body).toMatchObject({ stage: 'branch', seed: BRANCH_SEED, speak_seed: true })
    // 称呼复述「对」→ 不算分岔。
    expect((await say('branch', 'mode', 'existing', '我叫你 Ben,对吗?', '对')).status).toBe(409)
    expect((await say('branch', 'mode', 'existing', BRANCH_SEED, '已经有了,我在做个产品')).body).toMatchObject({ ok: true, stage: 'template' })
    // 分岔回答里的「产品」→ 不算布局。
    expect((await say('template', 'template', 'product', BRANCH_SEED, '已经有了,我在做个产品')).status).toBe(409)
    const brief = await getJson(fx.url, '/onboarding/brief')
    expect(brief.body).toMatchObject({ stage: 'template', speak_seed: true })
    expect(String(brief.body.seed)).toContain('更像是做产品研发,还是做自媒体运营')
    expect((await say('template', 'template', 'product', TEMPLATE_ASK, '做产品')).body).toMatchObject({ ok: true, stage: 'projects' })
    const projects = await getJson(fx.url, '/onboarding/brief')
    expect(projects.body.seed).toBe('你想先把哪个项目交给我?说个名字就行,我先只录这一个。')
    expect((projects.body.keys as { name: string }[]).map(key => key.name)).toContain('read_scan_roots')
  })
})

/*
 * 2026-09-23 统筹第三轮从零重装自跑(0.2.77,/onboarding/say 全程)+ 维护者手机真机。
 * 原话回放:AA(门管太宽逼她念「按流程」)、Z(同一授权问两遍)、Y(授权段插习惯题)、
 * X(「提交推上去」)、W(「没了,下一步」还追问)。V / U / T 的话术在 server-onboarding-polish-0923
 * 与 channel-worker/tests/onboarding-polish-0923 里。
 */
const WRITE_ASK = '我会往我这边的记忆文件夹里写你的偏好和项目,每次存一个版本、能翻回去,只在这台电脑上 —— 可以、要问,还是不可以?'

/** ②′ 里先问后看:读目录与读客户端文件都问出口、他点头,再收这一段。 */
async function projectsWithConsent(fx: Awaited<ReturnType<typeof serve>>) {
  await walkToBranch(fx)
  await answerBranchAndTemplate(fx)
  fx.turns.handleEvent('sess-ob', assistant('为了找到它、读读它的说明和最近的记录,我得看一眼你放代码的目录,只读不改,可以吗?'))
  fx.turns.handleEvent('sess-ob', user('可以'))
  expect((await post(fx.url, '/onboarding/answer', { stage: 'projects', key: 'read_scan_roots', value: true })).status).toBe(200)
  fx.turns.handleEvent('sess-ob', assistant('你电脑上 Claude、Codex、Kimi 里各自记着一些东西,我能读一读吗?只读,一个字都不改'))
  fx.turns.handleEvent('sess-ob', user('可以'))
  expect((await post(fx.url, '/onboarding/answer', { stage: 'projects', key: 'read_client_files', value: true })).status).toBe(200)
  expect((await post(fx.url, '/onboarding/answer', { stage: 'projects', key: 'done', value: true })).status).toBe(200)
  expect(fx.onboarding.detail().stage).toBe('authorization')
}

describe('第三轮自跑 Z / X / Y:③ 授权段', () => {
  it('Z:②′ 已答的读目录 / 读客户端文件,③ 里不再列、不再问;不答它们也能推进', async () => {
    const fx = await serve()
    await projectsWithConsent(fx)
    const brief = (await getJson(fx.url, '/onboarding/brief')).body as { keys: { name: string }[], goals: string[] }
    const names = brief.keys.map(key => key.name)
    expect(names).not.toContain('read_scan_roots')
    expect(names).not.toContain('read_client_files')
    expect(names).toEqual(expect.arrayContaining(['write_docs', 'write_commit', 'write_api']))
    expect(brief.goals[0]).toContain('已经答过的授权,这一段不再问')
    expect(brief.goals[0]).toContain('看你放代码的那个目录(可以)')
    expect(brief.goals[0]).toContain('读 Claude、Codex、Kimi 里记着的东西(可以)')
    // 电脑那条路的第一条消息(detail.next)同一份。
    expect(((await getJson(fx.url, '/onboarding')).body as { next: { keys: string[] } }).next.keys).not.toContain('read_scan_roots')

    // X:写记忆与存版本一句问完,两项按他同一个回答记。
    fx.turns.handleEvent('sess-ob', assistant(WRITE_ASK))
    fx.turns.handleEvent('sess-ob', user('可以'))
    expect((await post(fx.url, '/onboarding/answer', { stage: 'authorization', key: 'write_docs', value: true })).status).toBe(200)
    expect((await post(fx.url, '/onboarding/answer', { stage: 'authorization', key: 'write_commit', value: true })).status).toBe(200)
    fx.turns.handleEvent('sess-ob', assistant('再一件:建事项、往收件箱放东西、挪看板,这些要不要让我直接做?默认是不行的'))
    fx.turns.handleEvent('sess-ob', user('先不要'))
    const last = await post(fx.url, '/onboarding/answer', { stage: 'authorization', key: 'write_api', value: false })
    // read_client_files 是 ③ 的必答项,但 ②′ 答过了 —— 不再挡推进。
    expect(last.body).toMatchObject({ ok: true, stage: 'habits' })
    const table = readFileSync(join(fx.repo, 'docs', '记忆', '授权.md'), 'utf8')
    expect(table).toMatch(/read_client_files`[^\n]*\| 可以 \|/)
    expect(table).toContain('不推到任何远端')
    expect(table).not.toContain('push')
  })

  it('X / Y:③ 的清单用准确说法(记忆文件夹、只在这台电脑上),不说「仓库 / 推上去」;这一段只问授权', async () => {
    const fx = await serve()
    await walkToAuthorization(fx)
    const goals = ((await getJson(fx.url, '/onboarding/brief')).body.goals as string[]).join('\n')
    expect(goals).toContain('记忆文件夹')
    expect(goals).toContain('只在这台电脑上')
    expect(goals).not.toMatch(/commit \/ push|写本仓库/)
    expect(goals).toContain('这一段只问授权')
    expect(goals).toContain('作息')
    expect(goals).not.toContain('系统那边')
  })

  it('「重来授权」那一段不带 ②′ 的答案:读客户端文件照样要问', async () => {
    const fx = await serve()
    await projectsWithConsent(fx)
    await post(fx.url, '/onboarding/restart', { scope: 'authorization' })
    const names = ((await getJson(fx.url, '/onboarding/brief')).body.keys as { name: string }[]).map(key => key.name)
    expect(names).toContain('read_client_files')
  })
})

describe('第三轮自跑 AA:普通题他主动说了就收,不逼她「按流程正式问一次」', () => {
  it('取名:她上一句问的是别的,他说「就叫小管家」→ 直接收;人设、称呼同理', async () => {
    const fx = await serve()
    await projectsWithConsent(fx)
    for (const key of ['write_docs', 'write_commit']) {
      fx.turns.handleEvent('sess-ob', assistant(WRITE_ASK))
      fx.turns.handleEvent('sess-ob', user('可以'))
      expect((await post(fx.url, '/onboarding/answer', { stage: 'authorization', key, value: true })).status).toBe(200)
    }
    expect((await post(fx.url, '/onboarding/answer', { stage: 'authorization', key: 'write_api', value: false })).status).toBe(200)
    expect((await post(fx.url, '/onboarding/answer', { stage: 'habits', key: 'done', value: true })).status).toBe(200)
    // ④′ 人设:他没等她念完三种就说了「沉稳点,直说,别太多嘴」—— 直接收,不要求她先问出「人设」两个字。
    fx.turns.handleEvent('sess-ob', assistant('好,这些我都记下了。'))
    fx.turns.handleEvent('sess-ob', user('你就沉着点,有话直说,别太多嘴'))
    expect((await post(fx.url, '/onboarding/answer', { stage: 'persona', key: 'persona', value: '沉稳' })).status).toBe(200)
    expect((await post(fx.url, '/onboarding/answer', { stage: 'persona', key: 'candor', value: 4 })).status).toBe(200)
    expect((await post(fx.url, '/onboarding/answer', { stage: 'persona', key: 'verbosity', value: 2 })).status).toBe(200)
    expect(fx.onboarding.detail().stage).toBe('naming')
    // ④″ 取名:真机原话。上一句她说的是人设的复述,他直接说了名字。
    fx.turns.handleEvent('sess-ob', assistant('那我就话少一点,先说结论。'))
    fx.turns.handleEvent('sess-ob', user('就叫小管家'))
    const named = await post(fx.url, '/onboarding/answer', { stage: 'naming', key: 'butler_name', value: '小管家' })
    expect(named.status).toBe(200)
    expect(named.body).toMatchObject({ ok: true, stage: 'wrapup' })
  })

  it('分岔 / 布局那道门还在,而且被拦的话里明说「别跟他说按流程」', async () => {
    const fx = await serve()
    await walkToBranch(fx)
    const blocked = await post(fx.url, '/onboarding/answer', { stage: 'branch', key: 'mode', value: 'existing' })
    expect(blocked.status).toBe(409)
    expect(String(blocked.body.error)).toContain('别跟他说「按流程」')
    expect(String(blocked.body.error)).not.toContain('先把这一题问出口')
  })
})

describe('第三轮自跑 W:他说「没了,下一步」,本段就收', () => {
  it('问过「开口说还是发文字」,他答「没了,下一步」→ 409 只让她按默认记并明说,不再追问', async () => {
    const fx = await serve()
    await projectsWithConsent(fx)
    for (const key of ['write_docs', 'write_commit']) {
      fx.turns.handleEvent('sess-ob', assistant(WRITE_ASK))
      fx.turns.handleEvent('sess-ob', user('可以'))
      await post(fx.url, '/onboarding/answer', { stage: 'authorization', key, value: true })
    }
    await post(fx.url, '/onboarding/answer', { stage: 'authorization', key: 'write_api', value: false })
    expect(fx.onboarding.detail().stage).toBe('habits')
    fx.turns.handleEvent('sess-ob', assistant('那我是开口说,还是发文字给你?'))
    fx.turns.handleEvent('sess-ob', user('没了,下一步'))
    const blocked = await post(fx.url, '/onboarding/answer', { stage: 'habits', key: 'done', value: true })
    expect(blocked.status).toBe(409)
    expect(String(blocked.body.error)).toContain('别再追问')
    expect(String(blocked.body.error)).not.toContain('追问一次')
    expect((await post(fx.url, '/onboarding/answer', { stage: 'habits', key: 'channel', value: '文字为主(默认,他没明说)' })).status).toBe(200)
    expect((await post(fx.url, '/onboarding/answer', { stage: 'habits', key: 'done', value: true })).body).toMatchObject({ ok: true, stage: 'persona' })
  })
})
