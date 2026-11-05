// @vitest-environment node
/**
 * 事务官的日常例程(2026-09-15):开工汇报 / 下班例程 / 每周知识 lint。
 *
 * 守住的几条:
 * - 定时:到点跑一次、同一天不跑第二次、重启后从状态文件认出来不重跑;lint 只在那个星期几、且在下班例程之后;
 * - 不并发:在跑时再触发直接拒绝;
 * - DSH 不在线:跳过并记一条 note,过了冷却再试;会话开不出来:如实标「会话未开」,代码那一半照做;
 * - 下班例程:只追加不删、只碰记忆目录、一次 commit;
 * - 知识 lint:不写任何文件;
 * - HTTP:POST /routine/run 之后收件箱多一条「事务官交给我的」,三句加一问的数字与记忆文件一致。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProjectsState, WorkbenchState } from '../src/protocol.ts'
import type { ProjectsService } from '../src/server/projectsService.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import type { RoutinesService } from '../src/server/routines.ts'
import { DAY_REVIEW_HEAD, DAY_REVIEW_SECTION_HEADS } from '../src/server/agentDayReview.ts'
import type { JobEvent } from '../src/server/jobLog.ts'
import type { ChainRecord } from '../src/server/videoChain.ts'
import { STALLED_MORNING_HEAD } from '../src/server/itemStanding.ts'
import { BUTLER_SESSION_OFFLINE_NOTE } from '../src/protocol.ts'
import { MEETING_TODAY_HEAD, TODAY_TODO_HEAD } from '../src/server/routineMemory.ts'
import {
  DEFAULT_ROUTINES_CONFIG,
  createRoutinesService,
  eveningFirstMessage,
  lintDocPath,
  lintFirstMessage,
  morningFirstMessage,
  parseRoutinesConfig,
} from '../src/server/routines.ts'

const dirs: string[] = []
const started: WorkbenchServer[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-routines-'))
  dirs.push(dir)
  return dir
}

/** 本机时区里的某一天某一刻(例程的时刻都是本机 HH:MM)。 */
function at(date: string, hhmm: string): number {
  return Date.parse(`${date}T${hhmm}:00`)
}

const TODAY = '2026-09-15' // 周二
const FRIDAY = '2026-09-18'

/** 建仓那次 commit 的日期:在 TODAY 之前,像生产里「昨天有人提交过」——不能是墙上钟的今天,也不能是 TODAY。 */
const INIT_DATE = '2026-09-14'

/** 一个最小的记忆仓库:两个项目文件、用户文件、决策记录、项目索引、旧布局文件(带手写节)。 */
function memoryRepo(): string {
  const repo = tempDir()
  const initDate = `${INIT_DATE}T09:00:00`
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: repo, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: initDate, GIT_COMMITTER_DATE: initDate },
  })
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'test')
  git('config', 'user.email', 'test@example.com')
  mkdirSync(join(repo, 'docs/记忆/项目'), { recursive: true })
  writeFileSync(join(repo, 'docs/记忆/项目/A.md'), '# A\n\n- **一句话**:待梳理\n\n## 进展(倒序,一条一日期)\n- 2026-09-14:改了登录页(依据:/state)\n- 2026-09-10:建档\n\n## 下一步\n- 待梳理\n')
  writeFileSync(join(repo, 'docs/记忆/项目/B.md'), '# B\n\n## 进展(倒序,一条一日期)\n- 2026-09-14:发了 0.2 版\n\n## 风险\n- 待梳理\n')
  writeFileSync(join(repo, 'docs/记忆/项目/索引.md'), '# 项目索引(快照 2026-09-10)\n\n| 项目 | 一句话 | 阶段 | 最近活动 | 路径 | 文件 |\n|---|---|---|---|---|---|\n| A | 待梳理 | 待梳理 | 闲置 3 天 | `/x/A` | [项目/A.md](项目/A.md) |\n| B | 待梳理 | 待梳理 | 今天在动 | `/x/B` | [项目/B.md](项目/B.md) |\n')
  writeFileSync(join(repo, 'docs/记忆/用户-Ben.md'), '# 用户:Ben\n\n## 观察(事务官追加,倒序)\n- 2026-09-14 · 一次只问一个问题(本次对话)\n')
  writeFileSync(join(repo, 'docs/记忆/工作台-布局.md'), '# 工作台布局(快照 2026-09-10)\n\n## 模块与位置\n| 旧 |\n\n## 每个模块里有什么(能力清单的 UI 视角)\n- 项目区:总览\n\n## 字段来源\n- 旧\n')
  writeFileSync(join(repo, 'docs/决策记录.md'), '# 决策记录\n\n## 2026-09-14 · x(已拍板)\n- y\n\n## 2026-09-11 · z\n**待拍板**:\n1. 落点。\n')
  writeFileSync(join(repo, 'docs/交接-0914-x.md'), '# 交接 x\n\n一句话。\n')
  writeFileSync(join(repo, 'src.ts'), 'export {}\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  return repo
}

function gitLog(repo: string): string[] {
  return execFileSync('git', ['log', '--format=%s'], { cwd: repo }).toString().trim().split('\n')
}

function gitStatus(repo: string): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString()
}

const PROJECTS: ProjectsState = {
  projects: [
    {
      id: 'p-a', name: 'A', stage: 'MVP 开发', path: '/x/A', links: [], session_count: 0, idle: false,
      signals: { branch: 'main', dirty_count: 2, worktrees: 0, cleanup_count: 0, idle_days: 0, recent_commits: 4 },
    },
    {
      id: 'p-b', name: 'B', stage: '待整理', path: '/x/B', links: [], session_count: 0, idle: true,
      signals: { branch: 'main', dirty_count: 0, worktrees: 0, cleanup_count: 0, idle_days: 5 },
    },
    {
      id: 'p-z', name: 'Z', stage: '待整理', path: '/x/Z', links: [], session_count: 0, idle: false,
      signals: { branch: 'dev', dirty_count: 1, worktrees: 0, cleanup_count: 0, idle_days: 0 },
    },
  ],
  pending: [],
  scan_errors: [],
  scanned_at: '',
}

function fakeProjects(): ProjectsService {
  return {
    getProjectsState: async () => PROJECTS,
    getLayout: async () => undefined,
  } as unknown as ProjectsService
}

interface Harness {
  routines: RoutinesService
  sent: string[]
  clock: { ms: number }
  configFile: string
  stateFile: string
}

interface HarnessOptions {
  repo?: string
  /** 会话桩。缺席 = DSH 没接。返回 undefined = 开不出来。 */
  open?: (message: string) => Promise<string | undefined>
  available?: () => boolean
  config?: unknown
  startAt?: number
  skipRetryMs?: number
  state?: () => Promise<WorkbenchState>
  attach?: boolean
  /** 开工汇报之前先跑的那一下(2026-09-21 数据复盘自取)。 */
  beforeMorning?: () => Promise<string | undefined>
  /** 下班例程之后扫一遍重复(2026-09-22,卡 ⑥ 进化循环)。 */
  afterEvening?: () => Promise<string | undefined>
  /** 这台机器装好了没有(2026-09-23)。 */
  setupGate?: () => string | undefined
  /** 日报四段(2026-10-13):任务账与问模型那两样。 */
  dayReview?: { jobEvents?: () => readonly JobEvent[], chat?: (prompt: string) => Promise<string> }
  /** 正在走的两步接力(卡 F):由 http.ts 在 `attach` 那一格接进来。 */
  videoChains?: () => readonly ChainRecord[]
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = tempDir()
  const configFile = join(dir, 'routines.json')
  const stateFile = join(dir, 'routines-state.json')
  if (options.config !== undefined) writeFileSync(configFile, JSON.stringify(options.config))
  const clock = { ms: options.startAt ?? at(TODAY, '09:00') }
  const sent: string[] = []
  const routines = createRoutinesService({
    configFile,
    stateFile,
    now: () => clock.ms,
    ...(options.repo === undefined ? {} : { defaultRepo: options.repo }),
    skipRetryMs: options.skipRetryMs ?? 0,
    ...(options.beforeMorning === undefined ? {} : { beforeMorning: options.beforeMorning }),
    ...(options.afterEvening === undefined ? {} : { afterEvening: options.afterEvening }),
    ...(options.setupGate === undefined ? {} : { setupGate: options.setupGate }),
    ...(options.dayReview === undefined ? {} : { dayReview: options.dayReview }),
    ...(options.open === undefined
      ? {}
      : {
          session: {
            open: async (message: string) => { sent.push(message); return options.open?.(message) },
            ...(options.available === undefined ? {} : { available: options.available }),
          },
        }),
  })
  await routines.load()
  if (options.attach !== false) {
    routines.attach({
      ...(options.videoChains === undefined ? {} : { videoChains: options.videoChains }),
      readState: options.state ?? (async () => ({
        agents: [], sessions: [], quota: {}, now: new Date(clock.ms).toISOString(), stale: false,
        projects: PROJECTS,
        tasks: { tasks: [{ id: 't1', title: 'x', status: 'confirm', project_id: 'p-a', created_at: '', updated_at: '' } as never], sprints: [], modules: [], project_meta: [] },
      })),
    })
  }
  return { routines, sent, clock, configFile, stateFile }
}

const opened = async () => 'sess-1'

describe('routines.json:解析与默认值', () => {
  it('默认:开工汇报开(露面触发,06:00 之后)、下班 18:30、lint 周五', () => {
    expect(DEFAULT_ROUTINES_CONFIG).toEqual({
      morning: { enabled: true, not_before: '06:00' },
      evening: { enabled: true, at: '18:30' },
      lint: { enabled: true, weekday: 5 },
    })
  })

  it('认不出的字段退回默认,不抛;未知字段丢弃;时刻规整成 HH:MM', () => {
    expect(parseRoutinesConfig({ evening: { at: '9:5' }, lint: { weekday: 9 }, morning: { at: 'noon' }, foo: 1 })).toEqual({
      morning: { enabled: true, not_before: '06:00' },
      evening: { enabled: true, at: '09:05' },
      lint: { enabled: true, weekday: 5 },
    })
    expect(parseRoutinesConfig('garbage')).toEqual(DEFAULT_ROUTINES_CONFIG)
  })

  it('repo 与开工时刻可配', () => {
    expect(parseRoutinesConfig({ morning: { at: '08:30' }, repo: '/r' })).toEqual({
      morning: { enabled: true, at: '08:30', not_before: '06:00' },
      evening: { enabled: true, at: '18:30' },
      lint: { enabled: true, weekday: 5 },
      repo: '/r',
    })
  })

  it('setConfig 部分更新并落盘;下次 load 读回来', async () => {
    const h = await harness()
    const config = await h.routines.setConfig({ evening: { at: '19:00' }, lint: { enabled: false } })
    expect(config.evening).toEqual({ enabled: true, at: '19:00' })
    expect(config.lint.enabled).toBe(false)
    expect(JSON.parse(await readFile(h.configFile, 'utf8'))).toEqual(config)
    const again = createRoutinesService({ configFile: h.configFile, stateFile: h.stateFile })
    await again.load()
    expect(again.config()).toEqual(config)
  })
})

describe('/state.routines:next / last / running', () => {
  it('露面模式的开工汇报报 sighting;下班与 lint 报本机时刻;关着的不出现', async () => {
    const h = await harness({ config: { morning: { enabled: true }, lint: { enabled: false } } })
    const view = h.routines.view()
    expect(view.next).toEqual({
      morning: { kind: 'sighting', not_before: '06:00' },
      evening: { kind: 'at', at: `${TODAY}T18:30` },
    })
    expect(view.last).toEqual({})
    expect(view.running).toEqual([])
    expect(view.config.evening.at).toBe('18:30')
  })

  it('lint 的下一次是下一个周五的下班时刻;今天跑过的下班例程下一次是明天', async () => {
    const h = await harness({ open: opened })
    await h.routines.run('evening')
    const view = h.routines.view()
    expect(view.next.evening).toEqual({ kind: 'at', at: `2026-09-16T18:30` })
    expect(view.next.lint).toEqual({ kind: 'at', at: `${FRIDAY}T18:30` })
    expect(view.last.evening?.status).toBe('ok')
  })
})

describe('定时触发:到点跑一次,不并发,重启不重跑', () => {
  it('18:29 不跑;18:30 跑;之后每一拍都不再跑', async () => {
    const h = await harness({ open: opened })
    h.clock.ms = at(TODAY, '18:29')
    h.routines.pump()
    await new Promise(r => setTimeout(r, 20))
    expect(h.sent).toHaveLength(0)
    h.clock.ms = at(TODAY, '18:30')
    h.routines.pump()
    h.routines.pump()
    h.routines.pump()
    await new Promise(r => setTimeout(r, 50))
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toContain('下班例程 2026-09-15')
    h.clock.ms = at(TODAY, '21:00')
    h.routines.pump()
    await new Promise(r => setTimeout(r, 20))
    expect(h.sent).toHaveLength(1)
    expect(h.routines.view().last.evening?.trigger).toBe('schedule')
  })

  it('同一例程在跑时再触发 → 拒绝;跑完后 running 清空', async () => {
    let release: (() => void) | undefined
    // 只有第一次开会话卡住(那是下班例程的);后面的(lint 的)立刻开成。
    const h = await harness({ open: () => release === undefined ? new Promise(resolve => { release = () => resolve('s') }) : Promise.resolve('s2') })
    const first = h.routines.run('evening')
    await new Promise(r => setTimeout(r, 20))
    expect(h.routines.view().running).toEqual(['evening'])
    const second = await h.routines.run('evening')
    expect(second).toEqual({ ok: false, reason: '这条例程正在跑' })
    // 别的例程不受影响。
    const other = await h.routines.run('lint')
    expect(other.ok).toBe(true)
    release?.()
    const done = await first
    expect(done.ok).toBe(true)
    expect(h.routines.view().running).toEqual([])
  })

  it('进程重启:状态文件里今天已经跑过 → 不重跑', async () => {
    const h = await harness({ open: opened })
    h.clock.ms = at(TODAY, '18:30')
    await h.routines.run('evening', 'schedule')
    expect(JSON.parse(await readFile(h.stateFile, 'utf8')).last.evening.date).toBe(TODAY)

    const sent: string[] = []
    const again = createRoutinesService({
      configFile: h.configFile, stateFile: h.stateFile, now: () => at(TODAY, '18:31'),
      session: { open: async (m) => { sent.push(m); return 's' } },
    })
    await again.load()
    again.attach({ readState: async () => ({ agents: [], sessions: [], quota: {}, now: '', stale: false }) })
    again.pump()
    await new Promise(r => setTimeout(r, 20))
    expect(sent).toHaveLength(0)
    expect(again.view().last.evening?.date).toBe(TODAY)
  })

  it('设了开工时刻:到点跑,不靠露面', async () => {
    const h = await harness({ open: opened, config: { morning: { at: '08:00' } } })
    h.clock.ms = at(TODAY, '07:59')
    h.routines.sighted()
    h.routines.pump()
    await new Promise(r => setTimeout(r, 20))
    expect(h.sent).toHaveLength(0)
    h.clock.ms = at(TODAY, '08:00')
    h.routines.pump()
    await new Promise(r => setTimeout(r, 30))
    expect(h.sent).toHaveLength(1)
    expect(h.routines.view().last.morning?.trigger).toBe('schedule')
  })

  it('没设开工时刻:当天第一次露面触发(06:00 之前的露面不算),一天一次', async () => {
    const h = await harness({ open: opened })
    h.clock.ms = at(TODAY, '05:30')
    h.routines.sighted()
    await new Promise(r => setTimeout(r, 20))
    expect(h.sent).toHaveLength(0)
    h.clock.ms = at(TODAY, '09:00')
    h.routines.sighted()
    h.routines.sighted()
    await new Promise(r => setTimeout(r, 30))
    expect(h.sent).toHaveLength(1)
    h.clock.ms = at(TODAY, '15:00')
    h.routines.sighted()
    await new Promise(r => setTimeout(r, 20))
    expect(h.sent).toHaveLength(1)
    expect(h.routines.view().last.morning?.trigger).toBe('sighting')
  })

  it('知识 lint:只在周五、且当天下班例程跑完之后;周二不跑', async () => {
    const h = await harness({ open: opened })
    h.clock.ms = at(TODAY, '18:30')
    h.routines.pump()
    await new Promise(r => setTimeout(r, 40))
    h.routines.pump()
    await new Promise(r => setTimeout(r, 40))
    expect(h.sent.filter(m => m.includes('知识 lint'))).toHaveLength(0)

    h.clock.ms = at(FRIDAY, '18:30')
    h.routines.pump() // 先起下班例程
    await new Promise(r => setTimeout(r, 40))
    expect(h.routines.view().last.evening?.date).toBe(FRIDAY)
    h.routines.pump() // 下班例程跑完了,这一拍才轮到 lint
    await new Promise(r => setTimeout(r, 40))
    const lint = h.sent.filter(m => m.includes('知识 lint'))
    expect(lint).toHaveLength(1)
    expect(lint[0]).toContain('docs/交接-0918-知识lint.md')
    h.routines.pump()
    await new Promise(r => setTimeout(r, 20))
    expect(h.sent.filter(m => m.includes('知识 lint'))).toHaveLength(1)
  })
})

describe('DSH 不在线 / 会话开不出来', () => {
  it('没接会话通道 → 跳过并记一条 note,不写任何文件', async () => {
    const repo = memoryRepo()
    const h = await harness({ repo })
    const result = await h.routines.run('evening')
    expect(result.ok && result.run.status).toBe('skipped')
    expect(result.ok && result.run.note).toBe('DSH 不在线,这次跳过')
    expect(gitStatus(repo)).toBe('')
    expect(gitLog(repo)).toEqual(['init'])
  })

  it('通道在但 available() 说没接上 → 同样跳过;过了冷却再 pump 会再试,DSH 起来了就补上', async () => {
    let online = false
    const h = await harness({ open: opened, available: () => online })
    h.clock.ms = at(TODAY, '18:30')
    h.routines.pump()
    await new Promise(r => setTimeout(r, 20))
    expect(h.routines.view().last.evening?.status).toBe('skipped')
    expect(h.sent).toHaveLength(0)
    online = true
    h.clock.ms = at(TODAY, '18:31')
    h.routines.pump()
    await new Promise(r => setTimeout(r, 30))
    expect(h.routines.view().last.evening?.status).toBe('ok')
    expect(h.sent).toHaveLength(1)
  })

  /**
   * 2026-10-13(卡「早报…DSH 不在线也出早报」):不在线不再让早报整块消失 ——
   * 与「会话开不出来」同一条取舍,程序拼的那一半照出,模型那一半如实说缺席。
   */
  it('★开工汇报:DSH 不在线 → 程序拼的那一半照出(报文在、不开会话、note 说清只有程序那半)', async () => {
    const h = await harness({ repo: memoryRepo() })
    const result = await h.routines.run('morning')
    if (!result.ok) throw new Error(result.reason)
    expect(result.run.status).toBe('no_session')
    expect(result.run.session_offline).toBe(true)
    expect(result.run.note).toContain(BUTLER_SESSION_OFFLINE_NOTE)
    expect(result.run.conversation).toBeUndefined()
    expect(result.run.report).toBe([
      '上次 9月14日 记了 2 个项目的进展(A、B)、1 条关于你的观察。',
      '今天没有在盯的事。',
      '等你拍板:决策记录 1 段待拍板、1 张卡等你确认。',
      '今天先做哪件?',
    ].join('\n'))
  })

  it('★下班例程与知识 lint:DSH 不在线仍然跳过(一个文件不写、一次 commit 不做)', async () => {
    const repo = memoryRepo()
    const h = await harness({ repo })
    expect((await h.routines.run('evening')).ok && h.routines.view().last.evening?.status).toBe('skipped')
    expect((await h.routines.run('lint')).ok && h.routines.view().last.lint?.status).toBe('skipped')
    expect(h.routines.view().last.lint?.note).toBe('DSH 不在线,这次跳过')
    expect(gitStatus(repo)).toBe('')
    expect(gitLog(repo)).toEqual(['init'])
  })

  it('不在线出过那一份之后,当天不再重跑(省一次资讯搜索与一次模型调用;要不要补一份完整的待她定)', async () => {
    let online = false
    const h = await harness({ open: opened, available: () => online, config: { morning: { at: '08:00' } } })
    h.clock.ms = at(TODAY, '08:00')
    h.routines.pump()
    await new Promise(r => setTimeout(r, 30))
    expect(h.routines.view().last.morning?.status).toBe('no_session')
    expect(h.sent).toHaveLength(0)
    online = true
    h.clock.ms = at(TODAY, '08:05')
    h.routines.pump()
    h.routines.sighted()
    await new Promise(r => setTimeout(r, 30))
    expect(h.sent).toHaveLength(0)
    expect(h.routines.view().last.morning?.status).toBe('no_session')
  })

  it('开工汇报:会话开不出来 → 汇报照拼、状态 no_session、note「会话未开」', async () => {
    const h = await harness({ open: async () => undefined, repo: memoryRepo() })
    const result = await h.routines.run('morning')
    if (!result.ok) throw new Error(result.reason)
    expect(result.run.status).toBe('no_session')
    expect(result.run.note).toBe('会话未开')
    expect(result.run.conversation).toBeUndefined()
    expect(result.run.report).toBe([
      '上次 9月14日 记了 2 个项目的进展(A、B)、1 条关于你的观察。',
      '今天没有在盯的事。',
      '等你拍板:决策记录 1 段待拍板、1 张卡等你确认。',
      '今天先做哪件?',
    ].join('\n'))
  })

  it('会话桩抛了 → 与开不出来同样处理,不算 failed', async () => {
    const h = await harness({ open: async () => { throw new Error('boom') } })
    const result = await h.routines.run('lint')
    expect(result.ok && result.run.status).toBe('no_session')
  })

  it('没接 composeState → 如实拒绝', async () => {
    const h = await harness({ open: opened, attach: false })
    expect(await h.routines.run('morning')).toEqual({ ok: false, reason: '例程还没接上工作台状态' })
  })
})

describe('开工汇报:三句加一问,会话第一条消息', () => {
  it('会话开出来了:record 带 conversation 与 report;第一条消息 = 汇报原文 + 读技能那一句', async () => {
    const h = await harness({ open: opened, repo: memoryRepo() })
    const result = await h.routines.run('morning')
    if (!result.ok) throw new Error(result.reason)
    expect(result.run.status).toBe('ok')
    expect(result.run.conversation).toEqual({ agent: 'dsh', session_id: 'sess-1' })
    expect(h.sent[0]).toBe(morningFirstMessage(result.run.report!, TODAY))
    expect(h.sent[0]!.startsWith('上次 9月14日 记了 2 个项目的进展(A、B)、1 条关于你的观察。\n')).toBe(true)
    expect(h.sent[0]).toContain('.dsh/skills/例程/SKILL.md')
    expect(h.sent[0]).toContain('等 Ben 在这条会话里回答「今天先做哪件」再接手')
  })

  /**
   * 2026-10-13(卡「早报按日报规范出」):停太久的那几件**并进日报四段的卡点 / 下一步**,
   * 原来那一段(`STALLED_MORNING_HEAD`)不再单独出 —— 同一件事不在早报里出现两次。
   */
  it('停太久的事项(2026-10-12):读 /state 上每件事项的 standing,并进日报四段的卡点', async () => {
    const h = await harness({
      open: opened,
      state: async () => ({
        agents: [], sessions: [], quota: {}, now: '', stale: false,
        tasks: {
          tasks: [{
            id: 't9', title: '换首页截图', status: 'doing', direction: 'mine', source: { kind: 'manual' }, created_at: '', updated_at: '',
            standing: { case: 'result_unwritten', waiting_on: 'nobody', next: '看一眼收下', idle_days: 2, stalled: true },
          }],
          sprints: [], modules: [], project_meta: [],
        },
      }) as never,
    })
    const result = await h.routines.run('morning')
    if (!result.ok) throw new Error(result.reason)
    expect(result.run.report).toContain(DAY_REVIEW_SECTION_HEADS.blocked)
    expect(result.run.report).toContain('换首页截图｜卡在:停了 2 天:结果回来了没收进卡')
    expect(result.run.report).toContain('换首页截图｜看一眼收下')
    expect(result.run.report).not.toContain(STALLED_MORNING_HEAD)
  })

  /**
   * 2026-10-13(卡「早报按日报规范出」):四段排在最前;模型并好的那一份照它写,
   * 「今天的待办」并进「下一步」、不再单独出一段。
   */
  it('★日报四段:事实从任务账与卡上判,归并问一次模型,排在早报最前面', async () => {
    const prompts: string[] = []
    const h = await harness({
      open: opened,
      dayReview: {
        jobEvents: () => ([
          { at: new Date(at(TODAY, '08:10')).toISOString(), job: 't9', step: 'assigned', family: 'codex' },
          { at: new Date(at(TODAY, '08:20')).toISOString(), job: 't9', step: 'replied', family: 'codex' },
        ] satisfies JobEvent[]),
        chat: async (prompt) => {
          prompts.push(prompt)
          return JSON.stringify([{ section: 'done', fact: 'd1', name: '宣传视频', line: 'Codex 把脚本交回来了,等你验收' }])
        },
      },
      state: async () => ({
        agents: [], sessions: [], quota: {}, now: '', stale: false,
        today_todos: { date: TODAY, tomorrow: TODAY, items: [{ id: 'x1', title: '剪片子', due: TODAY, done: false, overdue: false }] },
        tasks: {
          tasks: [{
            id: 't9', title: '写脚本', status: 'confirm', direction: 'mine', source: { kind: 'manual' },
            created_at: new Date(at(TODAY, '08:00')).toISOString(), updated_at: new Date(at(TODAY, '08:20')).toISOString(),
          }],
          sprints: [], modules: [], project_meta: [],
        },
      }) as never,
    })
    const result = await h.routines.run('morning')
    if (!result.ok) throw new Error(result.reason)
    expect(result.run.report!.startsWith(DAY_REVIEW_HEAD)).toBe(true)
    expect(result.run.report).toContain('宣传视频｜Codex 把脚本交回来了,等你验收')
    // 待办并进「下一步」,原来那一段不再单独出
    expect(result.run.report).not.toContain(TODAY_TODO_HEAD)
    // 事实表里有编号,模型只许引它
    expect(prompts[0]).toContain('d1')
    expect(prompts[0]).toContain('只能引表里的编号')
  })

  it('★日报四段:没接模型 → 程序按事实表排,注明只有程序拼的部分', async () => {
    const h = await harness({
      open: opened,
      dayReview: { jobEvents: () => ([{ at: new Date(at(TODAY, '08:20')).toISOString(), job: 't9', step: 'replied', family: 'codex' }] satisfies JobEvent[]) },
      state: async () => ({
        agents: [], sessions: [], quota: {}, now: '', stale: false,
        tasks: {
          tasks: [{
            id: 't9', title: '写脚本', status: 'confirm', direction: 'mine', source: { kind: 'manual' },
            created_at: new Date(at(TODAY, '08:00')).toISOString(), updated_at: new Date(at(TODAY, '08:20')).toISOString(),
          }],
          sprints: [], modules: [], project_meta: [],
        },
      }) as never,
    })
    const result = await h.routines.run('morning')
    if (!result.ok) throw new Error(result.reason)
    expect(result.run.report).toContain(DAY_REVIEW_SECTION_HEADS.done)
    expect(result.run.report).toContain('写脚本｜Codex 交回来了,等你验收')
  })

  /**
   * ★ 2026-10-13(卡 F,四场景验收第 16 条):14:31 那份早报把正在可灵那一步的视频链
   * 列进了已完成(依据「豆包办公已说完」)。接力记录从 `attach` 那一格来(`videoChain.view()` 一处)。
   */
  it('★日报四段:正在接力中的那张卡算推进中,不进已完成', async () => {
    const h = await harness({
      open: opened,
      videoChains: () => [{ item: 't9', subject: '女孩树林摘蘑菇', video_prompt: '…', stage: 'kling', since: at(TODAY, '08:00') }],
      state: async () => ({
        agents: [], sessions: [], quota: {}, now: '', stale: false,
        tasks: {
          tasks: [{
            id: 't9', title: '女孩树林摘蘑菇的视频', status: 'doing', direction: 'mine', source: { kind: 'manual' },
            created_at: new Date(at(TODAY, '08:00')).toISOString(), updated_at: new Date(at(TODAY, '08:20')).toISOString(),
            client_dispatch: {
              hand: 'window', family: 'doubao', status: 'sent', text: '出一张参考图',
              at: new Date(at(TODAY, '08:05')).toISOString(), seen_at: new Date(at(TODAY, '08:06')).toISOString(),
              reply_state: 'done', reply_at: new Date(at(TODAY, '08:20')).toISOString(),
            },
          }],
          sprints: [], modules: [], project_meta: [],
        },
      }) as never,
    })
    const result = await h.routines.run('morning')
    if (!result.ok) throw new Error(result.reason)
    expect(result.run.report).toContain(DAY_REVIEW_SECTION_HEADS.in_progress)
    expect(result.run.report).toContain('做到:参考图拿到了,在可灵生成')
    expect(result.run.report).not.toContain(DAY_REVIEW_SECTION_HEADS.done)
  })

  /** 2026-10-13(卡第 3 件):素材都在 /state 上,早报只挑出来念,不另起扫描。 */
  it('★今天要开的会与今天的待办:读 /state.meetings.upcoming 与 /state.today_todos', async () => {
    const h = await harness({
      open: opened,
      state: async () => ({
        agents: [], sessions: [], quota: {}, now: '', stale: false,
        meetings: {
          recent: [],
          upcoming: [
            {
              id: 'm1', title: '跟品牌方对脚本', date: TODAY, started_at: '', status: 'planned', segments: 0, todos: [], unsure: [],
              prep: {
                said: '下午两点跟品牌方对脚本',
                scheduled_at: new Date(at(TODAY, '14:00')).toISOString(),
                people: { value: [{ alias: '小林' }], from: 'said' },
                card_status: 'ready',
              },
            },
            // 明天那一场不念。
            { id: 'm2', title: '周会', date: '2026-09-16', started_at: '', status: 'planned', segments: 0, todos: [], unsure: [] },
          ],
        },
        today_todos: {
          date: TODAY,
          tomorrow: '2026-09-16',
          items: [
            { id: 'a', title: '剪完周五那条', due: TODAY, done: false, overdue: false },
            { id: 'b', title: '回品牌方的脚本', due: '2026-09-12', done: false, overdue: true },
          ],
        },
      }) as never,
    })
    const result = await h.routines.run('morning')
    if (!result.ok) throw new Error(result.reason)
    expect(result.run.report).toContain(MEETING_TODAY_HEAD)
    expect(result.run.report).toContain('- 14:00「跟品牌方对脚本」(跟 小林);预案卡好了')
    expect(result.run.report).not.toContain('周会')
    expect(result.run.report).toContain(TODAY_TODO_HEAD)
    expect(result.run.report).toContain('- 「回品牌方的脚本」(逾期,原定 9月12日)')
    // 两段都在那三句之后、问句之前。
    const text = result.run.report ?? ''
    expect(text.indexOf(MEETING_TODAY_HEAD)).toBeGreaterThan(text.indexOf('今天没有在盯的事。'))
    expect(text.indexOf(TODAY_TODO_HEAD)).toBeGreaterThan(text.indexOf(MEETING_TODAY_HEAD))
    expect(h.sent[0]).toContain(MEETING_TODAY_HEAD)
  })

  it('没有今天的会、没接今天的待办 → 两段都不出(与加它们之前逐字相同)', async () => {
    const h = await harness({ open: opened })
    const result = await h.routines.run('morning')
    if (!result.ok) throw new Error(result.reason)
    expect(result.run.report).toBe('今天没有在盯的事。\n等你拍板:1 张卡等你确认。\n今天先做哪件?')
  })

  it('没配记忆仓库:第一句没有,note 说清楚', async () => {
    const h = await harness({ open: opened })
    const result = await h.routines.run('morning')
    if (!result.ok) throw new Error(result.reason)
    expect(result.run.report!.startsWith('今天没有在盯的事。')).toBe(true)
    expect(result.run.note).toContain('没配记忆仓库')
  })
})

/**
 * 开工汇报之前先跑的那一下(2026-09-21 数据复盘:每天早报前自取一次小红书后台)。
 *
 * 三条纪律:**跑在汇报之前**、**结果记进 note(自动动作要看得见)**、
 * **它失败不连累开工汇报**。
 */
describe('开工汇报之前:数据复盘自取那一下', () => {
  it('★跑在汇报之前,而且结果记进 note —— 自动动作要看得见(PRD §9)', async () => {
    const order: string[] = []
    const h = await harness({
      open: async (message) => { order.push(`汇报:${message.slice(0, 4)}`); return 'sess-1' },
      beforeMorning: async () => { order.push('自取'); return '数据复盘:取到 8 项,并写了三条建议' },
    })
    const result = await h.routines.run('morning')
    if (!result.ok) throw new Error(result.reason)
    expect(order[0]).toBe('自取')
    expect(order[1]?.startsWith('汇报:')).toBe(true)
    expect(result.run.note).toContain('数据复盘:取到 8 项,并写了三条建议')
    expect(result.run.status).toBe('ok')
  })

  it('★它抛了不连累开工汇报:汇报照发,原因如实写进 note', async () => {
    const h = await harness({
      open: opened,
      beforeMorning: async () => { throw new Error('登录窗口没开着') },
    })
    const result = await h.routines.run('morning')
    if (!result.ok) throw new Error(result.reason)
    expect(result.run.status).toBe('ok')
    expect(result.run.conversation).toEqual({ agent: 'dsh', session_id: 'sess-1' })
    expect(result.run.note).toContain('数据复盘自取出错:登录窗口没开着')
  })

  it('★会话开不出来时,自取那一下**已经做完了** —— note 里不能不写', async () => {
    const h = await harness({
      open: async () => undefined,
      beforeMorning: async () => '数据复盘:取到 8 项',
    })
    const result = await h.routines.run('morning')
    if (!result.ok) throw new Error(result.reason)
    expect(result.run.status).toBe('no_session')
    expect(result.run.note).toBe('会话未开;数据复盘:取到 8 项')
  })

  it('没接这个钩子时,开工汇报与加它之前逐字相同', async () => {
    const h = await harness({ open: opened })
    const result = await h.routines.run('morning')
    if (!result.ok) throw new Error(result.reason)
    expect(result.run.note).toBe('没配记忆仓库(routines.json 的 repo),第一句没有')
  })

  it('下班例程与知识 lint 不受它影响(只挂在开工汇报上)', async () => {
    let called = 0
    const h = await harness({ open: opened, beforeMorning: async () => { called++; return 'x' } })
    await h.routines.run('lint')
    expect(called).toBe(0)
  })
})

/**
 * 下班例程**之后**那一下(2026-09-22,卡 ⑥ 进化循环)。
 *
 * 挂在下班例程之后而不是早报之前:早上她要的是今天先做哪件,不是"要不要改一下我自己"。
 * 钉三件 —— 顺序在后、结果进 note、抛了不连累下班例程。
 */
describe('下班例程之后:扫一遍重复', () => {
  it('★跑在下班例程之后,结果记进 note —— 自动动作要看得见(PRD §9)', async () => {
    const order: string[] = []
    const h = await harness({
      open: async () => { order.push('下班会话'); return 'sess-1' },
      afterEvening: async () => { order.push('扫重复'); return '发现 1 件反复在做的事,提议摆进收件箱了' },
    })
    const result = await h.routines.run('evening')
    if (!result.ok) throw new Error(result.reason)
    expect(order).toEqual(['下班会话', '扫重复'])
    expect(result.run.note).toContain('发现 1 件反复在做的事')
    expect(result.run.status).toBe('ok')
  })

  it('★它抛了不连累下班例程:记忆照写、会话照开,原因如实写进 note', async () => {
    const h = await harness({ open: opened, afterEvening: async () => { throw new Error('读不到台账') } })
    const result = await h.routines.run('evening')
    if (!result.ok) throw new Error(result.reason)
    expect(result.run.status).toBe('ok')
    expect(result.run.conversation).toEqual({ agent: 'dsh', session_id: 'sess-1' })
    expect(result.run.note).toContain('进化提议没扫成:读不到台账')
  })

  it('★会话开不出来时这一扫照样跑 —— 代码那一半已经做完了', async () => {
    const h = await harness({ open: async () => undefined, afterEvening: async () => '近 14 天没发现值得固化的重复' })
    const result = await h.routines.run('evening')
    if (!result.ok) throw new Error(result.reason)
    expect(result.run.status).toBe('no_session')
    expect(result.run.note).toContain('近 14 天没发现值得固化的重复')
  })

  it('只挂在下班例程上:开工汇报与知识 lint 不碰它', async () => {
    let called = 0
    const h = await harness({ open: opened, afterEvening: async () => { called += 1; return 'x' } })
    await h.routines.run('morning')
    await h.routines.run('lint')
    expect(called).toBe(0)
  })
})

describe('下班例程:只追加不删、一次 commit', () => {
  it('布局覆盖(手写节保留)、今天有活动的项目各多一条进展、新项目建档、索引更新、记忆索引重写、一次 commit', async () => {
    const repo = memoryRepo()
    const h = await harness({ open: opened, repo })
    const before = {
      a: await readFile(join(repo, 'docs/记忆/项目/A.md'), 'utf8'),
      b: await readFile(join(repo, 'docs/记忆/项目/B.md'), 'utf8'),
    }
    const result = await h.routines.run('evening')
    if (!result.ok) throw new Error(result.reason)
    expect(result.run.status).toBe('ok')

    // A 今天在动:多了一条,旧行都还在。B 闲置:一字不动。
    const a = await readFile(join(repo, 'docs/记忆/项目/A.md'), 'utf8')
    expect(a).toContain('- 2026-09-15:今天有活动——分支 `main`,未提交 2 处,近 14 天 4 次提交;看板:等确认 1 张(依据:/state.projects[A].signals、/state.tasks;下班例程自动追加)\n- 2026-09-14:改了登录页')
    for (const line of before.a.split('\n')) expect(a).toContain(line)
    expect(await readFile(join(repo, 'docs/记忆/项目/B.md'), 'utf8')).toBe(before.b)
    // Z 是新项目:建档 + 今天那一条。
    const z = await readFile(join(repo, 'docs/记忆/项目/Z.md'), 'utf8')
    expect(z.startsWith('# Z\n')).toBe(true)
    expect(z).toContain('- 2026-09-15:今天有活动——分支 `dev`,未提交 1 处;看板:这个项目没有在动的卡')
    expect(z).toContain('- 2026-09-15:建档')
    // 项目索引:活动列与新行。
    const index = await readFile(join(repo, 'docs/记忆/项目/索引.md'), 'utf8')
    expect(index).toContain('# 项目索引(快照 2026-09-15)')
    expect(index).toContain('| A | 待梳理 | 待梳理 | 今天在动 |')
    expect(index).toContain('| B | 待梳理 | 待梳理 | 闲置 5 天 |')
    expect(index).toContain('| Z | 待梳理 | 待梳理 | 今天在动 | `/x/Z` | [项目/Z.md](项目/Z.md) |')
    // 布局:生成的 + 手写节。
    const layout = await readFile(join(repo, 'docs/记忆/工作台-布局.md'), 'utf8')
    expect(layout.startsWith('# 工作台布局(快照 2026-09-15')).toBe(true)
    expect(layout).not.toContain('| 旧 |')
    expect(layout).toContain('## 每个模块里有什么(能力清单的 UI 视角)\n- 项目区:总览')
    expect(await readFile(join(repo, 'docs/记忆/工作台-布局.html'), 'utf8')).toContain('<')
    // 记忆索引:一行一文件,日期来自 git log;没动过的文件是建仓那天,这次要提交的文件记今天。
    const memoryIndex = await readFile(join(repo, 'docs/记忆索引.md'), 'utf8')
    expect(memoryIndex.startsWith('# 记忆索引(全仓库 docs 一行一文件;2026-09-15 由下班例程重写)')).toBe(true)
    expect(memoryIndex).toMatch(/- \[docs\/记忆\/项目\/Z\.md\]\(记忆\/项目\/Z\.md\) — Z — [^\n]* — 2026-09-15\n/)
    expect(memoryIndex).toMatch(/- \[docs\/记忆\/项目\/A\.md\]\(记忆\/项目\/A\.md\) — A — [^\n]* — 2026-09-15\n/)
    expect(memoryIndex).toMatch(/- \[docs\/记忆\/项目\/B\.md\]\(记忆\/项目\/B\.md\) — B — [^\n]* — 2026-09-14\n/)
    expect(memoryIndex).toContain('- [docs/交接-0914-x.md](交接-0914-x.md) — 交接 x — 一句话。 — 2026-09-14\n')
    // 一次 commit,只带记忆路径;仓库别处没动。
    expect(gitLog(repo)).toEqual(['chore(记忆): 下班例程 2026-09-15', 'init'])
    expect(gitStatus(repo)).toBe('')
    expect(result.run.commit).toMatch(/^[0-9a-f]{7,}$/)
    expect(result.run.note).toContain('2 个项目追加了进展(A、Z)')
    expect(result.run.note).toContain('新建档 1 个')
    expect(result.run.note).toContain(`commit ${result.run.commit}`)
    // 会话第一条消息:说清楚代码做了什么,剩下的按技能做,只追加不删。
    expect(h.sent[0]).toBe(eveningFirstMessage(TODAY, result.run.note!.replace(/;会话未开$/, '')))
    expect(h.sent[0]).toContain('只追加不删')
    expect(h.sent[0]).toContain('回三行')
  })

  it('commit 的作者/提交日期跟例程的 today 走(注入时钟),第二次跑记忆索引一字不变', async () => {
    const repo = memoryRepo()
    const h = await harness({ open: opened, repo })
    h.clock.ms = at(TODAY, '18:30')
    const result = await h.routines.run('evening')
    if (!result.ok) throw new Error(result.reason)
    // 墙上钟早就不是 2026-09-15 了;%as/%cs 仍是 TODAY,时间是例程开跑那一刻(18:30,本地时区)。
    const dates = execFileSync('git', ['log', '-1', '--format=%as %cs %ad', '--date=format:%H:%M:%S'], { cwd: repo }).toString().trim()
    expect(dates).toBe(`${TODAY} ${TODAY} 18:30:00`)
    // 第一次跑时索引已按「提交后」记日期,第二次跑 git log 给出的就是同一天,索引不变、也就没有第二个 commit。
    const memoryIndex = await readFile(join(repo, 'docs/记忆索引.md'), 'utf8')
    const again = await h.routines.run('evening')
    if (!again.ok) throw new Error(again.reason)
    expect(await readFile(join(repo, 'docs/记忆索引.md'), 'utf8')).toBe(memoryIndex)
    expect(gitLog(repo)).toHaveLength(2)
  })

  it('同一天跑第二次:进展不重复、没有第二个 commit', async () => {
    const repo = memoryRepo()
    const h = await harness({ open: opened, repo })
    await h.routines.run('evening')
    const once = await readFile(join(repo, 'docs/记忆/项目/A.md'), 'utf8')
    const result = await h.routines.run('evening')
    if (!result.ok) throw new Error(result.reason)
    expect(await readFile(join(repo, 'docs/记忆/项目/A.md'), 'utf8')).toBe(once)
    expect(gitLog(repo)).toHaveLength(2)
    expect(result.run.commit).toBeUndefined()
    expect(result.run.note).toContain('没有需要提交的改动')
  })

  it('仓库里别处有未提交的改动:例程的 commit 不把它带进去', async () => {
    const repo = memoryRepo()
    writeFileSync(join(repo, 'src.ts'), 'export const x = 1\n')
    const h = await harness({ open: opened, repo })
    await h.routines.run('evening')
    expect(gitLog(repo)).toHaveLength(2)
    expect(gitStatus(repo).trim()).toBe('M src.ts')
  })

  it('会话开不出来:文件照写、照 commit,状态 no_session', async () => {
    const repo = memoryRepo()
    const h = await harness({ open: async () => undefined, repo })
    const result = await h.routines.run('evening')
    if (!result.ok) throw new Error(result.reason)
    expect(result.run.status).toBe('no_session')
    expect(result.run.note?.endsWith(';会话未开')).toBe(true)
    expect(gitLog(repo)).toHaveLength(2)
  })

  it('没配仓库:只开会话,note 说没写文件', async () => {
    const h = await harness({ open: opened })
    const result = await h.routines.run('evening')
    if (!result.ok) throw new Error(result.reason)
    expect(result.run.status).toBe('ok')
    expect(result.run.note).toContain('没配记忆仓库')
    expect(result.run.commit).toBeUndefined()
  })
})

describe('知识 lint:只提议,不写文件', () => {
  it('只开会话;仓库一个文件不动、没有 commit;第一条消息指明交接文档路径与「只提议不改」', async () => {
    const repo = memoryRepo()
    const h = await harness({ open: opened, repo })
    const filesBefore = (await readdir(join(repo, 'docs'))).sort()
    const result = await h.routines.run('lint')
    if (!result.ok) throw new Error(result.reason)
    expect(result.run.status).toBe('ok')
    expect(result.run.report).toBe(lintDocPath(TODAY))
    expect(lintDocPath(TODAY)).toBe('docs/交接-0915-知识lint.md')
    expect((await readdir(join(repo, 'docs'))).sort()).toEqual(filesBefore)
    expect(gitStatus(repo)).toBe('')
    expect(gitLog(repo)).toEqual(['init'])
    expect(h.sent[0]).toBe(lintFirstMessage(TODAY))
    expect(h.sent[0]).toContain('只写一份 docs/交接-0915-知识lint.md')
    expect(h.sent[0]).toContain('只提议,不改任何别的文件')
  })
})

describe('HTTP:POST /routine/run 与收件箱', () => {
  async function serve(options: { open?: (m: string) => Promise<string | undefined>, repo?: string, now?: number, config?: unknown } = {}) {
    const dir = tempDir()
    const nowMs = options.now ?? at(TODAY, '09:00')
    const routines = createRoutinesService({
      configFile: join(dir, 'routines.json'),
      stateFile: join(dir, 'routines-state.json'),
      now: () => nowMs,
      ...(options.repo === undefined ? {} : { defaultRepo: options.repo }),
      ...(options.open === undefined ? {} : { session: { open: options.open } }),
    })
    await routines.load()
    // 显式注入测试 config:默认 fixture 里早报 enabled 且无 at,09:00 的 GET /state 会被当露面自动触发,
    // 与本用例断言的收件箱互相干扰;验收哪个例程就显式禁用不相关的自动例程。
    if (options.config !== undefined) await routines.setConfig(options.config)
    const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => Math.floor(nowMs / 1000), newId: () => 't-1' })
    await tasks.create({ title: '验收这个', status: 'confirm' })
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService({ now: () => Math.floor(nowMs / 1000) }),
      tickIntervalMs: 0,
      routines,
      tasks,
      projects: fakeProjects(),
    })
    started.push(server)
    return { url: server.url, routines }
  }

  async function post(url: string, path: string, body: unknown) {
    const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }

  async function state(url: string): Promise<WorkbenchState> {
    return await (await fetch(`${url}/state`)).json() as WorkbenchState
  }

  it('验收 1:POST /routine/run morning 之后收件箱多一条「事务官交给我的」,内容是三句加一问,数字与记忆文件一致', async () => {
    const { url } = await serve({ open: async () => 'sess-m', repo: memoryRepo() })
    const res = await post(url, '/routine/run', { name: 'morning' })
    expect(res.status).toBe(200)
    const run = res.body.run as Record<string, unknown>
    expect(run.status).toBe('ok')

    const s = await state(url)
    const items = s.butler_inbox?.items ?? []
    const item = items.find(i => i.kind === 'routine')
    expect(item).toBeDefined()
    expect(items[0]).toBe(item) // 例程开口排最前
    expect(item?.title).toBe('开工汇报')
    expect(item?.note).toBe([
      '上次 9月14日 记了 2 个项目的进展(A、B)、1 条关于你的观察。',
      '今天没有在盯的事。',
      '等你拍板:决策记录 1 段待拍板、1 张卡等你确认。',
      '今天先做哪件?',
    ].join('\n'))
    expect(item?.conversation).toEqual({ agent: 'dsh', session_id: 'sess-m' })
    expect(item?.id).toBe(`routine:morning:${TODAY}`)
    expect(s.routines?.last.morning?.report).toBe(item?.note)
    expect(s.routines?.running).toEqual([])
  })

  it('会话未开时收件箱那条照样在,标「会话未开」,不给点', async () => {
    const { url } = await serve({ open: async () => undefined })
    await post(url, '/routine/run', { name: 'morning' })
    const item = (await state(url)).butler_inbox?.items.find(i => i.kind === 'routine')
    expect(item?.note?.endsWith('今天先做哪件? · 会话未开')).toBe(true)
    expect(item?.conversation).toBeUndefined()
  })

  it('DSH 没接:跳过的例程(下班)不进收件箱,/state.routines.last 里有 note', async () => {
    // 下班验收只关心 evening:显式禁用不相关的自动早报,不让 09:00 那次 GET /state 以「露面」触发它。
    // 早报 no_session 仍进收件箱的兄弟路由「★DSH 没接:早报那张卡照样进收件箱…」覆盖。
    const { url } = await serve({ config: { morning: { enabled: false } } })
    const res = await post(url, '/routine/run', { name: 'evening' })
    expect(res.status).toBe(200)
    const s = await state(url)
    expect(s.butler_inbox?.items.some(i => i.kind === 'routine')).toBe(false)
    expect(s.routines?.last.evening?.status).toBe('skipped')
    expect(s.routines?.last.evening?.note).toBe('DSH 不在线,这次跳过')
  })

  /** 2026-10-13:早报不跟着 DSH 一起消失 —— 卡照样在收件箱里,只在末尾说清模型那半没开。 */
  it('★DSH 没接:早报那张卡照样进收件箱,末尾标「事务官会话没开…」,不给点', async () => {
    const { url } = await serve()
    expect((await post(url, '/routine/run', { name: 'morning' })).status).toBe(200)
    const s = await state(url)
    const item = s.butler_inbox?.items.find(i => i.kind === 'routine')
    expect(item?.title).toBe('开工汇报')
    expect(item?.note?.endsWith(`今天先做哪件? · ${BUTLER_SESSION_OFFLINE_NOTE}`)).toBe(true)
    expect(item?.conversation).toBeUndefined()
    expect(s.routines?.last.morning?.status).toBe('no_session')
    expect(s.routines?.last.morning?.session_offline).toBe(true)
  })

  it('验收 2:POST /routine/run evening 之后项目文件各多一条进展、索引更新、一次 commit', async () => {
    const repo = memoryRepo()
    const { url } = await serve({ open: async () => 'sess-e', repo })
    const res = await post(url, '/routine/run', { name: 'evening' })
    expect(res.status).toBe(200)
    expect((res.body.run as Record<string, unknown>).status).toBe('ok')
    expect(await readFile(join(repo, 'docs/记忆/项目/A.md'), 'utf8')).toContain('- 2026-09-15:今天有活动')
    expect(await readFile(join(repo, 'docs/记忆/项目/索引.md'), 'utf8')).toContain('# 项目索引(快照 2026-09-15)')
    expect(gitLog(repo)).toEqual(['chore(记忆): 下班例程 2026-09-15', 'init'])
    const item = (await state(url)).butler_inbox?.items.find(i => i.kind === 'routine')
    expect(item?.title).toBe('下班例程')
    expect(item?.conversation).toEqual({ agent: 'dsh', session_id: 'sess-e' })
  })

  it('name 不对 400;在跑时 409;没接例程服务 404', async () => {
    let release: (() => void) | undefined
    const { url } = await serve({ open: () => new Promise(resolve => { release = () => resolve('s') }) })
    expect((await post(url, '/routine/run', { name: 'lunch' })).status).toBe(400)
    const first = post(url, '/routine/run', { name: 'lint' })
    await new Promise(r => setTimeout(r, 30))
    const second = await post(url, '/routine/run', { name: 'lint' })
    expect(second.status).toBe(409)
    release?.()
    expect((await first).status).toBe(200)

    const bare = await startWorkbenchServer({ port: 0, service: createWorkbenchService(), tickIntervalMs: 0 })
    started.push(bare)
    expect((await post(bare.url, '/routine/run', { name: 'lint' })).status).toBe(404)
    expect((await state(bare.url)).routines).toBeUndefined()
  })

  it('POST /routine/config 部分更新,/state.routines.config 回显', async () => {
    const { url } = await serve()
    const res = await post(url, '/routine/config', { evening: { at: '19:15' }, morning: { enabled: false } })
    expect(res.status).toBe(200)
    const s = await state(url)
    expect(s.routines?.config.evening.at).toBe('19:15')
    expect(s.routines?.config.morning.enabled).toBe(false)
    expect(s.routines?.next.morning).toBeUndefined()
    expect(s.routines?.next.evening).toEqual({ kind: 'at', at: `${TODAY}T19:15` })
  })

  it('本机 GET /state 算「露面」:没设开工时刻时第一次露面就跑开工汇报', async () => {
    const { url } = await serve({ open: async () => 'sess-s' })
    await state(url)
    await new Promise(r => setTimeout(r, 50))
    const s = await state(url)
    expect(s.routines?.last.morning?.trigger).toBe('sighting')
    expect(s.butler_inbox?.items[0]?.kind).toBe('routine')
  })
})

// ———————————————————————— 没装好不跑(2026-09-23 从零重装验收第 3 件) ————————————————————————

describe('★ 没注册 / 引导没走完:例程的自动那一半不跑', () => {
  it('新装机器第一次露面:不跑开工汇报;装好之后同一天再露面才跑', async () => {
    let gate: string | undefined = '还没注册账号'
    const h = await harness({ open: async () => 's', setupGate: () => gate })
    h.clock.ms = at(TODAY, '17:01')
    h.routines.sighted()
    await new Promise(r => setTimeout(r, 20))
    expect(h.sent).toHaveLength(0)
    expect(h.routines.view().last.morning).toBeUndefined()
    gate = undefined
    h.routines.sighted()
    await new Promise(r => setTimeout(r, 30))
    expect(h.sent).toHaveLength(1)
  })

  it('到点也不跑(下班例程),门一开下一拍就补上', async () => {
    let gate: string | undefined = '新用户引导还没走完'
    const h = await harness({ open: async () => 's', setupGate: () => gate })
    h.clock.ms = at(TODAY, '18:31')
    h.routines.pump()
    await new Promise(r => setTimeout(r, 20))
    expect(h.sent).toHaveLength(0)
    gate = undefined
    h.routines.pump()
    await new Promise(r => setTimeout(r, 30))
    expect(h.sent.some(m => m.includes('下班例程'))).toBe(true)
  })

  it('他亲手点「现在跑一次」不拦', async () => {
    const h = await harness({ open: async () => 's', setupGate: () => '还没注册账号' })
    const result = await h.routines.run('morning')
    expect(result.ok).toBe(true)
    expect(h.sent).toHaveLength(1)
  })
})
