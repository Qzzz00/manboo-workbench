// @vitest-environment node
/**
 * ★ **卡 D(2026-10-20):捎话 / 替她答不再按「从哪开的」先拒,改问引擎哪只手够得着**。
 *
 * 依据两张探针(都已入 main):
 * - `docs/交接-1019-claude捎话探针.md`:终端里开的 Claude 会话(`entrypoint:'cli'`)登记表里一样有
 *   `messagingSocketPath`,写一行 340 / 875 ms 落记录、5.4 / 12.1 s 回话;
 * - `docs/交接-1019-codex续线程探针.md`:`codex exec` 起的线程与 App 线程同一份 rollout、同一把写锁,
 *   App 没打开这条时 `thread/resume` 960 ms 续上;App 打开了这条才撞锁(照既有 `CODEX_THREAD_TAKEN_WHY` 换路)。
 *
 * 守五件事:
 * ① 终端 / VS Code 里开的 Claude 会话:有 socket 就进引擎、能捎能答;「去回答」不摆(调不到那个终端);
 * ② **这类会话只许走协议那只手**:socket 没了也**一个窗口 op 都不发**(窗口那只手开的是桌面 App,
 *    卡 AW「认不出那段对话也照发」会把她的话打进别的对话);
 * ③ Codex `exec` 线程:进引擎走 `thread/resume` + `turn/start`,带深链,「去回答」照旧摆;
 * ④ App 握着那条线程(撞写锁):照旧换窗口那只手;窗口也不通时说的那一句与从前一字不差;
 * ⑤ 壳没连上、也没有协议手:照旧 deskWhy。
 */
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionView } from '../src/protocol.ts'
import type { ClaudeAdapterDeps } from '../src/server/engine/adapters/claude.ts'
import type { CodexAdapterDeps } from '../src/server/engine/adapters/codex.ts'
import type { CodexStdioPeer } from '../src/server/engine/adapters/codexAppServerClient.ts'
import { codexAppServerLink } from '../src/server/engine/adapters/codexAppServerClient.ts'
import { answerPlanOf } from '../src/server/sessionAnswer.ts'
import { createSessionJobs, type SessionJobsDeps } from '../src/server/sessionJobs.ts'
import { sessionAgentName } from '../src/waiting.ts'
import { engineHarness, type EngineHarnessOptions } from './helpers/engineHarness.ts'

const NOW = '2026-10-20T10:00:00.000Z'
const CLAUDE_SID = '37724f2f-1019-4c0e-9a11-terminal00001'
const CODEX_SID = '01a152ba-48a1-7832-9514-c1acf084f9f5'
/** 会改那家对话 / 开窗 / 点键的那几种壳 op(只读的探测不算)。 */
const ACTING_OPS = new Set(['send_text', 'agent_press', 'agent_write_ask', 'agent_stop', 'agent_pick', 'open_url', 'bring_front', 'new_conversation'])

const view = (patch: Partial<SessionView> & Pick<SessionView, 'agent' | 'session_id'>): SessionView => ({
  project: 'desktop-workbench', status: 'done', elapsed_sec: 600, unread: false, updated_at: NOW, ...patch,
})
const asking = (agent: SessionView['agent'], id: string): SessionView => view({
  agent, session_id: id, status: 'waiting', title: '把导出 PDF 做出来',
  ask: { kind: 'choose', question: '先做哪一版', options: [{ label: '先做 A' }], since: NOW, quote: '你选哪一版?回个字母就行。', by: 'rules' },
})

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/**
 * 一条开着的 Claude 会话(登记表里有它、socket「在」)。写一行 = 往它的记录文件里追加一条
 * `isMeta` + `origin.kind:'peer'` 的 user 行 —— 与探针在真机上看到的落法一样。
 */
function claudeSocket(input: { live: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-card-d-claude-'))
  dirs.push(dir)
  const file = join(dir, `${CLAUDE_SID}.jsonl`)
  writeFileSync(file, `${JSON.stringify({ type: 'user', sessionId: CLAUDE_SID, entrypoint: 'cli', timestamp: NOW, origin: { kind: 'human' }, message: { role: 'user', content: '先把导出 PDF 做出来' } })}\n`)
  const written: string[] = []
  const deps: ClaudeAdapterDeps = {
    claudeHome: dir,
    sockets: async () => (input.live ? [{ sessionId: CLAUDE_SID, pid: 4242, socket: join(dir, '4242.sock') }] : []),
    socketReady: async () => input.live,
    writeLine: async (_path, line) => {
      written.push(line)
      const content = (JSON.parse(line) as { message: { content: string } }).message.content
      appendFileSync(file, `${JSON.stringify({ type: 'user', isMeta: true, origin: { kind: 'peer' }, timestamp: NOW, message: { role: 'user', content } })}\n`)
    },
    locate: async () => ({ agent: 'claude', session_id: CLAUDE_SID, file, format: 'claude-transcript' }),
    confirmMs: 0,
    confirmStepMs: 1,
    sleep: () => Promise.resolve(),
  }
  return { deps, written }
}

/** 假的 `codex app-server`:`thread/resume` 照 `resume` 回(通 / 撞写锁),`turn/start` 回一轮并报「开跑了」。 */
function codexPeer(resume: 'ok' | 'taken') {
  const methods: { method: string, params?: Record<string, unknown> }[] = []
  let onData: ((chunk: string) => void) | undefined
  const emit = (one: unknown): void => { onData?.(`${JSON.stringify(one)}\n`) }
  const peer: CodexStdioPeer = {
    send: (line) => {
      const one = JSON.parse(line) as { id?: unknown, method?: string, params?: Record<string, unknown> }
      if (one.method === undefined || one.id === undefined) return
      methods.push({ method: one.method, ...(one.params === undefined ? {} : { params: one.params }) })
      if (one.method === 'initialize') { emit({ jsonrpc: '2.0', id: one.id, result: { userAgent: 'test' } }); return }
      if (one.method === 'thread/resume') {
        if (resume === 'taken') {
          emit({ jsonrpc: '2.0', id: one.id, error: { code: -32600, message: `thread ${CODEX_SID} already has an active writer` } })
          return
        }
        emit({ jsonrpc: '2.0', id: one.id, result: { thread: { id: CODEX_SID, turns: [] } } })
        return
      }
      if (one.method === 'turn/start') {
        emit({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: CODEX_SID, turn: { id: 'turn-1' } } })
        emit({ jsonrpc: '2.0', id: one.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } })
        return
      }
      emit({ jsonrpc: '2.0', id: one.id, result: {} })
    },
    onData: (listen) => { onData = listen },
    onGone: () => {},
    kill: () => {},
  }
  const link = codexAppServerLink({ clientName: 'test', spawnPeer: () => peer })
  const deps: CodexAdapterDeps = { link, binary: () => '/usr/local/bin/codex', workdir: () => ({ writes: false }), warn: () => {} }
  return { deps, link, methods: () => methods.map(one => one.method) }
}

async function rig(input: {
  sessions: readonly SessionView[]
  service?: Omit<SessionJobsDeps, 'engine' | 'registry' | 'sessions'>
  engine?: EngineHarnessOptions
}) {
  const h = engineHarness({
    nameOf: sessionAgentName,
    now: () => new Date(NOW),
    installed: family => (family === 'codex'
      ? [{ bundle_id: 'com.openai.codex', name: 'Codex', running: true }]
      : [{ bundle_id: 'com.anthropic.claudefordesktop', name: 'Claude', running: true }]),
    ...input.engine,
  })
  const service = createSessionJobs({
    engine: h.engine,
    registry: h.registry,
    sessions: () => input.sessions,
    agentName: sessionAgentName,
    ...input.service,
  })
  await h.registry.targets()
  const acted = (): readonly string[] => h.requests.map(one => one.op).filter(op => ACTING_OPS.has(op))
  return { ...h, service, acted }
}

describe('判路(纯函数):entry 只定「去回答」能不能调到前面、有没有深链', () => {
  const both = { window: true }
  const none = { window: false }

  it('★终端 / VS Code 里开的 Claude:送得进话时走同一条路,不摆「去回答」,只许协议那只手', () => {
    expect(answerPlanOf('claude', 'd1', 'cli', both)).toEqual({ route: 'window', revealable: false, vias: ['protocol'] })
    expect(answerPlanOf('claude', 'd1', 'claude-vscode', both)).toEqual({ route: 'window', revealable: false, vias: ['protocol'] })
    // 有 hostId 也不给深链(那个深链开的是桌面 App,开不到终端里那一条)
    expect(answerPlanOf('claude', 'd1', 'cli', both, 'local_1')).not.toHaveProperty('deepLink')
  })

  it('送不进话时:那句人话照旧(终端 / VS Code 的说法一字没改)', () => {
    expect(answerPlanOf('claude', 'd1', 'cli', none)).toEqual({ route: 'desk', why: '这一问得在电脑上开着 Claude 的那个终端窗口里回答', revealable: false, vias: ['protocol'] })
    expect(answerPlanOf('claude', 'd1', 'claude-vscode', none, undefined, 'relay')).toMatchObject({ route: 'desk', why: '这句话得你到电脑上 VS Code 里的 Claude 里自己说', revealable: false })
  })

  it('★Codex exec 线程:按桌面 App 线程办(送得进 → window + 深链;送不进 → 去电脑上的 Codex + 深链)', () => {
    expect(answerPlanOf('codex', 'c-2', 'exec', both)).toEqual({ route: 'window', bundleId: 'com.openai.codex', deepLink: 'codex://threads/c-2', revealable: true })
    expect(answerPlanOf('codex', 'c-2', 'exec', none)).toEqual({ route: 'desk', why: '这一问得在电脑上的 Codex 里回答', deepLink: 'codex://threads/c-2', revealable: true })
  })

  it('Codex 终端里开的:同 Claude 终端那一类(只许协议那只手,不摆「去回答」)', () => {
    expect(answerPlanOf('codex', 'c-3', 'cli', both)).toEqual({ route: 'window', revealable: false, vias: ['protocol'] })
    expect(answerPlanOf('codex', 'c-3', 'cli', none)).toEqual({ route: 'desk', why: '这一问得在电脑上开着 Codex 的那个终端窗口里回答', revealable: false, vias: ['protocol'] })
  })
})

describe('Claude 终端 / VS Code 里开的会话', () => {
  it('★终端 cli 会话有 socket → 进引擎、捎得进(走协议、记录里核上了);一个窗口 op 都没发', async () => {
    const socket = claudeSocket({ live: true })
    const session = view({ agent: 'claude', session_id: CLAUDE_SID, title: '导出 PDF' })
    const t = await rig({ sessions: [session], service: { entryOf: () => 'cli' }, engine: { claude: socket.deps } })
    expect(t.service.relayReady('claude', CLAUDE_SID)).toMatchObject({ can: true })
    const sent = await t.service.relay('claude', CLAUDE_SID, '现在到哪了')
    expect(sent).toMatchObject({ ok: true, route: 'window' })
    expect(socket.written).toHaveLength(1)
    expect(socket.written[0]).toContain('现在到哪了')
    expect(t.acted()).toEqual([])
  })

  it('★claude-vscode 会话 → 进引擎、能捎;「去回答」不摆(revealable=false)', async () => {
    const socket = claudeSocket({ live: true })
    const ask = asking('claude', CLAUDE_SID)
    const t = await rig({ sessions: [ask], service: { entryOf: () => 'claude-vscode' }, engine: { claude: socket.deps } })
    // 界面那一格:摆输入框、不摆「去回答」
    expect(t.service.replyOf(ask, ask.ask)).toEqual({ reply: 'window' })
    // 替她答:同一处判据,一起生效
    expect(await t.service.answer('claude', CLAUDE_SID, 'A')).toMatchObject({ ok: true, confirmed: true })
    expect(socket.written).toHaveLength(1)
    expect(t.acted()).toEqual([])
  })

  it('★socket 不在了(它没开着)→ 照旧那句 deskWhy;**窗口那只手不接**(不去桌面 App 里打字)', async () => {
    const socket = claudeSocket({ live: false })
    const session = view({ agent: 'claude', session_id: CLAUDE_SID, title: '导出 PDF' })
    const t = await rig({ sessions: [session], service: { entryOf: () => 'cli' }, engine: { claude: socket.deps } })
    const ready = t.service.relayReady('claude', CLAUDE_SID)
    expect(ready).toMatchObject({ can: false, why: '这句话得你到电脑上开着 Claude 的那个终端窗口里自己说' })
    const sent = await t.service.relay('claude', CLAUDE_SID, '现在到哪了')
    expect(sent).toMatchObject({ ok: false, status: 200, where: 'desk', why: '这句话得你到电脑上开着 Claude 的那个终端窗口里自己说', reveal: false })
    expect(socket.written).toEqual([])
    expect(t.acted()).toEqual([])
  })

  it('★整家有别的会话在册、这一条不在册:捎话 / 替她答动过手又失败,也不摆「去回答」(调不到那个终端)', async () => {
    const socket = claudeSocket({ live: true })
    // 整家的 send = true(有一条在册),所以界面摆了输入框;送这一条时协议那只手找不到它的 socket。
    const deps: ClaudeAdapterDeps = { ...socket.deps, sockets: async () => [{ sessionId: 'another-claude-session-0001', pid: 4343, socket: join(tmpdir(), '4343.sock') }] }
    const ask = asking('claude', CLAUDE_SID)
    const t = await rig({ sessions: [ask], service: { entryOf: () => 'cli' }, engine: { claude: deps } })
    expect(await t.service.relay('claude', CLAUDE_SID, '现在到哪了')).toMatchObject({ ok: false, status: 200, where: 'desk', reveal: false })
    expect(await t.service.answer('claude', CLAUDE_SID, 'A')).toMatchObject({ ok: false, status: 200, where: 'desk', reveal: false })
    expect(socket.written).toEqual([])
    expect(t.acted()).toEqual([])
  })

  it('★按了发送、记录里没核上(unconfirmed):终端会话同样不摆「去回答」', async () => {
    const socket = claudeSocket({ live: true })
    // 字节写进了 socket,记录文件里却没落那一行。
    const deps: ClaudeAdapterDeps = { ...socket.deps, writeLine: async () => {} }
    const t = await rig({ sessions: [view({ agent: 'claude', session_id: CLAUDE_SID })], service: { entryOf: () => 'cli' }, engine: { claude: deps } })
    expect(await t.service.relay('claude', CLAUDE_SID, '现在到哪了')).toMatchObject({ ok: false, status: 200, unconfirmed: true, reveal: false })
    expect(t.acted()).toEqual([])
  })

  it('终端会话那一问要点它框上的键:协议点不了 → 到电脑上点;窗口那只手照样不接', async () => {
    const socket = claudeSocket({ live: true })
    const ask = asking('claude', CLAUDE_SID)
    const t = await rig({ sessions: [ask], service: { entryOf: () => 'cli' }, engine: { claude: socket.deps } })
    // 界面上不摆那颗「替她点」的键(协议那只手不会点)
    expect(t.service.replyOf(ask, ask.ask)).not.toHaveProperty('press')
    const pressed = await t.service.press('claude', CLAUDE_SID, '先做 A')
    expect(pressed).toMatchObject({ ok: false, status: 200, where: 'desk', reveal: false })
    expect(t.acted()).toEqual([])
  })

  it('「去回答」:终端里那一条调不到前面,也不去开桌面 App', async () => {
    const socket = claudeSocket({ live: true })
    const session = view({ agent: 'claude', session_id: CLAUDE_SID })
    const t = await rig({ sessions: [session], service: { entryOf: () => 'cli' }, engine: { claude: socket.deps } })
    expect(await t.service.reveal('claude', CLAUDE_SID)).toMatchObject({ ok: false })
    expect(t.acted()).toEqual([])
  })
})

describe('Codex exec 起的线程', () => {
  it('★App 没握着 → 进引擎走 thread/resume + turn/start;「去回答」照旧摆(有深链)', async () => {
    const codex = codexPeer('ok')
    const ask = asking('codex', CODEX_SID)
    const t = await rig({ sessions: [ask], service: { entryOf: () => 'exec' }, engine: { codex: codex.deps } })
    expect(t.service.replyOf(ask, ask.ask)).toMatchObject({ reply: 'window', reveal: true })
    expect(t.service.relayReady('codex', CODEX_SID)).toMatchObject({ can: true })
    const sent = await t.service.relay('codex', CODEX_SID, '再补一句:先别动那个文件')
    expect(sent).toMatchObject({ ok: true, route: 'window', turn_id: 'turn-1' })
    expect(codex.methods()).toContain('thread/resume')
    expect(codex.methods()).toContain('turn/start')
    expect(t.acted()).toEqual([])
    codex.link.close()
  })

  it('★App 握着那条线程(撞写锁)→ 照既有规矩换窗口那只手(深链开到那一段)', async () => {
    const codex = codexPeer('taken')
    const opened: string[] = []
    const t = await rig({
      sessions: [view({ agent: 'codex', session_id: CODEX_SID, title: '导出 PDF' })],
      service: { entryOf: () => 'exec' },
      engine: {
        codex: codex.deps,
        openUrl: async (url) => { opened.push(url); return { ok: true } },
        reply: (req) => (req.op === 'send_text' ? { submitted: true, method: 'ax' } : req.op === 'read_reply' ? { found: true, busy: false, texts: [] } : {}),
      },
    })
    const sent = await t.service.relay('codex', CODEX_SID, '再补一句:先别动那个文件')
    expect(sent.ok || (sent.status === 200 && sent.unconfirmed === true)).toBe(true)
    expect(codex.methods()).toContain('thread/resume')
    expect(codex.methods()).not.toContain('turn/start')
    expect(t.sentTo()).toEqual(['com.openai.codex'])
    expect(opened).toContain(`codex://threads/${CODEX_SID}`)
    codex.link.close()
  })

  it('App 握着、壳也没连上 → 那句话与从前一字不差(去电脑上的 Codex 里说,「去回答」摆着)', async () => {
    const codex = codexPeer('taken')
    const t = await rig({
      sessions: [view({ agent: 'codex', session_id: CODEX_SID })],
      service: { entryOf: () => 'exec' },
      engine: { codex: codex.deps, connected: () => false },
    })
    const sent = await t.service.relay('codex', CODEX_SID, '到哪了')
    expect(sent).toMatchObject({ ok: false, status: 200, where: 'desk', why: '这句话得你到电脑上的 Codex 里自己说', reveal: true })
    expect(t.acted()).toEqual([])
    codex.link.close()
  })
})

describe('壳没连上、也没有协议手', () => {
  it('★照旧 deskWhy:Claude 终端、Codex exec 两条都是从前那一句', async () => {
    const claude = view({ agent: 'claude', session_id: CLAUDE_SID })
    const codex = view({ agent: 'codex', session_id: CODEX_SID })
    const t = await rig({
      sessions: [claude, codex],
      service: { entryOf: agent => (agent === 'codex' ? 'exec' : 'cli') },
      engine: { connected: () => false },
    })
    expect(t.service.relayReady('claude', CLAUDE_SID)).toEqual({ can: false, why: '这句话得你到电脑上开着 Claude 的那个终端窗口里自己说', reveal: false })
    expect(await t.service.relay('claude', CLAUDE_SID, '到哪了')).toMatchObject({ ok: false, status: 200, why: '这句话得你到电脑上开着 Claude 的那个终端窗口里自己说', reveal: false })
    expect(t.service.relayReady('codex', CODEX_SID)).toEqual({ can: false, why: '这句话得你到电脑上的 Codex 里自己说', reveal: true })
    expect(await t.service.relay('codex', CODEX_SID, '到哪了')).toMatchObject({ ok: false, status: 200, why: '这句话得你到电脑上的 Codex 里自己说', reveal: true })
    expect(t.acted()).toEqual([])
  })
})
