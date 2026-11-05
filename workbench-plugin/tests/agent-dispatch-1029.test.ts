// @vitest-environment node
/**
 * 智能体文件解析(2026-10-29,任务书「派活智能体文件与起跑换手」①②③;10-29 09:22 真机:
 * 中枢把随手记那一格派给 Kimi,命令行一起就退 —— `Failed to read agent file
 * "/Users/example/.dsh/workbench/用户层/docs/卡/agents/kimi-coder.md": ENOENT`,卡直接「阻塞」)。
 *
 * 钉住:
 * - ① 名片里的相对路径**先相对 project.repo 解析**(不是任务 cwd),argv 里是仓库下的绝对路径;
 * - ② 解析出来的文件不存在 → argv 不带 `--agent-file`,照样派,卡上 note 一句「没找到,这次没带」;
 * - ③ 用户层那条路(cwdFixed 且 cwd 在用户层目录)一律不带(那份 coder 文件讲开工作树/推分支,
 *   对用户层是错指令;交代本身已带用户层契约)。
 * 一个真窗口、一个真进程都不碰(命令行是引擎 harness 里的假件)。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CapCellView } from '../src/protocol.ts'
import type { AgentCli } from '../src/server/agentDispatch.ts'
import { DEFAULT_KIMI_AGENT_FILE, dispatchCommand, kimiCliArgv, pickAgentFile } from '../src/server/agentDispatch.ts'
import type { DispatchRunDeps } from '../src/server/dispatchRun.ts'
import { createDispatchRunner } from '../src/server/dispatchRun.ts'
import { engineHarness } from './helpers/engineHarness.ts'
import { createClientDispatch } from '../src/server/dispatchSend.ts'
import { createTasksService } from '../src/server/tasks.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

/** 建一个带智能体文件的「仓库」目录,回目录路径。 */
function repoWithAgentFile(rel = DEFAULT_KIMI_AGENT_FILE): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-agent-file-'))
  dirs.push(dir)
  mkdirSync(join(dir, ...rel.split('/').slice(0, -1)), { recursive: true })
  writeFileSync(join(dir, rel), '# coder 智能体')
  return dir
}

const clock = Date.parse('2026-10-29T08:00:00Z')

function rig(opts: {
  choicesFor?: DispatchRunDeps['choicesFor']
  edit?: Partial<Record<string, CapCellView>>
  workdir?: DispatchRunDeps['workdirFor']
  userLayerDir?: string
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-dispatch-agentfile-'))
  dirs.push(dir)
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => Math.floor(clock / 1000), newId: () => `t-1029${++n}` })
  const cliRuns: { bin: string, argv: readonly string[], cwd: string, logFile: string }[] = []
  const exits: ((code: number | null) => void)[] = []
  let exit: (code: number | null) => void = () => {}
  const clis: Record<string, AgentCli> = {
    claude: { found: true, family: 'claude', bin: '/usr/bin/claude', source: 'bundled' },
    codex: { found: true, family: 'codex', bin: '/usr/bin/codex', source: 'bundled' },
    kimi: { found: true, family: 'kimi', bin: '/opt/homebrew/bin/kimi', source: 'path' },
  }
  const now = (): Date => new Date(clock)
  const h = engineHarness({
    connected: () => false,
    now,
    cli: {
      resolveCli: family => clis[family] ?? { found: false, family, why: 'x' },
      runCli: (cmd) => {
        cliRuns.push(cmd)
        return { pid: 6161, exited: new Promise<{ code: number | null }>((resolve) => { exit = code => resolve({ code }); exits.push(exit) }) }
      },
      resultDir: '/tmp/wb-agentfile-results',
      now,
    },
  })
  const runner = createDispatchRunner({
    tasks,
    ...(opts.choicesFor === undefined ? {} : { choicesFor: opts.choicesFor }),
    helper: { connected: () => true, request: async () => ({ found: false, busy: false }) },
    engine: h.engine,
    clientDispatch: createClientDispatch({ engine: h.engine, sessionIdsOf: () => [], now }),
    alive: () => true,
    readFile: async () => undefined,
    sessions: () => [],
    now,
    setTimer: () => 'timer',
    clearTimer: () => {},
    editCap: family => opts.edit?.[family],
    alternativesFor: async () => [],
    ...(opts.workdir === undefined ? {} : { workdirFor: opts.workdir }),
    ...(opts.userLayerDir === undefined ? {} : { userLayerDir: () => opts.userLayerDir }),
    killPid: () => {},
  })
  return { tasks, cliRuns, runner, finish: (code: number | null) => exit(code), finishRun: (index: number, code: number | null) => exits[index]?.(code) }
}

describe('pickAgentFile:相对路径先 project.repo、其次 cwd;不存在不带;用户层一律不带', () => {
  it('仓库里有 → 仓库下的绝对路径(①,repo 优先于 cwd)', () => {
    const repo = repoWithAgentFile()
    const cwd = mkdtempSync(join(tmpdir(), 'wb-af-cwd-'))
    dirs.push(cwd)
    expect(pickAgentFile({ instructions: DEFAULT_KIMI_AGENT_FILE, repo, cwd, exists: existsSync }))
      .toEqual({ agentFile: join(repo, DEFAULT_KIMI_AGENT_FILE) })
  })

  it('仓库没有、cwd 有 → cwd 下的绝对路径(其次相对 cwd)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'wb-af-repo-'))
    dirs.push(repo)
    const cwd = repoWithAgentFile()
    expect(pickAgentFile({ instructions: DEFAULT_KIMI_AGENT_FILE, repo, cwd, exists: existsSync }))
      .toEqual({ agentFile: join(cwd, DEFAULT_KIMI_AGENT_FILE) })
  })

  it('都没有而名片给了路径 → 不带 + 那句 note(②);没有名片(缺省那份)→ 静静不带,不造噪音', () => {
    const repo = mkdtempSync(join(tmpdir(), 'wb-af-repo-'))
    dirs.push(repo)
    const cwd = mkdtempSync(join(tmpdir(), 'wb-af-cwd-'))
    dirs.push(cwd)
    expect(pickAgentFile({ instructions: 'docs/卡/agents/kimi-coder.md', repo, cwd, exists: existsSync }))
      .toEqual({ omit: true, note: '名片的智能体文件 docs/卡/agents/kimi-coder.md 没找到,这次没带' })
    expect(pickAgentFile({ instructions: 'docs/卡/agents/kimi-coder.md', repo: undefined, cwd, exists: existsSync }).note)
      .toBe('名片的智能体文件 docs/卡/agents/kimi-coder.md 没找到,这次没带')
    // 缺省那份找不到:不带,但不落 note(不每张卡一句噪音)。
    expect(pickAgentFile({ instructions: undefined, repo, cwd, exists: existsSync })).toEqual({ omit: true })
  })

  it('绝对路径原样核:在 → 用;不在 → 不带 + note', () => {
    const file = join(repoWithAgentFile(), DEFAULT_KIMI_AGENT_FILE)
    const cwd = mkdtempSync(join(tmpdir(), 'wb-af-cwd-'))
    dirs.push(cwd)
    expect(pickAgentFile({ instructions: file, cwd, exists: existsSync })).toEqual({ agentFile: file })
    expect(pickAgentFile({ instructions: '/nope/nowhere.md', cwd, exists: existsSync }))
      .toEqual({ omit: true, note: '名片的智能体文件 /nope/nowhere.md 没找到,这次没带' })
  })

  it('用户层那条路 → 一律不带(③),哪怕仓库里明明有那份文件', () => {
    const repo = repoWithAgentFile()
    const layer = mkdtempSync(join(tmpdir(), 'wb-af-layer-'))
    dirs.push(layer)
    expect(pickAgentFile({ instructions: DEFAULT_KIMI_AGENT_FILE, repo, cwd: layer, userLayer: true, exists: existsSync }))
      .toEqual({ omit: true })
  })
})

describe('kimiCliArgv / dispatchCommand:不带智能体文件的那一位', () => {
  const cli: AgentCli = { found: true, family: 'kimi', bin: '/opt/homebrew/bin/kimi', source: 'path' }

  it('skipAgentFile:新起也不带 --agent-file(连缺省那一份都不加);续跑照旧不带且带 --session', () => {
    expect(kimiCliArgv('做这件事', '/worktree', { skipAgentFile: true }).join(' ')).not.toContain('--agent-file')
    const resumed = kimiCliArgv('接着做', '/worktree', { skipAgentFile: true, resume: 'session_1' })
    expect(resumed.join(' ')).not.toContain('--agent-file')
    expect(resumed).toContain('--session')
  })

  it('dispatchCommand 带 agentFileOmit → argv 没有 --agent-file;不带这一位的老行为一字不变', () => {
    const omitted = dispatchCommand(cli, { prompt: '做这件事', cwd: '/wt', kind: 'code', agentFileOmit: true })
    expect(omitted?.argv.join(' ')).not.toContain('--agent-file')
    const plain = dispatchCommand(cli, { prompt: '做这件事', cwd: '/wt', kind: 'code' })
    expect(plain?.argv).toEqual(kimiCliArgv('做这件事', '/wt', {}))
  })
})

describe('派发那一层:解析结果进 argv / 卡上 note(真引擎 harness,假进程)', () => {
  it('① 名片 + project.repo:argv 里是仓库下的绝对路径(工作区里没有那份文件)', async () => {
    const repo = repoWithAgentFile()
    const worktree = mkdtempSync(join(tmpdir(), 'wb-af-wt-'))
    dirs.push(worktree)
    const r = rig({ workdir: async () => ({ ok: true, cwd: worktree, branch: 'kimi/这件事' }) })
    const card = await r.tasks.saveAgentCard({
      name: 'Kimi 编程', hand: 'kimi', runtime: { family: 'kimi' },
      project: { repo }, instructions: DEFAULT_KIMI_AGENT_FILE,
    })
    const made = await r.tasks.create({ title: '修日历认法', assignee: card.id as string })
    const started = await r.runner.start(made.id as string, { family: card.id as never, said: '修一下', kind: 'code' })
    expect(started).toMatchObject({ ok: true, hand: 'cli' })
    expect(r.cliRuns[0]?.cwd).toBe(worktree)
    expect(r.cliRuns[0]?.argv).toEqual(expect.arrayContaining(['--agent-file', join(repo, DEFAULT_KIMI_AGENT_FILE)]))
  })

  it('② 名片给了路径而文件不存在:不带 --agent-file 照样派,卡上 note 那句「没找到,这次没带」', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'wb-af-repo-'))
    dirs.push(repo)
    const r = rig()
    const card = await r.tasks.saveAgentCard({
      name: 'Kimi 编程', hand: 'kimi', runtime: { family: 'kimi' },
      project: { repo }, instructions: 'docs/卡/agents/gone.md',
    })
    const made = await r.tasks.create({ title: '修日历认法', assignee: card.id as string })
    const started = await r.runner.start(made.id as string, { family: card.id as never, said: '修一下', kind: 'code' })
    expect(started).toMatchObject({ ok: true, hand: 'cli' })
    expect(r.cliRuns[0]?.argv.join(' ')).not.toContain('--agent-file')
    const task = (await r.tasks.list()).tasks.find(one => one.id === made.id)
    expect(task?.note).toBe('名片的智能体文件 docs/卡/agents/gone.md 没找到,这次没带')
  })

  it('③ cwdFixed 且 cwd 在用户层目录:不带仓库那份 coder 智能体文件(交代本身已带用户层契约)', async () => {
    const layer = mkdtempSync(join(tmpdir(), 'wb-af-layer-'))
    dirs.push(layer)
    const r = rig({ userLayerDir: layer })
    const made = await r.tasks.create({ title: '改随手记那一格' })
    const started = await r.runner.start(made.id as string, { family: 'kimi', said: '改一下', kind: 'code', cwd: layer, cwdFixed: true })
    expect(started).toMatchObject({ ok: true, hand: 'cli' })
    expect(r.cliRuns[0]?.cwd).toBe(layer)
    expect(r.cliRuns[0]?.argv.join(' ')).not.toContain('--agent-file')
    const task = (await r.tasks.list()).tasks.find(one => one.id === made.id)
    expect(task?.note ?? null).toBeNull()
  })
})
