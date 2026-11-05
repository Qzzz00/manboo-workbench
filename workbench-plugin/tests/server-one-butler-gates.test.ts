// @vitest-environment node
/**
 * 「同一个事务官」那道门(2026-09-23,docs/设计-同一个事务官-2026-09-23.md)。
 *
 * Ben 原话:
 *
 * > 「我希望电脑上的事务官和手机上的事务官是一种数字分身的概念,而不是两个人,
 * >  更不是两个权限不同的人。」
 *
 * 于是这一份钉的不是某一条路由,是**一条口径**:
 *
 * 1. **事务官的事** —— 需求卡、选题卡、复盘、技能、派活 —— 配对过的设备与本机**同权**;
 * 2. **这台机器的装配** —— 配对、钩子、路径配置、Finder、窗位叠、光圈 —— 仍然只认本机,
 *    而且理由换了:不是"手机权限低",是那件事**在手机上没有意义**(它动的是这台 Mac 自己);
 * 3. **陌生来源**(没配对过、没令牌)一个字都办不了 —— 放宽的是"她的另一台设备",不是"外面"。
 *
 * 两条路都验:手机在局域网里**直连 8791 带令牌**,以及出了局域网**经房间代理**
 * (工人在回环上转发、带 `X-Workbench-Channel-Device` 降权)。两条该拿到一模一样的答案。
 *
 * 全程在 `mkdtemp` 出来的临时目录与临时 HOME 里跑,一个字节不碰真实的 `~/.dsh`
 * (2026-09-04 家目录被删事故之后的纪律)。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import type { ProjectsState, WorkbenchLayout } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createAppConfig } from '../src/server/appConfig.ts'
import { createPairingService } from '../src/server/devices.ts'
import type { ProjectsService } from '../src/server/projectsService.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createTemplateService } from '../src/server/templateStore.ts'
import { DEFAULT_LANDSCAPE_MODULES } from '../src/client/layout.ts'

/** 本机仓库根(tests/ 的上两级)。技能那两条真要读仓库里的技能正文。 */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')
const NOW_SEC = Math.floor(Date.parse('2026-09-23T09:00:00Z') / 1000)
const NEED = '把座机页的时钟字号调大一号'

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  // **只删自己 mkdtemp 出来的那几个**(2026-09-04 的纪律)。
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

interface Harness {
  url: string
  /** 下一条请求装成从哪个地址来。'local' = 回环,'phone' = 局域网上那台手机。 */
  who: (value: 'local' | 'phone') => void
  token: string
  deviceId: string
  /** 这张需求卡的 id(kind:'feature',挂着一个有本机路径的项目)。 */
  featureId: string
}

function fakeProjects(path: string): ProjectsService {
  const state: ProjectsState = {
    projects: [{
      id: 'p-1',
      name: '工作台',
      stage: 'dev' as never,
      path,
      links: [],
      session_count: 0,
      idle: true,
    }],
    pending: [],
    scan_errors: [],
    scanned_at: '',
  }
  return { getProjectsState: async () => state, getLayout: async () => undefined } as unknown as ProjectsService
}

/**
 * `openDoor` = 「允许手机在局域网访问」那个开关。关着(缺省)时非回环来源连门口都到不了
 * —— 那正是"陌生来源"该撞上的第一道门。
 */
async function serve(opts: { openDoor?: boolean } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'wb-one-butler-'))
  dirs.push(dir)
  const home = join(dir, 'home')
  const repo = join(dir, '她的项目')

  let layout: WorkbenchLayout | undefined = {
    modules: [],
    butler: { corner: 'br', min: false },
    landscape: { modules: DEFAULT_LANDSCAPE_MODULES.map(one => ({ ...one })) },
  }
  const template = createTemplateService({
    file: join(dir, 'template.json'),
    backupsDir: join(dir, 'backups'),
    readLayout: () => Promise.resolve(layout),
    writeLayout: (next) => { layout = next; return Promise.resolve() },
  })
  await template.load()

  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${++n}` })
  const pairing = createPairingService({ file: join(dir, 'devices.json'), now: () => NOW_SEC })

  let actor: 'local' | 'phone' = 'local'
  let tick = 0
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    tasks,
    pairing,
    template,
    projects: fakeProjects(repo),
    butlerSession: { open: async () => 'sess-1', say: async () => true },
    remoteAddress: (_req: IncomingMessage) => (actor === 'local' ? '127.0.0.1' : '192.168.1.20'),
    ...(opts.openDoor === true ? { isRemoteAllowed: () => true } : {}),
    paths: {
      config: createAppConfig({ file: join(dir, 'app.json') }),
      home,
      // 仓库根走**真实**的这一个:技能正文要真读得到。写只写进临时 HOME。
      moduleDir: `${REPO_ROOT}/workbench-plugin/src/server`,
      applyHooks: {
        files: { claude: join(home, '.claude', 'settings.json'), codex: join(home, '.codex', 'hooks.json') },
        now: () => new Date(2026, 8, 23, 23, 30, tick++),
      },
    },
  })
  started.push(server)

  pairing.start()
  const code = pairing.current()?.code ?? ''
  const claimed = await pairing.claim({ code, device_name: '手机', platform: 'android' })
  if (!claimed.ok) throw new Error('测试装置:配对没成')

  const created = await fetch(`${server.url}/task/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: NEED, kind: 'feature', project_id: 'p-1' }),
  })
  const featureId = String(((await created.json()) as { id: string }).id)

  return {
    url: server.url,
    who: (value) => { actor = value },
    token: claimed.token,
    deviceId: claimed.device_id,
    featureId,
  }
}

interface Answer { status: number, error: string }

async function read(res: Response): Promise<Answer> {
  const text = await res.text()
  const body = (text === '' ? {} : JSON.parse(text)) as { error?: string }
  return { status: res.status, error: body.error ?? '' }
}

/** 本机(回环、不带任何头)。 */
async function asLocal(h: Harness, method: string, path: string, body?: unknown): Promise<Answer> {
  h.who('local')
  return read(await fetch(`${h.url}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
}

/** 出了局域网:工人在回环上替这台手机转发,带 `X-Workbench-Channel-Device` 降权。 */
async function viaRoom(h: Harness, method: string, path: string, body?: unknown, deviceId?: string): Promise<Answer> {
  h.who('local')
  return read(await fetch(`${h.url}${path}`, {
    method,
    headers: {
      'x-workbench-channel-device': deviceId ?? h.deviceId,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
}

/** 在家里:手机直连 8791,带设备令牌。 */
async function onLan(h: Harness, method: string, path: string, body?: unknown, token?: string): Promise<Answer> {
  h.who('phone')
  const answer = read(await fetch(`${h.url}${path}`, {
    method,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token ?? h.token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  h.who('local')
  return answer
}

/** 陌生来源:非回环,什么都不带。 */
async function asStranger(h: Harness, method: string, path: string, body?: unknown): Promise<Answer> {
  h.who('phone')
  const answer = read(await fetch(`${h.url}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  h.who('local')
  return answer
}

/**
 * 「事务官的事」那一族。每一条给一组**够到门后面那一层**的参数 ——
 * 验的是「不再是那句 403」,而不是「这一趟办成了」(办成不办成各自的用例管)。
 */
function butlerBusiness(h: Harness): { name: string, method: string, path: string, body?: unknown }[] {
  return [
    // 需求卡指挥台(八条同一道门,抽三条有代表性的:读、把关、★发版)
    { name: '/feature/docs', method: 'POST', path: '/feature/docs', body: { id: h.featureId } },
    { name: '/feature/record', method: 'POST', path: '/feature/record', body: { id: h.featureId } },
    { name: '/feature/ship', method: 'POST', path: '/feature/ship', body: { id: h.featureId } },
    // 选题卡指挥台
    { name: '/topic/docs', method: 'POST', path: '/topic/docs', body: { name: '一条选题' } },
    { name: '/topic/run', method: 'POST', path: '/topic/run', body: { id: 't-1', name: '一条选题' } },
    // 复盘
    { name: '/topic/<名>/review', method: 'POST', path: '/topic/%E4%B8%80%E6%9D%A1/review', body: {} },
    // 事务官的技能
    { name: '/config/skill/apply', method: 'POST', path: '/config/skill/apply', body: {} },
    { name: '/config/ops-skills/apply', method: 'POST', path: '/config/ops-skills/apply', body: {} },
    // 派活两只手
    { name: '/dispatch/client', method: 'POST', path: '/dispatch/client', body: { app: 'claude', text: '看一下这段' } },
    { name: '/dispatch/api', method: 'POST', path: '/dispatch/api', body: { app: 'gpt', text: '写条文案' } },
  ]
}

/**
 * 「这台机器的装配」那一族。**留在只认本机**,而且每一条都说得出为什么它在手机上没有意义。
 * 每一条都挑**门在最前面**的那种(门后面那一层没接线会回 404,那就验不出门了)。
 */
const MACHINE_ONLY: { name: string, method: string, path: string, body?: unknown, why: string }[] = [
  { name: '/pair/start', method: 'POST', path: '/pair/start', why: '配对本身:发码的那一头必须是这台机器' },
  { name: '/pair/revoke', method: 'POST', path: '/pair/revoke', body: { id: 'x' }, why: '解除配对:不能让一台设备把别的设备踢掉' },
  { name: '/lan', method: 'POST', path: '/lan', body: { enabled: true }, why: '这台机器对外开不开门' },
  { name: '/config/paths', method: 'PUT', path: '/config/paths', body: {}, why: '这台机器上的目录在哪' },
  { name: '/config/hooks/apply', method: 'POST', path: '/config/hooks/apply', body: { agent: 'claude' }, why: '这台机器上每一条 DSH 会话怎么起' },
  { name: '/topic/open', method: 'POST', path: '/topic/open', body: { name: '一条选题' }, why: '在这台 Mac 上弹一扇 Finder 窗' },
  { name: '/topic/assets', method: 'POST', path: '/topic/assets', body: { names: [] }, why: '列这台 Mac 盘上的文件名' },
  { name: '/dock/veil', method: 'POST', path: '/dock/veil', body: { on: true }, why: '这台 Mac 屏幕上的窗位叠' },
  { name: '/highlight', method: 'POST', path: '/highlight', body: { region: null }, why: '这台 Mac 屏幕上的一圈光' },
  { name: '/shell/window-mode', method: 'POST', path: '/shell/window-mode', body: { mode: 'front' }, why: '壳自己那扇窗的层级' },
  { name: '/debug/helper', method: 'POST', path: '/debug/helper', body: { op: 'ax_probe' }, why: '壳的排障透传口' },
  { name: '/butler/start', method: 'POST', path: '/butler/start', why: '本机后端(8792)的启停' },
]

describe('「事务官的事」:配对过的设备与本机同权(Ben 2026-09-23 拍板)', () => {
  it('★ 经房间代理的手机,这一族一条都不再撞「只能在本机」那句 403', async () => {
    const h = await serve()
    for (const one of butlerBusiness(h)) {
      const answer = await viaRoom(h, one.method, one.path, one.body)
      expect(answer.status, `${one.name} 不该 403`).not.toBe(403)
      expect(answer.status, `${one.name} 不该 401`).not.toBe(401)
    }
  })

  it('★ 局域网里直连带令牌的手机,拿到的与经房间代理**逐条一模一样**', async () => {
    const h = await serve({ openDoor: true })
    for (const one of butlerBusiness(h)) {
      const room = await viaRoom(h, one.method, one.path, one.body)
      const lan = await onLan(h, one.method, one.path, one.body)
      expect(lan.status, `${one.name} 两条路该同一个答案`).toBe(room.status)
    }
  })

  it('需求卡四个页签:手机读回来的与本机读回来的是同一份', async () => {
    const h = await serve()
    const local = await asLocal(h, 'POST', '/feature/docs', { id: h.featureId })
    const phone = await viaRoom(h, 'POST', '/feature/docs', { id: h.featureId })
    expect(local.status).toBe(200)
    expect(phone.status).toBe(200)
  })

  it('★ /feature/ship:手机按得动(Ben 明知——按一下会合并 main 并发一版)', async () => {
    const h = await serve()
    const answer = await viaRoom(h, 'POST', '/feature/ship', { id: h.featureId })
    // 这一版 selfShip 没接线,所以到得了门后面那一层就该是 404「未接线」而不是 403「只能在本机」。
    expect(answer.status).not.toBe(403)
    expect(answer.error).not.toContain('只能在本机')
  })

  it('派活两只手:手机按得动(派活是事务官的核心活,不是机器的事)', async () => {
    const h = await serve()
    // 窗口编排壳在用例里没接(它要一个真的壳进程),所以门后面那一层是 404「未接入」——
    // 要紧的是**不再是 403「只能在本机」**。
    const win = await viaRoom(h, 'POST', '/dispatch/client', { app: 'claude', text: '看一下这段' })
    expect(win.status).toBe(404)
    expect(win.error).toContain('窗口编排壳未接入')
    // 接口那只手没接模型服务 → 404「模型服务未接入」,**不是** 403。
    const api = await viaRoom(h, 'POST', '/dispatch/api', { app: 'gpt', text: '写条文案' })
    expect(api.status).toBe(404)
    expect(api.error).toContain('模型服务未接入')
  })

  it('技能:手机接得上(技能是事务官自己的能力,与钩子分道扬镳)', async () => {
    const h = await serve()
    const skill = await viaRoom(h, 'POST', '/config/skill/apply', {})
    expect(skill.status).toBe(200)
    const ops = await viaRoom(h, 'POST', '/config/ops-skills/apply', {})
    expect(ops.status).toBe(200)
  })
})

describe('「这台机器的装配」:仍然只认本机', () => {
  it('★ 经房间代理的手机,这一族逐条 403 —— 不是权限低,是那件事在手机上没有意义', async () => {
    const h = await serve()
    for (const one of MACHINE_ONLY) {
      const answer = await viaRoom(h, one.method, one.path, one.body)
      expect(answer.status, `${one.name}(${one.why})该 403`).toBe(403)
      expect(answer.error, `${one.name} 该说一句人话`).not.toBe('')
    }
  })

  it('本机自己打同一族:门是开的(403 来自这道门,不是路由本身坏了)', async () => {
    const h = await serve()
    for (const one of MACHINE_ONLY) {
      const answer = await asLocal(h, one.method, one.path, one.body)
      expect(answer.status, `${one.name} 在本机上不该是 403`).not.toBe(403)
    }
  })

  it('局域网里直连带令牌的手机,这一族一样 403', async () => {
    const h = await serve({ openDoor: true })
    for (const one of MACHINE_ONLY) {
      expect((await onLan(h, one.method, one.path, one.body)).status, one.name).toBe(403)
    }
  })
})

describe('陌生来源:放宽的是「她的另一台设备」,不是「外面」', () => {
  it('★ 没配对、没令牌的非本机来源,「事务官的事」那一族一条都进不去', async () => {
    const h = await serve()
    for (const one of butlerBusiness(h)) {
      // 开关关着:连门口都到不了(来源门 403)。
      expect((await asStranger(h, one.method, one.path, one.body)).status, one.name).toBe(403)
    }
  })

  it('门开着但不带令牌 → 401「先在工作台设置里配对」,不是悄悄放行', async () => {
    const h = await serve({ openDoor: true })
    for (const one of butlerBusiness(h)) {
      const answer = await asStranger(h, one.method, one.path, one.body)
      expect(answer.status, one.name).toBe(401)
      expect(answer.error).toContain('配对')
    }
  })

  it('令牌是伪造的 → 401,不退回任何权限', async () => {
    const h = await serve({ openDoor: true })
    const answer = await onLan(h, 'POST', '/feature/docs', { id: h.featureId }, 'not-a-real-token')
    expect(answer.status).toBe(401)
  })

  it('★ 认不出的设备 id 经房间过来 → 401,**绝不退回回环全权**', async () => {
    const h = await serve()
    const answer = await viaRoom(h, 'POST', '/feature/docs', { id: h.featureId }, 'no-such-device')
    expect(answer.status).toBe(401)
    expect(answer.error).toContain('没配对过')
  })
})
