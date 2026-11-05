// @vitest-environment node
/**
 * 「授权扫仓库,但是没去扫」(2026-09-20,Ben 真机从零验收第二轮第 ① 条)。
 *
 * 他那一通电话的工人日志里只有十几条 `record_answer`,**一次扫描都没有** ——
 * 通话模式的工人手上只有「记一项」这一件工具,②′ 那一段它只能凭空问。
 * 这条路把「授权线」那一半接回来:`POST /onboarding/scan`。
 *
 * 钉四件:
 *   ① 门认**授权表**(`read_scan_roots`),不是「可以」就 403 带那句人话;
 *   ② 复用项目区那份扫描,不另起一套(电话里的 13 和电脑上的 13 必须是同一个);
 *   ③ 手工建的、没有仓库路径的项目**不算扫到的仓库**;
 *   ④ 没接项目区就 503,**不回一个空清单**(空清单会被模型读成「你一个仓库都没有」)。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProjectsState } from '../src/protocol.ts'
import { createAuthorizationService } from '../src/server/authorization.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createOnboardingService } from '../src/server/onboarding.ts'
import { SCAN_REPO_LIMIT, byRecency, idleText, repoSummary, scanResultOf } from '../src/server/onboardingScan.ts'
import type { ProjectsService } from '../src/server/projectsService.ts'
import { FULL_PLAN, stageDef } from '../src/server/onboardingStages.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const NOW_SEC = Math.floor(Date.parse('2026-09-20T01:00:00Z') / 1000)

async function post(url: string, path: string, body?: unknown) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

function state(over: Partial<ProjectsState> = {}): ProjectsState {
  return {
    projects: [],
    pending: [],
    scan_errors: [],
    scanned_at: '2026-09-20T00:59:30Z',
    ...over,
  }
}

function repo(name: string, idleDays: number, over: Record<string, unknown> = {}) {
  return {
    id: name,
    name,
    stage: '待整理' as const,
    path: `/Users/example/Documents/GitHub/${name}`,
    signals: {
      branch: 'main',
      dirty_count: 0,
      worktrees: 0,
      cleanup_count: 0,
      idle_days: idleDays,
      last_commit_at: '2026-09-19T00:00:00Z',
    },
    links: [],
    session_count: 0,
    idle: false,
    ...over,
  }
}

async function serve(options: { projects?: ProjectsService } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wb-onboarding-scan-'))
  dirs.push(root)
  const repoRoot = join(root, 'repo')
  mkdirSync(join(repoRoot, 'docs', '记忆', '项目'), { recursive: true })
  writeFileSync(join(repoRoot, 'README.md'), 'x\n')
  execFileSync('git', ['init', '-q'], { cwd: repoRoot })
  execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repoRoot })
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: repoRoot })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repoRoot })
  const agentsFile = join(root, 'AGENTS.md')
  writeFileSync(agentsFile, '# 事务官\n')
  const authorization = createAuthorizationService({ file: join(repoRoot, 'docs', '记忆', '授权.md') })
  const onboarding = createOnboardingService({
    plan: FULL_PLAN,
    file: join(root, 'onboarding.json'),
    repoRoot,
    agentsFile,
    authorization,
    now: () => new Date(NOW_SEC * 1000),
  })
  await onboarding.load()
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    onboarding,
    authorization,
    ...(options.projects === undefined ? {} : { projects: options.projects }),
  })
  started.push(server)
  return { url: server.url, authorization }
}

function fakeProjects(next: () => Promise<ProjectsState>): { service: ProjectsService, calls: () => number } {
  let calls = 0
  const service = {
    getProjectsState: async () => { calls += 1; return next() },
    confirmStatus: async () => true,
    setDdl: async () => true,
    addRule: async () => {},
    getLayout: async () => undefined,
    setLayout: async () => {},
    invalidateScanCache: () => {},
  } as unknown as ProjectsService
  return { service, calls: () => calls }
}

describe('②′ 先问交哪一个,不先扫(2026-09-23 维护者拍板)', () => {
  it('种子句问「先把哪个项目交给我」,不再先要读目录的授权;goals 写明只录他挑的、「全部」先劝从一个开始、以后「再加一个」', () => {
    const def = stageDef('projects', 'existing')
    expect(def.seed).toContain('你想先把哪个项目交给我')
    expect(def.seed).not.toContain('放仓库的目录')
    const goals = def.goals.join('\n')
    expect(goals).toContain('**先不扫**')
    expect(goals).toContain('带上 name')
    expect(goals).toContain('你帮我找找')
    expect(goals).toContain('挑中的才录,没挑的一个都不记')
    expect(goals).toContain('建议先从一个开始')
    expect(goals).toContain('再加一个')
    expect(goals).not.toContain('当场去扫')
  })

  it('带 name → 只按名字找(不跑全量扫描),回 located;没找到回空数组 + 人话;同样过授权门', async () => {
    const located: string[] = []
    const projects = fakeProjects(async () => state())
    ;(projects.service as { locate?: unknown }).locate = async (query: string) => {
      located.push(query)
      return query === '工作台'
        ? { matches: [{ name: '工作台', path: '/Users/example/Documents/GitHub/工作台' }], errors: [] }
        : { matches: [], errors: [] }
    }
    const { url, authorization } = await serve({ projects: projects.service })
    expect((await post(url, '/onboarding/scan', { name: '工作台' })).status).toBe(403)
    expect(located).toEqual([])
    await authorization.set('read_scan_roots', '可以', '2026-09-20')
    const got = await post(url, '/onboarding/scan', { name: ' 工作台 ' })
    expect(got).toMatchObject({ status: 200, body: { query: '工作台', located: [{ name: '工作台' }] } })
    expect(projects.calls()).toBe(0)
    const none = await post(url, '/onboarding/scan', { name: '没有这个' })
    expect(none.body).toMatchObject({ located: [], note: expect.stringContaining('放在哪') })
  })

  it('GET /onboarding/scan/status 回扫描进度;/onboarding/turns 随带 scan', async () => {
    const projects = fakeProjects(async () => state())
    ;(projects.service as { scanProgress?: unknown }).scanProgress = () => ({ scanning: true, phase: 'repos', done: 3, total: 13, current: 'aiboo' })
    const { url } = await serve({ projects: projects.service })
    const status = await fetch(`${url}/onboarding/scan/status`)
    expect(status.status).toBe(200)
    expect(await status.json()).toEqual({ scanning: true, phase: 'repos', done: 3, total: 13, current: 'aiboo' })
    const turns = await (await fetch(`${url}/onboarding/turns`)).json() as Record<string, unknown>
    expect(turns.scan).toMatchObject({ scanning: true, done: 3, total: 13 })
  })
})

describe('POST /onboarding/scan', () => {
  it('没给「读扫描根」授权 → 403,而且回的是那句人话(她要原样说给他听)', async () => {
    const projects = fakeProjects(async () => state())
    const { url } = await serve({ projects: projects.service })
    const got = await post(url, '/onboarding/scan')
    expect(got.status).toBe(403)
    expect(String(got.body.error)).toContain('read_scan_roots')
    // **一次都没去读他的硬盘**:门在前面,不是拿到数据再过滤。
    expect(projects.calls()).toBe(0)
  })

  it('授权是「可以」→ 真扫,回一份念得出来的清单,最近动过的排在前面', async () => {
    const projects = fakeProjects(async () => state({
      projects: [
        repo('aiboo', 30),
        repo('desktop-workbench', 0, { signals: { branch: 'fix/x', dirty_count: 3, worktrees: 0, cleanup_count: 0, idle_days: 0, last_commit_at: '2026-09-20T00:00:00Z' } }),
        repo('echo', 8),
      ],
    }))
    const { url, authorization } = await serve({ projects: projects.service })
    await authorization.set('read_scan_roots', '可以', '2026-09-20')
    const got = await post(url, '/onboarding/scan')
    expect(got.status).toBe(200)
    const repos = got.body.repos as { name: string, summary: string, last_commit?: string }[]
    expect(repos.map(item => item.name)).toEqual(['desktop-workbench', 'echo', 'aiboo'])
    expect(repos[0]?.summary).toContain('今天还在动')
    expect(repos[0]?.summary).toContain('3 处还没提交')
    expect(repos[0]?.last_commit).toBe('2026-09-20T00:00:00Z')
    expect(got.body.total).toBe(3)
    expect(got.body.more).toBe(0)
  })

  it('没接项目区 → 503,**不回一个空清单**', async () => {
    const { url, authorization } = await serve()
    await authorization.set('read_scan_roots', '可以', '2026-09-20')
    const got = await post(url, '/onboarding/scan')
    expect(got.status).toBe(503)
    expect(String(got.body.error)).toContain('项目区')
    expect(got.body.repos).toBeUndefined()
  })

  it('扫描自己炸了 → 503 带原因,不是一个假的空清单', async () => {
    const projects = fakeProjects(async () => { throw new Error('git 不见了') })
    const { url, authorization } = await serve({ projects: projects.service })
    await authorization.set('read_scan_roots', '可以', '2026-09-20')
    const got = await post(url, '/onboarding/scan')
    expect(got.status).toBe(503)
    expect(String(got.body.error)).toContain('git 不见了')
  })

  it('扫描根读不到那几条原样带出去(一个根坏了不该让整次扫描变成一句「失败了」)', async () => {
    const projects = fakeProjects(async () => state({
      projects: [repo('aiboo', 1)],
      scan_errors: [{ root: '/Users/example/WeChatProjects', reason: 'EACCES' }],
    }))
    const { url, authorization } = await serve({ projects: projects.service })
    await authorization.set('read_scan_roots', '可以', '2026-09-20')
    const got = await post(url, '/onboarding/scan')
    expect(got.status).toBe(200)
    expect(got.body.errors).toEqual([{ root: '/Users/example/WeChatProjects', reason: 'EACCES' }])
  })
})

describe('scanResultOf', () => {
  it('没有仓库路径的项目不算「扫到的仓库」(那是手工建的,不是扫出来的)', () => {
    const result = scanResultOf(state({
      projects: [
        repo('aiboo', 1),
        { id: '市场调研', name: '市场调研', stage: '待整理', links: [], session_count: 0, idle: false },
      ],
    }))
    expect(result.repos.map(item => item.name)).toEqual(['aiboo'])
    expect(result.total).toBe(1)
  })

  it('超过上限就切一刀,剩下几个如实说', () => {
    const many = Array.from({ length: SCAN_REPO_LIMIT + 5 }, (_, i) => repo(`r${String(i).padStart(2, '0')}`, i))
    const result = scanResultOf(state({ projects: many }))
    expect(result.repos).toHaveLength(SCAN_REPO_LIMIT)
    expect(result.total).toBe(SCAN_REPO_LIMIT + 5)
    expect(result.more).toBe(5)
  })

  it('读不到 git 信号就**如实说**,不写一个 0 上去', () => {
    const result = scanResultOf(state({
      projects: [{ id: 'x', name: 'x', stage: '待整理', path: '/x', signal_error: 'not a git repo', links: [], session_count: 0, idle: false }],
    }))
    expect(result.repos[0]?.summary).toContain('读不到它的 git 信息')
    expect(result.repos[0]?.summary).toContain('not a git repo')
    expect(result.repos[0]?.last_commit).toBeUndefined()
  })

  it('人确认过的那一行状态排在最前面(那是他自己说过的话)', () => {
    const result = scanResultOf(state({
      projects: [repo('aiboo', 2, {
        status: { text: '卡在支付回调', review: 'confirmed', author: '你', updated_at: '2026-09-19T00:00:00Z', stale: false },
      })],
    }))
    expect(result.repos[0]?.summary.startsWith('卡在支付回调')).toBe(true)
  })
})

describe('念得出来的那几句', () => {
  it('idleText 说人话', () => {
    expect(idleText(0)).toBe('今天还在动')
    expect(idleText(1)).toBe('昨天动过')
    expect(idleText(3)).toBe('3 天没动')
    expect(idleText(10)).toBe('1 周没动')
    expect(idleText(70)).toBe('2 个月没动')
    expect(idleText(400)).toBe('一年多没动')
    expect(idleText(undefined)).toBe('')
  })

  it('main / master 不念分支名(念了是噪音),别的分支才念', () => {
    expect(repoSummary(repo('a', 1) as never)).not.toContain('分支')
    expect(repoSummary(repo('a', 1, {
      signals: { branch: 'fix/x', dirty_count: 0, worktrees: 0, cleanup_count: 0, idle_days: 1 },
    }) as never)).toContain('fix/x')
  })

  it('什么都没有的干净仓库也有一句话说(不留空)', () => {
    expect(repoSummary(repo('a', 0, {
      signals: { branch: 'main', dirty_count: 0, worktrees: 0, cleanup_count: 0, idle_days: 0 },
    }) as never)).toContain('今天还在动')
  })

  it('byRecency:读不到信号的排最后 —— **不知道 ≠ 很久没动**', () => {
    const known = repo('known', 99) as never
    const unknown = { id: 'u', name: 'u', stage: '待整理', path: '/u', links: [], session_count: 0, idle: false } as never
    expect(byRecency(unknown, known)).toBeGreaterThan(0)
    expect(byRecency(known, unknown)).toBeLessThan(0)
  })
})
