// @vitest-environment node
/**
 * ★ **CLI 起的 Kimi 会话能接着说话**(2026-10-23 深夜,卡 A 硬门槛前置;统筹定:
 * 既有卡 `t-b34ddf83`「命令行派活能续跑」的 **Kimi 这一支最小修**由本接缝唯一主人吸收进 A 同分支,
 * 复用既有 adapter 的 `--session` 续跑能力;不另造派活中枢/ID,不扩全 AI 适配;「两家各一条真跑」整卡仍不完成)。
 *
 * 两处、都不大:
 *   ① `sessionJobs.relayCandidates` 加一支 **cliSessions** 候选池(宿主从派活账上喂:
 *      `dispatch.hand==='cli'` 且带了 session_id 的那些)——以前 relayGate 第一扇门就 404
 *      「那条会话不在了」,因为 CLI 会话不在 文件型/窗口型/记录型 任何一池;
 *   ② 命令行适配器接 `kind:'relay'`:Kimi 那家把这句话当一次**续跑**发进原会话
 *      (`--session <id> -p <text>`,复用 `kimiCliArgv` 的既有拼装;续跑不带 --agent-file 的老规矩自动继承)。
 *      进程起来且正常退出 = 排进原会话(delivered 'confirmed' 由引擎回执口径照实翻 sent)。
 *
 * 诚实边界:只接 Kimi(既有登录 + 既有 --session 实测);Claude/Codex 的 CLI 续说不在这一支
 * (整卡 t-b34df83 的「两家各一条」仍留原卡);stop/interrupt 命令行没有,照实 can:false。
 */
import { describe, expect, it } from 'vitest'
import type { AdapterCapabilities, Job } from '../src/server/engine/adapter.ts'
import { createCliAdapter, type CliAdapterDeps } from '../src/server/engine/adapters/cli.ts'
import { createSessionJobs } from '../src/server/sessionJobs.ts'
import { engineHarness } from './helpers/engineHarness.ts'

const ALL: AdapterCapabilities = { open: true, send: true, read: true, press: true, approve: true, writeAsk: true, stop: true, openSession: true }

// —— ① sessionJobs:CLI 会话进 relay 候选池 ——
describe('relayCandidates:CLI 派活会话也算一条来源', () => {
  async function harness(cliSessions: readonly Record<string, unknown>[]) {
    const { engine, registry } = engineHarness({ helper: undefined as never })
    void engine
    const jobs = createSessionJobs({
      engine: { run: async (job: Job) => ({ delivered: 'confirmed', via: 'cli', evidence: 'receipt', ...(job.kind === 'relay' ? {} : { why: 'x' }) }), read: async () => { throw new Error('x') } } as never,
      registry: registry as never,
      sessions: () => [],
      cliSessions: () => cliSessions as never,
    })
    await registry.targets() // 先现查一遍能力(knownCaps 第一拍「查不到」不冒充行)
    return jobs
  }

  it('★relayReady:池里有 kimi 的 CLI 会话 → 能续(不摆打断:命令行没有停止键)', async () => {
    const jobs = await harness([{ agent: 'kimi', session_id: 'session_cli-1', project: '未归类', title: 'QA 派活', status: 'waiting', updated_at: '2026-10-23T22:00:00.000Z' }])
    const ready = jobs.relayReady('kimi', 'session_cli-1')
    expect(ready.can).toBe(true)
    if (ready.can) {
      // 没在跑(running 不是 true);「打断并发送」那颗键只有 running 时才摆(SessionSayBox 同一判据),
      // interrupt.can 这一格沿用现有 send 语义,不为 CLI 特设。
      expect(ready.running).not.toBe(true)
    }
  })

  it('★relay:把这句话当 relay Job 交给引擎(走 cli 通道的续跑);引擎确认 → ok 带回记号', async () => {
    let seen: Job | undefined
    const { registry } = engineHarness({ helper: undefined as never })
    const jobs = createSessionJobs({
      engine: { run: async (job: Job) => { seen = job; return { delivered: 'confirmed', via: 'cli', evidence: 'receipt' } }, read: async () => { throw new Error('x') } } as never,
      registry: registry as never,
      sessions: () => [],
      cliSessions: () => [{ agent: 'kimi', session_id: 'session_cli-1', project: '未归类', title: 'QA 派活', status: 'waiting', updated_at: '2026-10-23T22:00:00.000Z' }] as never,
    })
    const out = await jobs.relay('kimi', 'session_cli-1', '补一句材料')
    expect(out.ok).toBe(true)
    expect(seen?.kind).toBe('relay')
    expect(seen?.text).toBe('补一句材料')
    expect((seen?.target as { kind: string, sessionId?: string }).sessionId).toBe('session_cli-1')
  })

  it('池里没有的(别的来源/没派过活的)→ 照旧「那条会话不在了」', async () => {
    const jobs = await harness([])
    const ready = jobs.relayReady('kimi', 'session_cli-9')
    expect(ready.can).toBe(false)
  })
})

// —— ② 命令行适配器:kind relay(Kimi 续跑) ——
describe('cli 适配器 relay 支(Kimi --session 续说)', () => {
  const deps = (over: Partial<CliAdapterDeps> = {}): { deps: CliAdapterDeps, runs: { bin: string, argv: readonly string[], cwd: string }[] } => {
    const runs: { bin: string, argv: readonly string[], cwd: string }[] = []
    return {
      runs,
      deps: {
        resolveCli: () => ({ found: true as const, family: 'kimi', bin: '/opt/homebrew/bin/kimi', source: 'path' as const }),
        runCli: (cmd) => { runs.push(cmd); return { pid: 4242, exited: Promise.resolve({ code: 0 }) } },
        resultDir: '/tmp/qa-results',
        now: () => new Date('2026-10-23T22:30:00.000Z'),
        sayCwd: () => '/iso/workbench',
        sessionCwd: () => undefined,
        ...over,
      },
    }
  }

  it('★kimi relay → 复用既有续跑拼装:`--session <id> -p <text> --output-format stream-json`,**不带 --agent-file**;cwd 用 sayCwd(续跑不吃 cwd)', async () => {
    const { deps: d, runs } = deps()
    const adapter = createCliAdapter('kimi', d)
    const out = await adapter.run({ id: 'j-1', family: 'kimi', kind: 'relay', target: { kind: 'session', sessionId: 'session_abc' }, text: '补一句', expect: 'ack', model: 'chosen-kimi' } as Job)
    expect(out.delivered).toBe('confirmed')
    expect(runs).toHaveLength(1)
    expect(runs[0]?.bin).toBe('/opt/homebrew/bin/kimi')
    const argv = runs[0]?.argv ?? []
    expect(argv).toContain('--session')
    expect(argv).toContain('session_abc')
    expect(argv).toContain('-p')
    expect(argv).toContain('补一句')
    expect(argv).toContain('--output-format')
    expect(argv).toContain('stream-json')
    expect(argv).toEqual(expect.arrayContaining(['-m', 'chosen-kimi']))
    expect(argv.join(' ')).not.toContain('--agent-file')
    expect(runs[0]?.cwd).toBe('/iso/workbench')
    // 给了原目录就用原目录(kimi 续跑认原目录,换了它拒绝)
    const withCwd = deps({ sessionCwd: () => '/orig/worktree' })
    await createCliAdapter('kimi', withCwd.deps).run({ id: 'j-1b', family: 'kimi', kind: 'relay', target: { kind: 'session', sessionId: 'session_abc' }, text: '续', expect: 'ack' } as Job)
    expect(withCwd.runs[0]?.cwd).toBe('/orig/worktree')
  })

  it('进程没起来 / 非零退出 → not_sent,照实说;别的家(claude)的 relay 仍 unsupported(这一支只接 Kimi)', async () => {
    const bad = deps({ runCli: (cmd) => { void cmd; return { exited: Promise.resolve({ code: 1 }) } } })
    const outBad = await createCliAdapter('kimi', bad.deps).run({ id: 'j-2', family: 'kimi', kind: 'relay', target: { kind: 'session', sessionId: 'session_abc' }, text: '喂', expect: 'ack' } as Job)
    expect(outBad.delivered).toBe('not_sent')
    const claude = deps({ resolveCli: () => ({ found: true as const, family: 'claude', bin: '/x/claude', source: 'path' as const }) })
    const outClaude = await createCliAdapter('claude', claude.deps).run({ id: 'j-3', family: 'claude', kind: 'relay', target: { kind: 'session', sessionId: 's' }, text: '喂', expect: 'ack' } as Job)
    expect(outClaude.delivered).toBe('not_sent')
    expect(outClaude.unsupported).toBe(true)
  })

  it('relay 但 target 不是一条会话 → unsupported(没有会话号就没有续跑)', async () => {
    const { deps: d } = deps()
    const out = await createCliAdapter('kimi', d).run({ id: 'j-4', family: 'kimi', kind: 'relay', target: { kind: 'new' }, text: '喂', expect: 'ack' } as Job)
    expect(out.delivered).toBe('not_sent')
    expect(out.unsupported).toBe(true)
  })
})

// —— ③ 登记处本身:note/seed/list ——
describe('cliDispatchSessions 登记处(事实源头仍是任务 links,这里只放 relay 认池那几格)', () => {
  it('note 同键只留第一条;list 出最简会话视图;seed 只收 hand==cli 且带号的', async () => {
    const { clearCliDispatchSessions, cliDispatchSessions, noteCliDispatchSession, seedCliDispatchSessions } = await import('../src/server/cliDispatchSessions.ts')
    clearCliDispatchSessions()
    noteCliDispatchSession('kimi', 's-1', 'QA 活', '2026-10-23T22:00:00.000Z')
    noteCliDispatchSession('kimi', 's-1', '改名后的活', '2026-10-23T23:00:00.000Z')
    expect(cliDispatchSessions()).toHaveLength(1)
    expect(cliDispatchSessions()[0]).toMatchObject({ agent: 'kimi', session_id: 's-1', title: 'QA 活', status: 'waiting' })
    const seeded = await seedCliDispatchSessions({
      list: async () => ({ tasks: [
        { id: 't-1', title: 'CLI 派的活', dispatch: { family: 'kimi', status: 'done', started_at: '2026-10-23T21:00:00.000Z', hand: 'cli', session_id: 's-2', cwd: '/x' } } as never,
        { id: 't-2', title: '窗口派的活', dispatch: { family: 'claude', status: 'done', started_at: '', hand: 'window', session_id: 's-3', cwd: '/y' } } as never,
        { id: 't-3', title: '没号的 CLI 活', dispatch: { family: 'kimi', status: 'failed', started_at: '', hand: 'cli', cwd: '/z' } } as never,
      ] }),
    } as never)
    expect(seeded).toBe(1)
    const keys = cliDispatchSessions().map(one => `${one.agent}:${one.session_id}`).sort()
    expect(keys).toEqual(['kimi:s-1', 'kimi:s-2'])
    clearCliDispatchSessions()
  })
})

// —— ④ Minor②:非 Kimi 的 CLI 来源会话,能力口直接 none+why(不等到发送时才 unsupported;文件型不误伤)——
describe('relayReady:CLI 来源的非 Kimi 会话,能力口如实(2026-10-24 Minor②)', () => {
  it('★codex 的 CLI 派活会话 → can:false + 一句为什么;kimi 的照常能续;文件型 codex 会话不受影响', async () => {
    const { engine, registry } = engineHarness({ helper: undefined as never })
    void engine
    const fileCodex = { agent: 'codex', session_id: 'file-cx-1', project: 'p', status: 'done', elapsed_sec: 0, unread: false, updated_at: '2026-10-24T00:00:00.000Z' }
    const cliCodex = { agent: 'codex', session_id: 'cli-cx-1', project: 'p', status: 'waiting', elapsed_sec: 0, unread: false, updated_at: '2026-10-24T00:00:00.000Z' }
    const cliKimi = { agent: 'kimi', session_id: 'cli-k-1', project: 'p', status: 'waiting', elapsed_sec: 0, unread: false, updated_at: '2026-10-24T00:00:00.000Z' }
    const jobs = createSessionJobs({
      engine: { run: async () => ({ delivered: 'confirmed', via: 'cli', evidence: 'receipt' }), read: async () => { throw new Error('x') } } as never,
      registry: registry as never,
      sessions: () => [fileCodex] as never,
      cliSessions: () => [cliCodex, cliKimi] as never,
    })
    await registry.targets()
    const codexCli = jobs.relayReady('codex', 'cli-cx-1')
    expect(codexCli.can).toBe(false)
    if (!codexCli.can) expect(codexCli.why).toContain('还没有续说这条路')
    const kimiCli = jobs.relayReady('kimi', 'cli-k-1')
    expect(kimiCli.can).toBe(true)
    // 文件型 codex 照旧走原判据:这道门没把它当 CLI 来源(不带 CLI 那句 why;can 的真值归原判据)
    const codexFile = jobs.relayReady('codex', 'file-cx-1')
    if (!codexFile.can) expect(codexFile.why).not.toContain('还没有续说这条路')
  })
})
