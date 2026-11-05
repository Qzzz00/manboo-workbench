// @vitest-environment node
/**
 * 卡 feat/first-look-orb-top(2026-09-25)服务端那一半:
 *
 *   ① 事项写上「是谁写下的」(origin)+ 通话纪要那一通(call);老卡按形状认;
 *   ② 进化循环只数他亲口交代的、只用那句原话(标题);已经摆着的假提议当场撤;
 *   ③ 引导那一通也落记录,**一句话摘要、不落全文**(2026-10-22 起落成通话记录,不再是卡);
 *   ④ 项目区:在 projects.json 里的项目标 confirmed;
 *   ⑤ 拖窗进槽:原生光圈亮起来、悬着续期、出圈灭,页面收到 native。
 *
 * 维护者 09-24 晚的原话在各段注释里。数据全是造的临时目录,不碰 ~/.dsh。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { taskOriginOf, type TaskView, type WorkbenchState } from '../src/protocol.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { userSaysOf, userSpokenOf } from '../src/server/evolveSays.ts'
import { createEvolveService, createEvolveStore, findRepeats, proposalOf } from '../src/server/evolve.ts'
import { onboardingCallSummary, plainCallSummary } from '../src/server/callSummary.ts'
import { createCallRecordsService } from '../src/server/callRecords.ts'
import { createHighlightService, DROP_LABEL } from '../src/server/highlight.ts'
import { saveProjectsFile, emptyProjectsFile } from '../src/server/projects.ts'
import { createProjectsService } from '../src/server/projectsService.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createRtcCallService } from '../src/server/rtcCall.ts'

const dirs: string[] = []
const started: WorkbenchServer[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const AT = '2026-09-24T10:27:27.000Z'
function mine(id: string, title: string, extra: Partial<TaskView> = {}): TaskView {
  return { id, title, status: 'todo', direction: 'mine', source: { kind: 'manual' }, created_at: AT, updated_at: AT, ...extra }
}
/** 维护者 09-24 晚 tasks.json 里的样子(照抄形状,不读真身)。 */
const REAL_SHAPE: TaskView[] = [
  mine('t-call-4s', '和事务官通了个电话(4 秒)', { desc: '时长:4 秒。\n\n这通电话没有留下转写(手机没收到字幕,或者刚接通就挂了)。', status: 'done' }),
  mine('t-call-34s', '和事务官通了个电话(34 秒)', { desc: '时长:34 秒。\n\n通话里说了:\n我:是一段测试声音。', status: 'done' }),
  mine('t-onb-1', '让事务官能自己扫仓库,不用口述', { desc: '引导 ②′ 排的方案「desktop-workbench」。交接里写的头号需求' }),
  mine('t-onb-2', '查 0.2.80 真机聚球还卡不卡', { desc: '引导 ②′ 排的方案「desktop-workbench」。交接里排的第二件' }),
  mine('t-onb-3', '按三层清单自验 0.2.80', { desc: '引导 ②′ 排的方案「desktop-workbench」。交接里排的第三件' }),
  mine('t-onb-4', '让她能自己扫仓库,不用你口述', { desc: '引导 ②′ 排的方案「desktop-workbench」。你自己说的头号需求' }),
]

describe('① 事项是谁写下的(origin)', () => {
  it('有 origin 就用它;老卡按三种写死的形状认:通话纪要看标题、引导建的看 desc、会议来的看 source', () => {
    expect(taskOriginOf(REAL_SHAPE[0]!)).toBe('call')
    expect(taskOriginOf(REAL_SHAPE[2]!)).toBe('onboarding')
    expect(taskOriginOf(mine('m', '周五前把报价单发出去', { source: { kind: 'meeting', ref: 'mt-1' } }))).toBe('meeting')
    expect(taskOriginOf(mine('u', '把首页文案改一版', { desc: '把首页文案改一版,语气再轻一点' }))).toBe('user')
    // 显式写了就信它,不再看形状。
    expect(taskOriginOf(mine('x', '和事务官通了个电话(4 秒)', { origin: 'user' }))).toBe('user')
  })

  it('看板落盘:origin / call 写得进、读得回;认不出的值只挑掉这一格,卡照留', async () => {
    const dir = tempDir('wb-origin-')
    const file = join(dir, 'tasks.json')
    let n = 0
    const tasks = createTasksService({ file, newId: () => `t-${++n}` })
    await tasks.create({ title: '和事务官通了个电话(3 分)', direction: 'mine', status: 'done', origin: 'call', call: { kind: 'call', summary: '你先说的是「周五前交报销」', duration_seconds: 180.4 } })
    await tasks.create({ title: '让她自己扫仓库', direction: 'mine', origin: 'onboarding' })
    const listed = (await tasks.list()).tasks
    expect(listed[0]).toMatchObject({ origin: 'call', call: { kind: 'call', summary: '你先说的是「周五前交报销」', duration_seconds: 180 } })
    expect(listed[1]).toMatchObject({ origin: 'onboarding' })
    // 外部工具写坏了:origin 认不出、call 缺摘要 —— 两格挑掉,卡在。
    writeFileSync(file, JSON.stringify({ version: 1, tasks: [{ ...listed[0], origin: '随便', call: { kind: 'call', summary: '' } }], sprints: [], modules: [], project_meta: [] }))
    const reread = (await createTasksService({ file }).list()).tasks
    expect(reread).toHaveLength(1)
    expect(reread[0]!.origin).toBeUndefined()
    expect(reread[0]!.call).toBeUndefined()
  })
})

describe('② 固化提议只数他亲口交代的那句话', () => {
  it('维护者那份看板:四条引导排的 + 两条通话纪要,一句都不算「他说的」', () => {
    expect(userSaysOf(REAL_SHAPE)).toEqual([])
    // 旧口径(desc ?? title,mine 全算)会凑出那张「这 4 次你都在说…」—— 钉住它确实会,免得这条用例空转。
    const old = REAL_SHAPE.map(task => ({ id: task.id, text: task.desc ?? task.title, at: task.created_at }))
    expect(findRepeats({ says: old, nowMs: Date.parse(AT) + 60_000 }).length).toBeGreaterThan(0)
  })

  it('他亲口交代的:只用标题;长文全文不进 says,但进 spoken(给撤假提议时认旧的真提议)', () => {
    const tasks = [
      mine('u1', '整理本周选题', { origin: 'user', desc: '整理本周选题\n顺便把上周的数据贴进来' }),
      mine('u2', '把首页文案改一版'),
      ...REAL_SHAPE,
    ]
    expect(userSaysOf(tasks).map(say => say.text)).toEqual(['整理本周选题', '把首页文案改一版'])
    expect(userSpokenOf(tasks)).toEqual(['整理本周选题', '整理本周选题\n顺便把上周的数据贴进来', '把首页文案改一版'])
  })

  it('已经摆着的假提议:启动时 revalidate 就撤下(不记「不要」);他真说过的那条留着', async () => {
    const dir = tempDir('wb-evolve-')
    const store = createEvolveStore({ file: join(dir, 'evolve.json') })
    await store.load()
    const at = new Date(Date.parse(AT) + 60_000).toISOString()
    const fake = findRepeats({ says: REAL_SHAPE.map(task => ({ id: task.id, text: task.desc ?? task.title, at: task.created_at })), nowMs: Date.parse(at) })[0]!
    const realSays = ['整理本周选题 A', '整理本周选题 B', '整理本周选题 C'].map((text, i) => ({ id: `u${i}`, text, at: AT }))
    const real = findRepeats({ says: realSays, nowMs: Date.parse(at) })[0]!
    await store.add([proposalOf(fake, at), proposalOf(real, at)])
    const evolve = createEvolveService({
      store,
      io: { readFile: async () => undefined, writeFile: async () => {}, removeFile: async () => false },
      says: async () => [],
      spoken: async () => realSays.map(say => say.text),
      now: () => Date.parse(at),
    })
    expect(await evolve.revalidate?.()).toBe(1)
    expect(store.pending().map(p => p.id)).toEqual([real.id])
    // 撤下 ≠ 他点了「不要」:不进 declined,以后真说了三次还能再提。
    expect(store.declined()).not.toContain(fake.id)
  })
})

describe('③ 通话纪要:一句话摘要;引导那一通也算', () => {
  it('引导那一通:走完了说走完了、记下了哪几段(项目名照他确认的写);走到一半说聊到哪', () => {
    expect(onboardingCallSummary({ done: true, stage: 'done', answered: { projects: ['project'], authorization: ['write_docs'], habits: ['apps'], persona: ['persona'], naming: ['butler_name'] }, projects: ['desktop-workbench', 'Lapis'] }))
      .toBe('引导走完了:项目(desktop-workbench、Lapis)、授权、习惯、对话风格、取名都记下了')
    expect(onboardingCallSummary({ done: false, stage: 'authorization', answered: { opening: ['nickname'], projects: ['project'] }, projects: ['desktop-workbench'] }))
      .toBe('引导聊到「授权」,已记下项目(desktop-workbench),下次接着聊')
    expect(onboardingCallSummary({ done: false, stage: 'opening', answered: {}, projects: [] })).toBe('引导聊到「称呼」,下次接着聊')
  })

  /**
   * **2026-10-13 换了口径**(卡「通话纪要那张卡写聊了什么」):这一句从前写「你先说的是『…』,一共 N 句」,
   * 而落到卡上的标题是「和事务官通了个电话(101 秒)」—— 维护者:「你得写出来聊了什么啊」。
   * 现在这一句就是标题:**聊了什么**;时长与句数退到正文。逐句的判法见
   * `tests/call-record-what-we-said-20261013.test.ts`,这里只钉「换过口径」这件事。
   */
  it('平时那一通:摘要写聊了什么(不再是开口第一句 + 句数);没字幕、没开口各说各的', () => {
    expect(plainCallSummary([{ who: 'butler', text: '在呢。' }, { who: 'me', text: '周五之前把报销交了' }, { who: 'butler', text: '记下了。' }]))
      .toBe('电话里:周五之前把报销交了')
    expect(plainCallSummary([])).toBe('这通没有留下字幕')
    expect(plainCallSummary([{ who: 'butler', text: '有一件事等你确认。' }])).toBe('电话里:事务官说「有一件事等你确认。」')
    expect(plainCallSummary([{ who: 'me', text: '一'.repeat(40) }])).toBe(`电话里:${'一'.repeat(28)}…`)
  })

  async function serve(onboarding?: { summaryInput: () => Parameters<typeof onboardingCallSummary>[0], view: () => unknown }) {
    const dir = tempDir('wb-callrec-')
    const agentsFile = join(dir, 'AGENTS.md')
    writeFileSync(agentsFile, '我叫 周到。\n', 'utf8')
    let n = 0
    const tasks = createTasksService({ file: join(dir, 'tasks.json'), newId: () => `t-${++n}` })
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService({ now: () => Math.floor(Date.parse(AT) / 1000) }),
      tickIntervalMs: 0,
      heartbeatMs: 0,
      tasks,
      rtcCall: createRtcCallService({ agentsFile, tasks, signature: 'a'.repeat(48) }),
      callRecords: createCallRecordsService({ file: join(dir, 'calls.json'), workdir: () => dir, fallbackDir: join(dir, 'fallback') }),
      ...(onboarding === undefined ? {} : { onboarding: onboarding as never }),
    })
    started.push(server)
    const post = async (body: unknown) => {
      const res = await fetch(`${server.url}/butler/call/record`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: res.status, body: await res.json() as Record<string, unknown> }
    }
    const state = async () => await (await fetch(`${server.url}/state`)).json() as WorkbenchState
    return { post, state }
  }

  it('POST /butler/call/record kind:onboarding → 落一份引导记录(摘要按引导存档拼),不落字幕、不建卡', async () => {
    const t = await serve({
      // 只用到这两样:组装 /state 要 view,落纪要要 summaryInput。
      view: () => ({ stage: 'done', done: true }),
      summaryInput: () => ({ done: true, stage: 'done', answered: { projects: ['project'], habits: ['apps'] }, projects: ['desktop-workbench'] }),
    } as never)
    const res = await t.post({ kind: 'onboarding', durationSeconds: 27 * 60, transcript: [{ who: 'me', text: '私话一句' }] })
    expect(res.body.error ?? '').toBe('')
    expect(res.status).toBe(200)
    const state = await t.state()
    expect(state.tasks?.tasks ?? []).toHaveLength(0)
    const [record] = state.calls?.recent ?? []
    expect(record).toMatchObject({ kind: 'onboarding', summary: '引导走完了:项目(desktop-workbench)、习惯都记下了', duration_seconds: 1620, transcript: [] })
  })

  it('平时那一通:照旧落字幕,摘要写聊了什么', async () => {
    const t = await serve()
    await t.post({ durationSeconds: 65, transcript: [{ who: 'me', text: '把首页文案改一版' }, { who: 'butler', text: '好。' }] })
    const [record] = (await t.state()).calls?.recent ?? []
    expect(record).toMatchObject({ kind: 'call', summary: '电话里:把首页文案改一版', duration_seconds: 65, lines: 2 })
  })
})

describe('④ 项目区:在 projects.json 里的才算他确认过的', () => {
  it('扫到的仓库不带 confirmed;落过盘的带;没仓库的落盘项目也带', async () => {
    const dir = tempDir('wb-confirmed-')
    const file = join(dir, 'projects.json')
    const data = emptyProjectsFile()
    data.projects.push({ id: 'desktop-workbench', name: 'desktop-workbench', stage: 'MVP 开发', repoPath: '/roots/gh/desktop-workbench', links: [] })
    data.projects.push({ id: 'lapis', name: 'Lapis', stage: 'MVP 开发', links: [] })
    await saveProjectsFile(file, data)
    const repos = ['/roots/gh/boss', '/roots/gh/desktop-workbench', '/roots/gh/Aiboo']
    const svc = createProjectsService({
      file,
      exec: async args => args[0] === 'rev-parse' ? { ok: true, stdout: 'main\n' } : args[0] === 'log' ? { ok: true, stdout: '2026-09-24T00:00:00Z\n' } : { ok: true, stdout: '' },
      listDir: async d => d === '/roots/gh' ? repos : [],
      isRepo: async d => repos.includes(d),
      codexHome: '/x',
      codexDeps: { listFiles: async () => [], readFirstLine: async () => '' },
      home: '/Users/example',
      now: () => Math.floor(Date.parse('2026-09-24T12:00:00Z') / 1000),
      scanRoots: [{ path: '/roots/gh', depth: 1 }],
    })
    const state = await svc.getProjectsState()
    const byId = new Map(state.projects.map(p => [p.id, p]))
    expect(byId.get('desktop-workbench')?.confirmed).toBe(true)
    expect(byId.get('lapis')?.confirmed).toBe(true)
    expect(byId.get('boss')?.confirmed).toBeUndefined()
    expect(byId.get('Aiboo')?.confirmed).toBeUndefined()
  })
})

describe('⑤ 拖窗进槽:原生光圈(2026-09-25 卡 P 起只在「放下」那一下亮)', () => {
  it('放下:按槽的页面矩形换算屏幕坐标、亮一轮带那句话;不续期(ttl 到了壳自己灭)', async () => {
    vi.useFakeTimers()
    try {
      const requests: Record<string, unknown>[] = []
      const helper = {
        request: async (msg: Record<string, unknown>) => {
          requests.push(msg)
          if (msg.op === 'screen_info') return { webview: { x: 100, y: 50, w: 2000, h: 1200 }, scale: 1 } as never
          return {} as never
        },
      }
      const highlight = createHighlightService({ helper: helper as never, ttlMs: 2000 })
      // 页面还没报过槽的矩形:亮不成,回 false(页面自己那圈顶上)。
      expect(await highlight.drop?.()).toBe(false)
      highlight.setSlotRect({ x: 10, y: 20, w: 800, h: 500 })
      expect(await highlight.drop?.()).toBe(true)
      const lit = requests.filter(msg => msg.op === 'highlight_region' && msg.rect !== null)
      expect(lit).toHaveLength(1)
      expect(lit[0]).toMatchObject({ ttl_ms: 2000, label: DROP_LABEL, rect: { x: 110, y: 70, w: 800, h: 500 } })
      // 不续期:再过 5 秒也不会再打一次光。
      const after = requests.length
      await vi.advanceTimersByTimeAsync(5000)
      expect(requests.length).toBe(after)
    }
    finally { vi.useRealTimers() }
  })
})
