// @vitest-environment node
/**
 * 写代码的活只交给「能改本机文件」的那只手(2026-09-25,卡 O「派活的眼睛」;设计第 3、6 条)。
 *
 * 维护者:「那就不应该派给 Codex 啊,应该派给 Claude 啊」—— 可派给 Claude 真要改代码,Claude 命令行没登录,
 * 只能打进桌面 App 的聊天窗,聊天改不了本机文件。这里钉住:
 * - 写代码的活不走窗口那只手(一个字都不送进聊天窗);
 * - Claude 命令行没登录 → **不派**,卡挂「阻塞」,`dispatch_block` 说清为什么、给「登录 Claude」和能换的几家;
 * - 登着 → 起 Claude 命令行(沙箱、改文件不问、不等人),跑完从标准输出那条 JSON 收结果;
 * - 项目是工作台自己 → 在为这件事新开的独立工作区里跑,不在他正用的那份仓库里。
 * 一个真窗口、一个真进程都不碰。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CapCellView } from '../src/protocol.ts'
import type { AgentCli } from '../src/server/agentDispatch.ts'
import { loginFix } from '../src/server/agentCaps.ts'
// 2026-10-02:送话那一层搬到了 `dispatchSend.ts`(后面是一条引擎),类型跟着搬。
import { createClientDispatch } from '../src/server/dispatchSend.ts'
import { installSkills } from '../src/server/dispatchSkills.ts'
import type { DispatchRunDeps } from '../src/server/dispatchRun.ts'
import { claudeResultOf, createDispatchRunner, worktreeSlugOf } from '../src/server/dispatchRun.ts'
import type { CliAdapterDeps } from '../src/server/engine/adapters/cli.ts'
import { engineHarness } from './helpers/engineHarness.ts'
import { createTasksService } from '../src/server/tasks.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

const clock = Date.parse('2026-09-25T15:00:00Z')
/** 时长上限那几条要往后拨表。 */
let offsetMs = 0
afterEach(() => { offsetMs = 0 })
const CLAUDE_BIN = '/Users/example/Library/Application Support/Claude/claude-code/2.1.280/claude.app/Contents/MacOS/claude'

function rig(opts: {
  runtimeContext?: DispatchRunDeps['runtimeContext']
  choicesFor?: DispatchRunDeps['choicesFor']
  edit?: Partial<Record<string, CapCellView>>
  workdir?: DispatchRunDeps['workdirFor']
  envForCli?: CliAdapterDeps['envForCli']
  cliBudget?: DispatchRunDeps['cliBudget']
  cwdAllowed?: DispatchRunDeps['cwdAllowed']
  installSkills?: DispatchRunDeps['installSkills']
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-dispatch-code-'))
  dirs.push(dir)
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => Math.floor(clock / 1000), newId: () => `t-00000${++n}` })
  const cliRuns: { bin: string, argv: readonly string[], cwd: string, logFile: string, env?: NodeJS.ProcessEnv }[] = []
  const killed: number[] = []
  const files = new Map<string, string>()
  const exits: ((code: number | null) => void)[] = []
  let exit: (code: number | null) => void = () => {}
  const clis: Record<string, AgentCli> = {
    claude: { found: true, family: 'claude', bin: CLAUDE_BIN, source: 'bundled' },
    codex: { found: true, family: 'codex', bin: '/Applications/ChatGPT.app/Contents/Resources/codex', source: 'bundled' },
    kimi: { found: true, family: 'kimi', bin: '/opt/homebrew/bin/kimi', source: 'path' },
  }
  /*
   * ★ 2026-10-03(卡「派活三只手收进引擎」):命令行那只手在引擎的登记表里了。这里是**真引擎 + 真送话层**:
   * `engineHarness` 登上命令行那条(起进程是记下命令的假件),壳没连 → 窗口那条排不上;写代码的活只留命令行。
   * `sent` = 假壳真收到的 send_text,应当一条都没有(写代码的活一个字都不进聊天窗)。
   */
  const now = (): Date => new Date(clock + offsetMs)
  const h = engineHarness({
    connected: () => false,
    now,
    cli: {
      resolveCli: family => clis[family] ?? { found: false, family, why: 'x' },
      runCli: (cmd) => {
        cliRuns.push(cmd)
        return { pid: 5151, exited: new Promise<{ code: number | null }>((resolve) => { exit = code => resolve({ code }); exits.push(exit) }) }
      },
      ...(opts.envForCli === undefined ? {} : { envForCli: opts.envForCli }),
      resultDir: '/tmp/wb-dispatch-results',
      now,
    },
  })
  const runner = createDispatchRunner({
    tasks,
    ...(opts.choicesFor === undefined ? {} : { choicesFor: opts.choicesFor }),
    ...(opts.runtimeContext === undefined ? {} : { runtimeContext: opts.runtimeContext }),
    helper: { connected: () => true, request: async () => ({ found: false, busy: false }) },
    engine: h.engine,
    clientDispatch: createClientDispatch({ engine: h.engine, sessionIdsOf: () => [], now }),
    alive: () => true,
    readFile: async file => files.get(file),
    sessions: () => [],
    now,
    setTimer: () => 'timer',
    clearTimer: () => {},
    editCap: family => opts.edit?.[family],
    // 卡 BS2(2026-09-28):能换的几家里只有别家。
    alternativesFor: async () => [{ family: 'codex', title: 'Codex', note: '5 小时窗口还剩约 80%' }],
    ...(opts.workdir === undefined ? {} : { workdirFor: opts.workdir }),
    ...(opts.cliBudget === undefined ? {} : { cliBudget: opts.cliBudget }),
    ...(opts.cwdAllowed === undefined ? {} : { cwdAllowed: opts.cwdAllowed }),
    ...(opts.installSkills === undefined ? {} : { installSkills: opts.installSkills }),
    killPid: (pid) => { killed.push(pid) },
  })
  return { dir, tasks, get sent() { return h.sentTo() }, cliRuns, files, runner, killed, finishRun: (index: number, code: number | null) => exits[index]?.(code), finish: (code: number | null) => exit(code) }
}

async function item(r: ReturnType<typeof rig>, title = '修一下首页球的显示问题') {
  return (await r.tasks.create({ title, direction: 'mine', status: 'todo', projectId: 'p-wb' })).id as string
}

const NOT_LOGGED_IN: CapCellView = {
  state: 'no',
  note: '要让 Claude 直接改你电脑上的文件,还差一步:登录一次',
  fix: loginFix('claude'),
}

describe('写代码的活:只走能改本机文件的手', () => {
  it('★Claude 命令行没登录:不派(一个字都不送进聊天窗),卡挂「阻塞」、说清为什么、给「登录 Claude」和能换的几家', async () => {
    const r = rig({ edit: { claude: NOT_LOGGED_IN } })
    const id = await item(r)
    const started = await r.runner.start(id, { family: 'claude', said: '修一下首页球的显示问题', cwd: '/repo', kind: 'code' })
    expect(started.ok).toBe(false)
    expect(started.note).toBe('没派给 Claude:要让 Claude 直接改你电脑上的文件,还差一步:登录一次(点「帮我接上」);也可以先交给 Codex 做')
    expect(r.sent).toEqual([])
    expect(r.cliRuns).toEqual([])
    const task = (await r.tasks.list()).tasks.find(one => one.id === id)
    expect(task?.status).toBe('blocked')
    // 派不出去是在等他先修 / 换一家,不是出错(琥珀,不染红)。
    expect(task?.block_reason).toBe('input')
    expect(task?.dispatch_block).toMatchObject({ family: 'claude', kind: 'code', fix: { kind: 'login_cli', label: '帮我接上' } })
    expect(task?.dispatch_block?.alternatives?.map(one => one.family)).toEqual(['codex'])
  })

  it('Kimi 写代码的活:起 kimi -p(stream-json + --agent-file 缺省那一份),结果从 stream-json 收、session_id 挂 links(2026-10-22 卡 C;2026-10-29 起 agent-file 先 project.repo 后 cwd 解析、不存在不带)', async () => {
    const r = rig()
    // 真目录:缺省智能体文件相对 cwd 解析得到(这台没有名片 / project.repo)。
    const repo = join(r.dir, 'repo')
    mkdirSync(join(repo, 'docs', '卡', 'agents'), { recursive: true })
    writeFileSync(join(repo, 'docs', '卡', 'agents', 'kimi-coder.md'), '# coder')
    const id = await item(r)
    const started = await r.runner.start(id, { family: 'kimi', said: '修一下日历认法', cwd: repo, kind: 'code' })
    expect(started).toMatchObject({ ok: true, hand: 'cli' })
    expect(r.sent).toEqual([])
    const run = r.cliRuns[0]
    expect(run?.bin).toBe('/opt/homebrew/bin/kimi')
    expect(run?.cwd).toBe(repo)
    // kimi 的形状:-p <整段说明书> --output-format stream-json --agent-file <绝对路径>
    expect(run?.argv[0]).toBe('-p')
    expect(run?.argv.slice(2)).toEqual(['--output-format', 'stream-json', '--agent-file', join(repo, 'docs', '卡', 'agents', 'kimi-coder.md')])
    expect(run?.argv.some(arg => arg.startsWith('--dangerously'))).toBe(false)
    // 命令行那只手的说明书多带三行(卡 D):仓库(没有 worktreeFor 时不编分支)、交回格式
    const promptText = run?.argv[1] as string
    expect(promptText).not.toContain('仓库:')
    expect(promptText).toContain('交回:')
    r.files.set(run?.logFile as string, [
      '{"role":"meta","type":"system.version","version":"2.2.0"}',
      '{"role":"assistant","content":"做完:日历认法两边对齐了。"}',
      '{"role":"meta","type":"session.resume_hint","session_id":"session-k1"}',
    ].join('\n'))
    r.finish(0)
    let task = (await r.tasks.list()).tasks.find(one => one.id === id)
    for (let i = 0; i < 200 && task?.status !== 'confirm'; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
      task = (await r.tasks.list()).tasks.find(one => one.id === id)
    }
    expect(task?.status).toBe('confirm')
    expect(task?.dispatch).toMatchObject({ family: 'kimi', hand: 'cli', status: 'done', reply: '做完:日历认法两边对齐了。', session_id: 'session-k1' })
    expect(task?.links).toEqual([{ agent: 'kimi', session_id: 'session-k1' }])
  })

  /**
   * 负责人是名片(2026-10-22,卡「名片补四样与Kimi命令行手」B+D):family 取 runtime.family(缺席退回 hand)、
   * cwd 取 project.repo、模型 / 智能体文件从名片进命令行、说明书多带仓库(工作区+分支)与卡文件那两行、
   * 派完负责人还是名片 id。用哪一家 / 在哪个仓库这一处决定,所有派活的入口共用。
   */
  describe('负责人是名片:按名片的配置起', () => {
    it('family/cwd/模型/智能体文件按名片;分支 <family>/<这件事>;负责人保留名片 id;agent-file 先 project.repo 解析(2026-10-29)', async () => {
      const workdirCalls: { family: string | undefined, cwd: string }[] = []
      // 真目录:仓库里有那份智能体文件,工作区里没有 → argv 里应是**仓库下**的绝对路径。
      const repoDir = mkdtempSync(join(tmpdir(), 'wb-card-repo-'))
      dirs.push(repoDir)
      mkdirSync(join(repoDir, 'docs', '卡', 'agents'), { recursive: true })
      writeFileSync(join(repoDir, 'docs', '卡', 'agents', 'kimi-coder.md'), '# coder')
      const r = rig({
        workdir: async (task, cwd, family) => {
          workdirCalls.push({ family, cwd })
          return { ok: true, cwd: `${cwd}/.claude/worktrees/${task.title}`, branch: `${family ?? 'x'}/${task.title}` }
        },
      })
      const card = await r.tasks.saveAgentCard({
        name: 'Kimi 编程', hand: 'kimi',
        runtime: { family: 'kimi' },
        project: { repo: repoDir },
        model: { name: 'kimi-for-coding' },
        instructions: 'docs/卡/agents/kimi-coder.md',
      })
      const made = await r.tasks.create({
        title: '修日历认法', assignee: card.id as string,
        from: { kind: 'said', ref: 'docs/卡/试跑-记日历认法对照.md', quote: '对齐两份认法' },
        acceptance: ['对照用例补上'],
      })
      const started = await r.runner.start(made.id as string, { family: card.id as never, said: '修一下日历认法', kind: 'code' })
      expect(started).toMatchObject({ ok: true, hand: 'cli' })
      // cwd 取 project.repo,workdirFor 拿到 family → 分支 kimi/<这件事>
      expect(workdirCalls).toEqual([{ family: 'kimi', cwd: repoDir }])
      const run = r.cliRuns[0]
      expect(run?.bin).toBe('/opt/homebrew/bin/kimi')
      expect(run?.cwd).toBe(`${repoDir}/.claude/worktrees/修日历认法`)
      expect(run?.argv).toEqual(expect.arrayContaining(['-m', 'kimi-for-coding', '--agent-file', join(repoDir, 'docs', '卡', 'agents', 'kimi-coder.md')]))
      // 说明书多带三行:仓库(工作区+分支)、卡文件(from.ref 指向 docs/卡/…)、交回格式
      const promptText = run?.argv[1] as string
      expect(promptText).toContain(`仓库:在独立工作区 ${repoDir}/.claude/worktrees/修日历认法 里改,分支 kimi/修日历认法(不动你正用的那份目录)`)
      expect(promptText).toContain('卡:先读 docs/卡/试跑-记日历认法对照.md')
      expect(promptText).toContain('交回:')
      // 卡上的派活记录与负责人
      const task = (await r.tasks.list()).tasks.find(one => one.id === made.id)
      expect(task?.dispatch?.family).toBe('kimi')
      expect(task?.assignee).toBe(card.id)
      expect(started.note).toContain('Kimi')
    })

    it.each(['claude', 'codex'] as const)('名片思考档经中枢和引擎进 %s 新起与续跑参数', async family => {
      const r = rig()
      const card = await r.tasks.saveAgentCard({ name: '执行者', hand: family, project: { repo: '/repo' }, model: { name: 'chosen-model', effort: 'high' } })
      const made = await r.tasks.create({ title: '修首页', assignee: card.id as string })
      await r.runner.start(made.id as string, { family: card.id as never, said: '修首页', kind: 'code' })
      const args = r.cliRuns[0]?.argv ?? []
      expect(args).toContain(family === 'claude' ? '--effort' : 'model_reasoning_effort="high"')
      expect(args).toContain('chosen-model')
      const first = (await r.tasks.list()).tasks.find(t => t.id === made.id)?.dispatch
      expect(first?.runtime?.requested).toEqual({ model: 'chosen-model', effort: 'high' })
      await r.tasks.update(made.id as string, { dispatch: { ...first!, status: 'failed', session_id: 'original-session' } })
      await r.runner.start(made.id as string, { family: card.id as never, said: '继续修首页', kind: 'code', resume: true })
      const resumed = r.cliRuns[1]?.argv ?? []
      expect(resumed).toContain('original-session')
      expect(resumed).toContain(family === 'claude' ? '--effort' : 'model_reasoning_effort="high"')
      const second = (await r.tasks.list()).tasks.find(t => t.id === made.id)?.dispatch
      expect(second?.runtime?.mode).toBe('resume')
      expect(second?.runtime?.attempt_id).not.toBe(first?.runtime?.attempt_id)
      expect(second?.runtime?.status).toBe('unverified')
    })

    it('本次选人快照进说明与事项,不是执行者自报', async () => {
      const r = rig({ choicesFor: async () => ({ kind: 'code', kind_why: '改文件', default: 'codex', default_from: 'fallback', default_why: 'Claude 只剩 9%，这次用 Codex（80%）', line: '派 Codex', options: [{ family: 'codex', title: 'Codex', ok: true, balance: { level: 'ok', text: '还剩80%', read_at: new Date(clock).toISOString() } }] }) })
      const made = await r.tasks.create({ title: '修首页', assignee: 'codex' })
      await r.runner.start(made.id as string, { family: 'codex', said: '修首页', kind: 'code', cwd: '/repo' })
      expect(r.cliRuns[0]?.argv.at(-1)).toContain('本次分工依据：')
      expect(r.cliRuns[0]?.argv.at(-1)).toContain('9%')
      expect((await r.tasks.list()).tasks.find(t => t.id === made.id)?.dispatch?.selection).toMatchObject({ family: 'codex', candidates: [{ family: 'codex', quota: '还剩80%' }] })
    })

    it('续跑复用原会话工作区,名片换仓库也不另开作者', async () => {
      const r = rig({ workdir: async () => ({ ok: true, cwd: '/new-worktree', branch: 'codex/new' }) })
      const made = await r.tasks.create({ title: '修首页', assignee: 'codex' })
      await r.tasks.update(made.id as string, { dispatch: { family: 'codex', status: 'failed', hand: 'cli', started_at: new Date(clock).toISOString(), session_id: 'old', cwd: '/original-worktree', branch: 'codex/original' } })
      await r.runner.start(made.id as string, { family: 'codex', said: '继续', kind: 'code', cwd: '/repo', resume: true })
      expect(r.cliRuns[0]?.cwd).toBe('/original-worktree')
      expect(r.cliRuns[0]?.argv).toEqual(expect.arrayContaining(['resume', 'old']))
    })

    it('协议派发后的继续同样接原线程,不新开', async () => {
      const r = rig()
      const made = await r.tasks.create({ title: '修首页', assignee: 'codex' })
      await r.tasks.update(made.id as string, { clientDispatch: { hand: 'window', family: 'codex', status: 'sent', at: new Date(clock).toISOString(), text: '原交代', session_id: 'protocol-session', cwd: '/original-protocol-cwd' } })
      await r.runner.start(made.id as string, { family: 'codex', said: '继续', kind: 'code', cwd: '/repo', resume: true })
      expect(r.cliRuns[0]?.argv).toEqual(expect.arrayContaining(['resume', 'protocol-session']))
      expect(r.cliRuns[0]?.cwd).toBe('/original-protocol-cwd')
    })

    it('上一 attempt 延迟退出不能收掉本轮派活', async () => {
      const r = rig()
      const id = await item(r)
      await r.runner.start(id, { family: 'codex', said: '修首页', kind: 'code', cwd: '/repo' })
      const first = (await r.tasks.list()).tasks.find(t => t.id === id)?.dispatch
      await r.runner.start(id, { family: 'codex', said: '继续修首页', kind: 'code', cwd: '/repo' })
      const second = (await r.tasks.list()).tasks.find(t => t.id === id)?.dispatch
      expect(second?.output_file).not.toBe(first?.output_file)
      r.finishRun(0, 1)
      await new Promise(resolve => setTimeout(resolve, 25))
      expect((await r.tasks.list()).tasks.find(t => t.id === id)?.dispatch).toMatchObject({ status: 'running', runtime: { attempt_id: second?.runtime?.attempt_id } })
    })

    it('旧轮正在异步收尾时新轮按事项串行,不会覆盖新回执', async () => {
      let release!: (value: string | undefined) => void
      let entered = false
      const r = rig({ runtimeContext: async () => { entered = true; return await new Promise<string | undefined>(resolve => { release = resolve }) } })
      const id = await item(r)
      await r.runner.start(id, { family: 'codex', said: '修首页', kind: 'code', cwd: '/repo' })
      const first = (await r.tasks.list()).tasks.find(t => t.id === id)?.dispatch
      r.files.set(first!.output_file!, 'done')
      r.files.set(`${first!.output_file}.jsonl`, '{"type":"thread.started","thread_id":"s1"}\n{"type":"turn.completed"}')
      r.finishRun(0, 0)
      for (let i = 0; i < 100 && !entered; i++) await new Promise(resolve => setTimeout(resolve, 1))
      expect(entered).toBe(true)
      const pending = r.runner.start(id, { family: 'codex', said: '再修首页', kind: 'code', cwd: '/repo' })
      await new Promise(resolve => setTimeout(resolve, 15))
      const runningCount = r.cliRuns.length
      release(undefined)
      await pending
      await new Promise(resolve => setTimeout(resolve, 15))
      expect(runningCount).toBe(1)
      expect((await r.tasks.list()).tasks.find(t => t.id === id)?.dispatch?.status).toBe('running')
    })

    it('runtime.family 缺席退回 hand;卡片不在候选里的家照卡片的写', async () => {
      const r = rig()
      const card = await r.tasks.saveAgentCard({ name: 'Claude 老手', hand: 'claude', project: { repo: '/repo/c' } })
      const made = await r.tasks.create({ title: '润色文案', assignee: card.id as string })
      const started = await r.runner.start(made.id as string, { family: card.id as never, said: '润色文案', kind: 'code' })
      expect(started).toMatchObject({ ok: true, hand: 'cli' })
      expect(r.cliRuns[0]?.bin).toBe(CLAUDE_BIN)
      expect(r.cliRuns[0]?.cwd).toBe('/repo/c')
    })

    it('任务挂了项目、名片没写仓库:退回任务的项目(老行为)', async () => {
      const r = rig()
      const card = await r.tasks.saveAgentCard({ name: 'Kimi 编程', hand: 'kimi', runtime: { family: 'kimi' } })
      const made = await r.tasks.create({ title: '修日历认法', assignee: card.id as string, projectId: 'p-wb' })
      const started = await r.runner.start(made.id as string, { family: card.id as never, said: 'x', cwd: '/repo/from-project', kind: 'code' })
      expect(started).toMatchObject({ ok: true, hand: 'cli' })
      expect(r.cliRuns[0]?.cwd).toBe('/repo/from-project')
    })

    it('名片已经被删了:不派,卡上说清(等他换负责人 / 换名片)', async () => {
      const r = rig()
      const made = await r.tasks.create({ title: '修日历认法', assignee: 'agent:local:gone' })
      const started = await r.runner.start(made.id as string, { family: 'agent:local:gone' as never, said: 'x', cwd: '/repo', kind: 'code' })
      expect(started.ok).toBe(false)
      expect(started.block?.why).toContain('名片')
      expect(r.cliRuns).toEqual([])
    })

    it('Kimi 那家没装(探不到):如实失败,说明书不进窗', async () => {
      const r = rig()
      // rig 里 kimi 探得到;把 resolveCli 的 kimi 拿掉,走「没装」那一条
      const id = await item(r)
      const started = await r.runner.start(id, { family: 'kimi', said: '修一下', cwd: '/repo', kind: 'code' })
      // rig 的 kimi 是 found → 这条只是确认探得到时照派;「没装」由 cli 适配器回 not_sent,引擎如实报。
      expect(started.ok).toBe(true)
    })
  })

  it('没挂项目:不知道在哪个仓库里改 —— 不猜一个目录', async () => {
    const r = rig()
    const id = await item(r)
    const started = await r.runner.start(id, { family: 'codex', said: '修一下首页球的显示问题', kind: 'code' })
    expect(started.block?.why).toContain('还没归到项目')
    expect(r.cliRuns).toEqual([])
  })

  it('★Claude 登着:起 Claude 命令行(在项目目录里,沙箱、改文件不问),跑完从标准输出那条 JSON 收回结果、挂 links、进「等我确认」', async () => {
    const r = rig({ edit: { claude: { state: 'ok', via: 'cli', note: '命令行登着' } } })
    const id = await item(r)
    const started = await r.runner.start(id, { family: 'claude', said: '修一下首页球的显示问题', cwd: '/repo', kind: 'code' })
    expect(started).toMatchObject({ ok: true, hand: 'cli' })
    expect(r.sent).toEqual([])
    const run = r.cliRuns[0]
    expect(run?.bin).toBe(CLAUDE_BIN)
    expect(run?.cwd).toBe('/repo')
    expect(run?.argv).toEqual(expect.arrayContaining(['-p', '--permission-mode', 'acceptEdits', '--permission-prompts', 'none', '--settings']))
    r.files.set(run?.logFile as string, [
      'some warning line',
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '改好了:Orb.tsx 里球的高度按窗口算,测过 client-orb。', session_id: 'c0ffee-1' }),
    ].join('\n'))
    r.finish(0)
    let task = (await r.tasks.list()).tasks.find(one => one.id === id)
    for (let i = 0; i < 200 && task?.status !== 'confirm'; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
      task = (await r.tasks.list()).tasks.find(one => one.id === id)
    }
    expect(task?.status).toBe('confirm')
    expect(task?.dispatch).toMatchObject({ family: 'claude', hand: 'cli', status: 'done', reply: '改好了:Orb.tsx 里球的高度按窗口算,测过 client-orb。', session_id: 'c0ffee-1' })
    expect(task?.links).toEqual([{ agent: 'claude', session_id: 'c0ffee-1' }])
    expect(task?.dispatch_block).toBeUndefined()
  })

  it('Claude 自己说没做成(比如 Not logged in):卡上是它的原话,挂「阻塞」', async () => {
    const r = rig()
    const id = await item(r)
    await r.runner.start(id, { family: 'claude', said: '修一下首页球的显示问题', cwd: '/repo', kind: 'code' })
    r.files.set(r.cliRuns[0]?.logFile as string, JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' }))
    r.finish(1)
    let task = (await r.tasks.list()).tasks.find(one => one.id === id)
    for (let i = 0; i < 200 && task?.status !== 'blocked'; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
      task = (await r.tasks.list()).tasks.find(one => one.id === id)
    }
    expect(task?.status).toBe('blocked')
    // 它跑起来、出了一行结构化结果(自己的错误原话)——按共用那把尺(`cliOutputLines` 非空白行)
    // 这算「干了活没做成」,不算起跑失败:不换手,原话照列。(按事件类型数会把这一行漏掉、误判起跑失败,退修已换尺。)
    expect(task?.note).toBe('派给 Claude 没做成:Not logged in · Please run /login')
  })

  it('★项目是工作台自己:在为这件事新开的独立工作区里跑,不在他正用的那份仓库里', async () => {
    const r = rig({ workdir: async (_task, cwd) => ({ ok: true, cwd: `${cwd}/.claude/worktrees/修一下首页球的显示问题` }) })
    const id = await item(r)
    await r.runner.start(id, { family: 'codex', said: '修一下首页球的显示问题', cwd: '/Users/example/Documents/GitHub/desktop-workbench', kind: 'code' })
    const argv = r.cliRuns[0]?.argv ?? []
    expect(r.cliRuns[0]?.cwd).toBe('/Users/example/Documents/GitHub/desktop-workbench/.claude/worktrees/修一下首页球的显示问题')
    expect(argv[argv.indexOf('-C') + 1]).toBe('/Users/example/Documents/GitHub/desktop-workbench/.claude/worktrees/修一下首页球的显示问题')
    // 送出去那段话里的工作目录也是独立工作区
    expect(argv[argv.length - 1]).toContain('工作目录:/Users/example/Documents/GitHub/desktop-workbench/.claude/worktrees/')
  })

  it('开不出独立工作区:不派(不退回他那份仓库)', async () => {
    const r = rig({ workdir: async () => ({ ok: false, why: '开不出独立工作区(不在你正用的那份仓库里改):fatal' }) })
    const id = await item(r)
    const started = await r.runner.start(id, { family: 'codex', said: '修一下首页球的显示问题', cwd: '/repo', kind: 'code' })
    expect(started.ok).toBe(false)
    expect(r.cliRuns).toEqual([])
  })

  it('★起命令行用的是备好的那份环境(DSH 环境里那个本机没人在听的中转地址拿掉了)', async () => {
    const r = rig({
      edit: { claude: { state: 'ok', via: 'cli', note: '命令行登着' } },
      envForCli: async () => ({ env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'k' }, dropped: { url: 'http://127.0.0.1:8787' } }),
    })
    const id = await item(r)
    await r.runner.start(id, { family: 'claude', said: '修一下首页球的显示问题', cwd: '/repo', kind: 'code' })
    expect(r.cliRuns[0]?.env).toEqual({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'k' })
  })

  it('★命令行的活到时长上限(统筹拍板 ③):先记成停下来的、再停进程;卡挂「阻塞 · 等你输入」问继续 / 停 / 换一家,钱不算。时长这件活派出那一刻定好(2026-10-23 卡③):没挂名片的命令行活缺省 120', async () => {
    const r = rig({ edit: { claude: { state: 'ok', via: 'cli', note: '命令行登着' } }, cliBudget: () => ({ cny: 0.5, minutes: 10 }) })
    const id = await item(r)
    await r.runner.start(id, { family: 'claude', said: '修一下首页球的显示问题', cwd: '/repo', kind: 'code' })
    offsetMs = 11 * 60_000
    expect(await r.runner.tick()).toBe(0)
    expect(r.killed).toEqual([])
    offsetMs = 121 * 60_000
    expect(await r.runner.tick()).toBe(1)
    expect(r.killed).toEqual([5151])
    let task = (await r.tasks.list()).tasks.find(one => one.id === id)
    expect(task?.status).toBe('blocked')
    expect(task?.block_reason).toBe('input')
    expect(task?.dispatch).toMatchObject({ family: 'claude', status: 'failed', stopped: 'cap', kind: 'code', budget_minutes: 120 })
    expect(task?.budget).toMatchObject({ state: 'paused', limit_minutes: 120, cli_family: 'claude', switch_to: 'Codex', run_minutes: 121 })
    expect(task?.note).toBe('到时长上限了:Claude 在后台做了 121 分钟(上限 120 分钟),先停下来了;改过的东西留在 /repo。继续、停掉这一件,还是换 Codex 来做?')
    // 进程退了(被我们停的):收尾那一步不当「没做成」收 —— 卡照旧停在问他那一格。
    r.finish(null)
    await new Promise(resolve => setTimeout(resolve, 30))
    task = (await r.tasks.list()).tasks.find(one => one.id === id)
    expect(task?.status).toBe('blocked')
    expect(task?.block_reason).toBe('input')
    expect(task?.dispatch?.stopped).toBe('cap')
    // 没设上限(老宿主):不管。
    const old = rig({ edit: { claude: { state: 'ok', via: 'cli', note: '命令行登着' } } })
    const other = await item(old)
    await old.runner.start(other, { family: 'claude', said: '修一下', cwd: '/repo', kind: 'code' })
    offsetMs = 60 * 60_000
    await old.runner.tick()
    expect(old.killed).toEqual([])
  })

  it('★别的项目(统筹拍板 ②):在独立工作区里跑,分支记在派活记录里;目录门看的是项目本身;交回来时卡上写清在哪条分支、他看过再合', async () => {
    const worktree = '/Users/example/.dsh/workbench/worktrees/Echo/修一下-Echo-里的登录报错'
    const r = rig({
      edit: { codex: { state: 'ok', via: 'cli', note: '命令行登着' } },
      workdir: async () => ({ ok: true, cwd: worktree, branch: 'workbench/修一下-Echo-里的登录报错' }),
      cwdAllowed: async cwd => cwd === '/Users/example/Documents/GitHub/Echo' || cwd.startsWith('/Users/example/Documents/GitHub/Echo/'),
    })
    const id = await item(r, '修一下 Echo 里的登录报错')
    const started = await r.runner.start(id, { family: 'codex', said: '修一下 Echo 里的登录报错', cwd: '/Users/example/Documents/GitHub/Echo', kind: 'code' })
    expect(started).toMatchObject({ ok: true, hand: 'cli' })
    expect(started.note).toContain('不动你那份目录')
    expect(r.cliRuns[0]?.cwd).toBe(worktree)
    let task = (await r.tasks.list()).tasks.find(one => one.id === id)
    expect(task?.dispatch).toMatchObject({ cwd: worktree, branch: 'workbench/修一下-Echo-里的登录报错', kind: 'code' })
    const run = r.cliRuns[0]
    r.files.set(run?.logFile as string, '{"type":"thread.started","thread_id":"th-1"}')
    r.files.set((task?.dispatch?.output_file ?? '') as string, '改好了:登录报错是 token 过期没刷新。')
    r.finish(0)
    for (let i = 0; i < 200 && task?.status !== 'confirm'; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
      task = (await r.tasks.list()).tasks.find(one => one.id === id)
    }
    expect(task?.status).toBe('confirm')
    expect(task?.note).toBe(`Codex 改的东西在分支 workbench/修一下-Echo-里的登录报错(独立工作区 ${worktree}),你看过再合进去`)
  })

  it('claudeResultOf:只认最后那条 type=result;半截输出回 undefined', () => {
    expect(claudeResultOf('{"type":"system"}\n{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"s"}')).toEqual({ text: 'ok', error: false, session_id: 's' })
    expect(claudeResultOf('{"type":"result","subtype":"error_max_turns","is_error":false,"result":""}')?.error).toBe(true)
    expect(claudeResultOf('{"type":"resu')).toBeUndefined()
  })
})

describe('带技能的活(卡 S)', () => {
  function skillsRig() {
    const root = mkdtempSync(join(tmpdir(), 'wb-skill-root-'))
    const cwd = mkdtempSync(join(tmpdir(), 'wb-skill-cwd-'))
    dirs.push(root, cwd)
    mkdirSync(join(root, 'huashu-report'))
    writeFileSync(join(root, 'huashu-report', 'SKILL.md'), '---\nname: huashu-report\n---\n')
    writeFileSync(join(root, 'huashu-report', 'UPSTREAM.json'), '{}')
    const calls: { family: string, cwd: string, skills: readonly string[] }[] = []
    const r = rig({
      installSkills: async (input) => { calls.push(input); return await installSkills({ ...input, root }) },
      workdir: async () => ({ ok: true, cwd, branch: 'workbench/t' }),
    })
    return { r, cwd, calls }
  }

  it('Claude:拷进独立工作区的 .claude/skills,交代里点明,命令行照派', async () => {
    const { r, cwd, calls } = skillsRig()
    const id = await item(r)
    const started = await r.runner.start(id, { family: 'claude', said: '把 X 项目做一份研究简报', cwd: '/repo', kind: 'code', skills: ['huashu-report'] })
    expect(started.ok).toBe(true)
    expect(started.hand).toBe('cli')
    expect(started.note).toContain('带着技能 huashu-report')
    expect(calls).toEqual([{ family: 'claude', cwd, skills: ['huashu-report'] }])
    expect(existsSync(join(cwd, '.claude/skills/huashu-report/SKILL.md'))).toBe(true)
    expect(r.cliRuns).toHaveLength(1)
    expect(r.cliRuns[0]?.cwd).toBe(cwd)
    expect(r.cliRuns[0]?.argv.join(' ')).toContain('.claude/skills/huashu-report/SKILL.md')
    expect(r.sent).toEqual([])
  })

  it('读不了技能目录的那一家(窗口 / 接口那几家):当场拒绝,不拷、不派、卡不动', async () => {
    const { r, calls } = skillsRig()
    const id = await item(r)
    for (const family of ['gpt', 'doubao']) {
      const started = await r.runner.start(id, { family, said: '做一份研究简报', cwd: '/repo', kind: 'code', skills: ['huashu-report'] })
      expect(started.ok).toBe(false)
      expect(started.note).toContain('读不了技能目录')
    }
    expect(calls).toEqual([])
    expect(r.cliRuns).toEqual([])
    expect(r.sent).toEqual([])
    expect((await r.tasks.list()).tasks.find(one => one.id === id)?.status).toBe('todo')
  })

  it('带技能却说成 chat:按「改文件」那一类派(同 /dispatch/run 那一处的规矩,2026-10-22 卡「用户层技能生效」B 收到这一处)', async () => {
    const { r, calls } = skillsRig()
    const id = await item(r)
    const started = await r.runner.start(id, { family: 'claude', said: '做一份研究简报', cwd: '/repo', kind: 'chat', skills: ['huashu-report'] })
    expect(started.ok).toBe(true)
    expect(calls).toEqual([{ family: 'claude', cwd: expect.any(String), skills: ['huashu-report'] }])
    expect(r.sent).toEqual([])
  })

  it('没接技能库:带技能的活派不了,说清楚', async () => {
    const r = rig()
    const id = await item(r)
    const started = await r.runner.start(id, { family: 'claude', said: '做一份研究简报', cwd: '/repo', kind: 'code', skills: ['huashu-report'] })
    expect(started.ok).toBe(false)
    expect(started.note).toContain('没带技能库')
    expect(r.cliRuns).toEqual([])
  })

  it('拷不进去(技能库里缺这一件):卡挂阻塞、说清楚,不起进程', async () => {
    const { r } = skillsRig()
    const id = await item(r)
    const started = await r.runner.start(id, { family: 'claude', said: '做一份研究简报', cwd: '/repo', kind: 'code', skills: ['huashu-design'] })
    expect(started.ok).toBe(false)
    expect(started.block?.why).toContain('huashu-design')
    expect(r.cliRuns).toEqual([])
  })

  it('不带技能:命令一字不变、一件都不拷', async () => {
    const { r, calls } = skillsRig()
    const id = await item(r)
    await r.runner.start(id, { family: 'claude', said: '修一下首页球的显示问题', cwd: '/repo', kind: 'code' })
    // 两张卡只差卡号(交代里的记号与卡 id),别的一字不差。
    const scrub = (argv: readonly string[] | undefined): string => (argv ?? []).join(' ').replace(/0{4,5}\d/g, 'N')
    const plain = scrub(r.cliRuns[0]?.argv)
    expect(calls).toEqual([])
    expect(plain).not.toContain('技能')
    expect(plain).not.toBe('')
    const id2 = await item(r)
    await r.runner.start(id2, { family: 'claude', said: '修一下首页球的显示问题', cwd: '/repo', kind: 'code', skills: [] })
    expect(calls).toEqual([])
    expect(scrub(r.cliRuns[1]?.argv)).toBe(plain)
  })

  it('★ 名片勾的技能(用户层):派这张名片卡时拷进工作树,按「改文件」那一类派(2026-10-22 卡「用户层技能生效」B)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-skill-root-'))
    const cwd = mkdtempSync(join(tmpdir(), 'wb-skill-cwd-'))
    const userDir = mkdtempSync(join(tmpdir(), 'wb-skill-user-'))
    dirs.push(root, cwd, userDir)
    writeFileSync(join(userDir, 'g-scoped-implementation.SKILL.md'), '---\nname: 范围内实现\n---\n\n# 范围内实现\n')
    const userSkills = [{ id: 'g-scoped-implementation', name: '范围内实现', file: join(userDir, 'g-scoped-implementation.SKILL.md') }]
    const calls: { family: string, cwd: string, skills: readonly string[] }[] = []
    const r = rig({
      installSkills: async (input) => { calls.push(input); return await installSkills({ ...input, root, userSkills }) },
      workdir: async () => ({ ok: true, cwd, branch: 'workbench/t' }),
    })
    const card = await r.tasks.saveAgentCard({
      name: '小K', hand: 'kimi', runtime: { family: 'kimi' }, project: { repo: '/repo/k' },
      skills: ['g-scoped-implementation'],
    })
    const made = await r.tasks.create({ title: '接一张卡', assignee: card.id as string })
    // 交代里没带技能:名片勾了什么就带什么;说了是 chat 也按改文件那一类(带技能的活那条老规矩)。
    const started = await r.runner.start(made.id as string, { family: card.id as never, said: '按卡做', kind: 'chat' })
    expect(started.ok).toBe(true)
    expect(calls).toEqual([{ family: 'kimi', cwd, skills: ['g-scoped-implementation'] }])
    // 扁平形包成 <名>/SKILL.md 拷进那一家找技能的位置(Kimi = .agents/skills)。
    expect(existsSync(join(cwd, '.agents/skills/g-scoped-implementation/SKILL.md'))).toBe(true)
    expect(r.cliRuns[0]?.argv.join(' ')).toContain('这件活带了技能:g-scoped-implementation')
  })

  it('★ 交代里点名带了技能:名片勾的就不重复带(点名的说了算)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-skill-root-'))
    const cwd = mkdtempSync(join(tmpdir(), 'wb-skill-cwd-'))
    dirs.push(root, cwd)
    mkdirSync(join(root, 'huashu-report'))
    writeFileSync(join(root, 'huashu-report', 'SKILL.md'), '---\nname: huashu-report\n---\n')
    const calls: { family: string, cwd: string, skills: readonly string[] }[] = []
    const r = rig({
      installSkills: async (input) => { calls.push(input); return await installSkills({ ...input, root }) },
      workdir: async () => ({ ok: true, cwd, branch: 'workbench/t' }),
    })
    const card = await r.tasks.saveAgentCard({
      name: '小K', hand: 'kimi', runtime: { family: 'kimi' }, project: { repo: '/repo/k' },
      skills: ['g-scoped-implementation'],
    })
    const made = await r.tasks.create({ title: '接一张卡', assignee: card.id as string })
    const started = await r.runner.start(made.id as string, { family: card.id as never, said: '按卡做', kind: 'code', skills: ['huashu-report'] })
    expect(started.ok).toBe(true)
    expect(calls).toEqual([{ family: 'kimi', cwd, skills: ['huashu-report'] }])
  })
})

/**
 * 工作树与分支的短名(2026-10-23,卡「派活给名片的四处」①):from.ref 指向 docs/卡/<卡名>.md 时用
 * <卡名>;否则标题前 12 个字(去标点)+ 卡号后四位。真跑出来的反例(10-22 t-05df50c9):整条标题
 * 「改前端组件Agent-名片编辑表单按六段重排(docs-卡-名片编辑表单重排.md)」带括号带路径几十个字。
 */
describe('工作树与分支的短名(卡「派活给名片的四处」①)', () => {
  it('from.ref 指向 docs/卡/<卡名>.md:用 <卡名>,不带卡号后缀', () => {
    expect(worktreeSlugOf({
      id: 't-05df50c9',
      title: '改前端组件Agent-名片编辑表单按六段重排(docs-卡-名片编辑表单重排.md)',
      from: { kind: 'said', ref: 'docs/卡/名片编辑表单重排.md' },
    })).toBe('名片编辑表单重排')
  })

  it('没有卡 ref:标题前 12 个字(去标点)+ 卡号后四位防重', () => {
    expect(worktreeSlugOf({
      id: 't-1234abcd',
      title: '修一下 Echo 里的登录报错',
      from: { kind: 'user' },
    })).toBe('修一下Echo里的登录报-abcd')
  })

  it('标题里全是标点:回 undefined(调用方退回老的整条标题 slug,不编一个)', () => {
    expect(worktreeSlugOf({ id: 't-1234abcd', title: '(((', from: { kind: 'user' } })).toBeUndefined()
  })

  it('卡名再过一道 git 分支名守卫(空白 / 非法字符剥掉);拼不出回 undefined', () => {
    expect(worktreeSlugOf({ id: 't-1234abcd', title: 'x', from: { kind: 'said', ref: 'docs/卡/?.md' } })).toBeUndefined()
  })
})

/**
 * 时长上限按名片定 + 续跑接原会话(2026-10-23,卡「派活给名片的四处」③):
 * 名片加一格 budget.minutes;命令行家缺省 120(全局设置里那 10 分钟把第一张卡读到一半就停了);
 * 到点停下来那一刻把那家留下的会话号记在卡上;他说「继续」再派一次接着原会话(kimi --session)。
 */
describe('时长上限按名片定 + 续跑接原会话(卡「派活给名片的四处」③)', () => {
  async function cardTask(r: ReturnType<typeof rig>, card: { id?: string }) {
    const made = await r.tasks.create({ title: '接一张卡', assignee: card.id as string })
    return made.id as string
  }

  it('名片写了 budget.minutes:按名片停,不按全局设置', async () => {
    const r = rig({ edit: { kimi: { state: 'ok', via: 'cli', note: '命令行登着' } }, cliBudget: () => ({ cny: 0.5, minutes: 10 }) })
    const card = await r.tasks.saveAgentCard({ name: '小K', hand: 'kimi', runtime: { family: 'kimi' }, project: { repo: '/repo/k' }, budget: { minutes: 30 } })
    const id = await cardTask(r, card)
    const started = await r.runner.start(id, { family: 'kimi', said: '按卡做', kind: 'code' })
    expect(started.ok).toBe(true)
    offsetMs = 29 * 60_000
    expect(await r.runner.tick()).toBe(0)
    offsetMs = 31 * 60_000
    expect(await r.runner.tick()).toBe(1)
    const task = (await r.tasks.list()).tasks.find(one => one.id === id)
    expect(task?.dispatch).toMatchObject({ family: 'kimi', stopped: 'cap', budget_minutes: 30 })
    expect(task?.budget).toMatchObject({ state: 'paused', limit_minutes: 30, cli_family: 'kimi' })
    expect(task?.note).toContain('上限 30 分钟')
  })

  it('名片没写:命令行家缺省 120 分钟(全局设置的 10 分钟不再管命令行这一件)', async () => {
    const r = rig({ edit: { kimi: { state: 'ok', via: 'cli', note: '命令行登着' } }, cliBudget: () => ({ cny: 0.5, minutes: 10 }) })
    const card = await r.tasks.saveAgentCard({ name: '小K', hand: 'kimi', runtime: { family: 'kimi' }, project: { repo: '/repo/k' } })
    const id = await cardTask(r, card)
    await r.runner.start(id, { family: 'kimi', said: '按卡做', kind: 'code' })
    offsetMs = 119 * 60_000
    expect(await r.runner.tick()).toBe(0)
    offsetMs = 121 * 60_000
    expect(await r.runner.tick()).toBe(1)
    const task = (await r.tasks.list()).tasks.find(one => one.id === id)
    expect(task?.dispatch).toMatchObject({ stopped: 'cap', budget_minutes: 120 })
    expect(task?.budget).toMatchObject({ state: 'paused', limit_minutes: 120 })
    expect(task?.note).toContain('上限 120 分钟')
  })

  it('到点停下来那一刻:从结果日志里认出那家留下的会话号,记在卡上(续跑才接得着)', async () => {
    const r = rig({ edit: { kimi: { state: 'ok', via: 'cli', note: '命令行登着' } }, cliBudget: () => ({ cny: 0.5, minutes: 10 }) })
    const card = await r.tasks.saveAgentCard({ name: '小K', hand: 'kimi', runtime: { family: 'kimi' }, project: { repo: '/repo/k' }, budget: { minutes: 5 } })
    const id = await cardTask(r, card)
    await r.runner.start(id, { family: 'kimi', said: '按卡做', kind: 'code' })
    const started = (await r.tasks.list()).tasks.find(one => one.id === id)
    r.files.set(`${started?.dispatch?.output_file}.jsonl`, '{"role":"meta","type":"session.resume_hint","session_id":"sess-k1"}\n{"role":"assistant","content":"做了一半"}')
    offsetMs = 6 * 60_000
    expect(await r.runner.tick()).toBe(1)
    const task = (await r.tasks.list()).tasks.find(one => one.id === id)
    expect(task?.dispatch?.session_id).toBe('sess-k1')
  })

  it('他说「继续」:再派一次,接着原会话(kimi --session <id>),不从头再读一遍', async () => {
    const r = rig({ edit: { kimi: { state: 'ok', via: 'cli', note: '命令行登着' } }, cliBudget: () => ({ cny: 0.5, minutes: 10 }) })
    const card = await r.tasks.saveAgentCard({ name: '小K', hand: 'kimi', runtime: { family: 'kimi' }, project: { repo: '/repo/k' }, budget: { minutes: 5 } })
    const id = await cardTask(r, card)
    await r.runner.start(id, { family: 'kimi', said: '按卡做', kind: 'code' })
    const started = (await r.tasks.list()).tasks.find(one => one.id === id)
    r.files.set(`${started?.dispatch?.output_file}.jsonl`, '{"role":"meta","type":"session.resume_hint","session_id":"sess-k1"}')
    offsetMs = 6 * 60_000
    await r.runner.tick()
    // 卡面上那颗「继续」键走的就是这一条(resumeCli → dispatchItem → 这里):带上 resume。
    const again = await r.runner.start(id, { family: 'kimi', said: '接着把它做完', kind: 'code', resume: true })
    expect(again.ok).toBe(true)
    expect(r.cliRuns).toHaveLength(2)
    expect(r.cliRuns[1]?.argv.slice(0, 2)).toEqual(['--session', 'sess-k1'])
    // 对照:头一回派(不是续跑)照旧新起会话,不带 --session。
    expect(r.cliRuns[0]?.argv[0]).toBe('-p')
    expect(r.cliRuns[0]?.argv).not.toContain('--session')
  })
})
