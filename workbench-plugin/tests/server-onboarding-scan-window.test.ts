// @vitest-environment node
/**
 * 引导里「她去找 / 读你的项目」那一整段等待的窗口(2026-09-24 傍晚,卡 fix/scan-orb-working-whole-wait)。
 * 维护者:「扫描的时候,粒子球应该变成工作的状态……」—— 从动手找那一刻到她开口说结果,球一直是执行中;她一开口就回去。
 *
 * 钉住(onboardingActivity.ts + http.ts 那两条路由):
 *   ① 找 / 读一开始就是 `scanning:true`(带 phase 与名字);同一个请求里「按名字找完紧接着读」之间不断;
 *   ② DSH 那条路(开窗时引导会话那一轮在跑):活儿做完不收(`held`),**回合表里她的下一句**一出来就收;
 *      这一轮收场了她一句没说也收;保险时限到了也收;
 *   ③ 电话那条路(DSH 那一轮没在跑):活儿做完就收(她开口由手机本地看);
 *   ④ 窗口编号 `id`:开着时是这一段,收了留着最后那一段的号;一次都没开过时原样交出项目区那一份。
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { ProjectsState } from '../src/protocol.ts'
import { createAuthorizationService } from '../src/server/authorization.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { ACTIVITY_HOLD_MAX_MS, createOnboardingActivity, type ActivityTurns } from '../src/server/onboardingActivity.ts'
import { createOnboardingService } from '../src/server/onboarding.ts'
import { createOnboardingTurns } from '../src/server/onboardingTurns.ts'
import type { ProjectsService, ScanProgress } from '../src/server/projectsService.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FULL_PLAN } from '../src/server/onboardingStages.ts'

/** 一个可控的「项目区扫描进度」+ 回合表。 */
function rig(options: { busy?: boolean } = {}) {
  let progress: ScanProgress = { scanning: false, done: 0 }
  let clock = 1_000_000
  let busy = options.busy ?? false
  const turns: { seq: number, role: 'user' | 'assistant' }[] = []
  const fakeTurns: ActivityTurns = {
    busy: () => busy,
    lastSeq: () => turns.reduce((max, turn) => Math.max(max, turn.seq), 0),
    spokeAfter: seq => turns.some(turn => turn.seq > seq && turn.role === 'assistant'),
  }
  const activity = createOnboardingActivity({ progress: () => ({ ...progress }), turns: fakeTurns, now: () => clock })
  return {
    activity,
    set: (next: ScanProgress) => { progress = next },
    advance: (ms: number) => { clock += ms },
    setBusy: (next: boolean) => { busy = next },
    say: (role: 'user' | 'assistant') => { turns.push({ seq: turns.length + 1, role }) },
    reset: () => { turns.length = 0 },
  }
}

/** 一个能从外面放行的活儿。 */
function gated() {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  return { gate, release: () => release() }
}

describe('窗口(纯):开 / 中间不断 / 收', () => {
  it('一次都没开过:原样交出项目区那一份(老用例一字不变)', () => {
    const r = rig()
    r.set({ scanning: true, phase: 'repos', done: 3, total: 13, current: 'aiboo' })
    expect(r.activity.view()).toEqual({ scanning: true, phase: 'repos', done: 3, total: 13, current: 'aiboo' })
  })

  it('★按名字找完紧接着读:同一个请求里两段之间照样 scanning:true(不闪回),显示的是最后那一段', async () => {
    const r = rig()
    const between = gated()
    const reading = gated()
    const run = r.activity.run(async () => {
      r.set({ scanning: true, phase: 'list', done: 0 })
      expect(r.activity.view()).toMatchObject({ scanning: true, phase: 'list', id: 1 })
      r.set({ scanning: false, done: 0, finished_at: '2026-09-24T10:00:00.000Z' })
      await between.gate
      r.set({ scanning: true, phase: 'read', done: 0, current: 'desktop-workbench' })
      await reading.gate
      r.set({ scanning: false, done: 0, finished_at: '2026-09-24T10:00:01.000Z', last_read: 'desktop-workbench' })
    })
    // 两段之间:项目区那一份已经 scanning:false,窗口照样开着。
    expect(r.activity.view()).toMatchObject({ scanning: true, phase: 'list', id: 1 })
    expect(r.activity.view().held).toBeUndefined()
    between.release()
    await Promise.resolve()
    await Promise.resolve()
    expect(r.activity.view()).toMatchObject({ scanning: true, phase: 'read', current: 'desktop-workbench', id: 1 })
    reading.release()
    await run
    // 电话那条路(DSH 那一轮没在跑):活儿做完就收,留着这一段的号与 last_read。
    expect(r.activity.view()).toMatchObject({ scanning: false, last_read: 'desktop-workbench', id: 1 })
  })

  it('★DSH 那条路:活儿做完不收(held,显示最后读的那个),她的下一句一出来就收', async () => {
    const r = rig({ busy: true })
    r.say('user')
    await r.activity.run(async () => {
      r.set({ scanning: true, phase: 'read', done: 0, current: 'desktop-workbench' })
      r.set({ scanning: false, done: 0, finished_at: '2026-09-24T10:00:01.000Z', last_read: 'desktop-workbench' })
    })
    expect(r.activity.view()).toMatchObject({ scanning: true, held: true, phase: 'read', current: 'desktop-workbench', id: 1 })
    // 他又说了一句(还没轮到她):不收。
    r.say('user')
    expect(r.activity.view()).toMatchObject({ scanning: true, held: true })
    r.say('assistant')
    const after = r.activity.view()
    expect(after).toMatchObject({ scanning: false, id: 1, last_read: 'desktop-workbench' })
    expect(after.held).toBeUndefined()
  })

  it('开窗之前她说的那句(「我看一下」)不算她的下一句', async () => {
    const r = rig({ busy: true })
    r.say('assistant')
    await r.activity.run(async () => { r.set({ scanning: false, done: 0, finished_at: 'x' }) })
    expect(r.activity.view()).toMatchObject({ scanning: true, held: true })
  })

  it('DSH 那一轮收场了、她一句没说:收', async () => {
    const r = rig({ busy: true })
    await r.activity.run(async () => { r.set({ scanning: false, done: 0, finished_at: 'x' }) })
    expect(r.activity.view().scanning).toBe(true)
    r.setBusy(false)
    expect(r.activity.view().scanning).toBe(false)
  })

  it('保险时限:活儿做完 30 秒她还没开口,收;没到不收', async () => {
    const r = rig({ busy: true })
    await r.activity.run(async () => { r.set({ scanning: false, done: 0, finished_at: 'x' }) })
    r.advance(ACTIVITY_HOLD_MAX_MS - 1)
    expect(r.activity.view().scanning).toBe(true)
    r.advance(1)
    expect(r.activity.view().scanning).toBe(false)
  })

  it('回合表被清了(从头来):等的那句不会来了,收', async () => {
    const r = rig({ busy: true })
    r.say('user'); r.say('assistant'); r.say('user')
    await r.activity.run(async () => { r.set({ scanning: false, done: 0, finished_at: 'x' }) })
    expect(r.activity.view().scanning).toBe(true)
    r.reset()
    expect(r.activity.view().scanning).toBe(false)
  })

  it('held 着又来一段活儿(她一口气 curl 两次):接着算同一段,号不变;都做完之后她开口才收', async () => {
    const r = rig({ busy: true })
    await r.activity.run(async () => { r.set({ scanning: false, done: 0, finished_at: 'a' }) })
    expect(r.activity.view()).toMatchObject({ scanning: true, id: 1, held: true })
    await r.activity.run(async () => { r.set({ scanning: false, done: 0, finished_at: 'b', last_read: 'x' }) })
    expect(r.activity.view()).toMatchObject({ scanning: true, id: 1, held: true, phase: 'read', current: 'x' })
    r.say('assistant')
    expect(r.activity.view()).toMatchObject({ scanning: false, id: 1 })
    // 下一段是新的号。
    await r.activity.run(async () => { r.set({ scanning: false, done: 0, finished_at: 'c' }) })
    expect(r.activity.view()).toMatchObject({ scanning: true, id: 2 })
  })

  it('这一段一次都没碰过项目区那一份(路径被拒):显示笼统那句,不拿上一段的 last_read 冒充', async () => {
    const r = rig({ busy: true })
    r.set({ scanning: false, done: 0, finished_at: 'old', last_read: '上一个项目' })
    await r.activity.run(async () => { /* 门后面拒了,一个字节都没读 */ })
    const view = r.activity.view()
    expect(view).toMatchObject({ scanning: true, held: true })
    expect(view.phase).toBeUndefined()
    expect(view.current).toBeUndefined()
  })

  it('全量扫描做完在等她:显示「已看 N/M」那一份', async () => {
    const r = rig({ busy: true })
    await r.activity.run(async () => {
      r.set({ scanning: true, phase: 'repos', done: 5, total: 13, current: 'aiboo' })
      expect(r.activity.view()).toMatchObject({ scanning: true, phase: 'repos', done: 5, total: 13 })
      r.set({ scanning: false, done: 13, total: 13, finished_at: 'x' })
    })
    expect(r.activity.view()).toMatchObject({ scanning: true, held: true, phase: 'repos', done: 13, total: 13 })
  })

  it('活儿抛了也照样收(不留一个永远在「找」的窗口)', async () => {
    const r = rig()
    await expect(r.activity.run(async () => { throw new Error('git 不见了') })).rejects.toThrow('git 不见了')
    expect(r.activity.view()).toMatchObject({ scanning: false, id: 1 })
  })
})

/* ———————————————————————— HTTP:两条路由真的在窗口里 ———————————————————————— */

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const NOW_SEC = Math.floor(Date.parse('2026-09-24T10:00:00Z') / 1000)

function state(): ProjectsState {
  return { projects: [], pending: [], scan_errors: [], scanned_at: '2026-09-24T09:59:30Z' }
}

/** 项目区:按名字找回两个像的(不顺手读),找的时候推进进度;可以从外面卡住。 */
function fakeProjects() {
  let progress: ScanProgress = { scanning: false, done: 0 }
  let hold: Promise<void> | undefined
  const service = {
    getProjectsState: async () => state(),
    confirmStatus: async () => true,
    setDdl: async () => true,
    addRule: async () => {},
    getLayout: async () => undefined,
    setLayout: async () => {},
    invalidateScanCache: () => {},
    scanProgress: () => ({ ...progress }),
    locate: async (_query: string) => {
      progress = { scanning: true, phase: 'list', done: 0, started_at: '2026-09-24T10:00:00.000Z' }
      if (hold !== undefined) await hold
      progress = { scanning: false, done: 0, finished_at: '2026-09-24T10:00:00.000Z' }
      return { matches: [{ name: 'desktop-workbench', path: '/x/desktop-workbench' }, { name: 'workbench-notes', path: '/x/workbench-notes' }], errors: [] }
    },
  } as unknown as ProjectsService
  return { service, holdWith: (gate: Promise<void> | undefined) => { hold = gate } }
}

async function serve() {
  const root = mkdtempSync(join(tmpdir(), 'wb-scan-window-'))
  dirs.push(root)
  const repoRoot = join(root, 'repo')
  mkdirSync(join(repoRoot, 'docs', '记忆', '项目'), { recursive: true })
  writeFileSync(join(repoRoot, 'README.md'), 'x\n')
  execFileSync('git', ['init', '-q'], { cwd: repoRoot })
  execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repoRoot })
  const agentsFile = join(root, 'AGENTS.md')
  writeFileSync(agentsFile, '# 事务官\n')
  const authorization = createAuthorizationService({ file: join(repoRoot, 'docs', '记忆', '授权.md') })
  const onboarding = createOnboardingService({ plan: FULL_PLAN, file: join(root, 'onboarding.json'), repoRoot, agentsFile, authorization, now: () => new Date(NOW_SEC * 1000) })
  await onboarding.load()
  await authorization.set('read_scan_roots', '可以', '2026-09-24')
  const onboardingTurns = createOnboardingTurns({ now: () => new Date(NOW_SEC * 1000) })
  const projects = fakeProjects()
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    onboarding,
    authorization,
    onboardingTurns,
    projects: projects.service,
  })
  started.push(server)
  return { url: server.url, onboardingTurns, projects, authorization }
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function turnsOf(url: string): Promise<{ turns: { role: string, text: string }[], scan: Record<string, unknown> }> {
  return await (await fetch(`${url}/onboarding/turns`)).json() as { turns: { role: string, text: string }[], scan: Record<string, unknown> }
}

function herLine(text: string) {
  return { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }
}

describe('HTTP:找 / 读的两条路由在窗口里', () => {
  it('★DSH 那条路:她 curl 找项目 → 回包之后 turns.scan 照样在找(held);她下一句一进回合表,同一包里 scanning:false', async () => {
    const fx = await serve()
    fx.onboardingTurns.bind('s1', '开场')
    fx.onboardingTurns.handleEvent('s1', { type: 'turn/start' })
    fx.onboardingTurns.handleEvent('s1', herLine('我看一下。'))
    expect((await post(fx.url, '/onboarding/scan', { name: 'workbench' })).status).toBe(200)
    const waiting = await turnsOf(fx.url)
    expect(waiting.scan).toMatchObject({ scanning: true, held: true, phase: 'list', id: 1 })
    // 开窗之前那句「我看一下」不算。
    expect(waiting.turns.map(turn => turn.text)).toEqual(['我看一下。'])
    fx.onboardingTurns.handleEvent('s1', herLine('找到两个像的:desktop-workbench 和 workbench-notes,是哪个?'))
    const spoke = await turnsOf(fx.url)
    expect(spoke.turns.at(-1)?.text).toContain('找到两个像的')
    expect(spoke.scan).toMatchObject({ scanning: false, id: 1 })
    expect(spoke.scan.held).toBeUndefined()
    // /onboarding/scan/status 是同一份。
    expect(await (await fetch(`${fx.url}/onboarding/scan/status`)).json()).toMatchObject({ scanning: false, id: 1 })
  })

  it('动手那一刻就在找:请求还没回,turns.scan 已经 scanning:true(带 phase 与编号)', async () => {
    const fx = await serve()
    let release: () => void = () => {}
    fx.projects.holdWith(new Promise<void>((resolve) => { release = resolve }))
    const pending = post(fx.url, '/onboarding/scan', { name: 'workbench' })
    let seen: Record<string, unknown> = {}
    for (let i = 0; i < 50 && seen.scanning !== true; i++) {
      seen = (await turnsOf(fx.url)).scan
      if (seen.scanning !== true) await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(seen).toMatchObject({ scanning: true, phase: 'list', id: 1 })
    release()
    expect((await pending).status).toBe(200)
  })

  it('电话那条路(DSH 那一轮没在跑):活儿做完就收 —— 她开口由手机本地看', async () => {
    const fx = await serve()
    expect((await post(fx.url, '/onboarding/scan', { name: 'workbench' })).status).toBe(200)
    expect((await turnsOf(fx.url)).scan).toMatchObject({ scanning: false, id: 1 })
  })

  it('门没过(没授权)不开窗:一次都没去读他的硬盘,也就不装作在找', async () => {
    const fx = await serve()
    await fx.authorization.set('read_scan_roots', '不可以', '2026-09-24')
    expect((await post(fx.url, '/onboarding/scan', { name: 'workbench' })).status).toBe(403)
    const scan = (await turnsOf(fx.url)).scan
    expect(scan.scanning).toBe(false)
    expect(scan.id).toBeUndefined()
  })

  it('读项目被拒(这台没接读项目):窗口开了也照样收,不留一个永远在「读」的球', async () => {
    const fx = await serve()
    expect((await post(fx.url, '/onboarding/project-brief', { path: '/x/desktop-workbench' })).status).toBe(503)
    expect((await turnsOf(fx.url)).scan).toMatchObject({ scanning: false, id: 1 })
  })
})
