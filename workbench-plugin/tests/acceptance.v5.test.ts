// @vitest-environment node
/**
 * Task 14:spec §9 六条验收的实测脚本,跑完就是验收证据本身。
 *
 * 关键裁决(brief 没预料到的现实):不向 127.0.0.1:8791 发任何请求——那是 Ben 正在跑的
 * 旧版线上服务(0.1.8,没有本次的新路由),打进去只会得到误导结果甚至污染他的真实数据。
 * 这里每个 describe 块都起一个完全独立的服务实例:临时 HOME 下的真 git 仓库
 * (git init + 真提交 + 真 worktree)、临时 projects.json、随机高位端口(port: 0)。
 * 测的是 worktree 里的真代码(projectsService/scan/attribution/http/layout),
 * 不碰线上任何东西,也不 mock git——git 相关断言直接跟真实 `git` 命令的输出对照。
 */
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import * as layoutModule from '../src/client/layout.ts'
import { FIXED_MODULES, MODULE_IDS, resetLayout } from '../src/client/layout.ts'
import { butlerConclusions } from '../src/client/butler.ts'
import type { WorkbenchLayout, WorkbenchProject, WorkbenchState } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { emptyProjectsFile, saveProjectsFile } from '../src/server/projects.ts'
import { createProjectsService } from '../src/server/projectsService.ts'
import type { ScanRoot } from '../src/server/scan.ts'
import { findRepos } from '../src/server/scan.ts'
import { defaultCodexSessionSourceDeps } from '../src/server/sessionSources.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const execFileAsync = promisify(execFile)

/** 与 src/index.ts 的 gitExec 原样复刻(spec §6 的 Exec 签名)——测试要打真 git,不 mock。 */
async function gitExec(args: readonly string[], cwd: string): Promise<{ ok: boolean, stdout: string }> {
  try {
    const { stdout } = await execFileAsync('git', args as string[], { cwd })
    return { ok: true, stdout }
  }
  catch {
    return { ok: false, stdout: '' }
  }
}

/** 与 src/index.ts 的 listDir/isRepo 原样复刻。 */
async function listDir(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries.filter(entry => entry.isDirectory()).map(entry => join(dir, entry.name))
}
async function isRepo(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, '.git'))
    return true
  }
  catch {
    return false
  }
}

async function git(args: string[], cwd: string, env?: Record<string, string>): Promise<void> {
  await execFileAsync('git', args, { cwd, env: { ...process.env, ...env } })
}

/** 真造一个仓库:init + 提交(可控日期),供「算」行与真 git 输出对照。 */
async function makeRepo(dir: string, commitDate: string): Promise<void> {
  mkdirSync(dir, { recursive: true })
  await git(['init', '-q', '-b', 'main'], dir)
  await git(['config', 'user.email', 'test@example.com'], dir)
  await git(['config', 'user.name', 'Acceptance Test'], dir)
  writeFileSync(join(dir, 'README.md'), '# fake\n')
  await git(['add', '.'], dir)
  await git(['commit', '-q', '-m', 'init'], dir, {
    GIT_AUTHOR_DATE: commitDate,
    GIT_COMMITTER_DATE: commitDate,
  })
}

const dirs: string[] = []
const servers: WorkbenchServer[] = []

afterEach(async () => {
  while (servers.length) await servers.pop()?.close()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  // macOS 下 os.tmpdir() 落在 /var/folders/...,而 /var 是指向 /private/var 的符号链接。
  // git 内部报路径时用的是解析后的真实路径,这里也解析一次,否则「主仓路径」跟 git
  // 输出里的路径对不上,parseWorktreePorcelain 会把主仓自己也数成一个 worktree。
  return realpathSync(d)
}

function defaultProjectsServiceOpts(args: { file: string, home: string, scanRoots: ScanRoot[] }) {
  const codexHome = tempDir('wb-accept-codex-')
  mkdirSync(join(codexHome, 'sessions'), { recursive: true })
  return createProjectsService({
    file: args.file,
    home: args.home,
    scanRoots: args.scanRoots,
    exec: gitExec,
    listDir,
    isRepo,
    codexHome,
    codexDeps: defaultCodexSessionSourceDeps,
    scanMinIntervalSec: 0,
  })
}

// ---------------------------------------------------------------------------
// 验收 1:项目区显示真实仓库,算行与 git 实况一致;闲置线与折叠规则生效
// ---------------------------------------------------------------------------
describe('验收 1(spec §9.1):项目区真实仓库 / 算行与 git 一致 / 闲置线与折叠规则', () => {
  it('真造仓库:branch/dirty_count/worktrees 与真 git 输出逐项对照;worktree 不单独成行', async () => {
    const ghRoot = tempDir('wb-accept1-gh-')
    const repoDir = join(ghRoot, 'fake-active')
    await makeRepo(repoDir, new Date().toISOString())

    // 真造一个 worktree,挂在扫描根之外(和真机上 .claude/worktrees/ 的相对位置同理:
    // 不在扫描根的直接子层,天然不会被 findRepos 当成独立仓库行)。
    const wtParent = tempDir('wb-accept1-wt-')
    const wtDir = join(wtParent, 'fake-active-wt')
    await git(['worktree', 'add', '-q', '-b', 'feat/x', wtDir], repoDir)

    // 造一个脏文件,验证 dirty_count 与 git status --porcelain 行数一致
    writeFileSync(join(repoDir, 'scratch.txt'), 'wip')

    const file = join(tempDir('wb-accept1-proj-'), 'projects.json')
    const projects = defaultProjectsServiceOpts({
      file,
      home: ghRoot,
      scanRoots: [{ path: ghRoot, depth: 1 }],
    })

    const state = await projects.getProjectsState()
    expect(state.scan_errors).toEqual([])
    const project = state.projects.find(p => p.name === 'fake-active')
    expect(project).toBeDefined()

    const realStatus = await execFileAsync('git', ['status', '--porcelain'], { cwd: repoDir })
    const realDirty = realStatus.stdout.split('\n').filter(l => l !== '').length
    expect(project!.signals?.dirty_count).toBe(realDirty)
    expect(realDirty).toBe(1)

    const realBranch = (await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoDir })).stdout.trim()
    expect(project!.signals?.branch).toBe(realBranch)
    expect(realBranch).toBe('main')

    // worktree 计入 signals.worktrees(spec D14:折叠进主仓一行),不作为独立项目行出现
    expect(project!.signals?.worktrees).toBe(1)
    expect(state.projects.some(p => p.path === wtDir)).toBe(false)
    expect(state.projects).toHaveLength(1)
  })

  it('闲置线:提交时间在 30 天前 → idle_days/idle 判定生效', async () => {
    const ghRoot = tempDir('wb-accept1b-gh-')
    const idleDir = join(ghRoot, 'fake-idle')
    const past = new Date(Date.now() - 30 * 86_400_000).toISOString()
    await makeRepo(idleDir, past)

    const file = join(tempDir('wb-accept1b-proj-'), 'projects.json')
    const projects = defaultProjectsServiceOpts({
      file,
      home: ghRoot,
      scanRoots: [{ path: ghRoot, depth: 1 }],
    })

    const state = await projects.getProjectsState()
    const project = state.projects.find(p => p.name === 'fake-idle')
    expect(project).toBeDefined()
    expect(project!.signals?.idle_days).toBeGreaterThanOrEqual(29)
    expect(project!.idle).toBe(true)
  })

  it('「本机真实仓库」对照:只读扫描 ~/Documents/GitHub,不写入任何文件(环境自适应,终审 D2)', async ({ skip }) => {
    const home = process.env.HOME
    // 环境没有 HOME、目录不存在、或存在但扫出 0 仓库,都不是这条用例要验证的失败——
    // 用 ctx.skip() 显式跳过并注明原因,不能在没有真实仓库的机器/CI 上假红,
    // 也不能用早退的 `return` 悄悄放过(那样报告里看不出这条到底跑没跑)。
    skip(home === undefined, 'HOME 环境变量未设置')

    const root = `${home}/Documents/GitHub`
    let repos: string[] = []
    try {
      // findRepos 内部只调用 listDir(readdir)与 isRepo(stat),没有任何写操作。
      repos = await findRepos({ path: root, depth: 1 }, listDir, isRepo)
    }
    catch {
      skip(true, `~/Documents/GitHub 不存在或不可读:${root}`)
    }
    skip(repos.length === 0, `~/Documents/GitHub 下没有扫到任何仓库:${root}`)

    // 只断言"扫到了真实仓库",不断言具体名字(会随本机项目增减漂移)。
    expect(repos.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 验收 2:新会话结束后 cwd 可归 → 自动进对应项目;不可归 → 进待归档目录组,
//        标一次规则后同目录不再问
// ---------------------------------------------------------------------------
describe('验收 2(spec §9.2):新会话归属', () => {
  it('cwd 落在已知仓库内 → 自动计入对应项目 session_count', async () => {
    const ghRoot = tempDir('wb-accept2-gh-')
    const repoDir = join(ghRoot, 'proj-a')
    await makeRepo(repoDir, new Date().toISOString())

    const file = join(tempDir('wb-accept2-proj-'), 'projects.json')
    const codexHome = tempDir('wb-accept2-codex-')
    const sessionsDir = join(codexHome, 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    writeFileSync(
      join(sessionsDir, 'a.jsonl'),
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'top-repo', cwd: join(repoDir, 'sub', 'dir'), timestamp: new Date().toISOString(), source: 'cli' } })}\n`,
    )

    const projects = createProjectsService({
      file, exec: gitExec, listDir, isRepo, codexHome,
      codexDeps: defaultCodexSessionSourceDeps,
      home: ghRoot,
      scanRoots: [{ path: ghRoot, depth: 1 }],
      scanMinIntervalSec: 0,
    })

    const state = await projects.getProjectsState()
    const project = state.projects.find(p => p.name === 'proj-a')
    expect(project?.session_count).toBe(1)
    expect(state.pending).toHaveLength(0)
  })

  it('cwd 归不出 → 进待归档目录组;标一次「不是我的」规则后,同目录新会话不再进 pending', async () => {
    const ghRoot = tempDir('wb-accept2b-gh-') // 空扫描根,没有任何仓库
    const file = join(tempDir('wb-accept2b-proj-'), 'projects.json')
    const codexHome = tempDir('wb-accept2b-codex-')
    const sessionsDir = join(codexHome, 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    const home = tempDir('wb-accept2b-home-')
    const strayCwd = join(home, 'elsewhere', 'someproject')
    writeFileSync(
      join(sessionsDir, 'a.jsonl'),
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'top-stray', cwd: strayCwd, timestamp: new Date().toISOString(), source: 'cli' } })}\n`,
    )

    const projects = createProjectsService({
      file, exec: gitExec, listDir, isRepo, codexHome,
      codexDeps: defaultCodexSessionSourceDeps,
      home,
      scanRoots: [{ path: ghRoot, depth: 1 }],
      scanMinIntervalSec: 0,
    })

    const state1 = await projects.getProjectsState()
    expect(state1.pending.length).toBeGreaterThan(0)
    const groupDir = state1.pending[0]!.dir

    // 标一次规则(D7:目录级规则一次生效)
    await projects.addRule({ dir: groupDir, action: 'not_mine' })

    const state2 = await projects.getProjectsState()
    expect(state2.pending.some(g => g.dir === groupDir)).toBe(false)

    // 模拟"新会话结束"——同目录下再来一条新的 codex 会话,验证不再问
    writeFileSync(
      join(sessionsDir, 'b.jsonl'),
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'top-stray-2', cwd: join(strayCwd, 'sibling'), timestamp: new Date().toISOString(), source: 'cli' } })}\n`,
    )
    const state3 = await projects.getProjectsState()
    expect(state3.pending.some(g => g.dir === groupDir)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 验收 3:拖拽调整布局并"重启"(服务实例重建读同一文件)后布局保持;恢复默认可用
// ---------------------------------------------------------------------------
describe('验收 3(spec §9.3):布局持久化 / "重启" / 恢复默认', () => {
  it('POST /layout → 关服务 → 用同一文件重建全新 service+projects 实例("重启") → 布局仍在;恢复默认可用', async () => {
    const file = join(tempDir('wb-accept3-proj-'), 'projects.json')
    const ghRoot = tempDir('wb-accept3-gh-')

    const projects1 = defaultProjectsServiceOpts({ file, home: ghRoot, scanRoots: [{ path: ghRoot, depth: 1 }] })
    const service1 = createWorkbenchService()
    const server1 = await startWorkbenchServer({ port: 0, service: service1, tickIntervalMs: 0, projects: projects1 })
    servers.push(server1)

    const customLayout: WorkbenchLayout = {
      modules: [
        { id: 'notes', order: 0, basis_pct: 50 },
        { id: 'projects', order: 1, basis_pct: 20 },
        { id: 'slot', order: 2, basis_pct: 10, hidden: true },
      ],
      butler: { corner: 'tl', min: true },
    }
    const postResp = await fetch(`${server1.url}/layout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layout: customLayout }),
    })
    expect(postResp.status).toBe(200)

    // "重启":真的关掉服务、丢弃这一份内存里的 projectsService,重新 new 一份读同一份文件——
    // 不是同进程内存的残留(那样测不出持久化,只是测了变量没被 GC)。
    await server1.close()
    servers.splice(servers.indexOf(server1), 1)

    const projects2 = defaultProjectsServiceOpts({ file, home: ghRoot, scanRoots: [{ path: ghRoot, depth: 1 }] })
    const service2 = createWorkbenchService()
    const server2 = await startWorkbenchServer({ port: 0, service: service2, tickIntervalMs: 0, projects: projects2 })
    servers.push(server2)

    const state = await (await fetch(`${server2.url}/state`)).json() as WorkbenchState
    // 2026-08-25 顶部分栏:迁移会给不含 usage 的旧存档补一条,并把它插在项目区紧后面
    // ——插入必然让后面的模块序号顺移,所以不能再断言**绝对** order。这一条验收要验的
    // 是"用户存的那几条原样回来了":篇幅/收起状态逐字不变,**相对先后**不变。
    expect(state.layout?.butler).toEqual(customLayout.butler)

    const returned = state.layout?.modules ?? []
    // 退休的模块(sessions)不会回来,只比对仍然合法的那些。
    const stillValid = customLayout.modules.filter(saved => returned.some(m => m.id === saved.id))
    expect(stillValid.length).toBeGreaterThan(0)

    for (const saved of stillValid) {
      const back = returned.find(m => m.id === saved.id)
      expect(back).toBeDefined()
      if (saved.hidden !== undefined) expect(back?.hidden).toBe(saved.hidden)

      if (saved.id === 'projects') {
        // 顶部行在补 usage 那一次会被抬到可用高度(那一行的职责变了,见
        // migrateLayoutModules 的 TOP_ROW_MIN_BASIS):只保证不低于用户存的值。
        expect(back?.basis_pct ?? 0).toBeGreaterThanOrEqual(saved.basis_pct ?? 0)
      }
      else {
        // 其他模块的篇幅逐字不变——迁移只碰顶部行。
        expect(back?.basis_pct).toBe(saved.basis_pct)
      }
    }

    // 相对先后不变
    const orderOf = (id: string): number => returned.find(m => m.id === id)?.order ?? -1
    for (let i = 1; i < stillValid.length; i += 1) {
      const prev = stillValid[i - 1]?.id ?? ''
      const curr = stillValid[i]?.id ?? ''
      expect(orderOf(prev)).toBeLessThan(orderOf(curr))
    }

    expect(returned.map(m => m.id)).toContain('usage')

    // 恢复默认
    const def = resetLayout()
    const resetResp = await fetch(`${server2.url}/layout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layout: def }),
    })
    expect(resetResp.status).toBe(200)
    const state2 = await (await fetch(`${server2.url}/state`)).json() as WorkbenchState
    expect(state2.layout).toEqual(def)
  })
})

// ---------------------------------------------------------------------------
// 验收 4(2026-10-13 修订):收起补偿("收起必有通知")**整条退休**,信号归常显的主人
//
// 原来这一节验的是"收起含红档信号的模块 → 顶条下方那条固定通知行可见"。A3 那一波
// sessions 那支先退(让给窗位叠标签上的徽章),2026-08-25 widgets 那支再退(让给顶条常显),
// 2026-10-13 最后的 projects 那支也退了:维护者看着真机截图问「顶部这个黄色框是啥意思」
// —— 那条琥珀描边里只有一个项目名,一个字不说为什么,而过期的 DDL 还让它永久钉在那儿。
//
// 现在要守的是**替换关系成立**:判据层不再有"上浮文本"的出口,而同一条信号由事务官浮窗
// 用整句话说、不看模块收没收起。渲染出来那一屏没有那条横条,由
// tests/client-hoisted-alert-bar-gone-20261013.test.tsx 钉。
// ---------------------------------------------------------------------------
describe('验收 4(spec §9.4 修订):收起补偿退休,信号归常显的主人', () => {
  it('布局层不再有任何"上浮文本"的出口(hoistedAlerts 已随最后一支退休一起删掉)', () => {
    expect('hoistedAlerts' in layoutModule).toBe(false)
  })

  it('同一条信号有常显的主人:事务官浮窗用整句话说,且不看模块收没收起', () => {
    // 真机 /state 那一份的形状(维护者截图当天):DDL 过了九天、服务端把排期判成「赶不上」。
    const late: WorkbenchProject = {
      id: 'wb', name: '工作台', stage: '待整理', links: [], session_count: 0, idle: false,
      ddl: { date: '2026-10-04', title: 'Spotlight 报名截止' },
      risk: { level: 'late', reason: '截止已过 9 天,还剩 2 条', window_days: 14, done_recent: 2, remaining: 2 },
    }
    const state: WorkbenchState = {
      agents: [], sessions: [], quota: {}, now: '2026-10-13T12:36:31+08:00', stale: false,
      projects: { projects: [late], pending: [], scan_errors: [], scanned_at: '2026-10-13T12:36:31+08:00' },
    }

    // 整句话,不是一个光秃秃的名字 —— 这正是那条横条做不到的事。
    expect(butlerConclusions(state, Date.parse(state.now) / 1000))
      .toContain('工作台 按当前速度赶不上 10-4')
  })
})

// ---------------------------------------------------------------------------
// 验收 5:日结最小闭环——过期状态确认后转 confirmed 并盖新日期
// ---------------------------------------------------------------------------
describe('验收 5(spec §9.5):日结最小闭环(D9 界定的 confirm 闭环,不含自动唤起——那是 M5)', () => {
  it('预置一条 stale 的旧状态 → confirmStatus → review=confirmed,updated_at 盖新日期,stale 翻 false', async () => {
    const ghRoot = tempDir('wb-accept5-gh-')
    const repoDir = join(ghRoot, 'proj-stale')
    const commitDate = new Date(Date.now() - 5 * 86_400_000).toISOString() // 5 天前提交
    await makeRepo(repoDir, commitDate)

    const file = join(tempDir('wb-accept5-proj-'), 'projects.json')
    const staleStatusAt = new Date(Date.now() - 10 * 86_400_000).toISOString() // 10 天前的状态,早于提交 → stale
    await saveProjectsFile(file, {
      ...emptyProjectsFile(),
      projects: [{
        id: 'proj-stale',
        name: 'proj-stale',
        stage: 'MVP 开发',
        repoPath: repoDir,
        status: { text: '旧的一句话状态', review: 'suggested', author: '你', updated_at: staleStatusAt },
        links: [],
      }],
    })

    const codexHome5 = tempDir('wb-accept5-codex-')
    mkdirSync(join(codexHome5, 'sessions'), { recursive: true })
    const projects = createProjectsService({
      file, exec: gitExec, listDir, isRepo,
      codexHome: codexHome5,
      codexDeps: defaultCodexSessionSourceDeps,
      home: ghRoot,
      scanRoots: [{ path: ghRoot, depth: 1 }],
      scanMinIntervalSec: 0,
    })

    const before = await projects.getProjectsState()
    const projBefore = before.projects.find(p => p.id === 'proj-stale')
    expect(projBefore?.status?.stale).toBe(true)
    expect(projBefore?.status?.review).toBe('suggested')

    const ok = await projects.confirmStatus('proj-stale', '已经确认,继续推进')
    expect(ok).toBe(true)

    const after = await projects.getProjectsState()
    const projAfter = after.projects.find(p => p.id === 'proj-stale')
    expect(projAfter?.status?.review).toBe('confirmed')
    expect(projAfter?.status?.text).toBe('已经确认,继续推进')
    expect(projAfter?.status?.stale).toBe(false)
    // 盖了新日期:updated_at 比预置的旧状态晚,且是个可解析的时间
    expect(Date.parse(projAfter!.status!.updated_at)).toBeGreaterThan(Date.parse(staleStatusAt))
    expect(Number.isNaN(Date.parse(projAfter!.status!.updated_at))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 验收 6:「全部暂停」代码层存在且不可被提议流程触及
// ---------------------------------------------------------------------------
describe('验收 6(spec §9.6):「全部暂停」静态证据', () => {
  it('Butler 不在可拖拽/隐藏的 MODULE_IDS 里,FIXED_MODULES 排除 butler(src/client/layout.ts)', () => {
    // A3 起 sessions 退休;2026-08-25 加 usage 与 quota(余额独立成模块),
    // 同日 widgets(组件条)退休,底部换成并排的 notes(随手记)/ files(系统文件夹)。
    // 这条断言的本意是"butler 不在里面",下面那行才是本意本身——这行只是顺带把当前
    // 清单钉住,清单变了就照实更新。
    expect(MODULE_IDS).toEqual(['projects', 'slot', 'usage', 'quota', 'notes', 'files', 'todo', 'publish', 'review', 'today'])
    expect(MODULE_IDS as readonly string[]).not.toContain('butler')
    expect(FIXED_MODULES).toEqual(['foot', 'butler'])
  })

  it('/pause 路由存在,只认本机回环,只翻转 paused 位', async () => {
    const service = createWorkbenchService()
    const server = await startWorkbenchServer({ port: 0, service, tickIntervalMs: 0 })
    servers.push(server)

    const first = await fetch(`${server.url}/pause`, { method: 'POST' })
    expect(first.status).toBe(200)
    expect((await first.json()).paused).toBe(true)

    const state = await (await fetch(`${server.url}/state`)).json() as WorkbenchState
    expect(state.paused).toBe(true)

    const second = await fetch(`${server.url}/pause`, { method: 'POST' })
    expect((await second.json()).paused).toBe(false)
  })

  it('/layout 写入路径服务端自己按合法 id 过滤 modules[](终审 F1 已补,不再只靠客户端三个纯函数单方面排除)', async () => {
    const file = join(tempDir('wb-accept6-proj-'), 'projects.json')
    const ghRoot = tempDir('wb-accept6-gh-')
    const projects = defaultProjectsServiceOpts({ file, home: ghRoot, scanRoots: [{ path: ghRoot, depth: 1 }] })
    const service = createWorkbenchService()
    const server = await startWorkbenchServer({ port: 0, service, tickIntervalMs: 0, projects })
    servers.push(server)

    // 直接绕过客户端纯函数,手写一条把 butler 塞进 modules[] 的 layout
    const sneaky = {
      modules: [
        { id: 'projects', order: 0, basis_pct: 44 },
        { id: 'butler', order: 1, basis_pct: 10, hidden: true },
      ],
      butler: { corner: 'br', min: false },
    }
    const resp = await fetch(`${server.url}/layout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layout: sneaky }),
    })
    expect(resp.status).toBe(200)

    // 服务端持久化层自己把 butler 剔除了——不可被提议流程触及现在是双重保证:
    // 客户端三个纯函数 + 服务端 parseLayout 按 LAYOUT_MODULE_IDS 过滤(src/server/http.ts)。
    const state = await (await fetch(`${server.url}/state`)).json() as WorkbenchState
    // butler 被剔除;usage 是 2026-08-25 顶部分栏的迁移补齐项(migrateLayoutModules),
    // 旧存档读进来自动补一条——所以这里是 ['projects','usage'] 而不是 ['projects']。
    expect(state.layout?.modules.map(m => m.id)).toEqual(['projects', 'usage', 'quota'])
    expect(state.layout?.modules.map(m => m.id)).not.toContain('butler')
  })
})
