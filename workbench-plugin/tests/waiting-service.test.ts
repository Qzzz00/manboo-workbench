// @vitest-environment node
/**
 * 「在等你」的 I/O 那一半(waitingService.ts,2026-09-25 卡 T)。
 *
 * 会话文件写在临时目录里(形状照真机的 Claude transcript / Codex rollout 抄);**模型用假 fetch,不调真模型**。守:
 * ① 叠到会话表上:在等你 > 在跑 > 空闲;没弹窗、正文里在问他的会话算在等你,带问题与选项;
 * ② 子任务挂到主会话下:主会话说完了、子任务还在跑 → 主会话在跑;子任务在等他 → 冒到主会话上(说清哪个子任务),不单成一张;
 * ③ 拿不准才问模型:授权表没点头不问;同一段话只问一次(按消息哈希);今天花到上限就不问;账只记日期、花了多少;
 * ④ Claude 那一路「第一次见就说完了不回放」—— 在等他的例外(waitingIfIdle)。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionView, WorkbenchState } from '../src/protocol.ts'
import type { ClaudeLiveSession } from '../src/server/claudeSessionRecover.ts'
import { createWaitingService, type SessionFileRef, type WaitModelDeps, type WindowWaitRef } from '../src/server/waitingService.ts'
import { waitingOnHim } from '../src/waiting.ts'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-waiting-'))
  dirs.push(dir)
  return dir
}

const NOW = new Date('2026-09-25T10:00:00.000Z')
const NOW_SEC = Math.floor(NOW.getTime() / 1000)
const lines = (...rows: unknown[]): string => `${rows.map(row => JSON.stringify(row)).join('\n')}\n`
const human = (sid: string, text: string, at: string, extra: Record<string, unknown> = {}) => ({
  type: 'user', sessionId: sid, cwd: '/w', timestamp: at, entrypoint: 'claude-desktop', origin: { kind: 'human' }, message: { role: 'user', content: text }, ...extra,
})
const said = (sid: string, text: string, at: string, stop = 'end_turn', extra: Record<string, unknown> = {}) => ({
  type: 'assistant', sessionId: sid, timestamp: at, entrypoint: 'claude-desktop', message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: stop }, ...extra,
})

function view(patch: Partial<SessionView> & Pick<SessionView, 'session_id'>): SessionView {
  return { agent: 'claude', project: 'p', status: 'done', elapsed_sec: 60, unread: false, updated_at: NOW.toISOString(), ...patch }
}

/** 写一个会话文件,修改时刻设成 `ageSec` 秒前(「文件没动就不读」靠它)。 */
function writeSession(dir: string, name: string, text: string, ageSec = 60): string {
  const file = join(dir, name)
  writeFileSync(file, text)
  const at = new Date(NOW.getTime() - ageSec * 1000)
  utimesSync(file, at, at)
  return file
}

function fakeModel(reply: unknown, options: { allowed?: boolean, budget?: number, ledgerFile: string, usage?: Record<string, number>, model?: string | (() => Promise<string | undefined>) }): { deps: WaitModelDeps, stateFile: string, calls: () => number, bodies: () => Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = []
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }], usage: options.usage ?? { prompt_tokens: 1000, completion_tokens: 60 } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return {
    deps: {
      endpoint: async () => ({ ready: true, baseUrl: 'http://relay.invalid/v1', key: 'test-only' }),
      fetchImpl,
      allowed: async () => options.allowed ?? true,
      budgetCny: async () => options.budget ?? 0.5,
      ...(options.model === undefined ? {} : { model: options.model }),
    },
    stateFile: options.ledgerFile,
    calls: () => bodies.length,
    bodies: () => bodies,
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise(resolve => setTimeout(resolve, 5))
}

describe('叠到会话表上', () => {
  /**
   * 2026-09-26(卡 V 补)改了断言的一半:**按内容判出来的只挂 `ask`,不改运行状态** ——
   * 「说完了、顺口问了他一句」在「几条在跑几条做完」那个口径里就是做完了(理由见
   * src/server/waitingForYou.ts 的 overlayWaiting)。这一条照旧钉住卡 T 的正题:
   * 正文里那一问**读出来了**、问题与选项都对、在跑的不算、事务官自己的不碰。
   */
  it('★没弹窗、正文里在问他 → 挂上那一问(带问题与选项),运行状态原样;在跑的不算;事务官自己的不碰', async () => {
    const dir = tempDir()
    const asking = writeSession(dir, 'a1.jsonl', lines(
      human('a1', '额度怎么办', '2026-09-25T09:50:00.000Z'),
      said('a1', '今天额度只剩 0.58 元。三个选择:\n1. 提到 15 元\n2. 不提\n3. 换自己的 Key\n你选哪个?回个数字就行。', '2026-09-25T09:51:00.000Z'),
    ))
    const reporting = writeSession(dir, 'b2.jsonl', lines(human('b2', '跑测试', '2026-09-25T09:40:00.000Z'), said('b2', '全绿,已提交。', '2026-09-25T09:45:00.000Z')))
    const files: SessionFileRef[] = [
      { agent: 'claude', session_id: 'a1', file: asking, format: 'claude-transcript' },
      { agent: 'claude', session_id: 'b2', file: reporting, format: 'claude-transcript' },
    ]
    const sessions = [view({ session_id: 'a1' }), view({ session_id: 'b2' }), view({ agent: 'dsh', session_id: 'd1' })]
    const waiting = createWaitingService({ sessions: () => sessions, files: () => files, now: () => NOW, childrenOf: async () => [], agentName: agent => (agent === 'claude' ? 'Claude' : agent), replyOf: () => ({ reply: 'desk', where: '这一问得在电脑上的 Claude 里回答' }) })
    await waiting.scanNow()
    const shown = waiting.overlay(sessions, NOW_SEC)
    // 卡 V(09-26):运行状态原样(这条 view 是 done),不再被改成 waiting;那一问挂在 ask 上。
    expect(shown[0]).toMatchObject({ session_id: 'a1', status: 'done' })
    expect(shown[0]?.wait_reason).toBeUndefined()
    expect(shown[0]?.ask).toMatchObject({ kind: 'choose', question: '今天额度只剩 0.58 元。', since: '2026-09-25T09:51:00.000Z', by: 'rules', reply: 'desk', where: '这一问得在电脑上的 Claude 里回答' })
    expect(shown[0]?.ask?.options?.map(option => option.label)).toEqual(['提到 15 元', '不提', '换自己的 Key'])
    expect(shown[1]).toBe(sessions[1]) // 汇报完的:原样
    expect(shown[2]).toBe(sessions[2]) // 事务官的:不碰
    // 同一条会话又跑起来了(那家报 running)→ 不再算等他
    const running = waiting.overlay([view({ session_id: 'a1', status: 'running' })], NOW_SEC)
    expect(running[0]?.status).toBe('running')
    expect(running[0]?.ask).toBeUndefined()
  })

  it('Claude 自己记着 waiting + permission prompt(没接 hook 的机器)→ 在等你点头;挂着的那一步说清要干什么', async () => {
    const dir = tempDir()
    const file = writeSession(dir, 'c3.jsonl', lines(
      human('c3', '把旧截图清掉', '2026-09-25T09:58:00.000Z'),
      { type: 'assistant', sessionId: 'c3', timestamp: '2026-09-25T09:58:30.000Z', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'trash x', description: '把旧截图移到废纸篓' } }] } },
    ))
    const live = new Map<string, ClaudeLiveSession>([['c3', { alive: true, status: 'waiting', waitingFor: 'permission prompt' }]])
    const sessions = [view({ session_id: 'c3', status: 'waiting', reason: 'permission_prompt', wait_reason: 'approval' })]
    const waiting = createWaitingService({ sessions: () => sessions, files: () => [{ agent: 'claude', session_id: 'c3', file, format: 'claude-transcript' }], now: () => NOW, claudeLive: async () => live, childrenOf: async () => [], agentName: () => 'Claude' })
    await waiting.scanNow()
    const [shown] = waiting.overlay(sessions, NOW_SEC)
    expect(shown).toMatchObject({ status: 'waiting', reason: 'permission_prompt', wait_reason: 'approval' })
    expect(shown?.ask).toMatchObject({ kind: 'approve', by: 'form', question: 'Claude 要把旧截图移到废纸篓,等你批准' })
  })

  it('Kimi 的 blocked:记录里有待批的那一条才挂问(没有证据就不挂;2026-09-28 卡 KM)', async () => {
    // 有证据(会话事件带着记录里读到的 formal_wait):照算在等你,并说清是要批一步操作。
    const blocked = [view({ agent: 'kimi', session_id: 'k1', status: 'waiting', formal_wait: 'approval' })]
    const withProof = createWaitingService({ sessions: () => blocked, files: () => [], now: () => NOW, agentName: () => 'Kimi' })
    await withProof.scanNow()
    expect(withProof.overlay(blocked, NOW_SEC)[0]?.ask).toMatchObject({ kind: 'approve', by: 'form', question: 'Kimi 要你批准一步操作' })
    // 没有证据(Kimi 这一轮说完也记 blocked):一个问都不挂 —— 不编「停下来等你确认」、不编「弹了个框」。
    const bare = [view({ agent: 'kimi', session_id: 'k2', status: 'waiting' })]
    const noProof = createWaitingService({ sessions: () => bare, files: () => [], now: () => NOW, agentName: () => 'Kimi' })
    await noProof.scanNow()
    expect(noProof.overlay(bare, NOW_SEC)[0]?.ask).toBeUndefined()
  })

  it('文件没动就一个字节都不读', async () => {
    const dir = tempDir()
    const file = writeSession(dir, 'a1.jsonl', lines(said('a1', '要不要合?', '2026-09-25T09:59:00.000Z')))
    let reads = 0
    const waiting = createWaitingService({
      sessions: () => [view({ session_id: 'a1' })],
      files: () => [{ agent: 'claude', session_id: 'a1', file, format: 'claude-transcript' }],
      now: () => NOW,
      childrenOf: async () => [],
      readTurns: async (ref) => {
        reads += 1
        const { readSessionTurns } = await import('../src/server/sessionDigest.ts')
        return readSessionTurns(ref)
      },
    })
    await waiting.scanNow()
    await waiting.scanNow()
    expect(reads).toBe(1)
    expect(waiting.verdictOf('claude', 'a1')).toMatchObject({ waiting: true, kind: 'approve' })
  })
})

describe('★子任务挂到主会话下', () => {
  it('主会话「这一轮说完了」、它的子任务还在跑 → 主会话在跑;子任务说完了 → 主会话空闲', async () => {
    const dir = tempDir()
    const main = writeSession(dir, 'm1.jsonl', lines(human('m1', '三张卡派出去', '2026-09-25T09:30:00.000Z'), said('m1', '派出去了,等它们回来。', '2026-09-25T09:31:00.000Z')))
    mkdirSync(join(dir, 'm1', 'subagents'), { recursive: true })
    const child = writeSession(join(dir, 'm1', 'subagents'), 'agent-a1.jsonl', lines(
      human('m1', '去做卡 T', '2026-09-25T09:31:00.000Z', { isSidechain: true, agentId: 'a1' }),
      said('m1', '我先读设计文档。', '2026-09-25T09:59:00.000Z', 'tool_use', { isSidechain: true, agentId: 'a1' }),
    ), 30)
    const sessions = [view({ session_id: 'm1', status: 'done' })]
    const waiting = createWaitingService({ sessions: () => sessions, files: () => [{ agent: 'claude', session_id: 'm1', file: main, format: 'claude-transcript' }], now: () => NOW })
    await waiting.scanNow()
    expect(waiting.overlay(sessions, NOW_SEC)[0]?.status).toBe('running')
    // 子任务说完了(最终回答)→ 主会话回到空闲
    writeFileSync(child, lines(said('m1', '卡 T 做完了。', '2026-09-25T09:59:30.000Z', 'end_turn', { isSidechain: true, agentId: 'a1' })))
    utimesSync(child, new Date(NOW.getTime() - 20_000), new Date(NOW.getTime() - 20_000))
    utimesSync(main, new Date(NOW.getTime() - 10_000), new Date(NOW.getTime() - 10_000))
    await waiting.scanNow()
    expect(waiting.overlay(sessions, NOW_SEC)[0]?.status).toBe('done')
  })

  it('十分钟没动的子任务不算在跑', async () => {
    const dir = tempDir()
    const main = writeSession(dir, 'm2.jsonl', lines(said('m2', '都派出去了。', '2026-09-25T09:00:00.000Z')))
    mkdirSync(join(dir, 'm2', 'subagents'), { recursive: true })
    writeSession(join(dir, 'm2', 'subagents'), 'agent-b.jsonl', lines(said('m2', '还在读。', '2026-09-25T09:10:00.000Z', 'tool_use', { isSidechain: true })), 1800)
    const sessions = [view({ session_id: 'm2' })]
    const waiting = createWaitingService({ sessions: () => sessions, files: () => [{ agent: 'claude', session_id: 'm2', file: main, format: 'claude-transcript' }], now: () => NOW })
    await waiting.scanNow()
    expect(waiting.overlay(sessions, NOW_SEC)[0]?.status).toBe('done')
  })
})

describe('★子任务在等他:冒到主会话卡上、进「等你」同一堆', () => {
  const toolUse = (sid: string, id: string, name: string, input: Record<string, unknown>, at: string, extra: Record<string, unknown> = {}) => ({
    type: 'assistant', sessionId: sid, timestamp: at, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] }, ...extra,
  })

  it('Claude 主会话停在权限弹窗上、它挂着的是「派助手」:是子任务要的权限 —— 说清哪个子任务、要做什么;外层一句话带上它', async () => {
    const dir = tempDir()
    // 主会话:派了一个助手(Task)还没回来;Claude 自己记着 waiting + permission prompt
    const main = writeSession(dir, 'm3.jsonl', lines(
      human('m3', '把测试跑一遍', '2026-09-25T09:50:00.000Z'),
      toolUse('m3', 'toolu_t', 'Task', { description: '跑一遍测试', prompt: '去跑测试' }, '2026-09-25T09:51:00.000Z'),
    ))
    const subDir = join(dir, 'm3', 'subagents')
    mkdirSync(subDir, { recursive: true })
    writeSession(subDir, 'agent-a7.jsonl', lines(
      human('m3', '去跑测试', '2026-09-25T09:51:00.000Z', { isSidechain: true, agentId: 'a7' }),
      toolUse('m3', 'toolu_b', 'Bash', { command: 'pnpm test', description: 'Run the test suite' }, '2026-09-25T09:59:00.000Z', { isSidechain: true, agentId: 'a7' }),
    ), 30)
    writeFileSync(join(subDir, 'agent-a7.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: '跑一遍测试' }))
    const live = new Map<string, ClaudeLiveSession>([['m3', { alive: true, status: 'waiting', waitingFor: 'permission prompt' }]])
    const sessions = [view({ session_id: 'm3', status: 'waiting', reason: 'permission_prompt', wait_reason: 'approval' })]
    const waiting = createWaitingService({
      sessions: () => sessions, files: () => [{ agent: 'claude', session_id: 'm3', file: main, format: 'claude-transcript' }], now: () => NOW, claudeLive: async () => live, agentName: () => 'Claude',
      replyOf: (_view, ask) => (ask.child !== undefined ? { reply: 'desk', where: '这一问得在电脑上的 Claude 里回答(它那边弹了个框等你点)', reveal: true } : { reply: 'window' }),
    })
    await waiting.scanNow()
    const shown = waiting.overlay(sessions, NOW_SEC)
    expect(shown).toHaveLength(1) // 子任务不单成一张卡
    expect(shown[0]?.ask).toMatchObject({ kind: 'approve', by: 'form', question: '它要跑测试,等你批准', child: { id: 'agent-a7', title: '跑一遍测试' }, reply: 'desk' })
    const pile = waitingOnHim({ sessions: shown } as unknown as WorkbenchState)
    expect(pile.items.map(item => item.text)).toEqual(['Claude 的子任务「跑一遍测试」在等你点头:它要跑测试,等你批准'])
  })

  it('主会话自己挂着一条命令:那是它自己要的权限,不算子任务的', async () => {
    const dir = tempDir()
    const main = writeSession(dir, 'm4.jsonl', lines(
      human('m4', '清一下', '2026-09-25T09:50:00.000Z'),
      toolUse('m4', 'toolu_c', 'Bash', { command: 'trash x', description: '把旧截图移到废纸篓' }, '2026-09-25T09:59:00.000Z'),
    ))
    const subDir = join(dir, 'm4', 'subagents')
    mkdirSync(subDir, { recursive: true })
    writeSession(subDir, 'agent-a8.jsonl', lines(toolUse('m4', 'toolu_d', 'Read', { file_path: '/w/a.ts' }, '2026-09-25T09:58:00.000Z', { isSidechain: true })), 60)
    const live = new Map<string, ClaudeLiveSession>([['m4', { alive: true, status: 'waiting', waitingFor: 'permission prompt' }]])
    const sessions = [view({ session_id: 'm4', status: 'waiting', reason: 'permission_prompt', wait_reason: 'approval' })]
    const waiting = createWaitingService({ sessions: () => sessions, files: () => [{ agent: 'claude', session_id: 'm4', file: main, format: 'claude-transcript' }], now: () => NOW, claudeLive: async () => live, agentName: () => 'Claude' })
    await waiting.scanNow()
    const ask = waiting.overlay(sessions, NOW_SEC)[0]?.ask
    expect(ask).toMatchObject({ question: 'Claude 要把旧截图移到废纸篓,等你批准' })
    expect(ask?.child).toBeUndefined()
  })

  it('★卡 Q 的 children 那个口:给了就用它(不另读子任务文件);哪一家都一样 —— Codex 的子任务在问他,主会话还在跑也算等你', async () => {
    const dir = tempDir()
    const main = writeSession(dir, 'rollout-x.jsonl', lines({ timestamp: '2026-09-25T09:50:00.000Z', type: 'session_meta', payload: { id: 'cx1', cwd: '/w' } }))
    const asked: string[] = []
    const sessions = [view({ agent: 'codex', session_id: 'cx1', status: 'running' })]
    const waiting = createWaitingService({
      sessions: () => sessions,
      files: () => [{ agent: 'codex', session_id: 'cx1', file: main, format: 'codex-rollout' }],
      now: () => NOW,
      agentName: () => 'Codex',
      childrenOf: async (ref) => {
        asked.push(`${ref.agent}:${ref.session_id}`)
        return [
          { id: 't1', title: '改手机端', status: 'running' },
          { id: 't2', title: '核对额度来源', status: 'waiting', updated_at: '2026-09-25T09:58:00.000Z', pending: { kind: 'question', tool: 'request_user_input', at: '2026-09-25T09:58:00.000Z', questions: [{ question: '额度按天算还是按月算?', options: [{ label: '按天' }, { label: '按月' }] }] } },
        ]
      },
    })
    await waiting.scanNow()
    expect(asked).toEqual(['codex:cx1'])
    const [shown] = waiting.overlay(sessions, NOW_SEC)
    expect(shown).toMatchObject({ status: 'waiting' })
    expect(shown?.ask).toMatchObject({ kind: 'choose', question: '额度按天算还是按月算?', child: { id: 't2', title: '核对额度来源' } })
    const pile = waitingOnHim({ sessions: [shown] } as unknown as WorkbenchState)
    expect(pile.items.map(item => [item.verb, item.text])).toEqual([['答', 'Codex 的子任务「核对额度来源」在等你选:额度按天算还是按月算?']])
  })
})

describe('拿不准时问一次模型(假 fetch)', () => {
  const UNSURE = '这样行不行呢,我也拿不准。先按这个版本合了,测试全绿。'

  function setup(model: ReturnType<typeof fakeModel>, dir: string) {
    const file = writeSession(dir, 'u1.jsonl', lines(human('u1', '看看这版', '2026-09-25T09:55:00.000Z'), said('u1', UNSURE, '2026-09-25T09:56:00.000Z')))
    const sessions = [view({ session_id: 'u1' })]
    const waiting = createWaitingService({ sessions: () => sessions, files: () => [{ agent: 'claude', session_id: 'u1', file, format: 'claude-transcript' }], now: () => NOW, childrenOf: async () => [], model: model.deps, stateFile: model.stateFile, agentName: () => 'Claude' })
    return { waiting, sessions }
  }

  it('own 档他自己填的模型名照用(2026-10-23,卡「事务官换Key」)', async () => {
    const dir = tempDir()
    const model = fakeModel({ waiting: true, kind: 'approve', question: '这版能不能合', options: [], quote: '这样行不行呢' }, { ledgerFile: join(dir, 'waiting.json'), model: async () => 'his-own-model' })
    const { waiting } = setup(model, dir)
    await waiting.scanNow()
    await settle()
    expect(model.calls()).toBe(1)
    expect(model.bodies()[0]).toMatchObject({ model: 'his-own-model' })
  })

  it('★规则拿不准 → 问一次(V4 Flash、关掉先想一遍);依据逐字核过才算;同一段话只问一次;账只记日期与钱', async () => {
    const dir = tempDir()
    const ledgerFile = join(dir, 'waiting.json')
    const model = fakeModel({ waiting: true, kind: 'approve', question: '这版能不能合', options: [], quote: '这样行不行呢' }, { ledgerFile })
    const { waiting, sessions } = setup(model, dir)
    // 还没扫:只有那家报的状态可看(形式上的都没有),不等
    expect(waiting.verdictOf('claude', 'u1')).toMatchObject({ waiting: false, rule: 'empty' })
    await waiting.scanNow()
    await settle()
    expect(model.calls()).toBe(1)
    expect(model.bodies()[0]).toMatchObject({ model: 'deepseek-v4-flash', thinking: { type: 'disabled' }, temperature: 0 })
    // 送去的只有最后一来一回
    const sent = JSON.stringify(model.bodies()[0])
    expect(sent).toContain('看看这版')
    expect(sent).toContain(UNSURE.slice(0, 10))
    const [shown] = waiting.overlay(sessions, NOW_SEC)
    expect(shown?.ask).toMatchObject({ kind: 'approve', by: 'model', quote: '这样行不行呢', since: '2026-09-25T09:56:00.000Z' })
    // 同一段话再扫一遍:不再问
    await waiting.scanNow()
    await settle()
    expect(model.calls()).toBe(1)
    // 账:只有日期、花了多少、问了几次(外加他点过「不用管这条」的会话 id 与时刻 —— 这里还没有)
    const ledger = JSON.parse(readFileSync(ledgerFile, 'utf8')) as { day: Record<string, unknown>, dismissed: Record<string, string> }
    expect(Object.keys(ledger).sort()).toEqual(['day', 'dismissed'])
    expect(ledger.dismissed).toEqual({})
    expect(Object.keys(ledger.day).sort()).toEqual(['calls', 'date', 'spend_cny'])
    expect(ledger.day.calls).toBe(1)
    expect(ledger.day.spend_cny).toBeCloseTo((1000 * 2 + 60 * 8) / 1_000_000, 8)
    expect(readFileSync(ledgerFile, 'utf8')).not.toContain('行不行')
  })

  it('授权表没点头(read_session_content 不是「可以」)→ 一次都不问,照规则(不算等)', async () => {
    const dir = tempDir()
    const model = fakeModel({ waiting: true, kind: 'approve', quote: '这样行不行呢' }, { allowed: false, ledgerFile: join(dir, 'waiting.json') })
    const { waiting, sessions } = setup(model, dir)
    await waiting.scanNow()
    await settle()
    expect(model.calls()).toBe(0)
    expect(waiting.overlay(sessions, NOW_SEC)[0]?.ask).toBeUndefined()
  })

  it('今天花到上限了 → 不问', async () => {
    const dir = tempDir()
    const ledgerFile = join(dir, 'waiting.json')
    writeFileSync(ledgerFile, JSON.stringify({ day: { date: '2026-09-25', spend_cny: 0.5, calls: 90 } }))
    const model = fakeModel({ waiting: true, kind: 'approve', quote: '这样行不行呢' }, { ledgerFile, budget: 0.5 })
    const { waiting } = setup(model, dir)
    await waiting.scanNow()
    await settle()
    expect(model.calls()).toBe(0)
  })

  it('模型给的依据在原话里对不上 → 不算(当判不出),过一阵才再试', async () => {
    const dir = tempDir()
    const model = fakeModel({ waiting: true, kind: 'approve', question: '能不能合', options: [], quote: '你同意合进去吗' }, { ledgerFile: join(dir, 'waiting.json') })
    const { waiting, sessions } = setup(model, dir)
    await waiting.scanNow()
    await settle()
    expect(model.calls()).toBe(1)
    expect(waiting.overlay(sessions, NOW_SEC)[0]?.ask).toBeUndefined()
    await waiting.scanNow()
    await settle()
    expect(model.calls()).toBe(1) // 十分钟内不再问同一段
  })

  it('模型说没在等 → 不等', async () => {
    const dir = tempDir()
    const model = fakeModel({ waiting: false, kind: '', question: '', options: [], quote: '' }, { ledgerFile: join(dir, 'waiting.json') })
    const { waiting } = setup(model, dir)
    await waiting.scanNow()
    await settle()
    expect(waiting.verdictOf('claude', 'u1')).toMatchObject({ waiting: false, by: 'model' })
  })
})

describe('Claude 那一路的回放', () => {
  it('第一次见就说完了、但在等他 → waitingIfIdle 说要回放;汇报完的不回放;没读过的不回放', async () => {
    const dir = tempDir()
    const asking = writeSession(dir, 'w1.jsonl', lines(said('w1', '你选哪个?回个数字就行。\n1. A\n2. B', '2026-09-25T09:59:00.000Z')))
    const done = writeSession(dir, 'w2.jsonl', lines(said('w2', '全绿,已提交。', '2026-09-25T09:59:00.000Z')))
    const waiting = createWaitingService({
      sessions: () => [],
      files: () => [
        { agent: 'claude', session_id: 'w1', file: asking, format: 'claude-transcript' },
        { agent: 'claude', session_id: 'w2', file: done, format: 'claude-transcript' },
      ],
      now: () => NOW,
      childrenOf: async () => [],
    })
    await waiting.scanNow()
    expect(waiting.waitingIfIdle('claude', 'w1')).toBe(true)
    expect(waiting.waitingIfIdle('claude', 'w2')).toBe(false)
    expect(waiting.waitingIfIdle('claude', 'nope')).toBe(false)
    expect(waiting.entryOf('claude', 'w1')).toBe('claude-desktop')
  })

  it('★第一次用时不冒一堆老会话的「在等你」:十二小时前说的那一句不算', async () => {
    const dir = tempDir()
    const old = writeSession(dir, 'o1.jsonl', lines(said('o1', '要不要我顺手把手机端也改了?', '2026-09-24T08:00:00.000Z')), 26 * 3600)
    const sessions = [view({ session_id: 'o1' })]
    const waiting = createWaitingService({ sessions: () => sessions, files: () => [{ agent: 'claude', session_id: 'o1', file: old, format: 'claude-transcript' }], now: () => NOW, childrenOf: async () => [] })
    await waiting.scanNow()
    expect(waiting.overlay(sessions, NOW_SEC)[0]?.ask).toBeUndefined()
    expect(waiting.waitingIfIdle('claude', 'o1')).toBe(false)
  })
})

describe('「不用管这条」', () => {
  it('★按内容判出来的:点了就不算在等他;那家说了新的一句再重新判;账本里只记会话 id 与那句话的时刻', async () => {
    const dir = tempDir()
    const stateFile = join(dir, 'waiting.json')
    const file = writeSession(dir, 'a1.jsonl', lines(said('a1', '要不要我顺手把手机端也改了?', '2026-09-25T09:59:00.000Z')))
    const sessions = [view({ session_id: 'a1' })]
    const refs = [{ agent: 'claude', session_id: 'a1', file, format: 'claude-transcript' as const }]
    const waiting = createWaitingService({ sessions: () => sessions, files: () => refs, now: () => NOW, childrenOf: async () => [], stateFile })
    await waiting.scanNow()
    expect(waiting.overlay(sessions, NOW_SEC)[0]?.ask?.kind).toBe('approve')
    expect(await waiting.dismiss('claude', 'a1')).toBe(true)
    expect(waiting.overlay(sessions, NOW_SEC)[0]?.ask).toBeUndefined()
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).dismissed).toEqual({ 'claude:a1': '2026-09-25T09:59:00.000Z' })
    expect(readFileSync(stateFile, 'utf8')).not.toContain('手机端')
    // 重启(新的一份服务,读回账本):照样不算
    const again = createWaitingService({ sessions: () => sessions, files: () => refs, now: () => NOW, childrenOf: async () => [], stateFile })
    await again.scanNow()
    expect(again.overlay(sessions, NOW_SEC)[0]?.ask).toBeUndefined()
    // 那家说了新的一句:重新判
    writeFileSync(file, lines(said('a1', '要不要我顺手把手机端也改了?', '2026-09-25T09:59:00.000Z'), said('a1', '那桌面端呢,也一起改吗?', '2026-09-25T09:59:40.000Z')))
    utimesSync(file, new Date(NOW.getTime() - 10_000), new Date(NOW.getTime() - 10_000))
    await again.scanNow()
    expect(again.overlay(sessions, NOW_SEC)[0]?.ask).toBeDefined()
  })

  it('账本读坏了(2026-10-21):先把原本挪成 waiting.json.corrupt-<时间>,再从空账记,不拿空账盖原本', async () => {
    const dir = tempDir()
    const stateFile = join(dir, 'waiting.json')
    writeFileSync(stateFile, '{"day":{"date":"2026-09-25","spend_cny":0.4')
    const file = writeSession(dir, 'b1.jsonl', lines(said('b1', '要不要我顺手把手机端也改了?', '2026-09-25T09:59:00.000Z')))
    const sessions = [view({ session_id: 'b1' })]
    const refs = [{ agent: 'claude', session_id: 'b1', file, format: 'claude-transcript' as const }]
    const waiting = createWaitingService({ sessions: () => sessions, files: () => refs, now: () => NOW, childrenOf: async () => [], stateFile })
    await waiting.scanNow()
    expect(await waiting.dismiss('claude', 'b1')).toBe(true)
    const copies = readdirSync(dir).filter(name => name.startsWith('waiting.json.corrupt-'))
    expect(copies).toHaveLength(1)
    expect(readFileSync(join(dir, copies[0] as string), 'utf8')).toBe('{"day":{"date":"2026-09-25","spend_cny":0.4')
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).dismissed).toEqual({ 'claude:b1': '2026-09-25T09:59:00.000Z' })
  })

  it('弹窗那种点不掉(那家真停着)', async () => {
    // 卡 KM:`by:'form'` 要有证据 —— 这里就是记录里那条待批的 `ApprovalRequest`。
    const sessions = [view({ agent: 'kimi', session_id: 'k1', status: 'waiting', formal_wait: 'approval' })]
    const waiting = createWaitingService({ sessions: () => sessions, files: () => [], now: () => NOW })
    await waiting.scanNow()
    expect(await waiting.dismiss('kimi', 'k1')).toBe(false)
    expect(waiting.overlay(sessions, NOW_SEC)[0]?.ask).toBeDefined()
  })
})

/**
 * 读窗口读出来的那几家(2026-09-26,卡 WS)。维护者:「新加的是不是状态不全,只有完成的,
 * 但是没有弹过待确认还有执行中的气泡」。窗口型 Agent 没有会话文件,只有壳读回来的「最新那句」——
 * 过**同一份** `factsOf` / `decide`、同一个模型上限,出来的 `ask` 由登记表挂到那条窗口会话上。
 */
describe('窗口型 Agent 的「在等你」:同一份判断,不另起一套', () => {
  const windowRef = (over: Partial<WindowWaitRef> = {}): WindowWaitRef => ({
    agent: 'com.anysphere.sand',
    session_id: 'window:1a2b3c4d',
    latest: '两种改法:1. 只改插件 2. 连壳一起改。你选哪个?',
    at: '2026-09-26T07:56:00.000Z',
    status: 'done',
    answered: true,
    name: 'Grok Bot',
    ...over,
  })
  const NOW26 = new Date('2026-09-26T07:57:00.000Z')

  it('★最新那句是在问他 → 挂上那一问(带问题与选项);走的是文件型那同一份规则', async () => {
    const windows = [windowRef()]
    const waiting = createWaitingService({ sessions: () => [], files: () => [], windows: () => windows, now: () => NOW26 })
    await waiting.scanNow()
    const ask = waiting.askOf('com.anysphere.sand', 'window:1a2b3c4d')
    expect(ask).toMatchObject({ kind: 'choose', by: 'rules', since: '2026-09-26T07:56:00.000Z' })
    expect(ask?.question).toBe('你选哪个?')
    /**
     * **已知缺口**(钉在这里,交接里也写了):读窗口读回来的那句话是**拍平成一行**的
     * (`summarizeRead` 把换行收成空格),而选项那一套认的是「一行一个」——
     * 所以窗口这一路判得出「在等你选」,却列不出选项。文件型那一路照旧列得出(上面那几条钉着)。
     * 不为这个去猜断句:猜错了摆一排半截选项,比不摆更糟。
     */
    expect(ask?.options).toBeUndefined()
    // 「去哪儿答」不编:那一套认 /state.sessions 里的会话,窗口这一条不在那份表里。
    expect(ask?.reply).toBeUndefined()
  })

  it('★它正在跑 → 不算在等他(那句话是半截旁白)', async () => {
    const windows = [windowRef({ status: 'running' })]
    const waiting = createWaitingService({ sessions: () => [], files: () => [], windows: () => windows, now: () => NOW26 })
    await waiting.scanNow()
    expect(waiting.askOf('com.anysphere.sand', 'window:1a2b3c4d')).toBeUndefined()
  })

  it('★★他在那扇窗里回了话(latest 变了、answered 翻掉)→ 那一问自动撤', async () => {
    let current = windowRef()
    const waiting = createWaitingService({ sessions: () => [], files: () => [], windows: () => [current], now: () => NOW26 })
    await waiting.scanNow()
    expect(waiting.askOf('com.anysphere.sand', 'window:1a2b3c4d')).toBeDefined()
    // 他打了一句进去:那句话不是它刚说完的回话 → 一个字都不判。**还没扫就已经撤了**
    // (`askOf` 只对「已经判过的那一句」下结论 —— 不然那一问会挂到下一次扫,最多 10 秒)。
    current = windowRef({ latest: '就只改插件吧', at: '2026-09-26T07:56:40.000Z', answered: false })
    expect(waiting.askOf('com.anysphere.sand', 'window:1a2b3c4d')).toBeUndefined()
    await waiting.scanNow()
    expect(waiting.askOf('com.anysphere.sand', 'window:1a2b3c4d')).toBeUndefined()
    // 它又答了一句(还没扫到):照旧不拿上一句的结论顶替 —— 判过哪一句就只说哪一句。
    current = windowRef({ latest: '好,那我开始改插件那半。', at: '2026-09-26T07:57:10.000Z' })
    expect(waiting.askOf('com.anysphere.sand', 'window:1a2b3c4d')).toBeUndefined()
  })

  it('★最新那句是它刚说完的回话才判:第一次读到(answered 缺席)不判 —— 分不清是谁说的就不猜', async () => {
    const { answered: _dropped, ...first } = windowRef()
    const windows: WindowWaitRef[] = [first]
    const waiting = createWaitingService({ sessions: () => [], files: () => [], windows: () => windows, now: () => NOW26 })
    await waiting.scanNow()
    expect(waiting.askOf('com.anysphere.sand', 'window:1a2b3c4d')).toBeUndefined()
  })

  it('★汇报完就完了那一句 → 不算在等他', async () => {
    const windows = [windowRef({ latest: '改好了,两个文件都提交了。' })]
    const waiting = createWaitingService({ sessions: () => [], files: () => [], windows: () => windows, now: () => NOW26 })
    await waiting.scanNow()
    expect(waiting.askOf('com.anysphere.sand', 'window:1a2b3c4d')).toBeUndefined()
  })

  it('★★拿不准的才问模型;花费到了上限就不问、也不假装判出来了', async () => {
    const dir = tempDir()
    const ledger = join(dir, 'waiting.json')
    // 规则拿不准的一句(与 UNSURE 那条同一句:既不是明着在问、也不是纯汇报)。
    const windows = [windowRef({ latest: '这样行不行呢,我也拿不准。先按这个版本合了,测试全绿。' })]
    const model = fakeModel({ waiting: true, kind: 'approve', question: '这版能不能合', options: [], quote: '这样行不行呢' }, { ledgerFile: ledger, budget: 0 })
    const capped = createWaitingService({ sessions: () => [], files: () => [], windows: () => windows, now: () => NOW26, model: model.deps, stateFile: ledger })
    await capped.scanNow()
    await settle()
    expect(model.calls()).toBe(0)
    expect(capped.askOf('com.anysphere.sand', 'window:1a2b3c4d')).toBeUndefined()
    // 上限够了:问一次,判出来的那一问挂上去(同一份提示词、同一份缓存)。
    const ok = fakeModel({ waiting: true, kind: 'approve', question: '这版能不能合', options: [], quote: '这样行不行呢' }, { ledgerFile: ledger, budget: 0.5 })
    const service = createWaitingService({ sessions: () => [], files: () => [], windows: () => windows, now: () => NOW26, model: ok.deps, stateFile: join(dir, 'waiting2.json') })
    await service.scanNow()
    await settle()
    expect(ok.calls()).toBe(1)
    expect(service.askOf('com.anysphere.sand', 'window:1a2b3c4d')).toMatchObject({ kind: 'approve', by: 'model', question: '这版能不能合' })
  })

  it('★★那一问进「等你」那一堆:登记表里 via:window 那几条也数(与 state.sessions 不重不漏)', async () => {
    const windows = [windowRef()]
    const waiting = createWaitingService({ sessions: () => [], files: () => [], windows: () => windows, now: () => NOW26 })
    await waiting.scanNow()
    const ask = waiting.askOf('com.anysphere.sand', 'window:1a2b3c4d')
    const state: Pick<WorkbenchState, 'agent_registry'> = {
      agent_registry: {
        entries: [{
          id: 'com.anysphere.sand',
          bundle_id: 'com.anysphere.sand',
          name: 'Grok Bot',
          found: { how: 'activate', at: '2026-09-26T07:54:00.000Z', basis: '模型判成 Agent' },
          sources: [{ kind: 'window', label: '读它的窗口', ok: true }],
          status: 'idle',
          gaps: {},
          sessions: [{
            agent: 'com.anysphere.sand', session_id: 'window:1a2b3c4d', project: 'Grok Bot', status: 'done',
            unread: true, elapsed_sec: 60, updated_at: '2026-09-26T07:56:00.000Z', via: 'window',
            ...(ask === undefined ? {} : { ask }),
          }],
          counts: { running: 0, waiting: 0, unread: 1 },
        }],
        asking: [],
        notices: [],
      },
    }
    const pile = waitingOnHim(state)
    expect(pile.count).toBe(1)
    expect(pile.items[0]).toMatchObject({ key: 'session:com.anysphere.sand/window:1a2b3c4d', kind: 'session', verb: '答' })
    // ★名字从登记表来:不许把 `com.anysphere.sand` 这种包标识摆到他眼前。
    expect(pile.items[0]?.text).toContain('Grok Bot 在等你选')
    expect(pile.items[0]?.text).not.toContain('com.anysphere.sand')
    // 登记表里文件型那几家的会话是 state.sessions 的副本(via:'sessions'),不许数两遍。
    const both = waitingOnHim({
      sessions: [view({ session_id: 'a1', ask: { kind: 'choose', question: '选哪个', since: NOW.toISOString(), by: 'rules' } })],
      agent_registry: {
        entries: [{
          id: 'claude', name: 'Claude', found: { how: 'sessions', at: '', basis: '' }, sources: [], status: 'idle', gaps: {},
          sessions: [{
            agent: 'claude', session_id: 'a1', project: 'p', status: 'done', unread: false, elapsed_sec: 60,
            updated_at: NOW.toISOString(), via: 'sessions', ask: { kind: 'choose', question: '选哪个', since: NOW.toISOString(), by: 'rules' },
          }],
          counts: { running: 0, waiting: 0, unread: 0 },
        }],
        asking: [],
        notices: [],
      },
    })
    expect(both.count).toBe(1)
  })
})
