// @vitest-environment node
/**
 * 派活的三只手收进一条引擎(2026-10-03,卡「派活三只手收进引擎」;设计 `docs/设计-派活三只手收进引擎-2026-10-03.md`)。
 *
 * 这一份钉四件事:
 * ① **每种通道都念得出人话**(`VIA_TEXT`),账那一行带通道、读回来还在;
 * ② **登记表按活的种类挑通道**:写代码只留命令行、在电脑上动手只留窗口、聊天 = 协议 > 窗口 > 命令行 > 接口(备用规矩);
 * ③ 命令行 / 接口两条适配器各自的结局形状(起进程 = 送到;接口回答进 `reply`;做不了就 unsupported 让引擎换路);
 * ④ **走引擎**:同一道闸、同一本账 —— 闸拦下时命令行 / 接口零调用,放行时账上有 `assigned`(带 via)与 `sent`。
 *
 * 一个真进程、一个真网络请求都没有:命令行是计数的假件,接口是回一句话的假件,壳是假壳。
 */
import { describe, expect, it } from 'vitest'
import type { Adapter, AdapterCapabilities, Job } from '../src/server/engine/adapter.ts'
import { VIA_TEXT, type JobVia } from '../src/server/engine/adapter.ts'
import { DISPATCH_VIA_ORDER, VIA_ORDER, channelAllowedFor, createRegistry } from '../src/server/engine/registry.ts'
import { jobLogLine, parseJobEventLine } from '../src/server/jobLog.ts'
import { CLI_FAMILIES, CLI_NO_CWD_WHY, CLI_NOT_THIS_WAY_WHY, cliDidNotStartWhy, cliNotFoundWhy, createCliAdapter, type CliAdapterDeps } from '../src/server/engine/adapters/cli.ts'
import { API_NOT_CONFIGURED_WHY, apiFailedWhy, createApiAdapter, type ApiAdapterDeps } from '../src/server/engine/adapters/api.ts'
import { FAMILY_SOURCES } from '../src/server/agentSources.ts'
// hasCodeCli / CODE_CLI_FAMILIES 的唯一定义在 protocol.ts(卡「名片编辑表单重排」挪过去的),这里引协议那份。
import { hasCodeCli, CODE_CLI_FAMILIES } from '../src/protocol.ts'
import { engineHarness } from './helpers/engineHarness.ts'

const ALL: AdapterCapabilities = { open: true, send: true, read: true, press: true, approve: true, writeAsk: true, stop: true, openSession: true }
const fake = (family: string, via: JobVia, caps: Partial<AdapterCapabilities> = {}): Adapter => ({
  family, via, capabilities: async () => ({ ...ALL, ...caps }), run: async () => ({ delivered: 'confirmed', via, evidence: 'receipt' }),
})
const job = (over: Partial<Job> = {}): Job => ({ id: 't-1', itemId: 't-1', family: 'x', kind: 'dispatch', target: { kind: 'new' }, text: '一段交代', expect: 'ack', ...over })

describe('① 每种通道都念得出人话;账上记通道', () => {
  it('★VIA_TEXT 覆盖 JobVia 的每一种(新加一种 via 这里就红)', () => {
    const vias: JobVia[] = ['protocol', 'cli', 'api', 'file', 'window', 'none']
    for (const via of vias) expect(VIA_TEXT[via], via).toMatch(/\S/)
    expect(Object.keys(VIA_TEXT).sort()).toEqual([...vias].sort())
    // 两张次序表上的每一种也都念得出来。
    for (const via of [...VIA_ORDER, ...DISPATCH_VIA_ORDER]) expect(VIA_TEXT[via]).toBeTruthy()
  })

  it('账那一行带通道的人话;写盘再读回来通道还在;认不出的通道当没写', () => {
    const line = jobLogLine({ at: '2026-10-03T06:00:00.000Z', job: 't-1', step: 'assigned', family: 'codex', via: 'cli' })
    expect(line).toContain(VIA_TEXT.cli)
    const back = parseJobEventLine(JSON.stringify({ at: '2026-10-03T06:00:00.000Z', job: 't-1', step: 'sent', family: 'doubao', via: 'api' }))
    expect(back?.via).toBe('api')
    const odd = parseJobEventLine(JSON.stringify({ at: '2026-10-03T06:00:00.000Z', job: 't-1', step: 'sent', via: 'carrier-pigeon' }))
    expect(odd).toBeDefined()
    expect(odd?.via).toBeUndefined()
  })
})

describe('② 登记表按活的种类挑通道', () => {
  function registryWith(...vias: JobVia[]) {
    const registry = createRegistry()
    for (const via of vias) registry.register(fake('x', via))
    return registry
  }
  const viasOf = async (registry: ReturnType<typeof createRegistry>, one: Job): Promise<JobVia[]> => (await registry.picksFor(one)).map(pick => pick.adapter.via)

  it('★聊天的派活:协议 > 窗口 > 命令行 > 接口(命令行 / 接口是备用)', async () => {
    const registry = registryWith('api', 'cli', 'window', 'file', 'protocol')
    expect(await viasOf(registry, job({ work: 'chat' }))).toEqual(['protocol', 'window', 'cli', 'api', 'file'])
    // 没说是哪一种活 → 当聊天。
    expect(await viasOf(registry, job())).toEqual(['protocol', 'window', 'cli', 'api', 'file'])
  })

  it('★写代码的派活只留命令行;在电脑上动手只留窗口', async () => {
    const registry = registryWith('api', 'cli', 'window', 'protocol')
    expect(await viasOf(registry, job({ work: 'code' }))).toEqual(['cli'])
    expect(await viasOf(registry, job({ work: 'desk' }))).toEqual(['window'])
    expect(channelAllowedFor('code', 'window')).toBe(false)
    expect(channelAllowedFor('desk', 'cli')).toBe(false)
    expect(channelAllowedFor(undefined, 'api')).toBe(true)
  })

  it('指定模型与思考档不能回退到不可控的窗口或接口', async () => {
    const registry = registryWith('window', 'api', 'cli', 'protocol')
    expect(await viasOf(registry, job({ model: 'chosen', effort: 'high' }))).toEqual(['cli'])
  })

  it('别的活种照旧按缺省次序(协议 > 命令行 > 接口 > 文件 > 窗口),不过活种那一道', async () => {
    const registry = registryWith('window', 'file', 'api', 'cli', 'protocol')
    expect(await viasOf(registry, job({ kind: 'relay', target: { kind: 'session', sessionId: 's' }, work: 'code' }))).toEqual(['protocol', 'cli', 'api', 'file', 'window'])
  })

  it('有命令行这条通道的那几家 = 写代码的几家 ∪ 聊天留命令行当备用的那一家(读源头比对;2026-10-22 卡 C 起含 Kimi)', () => {
    expect(hasCodeCli('kimi')).toBe(true)
    expect(CODE_CLI_FAMILIES).toContain('kimi')
    const fromSources = FAMILY_SOURCES.filter(one => one.cliBackup === true || hasCodeCli(one.agent)).map(one => one.agent).sort()
    expect([...CLI_FAMILIES].sort()).toEqual(fromSources)
  })
})

describe('③ 命令行那一条适配器', () => {
  function cliDeps(over: Partial<CliAdapterDeps> & { found?: boolean, pid?: number | undefined } = {}) {
    const runs: { bin: string, argv: readonly string[], cwd: string, logFile: string, env?: NodeJS.ProcessEnv }[] = []
    const deps: CliAdapterDeps = {
      resolveCli: family => (over.found === false ? { found: false, family, why: '没装' } : { found: true, family, bin: '/fake/bin', source: 'path' }),
      runCli: (cmd) => { runs.push(cmd); return over.pid === undefined && 'pid' in over ? { error: '起不来', exited: Promise.resolve({ code: null }) } : { pid: over.pid ?? 4242, exited: new Promise(() => {}) } },
      resultDir: '/tmp/wb-cli-adapter',
      now: () => new Date('2026-10-03T06:00:00.000Z'),
      name: () => 'Codex',
      ...over,
    }
    return { deps, runs }
  }

  it('能力 = 这台找得到它的命令行;找不到就说得出为什么', async () => {
    const yes = createCliAdapter('codex', cliDeps().deps)
    expect((await yes.capabilities()).send).toBe(true)
    const no = createCliAdapter('codex', cliDeps({ found: false }).deps)
    expect((await no.capabilities()).send).toBe(false)
    expect(no.unavailable?.()).toBe(cliNotFoundWhy('Codex'))
  })

  it('不是派活 → unsupported(让引擎换路);没挂项目 → not_sent 说清楚', async () => {
    const { deps } = cliDeps()
    const adapter = createCliAdapter('codex', deps)
    expect(await adapter.run(job({ kind: 'relay', target: { kind: 'session', sessionId: 's' }, cwd: '/p' }))).toMatchObject({ delivered: 'not_sent', unsupported: true, via: 'cli' })
    expect(await adapter.run(job({ work: 'code' }))).toMatchObject({ delivered: 'not_sent', via: 'cli', why: CLI_NO_CWD_WHY })
  })


it('Kimi 指定思考档无法落实时禁止静默开跑', async () => {
  const { deps, runs } = cliDeps({ pid: 1 })
  const result = await createCliAdapter('kimi', deps).run(job({ family: 'kimi', work: 'code', cwd: '/repo', effort: 'high' }))
  expect(result).toMatchObject({ delivered: 'not_sent', blocked: true })
  expect(runs).toHaveLength(0)
})

  it('策略闸在 dispatchCommand 里:Claude 聊天的活不走命令行 → unsupported;写代码的活走', async () => {
    const { deps, runs } = cliDeps()
    const claude = createCliAdapter('claude', { ...deps, name: () => 'Claude' })
    expect(await claude.run(job({ family: 'claude', work: 'chat', cwd: '/p' }))).toMatchObject({ unsupported: true, why: CLI_NOT_THIS_WAY_WHY })
    expect(runs).toHaveLength(0)
    expect((await claude.run(job({ family: 'claude', work: 'code', cwd: '/p' }))).delivered).toBe('confirmed')
    expect(runs).toHaveLength(1)
  })

  it('★起来了 = 送到:带 process(pid / 结果文件 / 事件流 / 退出承诺);命令带着交代与目录', async () => {
    const { deps, runs } = cliDeps({ pid: 777 })
    const adapter = createCliAdapter('codex', deps)
    const out = await adapter.run(job({ family: 'codex', work: 'code', cwd: '/proj', text: '【工作台派活 000001】改一处' }))
    expect(out).toMatchObject({ delivered: 'confirmed', via: 'cli', evidence: 'receipt' })
    expect(out.process?.pid).toBe(777)
    expect(out.process?.output_file).toBe('/tmp/wb-cli-adapter/t-1-2026-10-03T06-00-00-000Z.txt')
    expect(out.process?.log_file).toBe(`${out.process?.output_file}.jsonl`)
    expect(out.process?.exited).toBeInstanceOf(Promise)
    expect(runs[0]?.cwd).toBe('/proj')
    expect(runs[0]?.argv.join(' ')).toContain('改一处')
  })

  it('★名片带的模型与智能体文件原样进命令(2026-10-22 卡 D):kimi `-m` + `--agent-file`,claude `--model`', async () => {
    const { deps: kimiDeps, runs: kimiRuns } = cliDeps({ pid: 1 })
    const kimi = createCliAdapter('kimi', { ...kimiDeps, name: () => 'Kimi' })
    await kimi.run(job({ family: 'kimi', work: 'code', cwd: '/wt', model: 'kimi-for-coding', agentFile: 'docs/卡/agents/kimi-coder.md' }))
    expect(kimiRuns[0]?.argv).toEqual(expect.arrayContaining(['-m', 'kimi-for-coding', '--agent-file', '/wt/docs/卡/agents/kimi-coder.md']))
    const { deps: claudeDeps, runs: claudeRuns } = cliDeps({ pid: 1 })
    const claude = createCliAdapter('claude', { ...claudeDeps, name: () => 'Claude' })
    await claude.run(job({ family: 'claude', work: 'code', cwd: '/wt', model: 'opus' }))
    expect(claudeRuns[0]?.argv).toEqual(expect.arrayContaining(['--model', 'opus']))
    // 不带:一字不加(老命令形状不变)
    const { deps: plain, runs: plainRuns } = cliDeps({ pid: 1 })
    await createCliAdapter('codex', plain).run(job({ family: 'codex', work: 'code', cwd: '/wt' }))
    expect(plainRuns[0]?.argv.join(' ')).not.toContain('--model')
    expect(plainRuns[0]?.argv.join(' ')).not.toContain('--agent-file')
  })

  it('起不来 → not_sent,带它的原话;备好的环境传给进程', async () => {
    const { deps, runs } = cliDeps({ pid: undefined, envForCli: async () => ({ env: { PATH: '/x' } }) })
    const adapter = createCliAdapter('codex', deps)
    const out = await adapter.run(job({ family: 'codex', work: 'code', cwd: '/proj' }))
    expect(out).toMatchObject({ delivered: 'not_sent', via: 'cli', why: cliDidNotStartWhy('起不来') })
    expect(runs[0]?.env).toEqual({ PATH: '/x' })
  })
})

describe('③ 接口那一条适配器', () => {
  function apiDeps(over: Partial<ApiAdapterDeps> & { reply?: string, reason?: string } = {}) {
    const sent: { family: string, text: string, context?: unknown }[] = []
    const deps: ApiAdapterDeps = {
      send: async (input) => {
        sent.push({ family: input.family, text: input.text, ...(input.context === undefined ? {} : { context: input.context }) })
        if (over.reason !== undefined) return { ok: false, reason: over.reason, dispatch: { family: input.family, hand: 'api', status: 'failed', started_at: 'x' } as never }
        return { ok: true, reply: over.reply ?? '润色好了', dispatch: { family: input.family, hand: 'api', status: 'done', started_at: 'x' } as never }
      },
      ...over,
    }
    return { deps, sent }
  }

  it('中转没配 → 能力 send:false、说得出为什么;run 也不发', async () => {
    const { deps, sent } = apiDeps({ configured: () => false })
    const adapter = createApiAdapter('doubao', deps)
    expect((await adapter.capabilities()).send).toBe(false)
    expect(adapter.unavailable?.()).toBe(API_NOT_CONFIGURED_WHY)
    expect(await adapter.run(job({ family: 'doubao', brief: '帮我润色' }))).toMatchObject({ delivered: 'not_sent', via: 'api', why: API_NOT_CONFIGURED_WHY })
    expect(sent).toHaveLength(0)
  })

  it('★只送她的原话(brief)+ 项目 / 目录当上下文;回答进 reply,via 是 api', async () => {
    const { deps, sent } = apiDeps({ reply: '改好了。' })
    const adapter = createApiAdapter('doubao', deps)
    const out = await adapter.run(job({ family: 'doubao', text: '【工作台派活 000001】帮我润色\n\n规矩…', brief: '帮我润色', project: 'p', cwd: '/p' }))
    expect(out).toEqual({ delivered: 'confirmed', via: 'api', evidence: 'receipt', reply: '改好了。' })
    expect(sent).toEqual([{ family: 'doubao', text: '帮我润色', context: { project: 'p', cwd: '/p' } }])
  })

  it('没给原话就送整段;不是派活 → unsupported;上游回错 → not_sent 带原因', async () => {
    const { deps } = apiDeps({ reason: '服务器没配 豆包' })
    const adapter = createApiAdapter('doubao', deps)
    expect((await adapter.run(job({ family: 'doubao', kind: 'relay', target: { kind: 'session', sessionId: 's' } }))).unsupported).toBe(true)
    expect(await adapter.run(job({ family: 'doubao', text: '整段' }))).toMatchObject({ delivered: 'not_sent', via: 'api', why: apiFailedWhy('服务器没配 豆包') })
  })
})

describe('④ 走引擎:同一道闸、同一本账', () => {
  function rig(options: { phase?: 'open' | 'settled', connected?: boolean } = {}) {
    let cliRuns = 0
    let apiCalls = 0
    const h = engineHarness({
      phaseOf: () => options.phase ?? 'open',
      connected: () => options.connected ?? false,
      nameOf: family => (family === 'codex' ? 'Codex' : family === 'doubao' ? '豆包办公' : family),
      cli: {
        resolveCli: family => ({ found: true, family, bin: '/fake', source: 'path' }),
        runCli: () => { cliRuns += 1; return { pid: 99, exited: new Promise(() => {}) } },
        resultDir: '/tmp/wb-engine-hands',
        now: () => new Date('2026-10-03T06:00:00.000Z'),
      },
      api: {
        send: async (input) => { apiCalls += 1; return { ok: true, reply: '接口答的', dispatch: { family: input.family, hand: 'api', status: 'done', started_at: 'x' } as never } },
      },
    })
    return { h, cli: () => cliRuns, api: () => apiCalls }
  }

  it('★壳没连(窗口不可用)→ Codex 聊天的派活走命令行;账上 assigned 带 via cli、随后 sent', async () => {
    const r = rig()
    const out = await r.h.engine.run(job({ family: 'codex', work: 'chat', cwd: '/p' }))
    expect(out).toMatchObject({ delivered: 'confirmed', via: 'cli' })
    expect(r.cli()).toBe(1)
    const events = r.h.log.events('t-1')
    expect(events.find(one => one.step === 'assigned')?.via).toBe('cli')
    // 投递那一步:起进程 = 有回执,引擎按「亲眼看见 / 有回执」记 `seen`(与协议那条同一口径;四步表上算投递)。
    expect(events.map(one => one.step)).toEqual(['gate_pass', 'assigned', 'seen'])
    expect(events.find(one => one.step === 'seen')?.via).toBe('cli')
  })

  it('★豆包聊天、壳没连 → 走接口;GPT(没有窗口)直接走接口;账上 via 是 api', async () => {
    const r = rig()
    expect(await r.h.engine.run(job({ family: 'doubao', work: 'chat', brief: '润色' }))).toMatchObject({ delivered: 'confirmed', via: 'api', reply: '接口答的' })
    expect(await r.h.engine.run(job({ id: 't-2', itemId: 't-2', family: 'gpt', work: 'chat', brief: '写个标题' }))).toMatchObject({ via: 'api' })
    expect(r.api()).toBe(2)
    expect(r.h.log.events('t-2').find(one => one.step === 'assigned')?.via).toBe('api')
  })

  it('★闸拦下(这件事收场了)→ 命令行 / 接口一次都不调,结局带 blocked', async () => {
    const r = rig({ phase: 'settled' })
    const codex = await r.h.engine.run(job({ family: 'codex', work: 'code', cwd: '/p' }))
    const doubao = await r.h.engine.run(job({ family: 'doubao', work: 'chat' }))
    expect(codex).toMatchObject({ delivered: 'not_sent', blocked: true })
    expect(doubao).toMatchObject({ delivered: 'not_sent', blocked: true })
    expect(r.cli()).toBe(0)
    expect(r.api()).toBe(0)
  })

  it('写代码的活派给豆包(没有命令行这条通道)→ 一条通道都排不上,如实说;接口一次不调', async () => {
    const r = rig()
    const out = await r.h.engine.run(job({ family: 'doubao', work: 'code', cwd: '/p' }))
    expect(out).toMatchObject({ delivered: 'not_sent', unsupported: true })
    expect(r.api()).toBe(0)
  })
})

describe('⑤ 派活的「备用」规矩在引擎里:窗口没送成就退到命令行 / 接口,原因按通道接起来', () => {
  const NO_WINDOW = '找不到窗口:com.openai.codex 在跑,但一扇标准窗口都没有'
  function rig(options: { cliStarts?: boolean } = {}) {
    let cliRuns = 0
    let apiCalls = 0
    const h = engineHarness({
      connected: () => true,
      installed: family => (family === 'codex' ? [{ bundle_id: 'com.openai.codex', name: 'Codex', running: true }] : family === 'doubao' ? [{ bundle_id: 'com.work.pc.doubao', name: '豆包办公', running: true }] : undefined),
      nameOf: family => (family === 'codex' ? 'Codex' : family === 'doubao' ? '豆包办公' : family),
      // 壳连着、窗口却送不进(没窗口):窗口那条回 not_sent。
      reply: (req) => { if (req.op === 'send_text') throw new Error(NO_WINDOW); return {} },
      cli: {
        resolveCli: family => ({ found: true, family, bin: '/fake', source: 'path' }),
        runCli: () => { cliRuns += 1; return options.cliStarts === false ? { error: '起不来', exited: Promise.resolve({ code: null }) } : { pid: 7, exited: new Promise(() => {}) } },
        resultDir: '/tmp/wb-engine-hands',
        now: () => new Date('2026-10-03T06:00:00.000Z'),
      },
      api: { send: async (input) => { apiCalls += 1; return { ok: true, reply: '接口答的', dispatch: { family: input.family, hand: 'api', status: 'done', started_at: 'x' } as never } } },
    })
    return { h, cli: () => cliRuns, api: () => apiCalls }
  }

  it('★Codex 聊天:窗口没送成 → 退到命令行;账上窗口那一条 not_sent、命令行那一条 assigned + seen', async () => {
    const r = rig()
    const out = await r.h.engine.run(job({ family: 'codex', work: 'chat', cwd: '/p' }))
    expect(out).toMatchObject({ delivered: 'confirmed', via: 'cli' })
    expect(r.cli()).toBe(1)
    const steps = r.h.log.events('t-1').map(one => `${one.step}:${one.via ?? '-'}`)
    expect(steps).toEqual(['gate_pass:-', 'assigned:window', 'not_sent:window', 'assigned:cli', 'seen:cli'])
  })

  it('★豆包聊天:窗口没送成 → 退到接口', async () => {
    const r = rig()
    expect(await r.h.engine.run(job({ family: 'doubao', work: 'chat', brief: '润色' }))).toMatchObject({ via: 'api', reply: '接口答的' })
    expect(r.api()).toBe(1)
  })

  it('★都没成:原因按通道接起来(窗口:…;命令行:…),不再标 unsupported', async () => {
    const r = rig({ cliStarts: false })
    const out = await r.h.engine.run(job({ family: 'codex', work: 'chat', cwd: '/p' }))
    expect(out.delivered).toBe('not_sent')
    expect(out.unsupported).toBeUndefined()
    expect(out.why).toContain(`${VIA_TEXT.window}:`)
    expect(out.why).toContain(`${VIA_TEXT.cli}:${cliDidNotStartWhy('起不来')}`)
  })

  it('捎话 / 替她答不走备用:窗口没送成就是没送成,不去碰命令行', async () => {
    const r = rig()
    const out = await r.h.engine.run(job({ family: 'codex', kind: 'relay', target: { kind: 'session', sessionId: 'window:abc' }, text: '捎一句', marks: ['捎一句'] }))
    expect(out.delivered).toBe('not_sent')
    expect(r.cli()).toBe(0)
  })
})
