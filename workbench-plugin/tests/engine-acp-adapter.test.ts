/**
 * ACP 客户端适配器(2026-10-19,实验卡「ACP 客户端替 app-server 直连」;契约见 `src/server/engine/adapter.ts`,
 * 经过与结论见 `docs/交接-1019-ACP客户端实验.md`)。
 *
 * ★ 实验件:适配器**没登记进引擎**,抽屉真路 / `/asks/answer` 没碰;这里的 `asks()` 断言就是「那一问该长成什么形状」的桩。
 *
 * 假 ACP 代理(stdio JSON-RPC)**回放 codex-acp 2.2.2 的那几串**:
 * `initialize` → `session/new` → `session/set_mode` → `session/prompt` → `session/update{agent_message_chunk}` → 回包 `{stopReason}`;
 * 中途它会反过来问我们 `session/request_permission`(选项照 codex-acp 的 `commandDecisionOptions`),等我们答了才接着跑。
 * 一个真进程都不起、一个凭据都不读。真机那条在 `scripts/probe-acp-compare.ts`(手动跑)。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Job } from '../src/server/engine/adapter.ts'
import { RetryableError } from '../src/server/engine/adapter.ts'
import type { CodexStdioPeer } from '../src/server/engine/adapters/codexAppServerClient.ts'
import {
  ACP_METHODS,
  ACP_PROTOCOL_VERSION,
  CODEX_ACP_MODES,
  acpAgentLink,
} from '../src/server/engine/adapters/acpClient.ts'
import {
  ACP_OPTION_LABELS,
  ACP_RULE,
  acpCodexAdapter,
  acpQuestionOf,
  acpReplyOf,
} from '../src/server/engine/adapters/acp.ts'
import type { WorkbenchEvent } from '../src/protocol.ts'

interface Sent { id?: unknown, method?: string, params?: Record<string, unknown>, result?: unknown, error?: unknown }

/** codex-acp 对「跑一条命令」给的那四项(`commandDecisionOptions`,2.2.2 原字)。 */
const COMMAND_OPTIONS = [
  { optionId: 'allow_once', name: 'Yes, proceed', kind: 'allow_once' },
  { optionId: 'allow_for_session', name: "Yes, and don't ask again for this command in this session", kind: 'allow_always' },
  { optionId: 'decline', name: 'No, continue without running it', kind: 'reject_once' },
  { optionId: 'cancel', name: 'No, and tell Codex what to do differently', kind: 'reject_once' },
]

/**
 * 假代理 + 一个「它会怎么回」的脚本。
 * `answer(method, fn)` 说清某个方法的回包;没写的方法回 `{}`。
 * 它自己也能反过来问我们(`ask`):发一条带 id 的请求,等我们回。
 */
function scriptedAgent() {
  const sent: Sent[] = []
  let onData: ((chunk: string) => void) | undefined
  let onGone: ((why: string) => void) | undefined
  let killed = false
  const answers = new Map<string, (params: Record<string, unknown>, id: unknown) => void>()
  /** 我们对它那几问的答复(按它的请求 id)。 */
  const replies = new Map<string, (message: Sent) => void>()
  let nextAskId = 1000

  const emit = (message: unknown): void => { onData?.(`${JSON.stringify(message)}\n`) }
  const reply = (id: unknown, result: unknown): void => { emit({ jsonrpc: '2.0', id, result }) }
  const refuse = (id: unknown, message: string, code = -32602): void => { emit({ jsonrpc: '2.0', id, error: { code, message } }) }
  const notify = (method: string, params: unknown): void => { emit({ jsonrpc: '2.0', method, params }) }

  const peer: CodexStdioPeer = {
    send: (line) => {
      if (killed) throw new Error('已经杀掉了')
      const message = JSON.parse(line) as Sent
      sent.push(message)
      // 我们答它那一问(有 id、没有 method)。
      if (message.method === undefined && message.id !== undefined) {
        replies.get(String(message.id))?.(message)
        replies.delete(String(message.id))
        return
      }
      if (message.method === undefined || message.id === undefined) return
      const scripted = answers.get(message.method)
      if (scripted !== undefined) { scripted(message.params ?? {}, message.id); return }
      if (message.method === ACP_METHODS.initialize) {
        reply(message.id, { protocolVersion: ACP_PROTOCOL_VERSION, agentCapabilities: { loadSession: true }, authMethods: [{ id: 'chat-gpt', name: 'ChatGPT' }] })
        return
      }
      if (message.method === ACP_METHODS.newSession) { reply(message.id, { sessionId: 'S1', modes: { currentModeId: 'agent', availableModes: [] } }); return }
      reply(message.id, {})
    },
    onData: (listen) => { onData = listen },
    onGone: (listen) => { onGone = listen },
    kill: () => { killed = true },
  }

  return {
    peer,
    sent,
    killed: () => killed,
    emit,
    reply,
    refuse,
    notify,
    die: (why = '提前退出') => onGone?.(why),
    answer: (method: string, fn: (params: Record<string, unknown>, id: unknown) => void) => { answers.set(method, fn) },
    /** 它反过来问我们一句,回一个「我们答了什么」的 Promise。 */
    ask: (method: string, params: unknown): Promise<Sent> => {
      const id = nextAskId++
      return new Promise<Sent>((resolve) => {
        replies.set(String(id), resolve)
        emit({ jsonrpc: '2.0', id, method, params })
      })
    },
    paramsOf: (method: string) => sent.find(m => m.method === method)?.params,
    allParamsOf: (method: string) => sent.filter(m => m.method === method).map(m => m.params),
    methods: () => sent.filter(m => m.method !== undefined).map(m => m.method),
    /** 流几段回话 + 收尾。 */
    say: (sessionId: string, chunks: readonly string[]) => {
      for (const text of chunks) notify(ACP_METHODS.update, { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } })
    },
  }
}

function job(over: Partial<Job> = {}): Job {
  return {
    id: 'J1',
    family: 'codex',
    kind: 'dispatch',
    target: { kind: 'new' },
    text: '在这个目录新建 hello.txt 写一句话',
    expect: 'reply',
    itemId: 't-1',
    cwd: '/Users/example/tmp/acp-x',
    ...over,
  }
}

function rig(options: {
  agent: ReturnType<typeof scriptedAgent>
  writes?: boolean
  cwd?: string
  binary?: () => string | undefined
  spawnFails?: string
  ackMs?: number
  turnMs?: number
} = { agent: scriptedAgent() }) {
  const events: WorkbenchEvent[] = []
  const changes: number[] = []
  const link = acpAgentLink({
    clientName: 'test',
    spawnPeer: () => {
      if (options.spawnFails !== undefined) throw new Error(options.spawnFails)
      return options.agent.peer
    },
  })
  const adapter = acpCodexAdapter({
    link,
    binary: options.binary ?? (() => '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'),
    workdir: () => ({ writes: options.writes ?? false, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) }),
    title: () => '新建 hello.txt',
    events: event => { events.push(event) },
    onChange: () => { changes.push(Date.now()) },
    warn: () => {},
    timeouts: { ack: options.ackMs ?? 50, turn: options.turnMs ?? 2_000 },
  })
  return { adapter, link, events, changes }
}

/** 等到 `test()` 成立(假代理的事件都是异步到的)。 */
async function until(test: () => boolean, ms = 1500): Promise<void> {
  const since = Date.now()
  while (!test()) {
    if (Date.now() - since > ms) throw new Error('等不到')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('capabilities:现查,不写死', () => {
  it('二进制在、握手得上 → 开 / 发 / 读 / 点 / 停 / 开到某一段都能;权限弹框与提问面板不能(那两样是窗口的)', async () => {
    const agent = scriptedAgent()
    const { adapter, link } = rig({ agent })
    expect(await adapter.capabilities()).toEqual({
      open: true, send: true, read: true, press: true, approve: false, writeAsk: false, stop: true, openSession: true,
    })
    expect(adapter.family).toBe('codex')
    expect(adapter.via).toBe('protocol')
    // 握手:ACP 的 initialize 带协议版本与「我们不做文件 / 终端」。
    expect(agent.paramsOf(ACP_METHODS.initialize)).toMatchObject({
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    link.close()
  })

  it('这台机器上找不到 codex → 一样都不能,**不去起进程**', async () => {
    const agent = scriptedAgent()
    const { adapter, link } = rig({ agent, binary: () => undefined })
    expect(Object.values(await adapter.capabilities()).some(Boolean)).toBe(false)
    expect(agent.sent).toEqual([])
    link.close()
  })

  it('代理起不来(npx 没装上 / 崩了)→ 一样都不能;送话时抛可重试的错,人话里说清是 codex-acp 没起来', async () => {
    const agent = scriptedAgent()
    const { adapter, link } = rig({ agent, spawnFails: 'spawn npx ENOENT' })
    expect(Object.values(await adapter.capabilities()).some(Boolean)).toBe(false)
    await expect(adapter.run(job())).rejects.toBeInstanceOf(RetryableError)
    await expect(adapter.run(job())).rejects.toThrow(/codex-acp 这一下没起来/)
    link.close()
  })
})

describe('派活:新开一条 → 回话', () => {
  it('★session/new 带卡上的目录;许改文件就 set_mode workspace-write;prompt 送的是交代原话;回话 = 几段拼起来', async () => {
    const agent = scriptedAgent()
    agent.answer(ACP_METHODS.prompt, (params, id) => {
      const sessionId = params.sessionId as string
      agent.say(sessionId, ['已经', '写好了 hello.txt'])
      agent.reply(id, { stopReason: 'end_turn' })
    })
    const { adapter, link, events } = rig({ agent, writes: true, cwd: '/Users/example/tmp/acp-x' })
    const out = await adapter.run(job())
    expect(out).toMatchObject({ delivered: 'confirmed', via: 'protocol', evidence: 'receipt', sessionId: 'S1', reply: '已经写好了 hello.txt' })
    expect(out.turnId).toMatch(/\S/)
    expect(agent.methods()).toEqual([ACP_METHODS.initialize, ACP_METHODS.newSession, ACP_METHODS.setMode, ACP_METHODS.prompt])
    expect(agent.paramsOf(ACP_METHODS.newSession)).toMatchObject({ cwd: '/Users/example/tmp/acp-x', mcpServers: [] })
    expect(agent.paramsOf(ACP_METHODS.setMode)).toEqual({ sessionId: 'S1', modeId: CODEX_ACP_MODES.writes })
    expect(agent.paramsOf(ACP_METHODS.prompt)).toEqual({ sessionId: 'S1', prompt: [{ type: 'text', text: '在这个目录新建 hello.txt 写一句话' }] })
    // 会话表上这条跟着走:在跑 → 做完(摘要就是它的回话开头)。
    expect(events.map(one => one.type)).toEqual(['running', 'done'])
    expect(events[0]).toMatchObject({ agent: 'codex', session_id: 'S1', title: '新建 hello.txt' })
    link.close()
  })

  it('★回话只认最后那一段(messageId 变了就是新一段;真机:过场话与收尾句一起流回来)', async () => {
    const agent = scriptedAgent()
    agent.answer(ACP_METHODS.prompt, (params, id) => {
      const sessionId = params.sessionId as string
      const chunk = (messageId: string, text: string) => agent.notify(ACP_METHODS.update, { sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } } })
      chunk('m1', '我会先看一眼目录')
      chunk('m1', ',再新建文件。')
      chunk('m2', '已经写好了')
      chunk('m2', ' hello.txt')
      agent.reply(id, { stopReason: 'end_turn' })
    })
    const { adapter, link } = rig({ agent })
    const out = await adapter.run(job())
    expect(out.reply).toBe('已经写好了 hello.txt')
    expect(acpReplyOf([])).toBeUndefined()
    expect(acpReplyOf([{ id: 'a', text: '过场' }, { id: 'b', text: '  ' }])).toBeUndefined()
    link.close()
  })

  it('不许改文件 → set_mode read-only;**danger-full-access 不出现在这条路上**', async () => {
    const agent = scriptedAgent()
    agent.answer(ACP_METHODS.prompt, (_params, id) => { agent.reply(id, { stopReason: 'end_turn' }) })
    const { adapter, link } = rig({ agent, writes: false })
    await adapter.run(job())
    expect(agent.paramsOf(ACP_METHODS.setMode)).toEqual({ sessionId: 'S1', modeId: CODEX_ACP_MODES.readOnly })
    expect(JSON.stringify(agent.sent)).not.toContain('full-access')
    expect(Object.values(CODEX_ACP_MODES)).not.toContain('agent-full-access')
    link.close()
  })

  it('set_mode 被拒 → **不发 prompt**(权限档钉不上就不跑),如实 not_sent', async () => {
    const agent = scriptedAgent()
    agent.answer(ACP_METHODS.setMode, (_params, id) => { agent.refuse(id, 'mode not available') })
    const { adapter, link } = rig({ agent, writes: false })
    const out = await adapter.run(job())
    expect(out.delivered).toBe('not_sent')
    expect(out.why).toContain('mode not available')
    expect(agent.methods()).not.toContain(ACP_METHODS.prompt)
    link.close()
  })

  it('它说没登录(-32000)→ not_sent,人话里说去 ChatGPT 桌面版登一次', async () => {
    const agent = scriptedAgent()
    agent.answer(ACP_METHODS.newSession, (_params, id) => { agent.refuse(id, 'Authentication required', -32000) })
    const { adapter, link } = rig({ agent })
    const out = await adapter.run(job())
    expect(out.delivered).toBe('not_sent')
    expect(out.why).toContain('还没登录')
    link.close()
  })

  it('它收尾不是 end_turn(refusal)→ 送到了、带一句为什么,回话有就带', async () => {
    const agent = scriptedAgent()
    agent.answer(ACP_METHODS.prompt, (params, id) => {
      agent.say(params.sessionId as string, ['这我做不了'])
      agent.reply(id, { stopReason: 'refusal' })
    })
    const { adapter, link } = rig({ agent })
    const out = await adapter.run(job())
    expect(out).toMatchObject({ delivered: 'confirmed', reply: '这我做不了' })
    expect(out.why).toContain('refusal')
    link.close()
  })

  it('等到点它还没说完 → 送到了 + 「还在做」,**不编一个回答**;read 这时回 busy', async () => {
    const agent = scriptedAgent()
    agent.answer(ACP_METHODS.prompt, (params) => { agent.say(params.sessionId as string, ['先看看']) })
    const { adapter, link } = rig({ agent, turnMs: 60 })
    const out = await adapter.run(job())
    expect(out).toMatchObject({ delivered: 'confirmed', sessionId: 'S1' })
    expect(out.reply).toBeUndefined()
    expect(out.why).toContain('还在做')
    const read = await adapter.read!(job({ kind: 'dispatch', target: { kind: 'session', sessionId: 'S1' }, turnId: out.turnId as string }))
    expect(read).toMatchObject({ via: 'protocol', busy: true })
    expect(read.reply).toBeUndefined()
    link.close()
  })

  it('代理中途断了 → 送到了 + 「连接断了」那一句;下一次用自己重起一条', async () => {
    const agent = scriptedAgent()
    agent.answer(ACP_METHODS.prompt, (params) => {
      agent.say(params.sessionId as string, ['开始'])
      setTimeout(() => agent.die('进程没了'), 10)
    })
    const { adapter, link } = rig({ agent })
    const out = await adapter.run(job())
    expect(out.delivered).toBe('confirmed')
    expect(out.why).toContain('连接断了')
    link.close()
  })
})

describe('它在问她:权限请求进抽屉,答完接着跑', () => {
  async function askingRig(options: { toolTitle?: string, kind?: string, rawInput?: unknown } = {}) {
    const agent = scriptedAgent()
    let decided: Promise<Sent> | undefined
    let finish: ((stop: string) => void) | undefined
    agent.answer(ACP_METHODS.prompt, (params, id) => {
      const sessionId = params.sessionId as string
      agent.notify(ACP_METHODS.update, { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'c1', title: options.toolTitle ?? 'touch hello.txt', kind: options.kind ?? 'execute', status: 'pending' } })
      decided = agent.ask(ACP_METHODS.requestPermission, {
        sessionId,
        toolCall: { toolCallId: 'c1', title: options.toolTitle ?? 'touch hello.txt', kind: options.kind ?? 'execute', status: 'pending', ...(options.rawInput === undefined ? {} : { rawInput: options.rawInput }) },
        options: COMMAND_OPTIONS,
      })
      finish = (stop) => {
        if (stop === 'end_turn') agent.say(sessionId, ['写好了'])
        agent.reply(id, { stopReason: stop })
      }
    })
    const r = rig({ agent, writes: true })
    const running = r.adapter.run(job())
    await until(() => r.adapter.asks().length === 1)
    return { ...r, agent, running, decided: () => decided as Promise<Sent>, finish: (stop: string) => finish?.(stop) }
  }

  it('★请求一到:asks() 里一条 —— 这就是抽屉那一问该长成的形状(桩):家 / 会话 / 人话问题 / 选项(放宽那一项不摆)/ 原文 / since / by:form;会话表记「等你批」;onChange 叫了', async () => {
    const t = await askingRig({ rawInput: { command: 'touch hello.txt' } })
    const ask = t.adapter.asks()[0]!
    expect(ask).toMatchObject({ agent: 'codex', session_id: 'S1', kind: 'choose', by: 'form', rule: ACP_RULE })
    expect(ask.question).toBe(acpQuestionOf({ who: 'Codex', title: 'touch hello.txt', kind: 'execute' }))
    expect(ask.question).toContain('Codex')
    expect(ask.question).toContain('touch hello.txt')
    expect(ask.options.map(one => one.label)).toEqual([ACP_OPTION_LABELS.allow_once, ACP_OPTION_LABELS.decline, ACP_OPTION_LABELS.cancel])
    expect(ask.options.map(one => one.label)).not.toContain("Yes, and don't ask again for this command in this session")
    // 原文那一格:它的原话 + 命令原字,给她点开看。
    expect(ask.full?.question).toContain('touch hello.txt')
    expect(ask.full?.options?.map(one => one.label)).toEqual(['Yes, proceed', 'No, continue without running it', 'No, and tell Codex what to do differently'])
    expect(ask.since).toMatch(/^\d{4}-/)
    expect(t.events.at(-1)).toMatchObject({ agent: 'codex', session_id: 'S1', type: 'waiting', wait_reason: 'approval', formal_wait: 'approval' })
    expect(t.changes.length).toBeGreaterThan(0)
    t.finish('end_turn')
    t.link.close()
  })

  it('★她点「批准这一次」→ 回它 selected{allow_once};抽屉里那条没了;它接着跑,派活那一轮拿到回话', async () => {
    const t = await askingRig()
    const pressed = await t.adapter.run(job({ kind: 'press', target: { kind: 'session', sessionId: 'S1' }, text: ACP_OPTION_LABELS.allow_once, expect: 'none' }))
    expect(pressed).toMatchObject({ delivered: 'confirmed', via: 'protocol', evidence: 'receipt', sessionId: 'S1' })
    const decided = await t.decided()
    expect(decided.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } })
    expect(t.adapter.asks()).toEqual([])
    expect(t.events.at(-1)).toMatchObject({ type: 'running' })
    t.finish('end_turn')
    expect(await t.running).toMatchObject({ delivered: 'confirmed', reply: '写好了' })
    t.link.close()
  })

  it('她点「不批,让它跳过这一步」→ selected{decline};按它原字(optionId / name)也认', async () => {
    const t = await askingRig()
    await t.adapter.run(job({ kind: 'press', target: { kind: 'session', sessionId: 'S1' }, text: ACP_OPTION_LABELS.decline, expect: 'none' }))
    expect((await t.decided()).result).toEqual({ outcome: { outcome: 'selected', optionId: 'decline' } })
    t.finish('end_turn')
    await t.running
    // 第二问:按它的英文原字点也认。
    const t2 = await askingRig()
    await t2.adapter.run(job({ kind: 'press', target: { kind: 'session', sessionId: 'S1' }, text: 'No, and tell Codex what to do differently', expect: 'none' }))
    expect((await t2.decided()).result).toEqual({ outcome: { outcome: 'selected', optionId: 'cancel' } })
    t2.finish('cancelled')
    await t2.running
    t.link.close()
    t2.link.close()
  })

  it('★放宽那一项(allow_always)她点了也不替她按:不是它给的那一项 → not_sent,一下都没答', async () => {
    const t = await askingRig()
    const out = await t.adapter.run(job({ kind: 'press', target: { kind: 'session', sessionId: 'S1' }, text: "Yes, and don't ask again for this command in this session", expect: 'none' }))
    expect(out.delivered).toBe('not_sent')
    expect(out.why).toContain('不是它给的那一项')
    expect(t.adapter.asks()).toHaveLength(1)
    t.finish('end_turn')
    t.link.close()
  })

  it('没有在等答的那一问时点键 → unsupported(让引擎换窗口那条路),不编', async () => {
    const agent = scriptedAgent()
    const { adapter, link } = rig({ agent })
    const out = await adapter.run(job({ kind: 'press', target: { kind: 'session', sessionId: 'S9' }, text: ACP_OPTION_LABELS.allow_once, expect: 'none' }))
    expect(out).toMatchObject({ delivered: 'not_sent', unsupported: true })
    link.close()
  })

  it('★按停止 → session/cancel;挂着的那一问回 cancelled;抽屉里那条没了;这一轮按被打断收场', async () => {
    const t = await askingRig()
    t.agent.answer(ACP_METHODS.cancel, () => { /* 通知,没有回包 */ })
    const stopped = await t.adapter.run(job({ kind: 'stop', target: { kind: 'session', sessionId: 'S1' }, text: '', expect: 'none' }))
    expect(stopped).toMatchObject({ delivered: 'confirmed', via: 'protocol' })
    expect(t.agent.allParamsOf(ACP_METHODS.cancel)).toEqual([{ sessionId: 'S1' }])
    expect((await t.decided()).result).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(t.adapter.asks()).toEqual([])
    t.finish('cancelled')
    const out = await t.running
    expect(out.delivered).toBe('confirmed')
    expect(out.why).toContain('打断')
    t.link.close()
  })

  it('代理死了 → 挂着的那一问一起撤(不留一条永远答不上的)', async () => {
    const t = await askingRig()
    t.agent.die('进程没了')
    await until(() => t.adapter.asks().length === 0)
    const out = await t.running
    expect(out.why).toContain('连接断了')
    t.link.close()
  })
})

describe('读一眼 / 回执 / 做不了的几样', () => {
  it('read:这一轮说完了 → reply + transcript;报了别的轮号 → unsupported(让 app-server 那条读);没这条会话 → unsupported', async () => {
    const agent = scriptedAgent()
    agent.answer(ACP_METHODS.prompt, (params, id) => { agent.say(params.sessionId as string, ['七天。']); agent.reply(id, { stopReason: 'end_turn' }) })
    const { adapter, link } = rig({ agent })
    const out = await adapter.run(job())
    const mine = job({ kind: 'dispatch', target: { kind: 'session', sessionId: 'S1' }, turnId: out.turnId as string })
    expect(await adapter.read!(mine)).toEqual({ reply: '七天。', evidence: 'transcript', via: 'protocol' })
    expect(await adapter.read!({ ...mine, turnId: 'someone-else' })).toMatchObject({ unsupported: true, via: 'protocol' })
    expect(await adapter.read!({ ...mine, target: { kind: 'session', sessionId: 'S404' } })).toMatchObject({ unsupported: true })
    link.close()
  })

  it('expect:ack → 第一个动静到了就算送到(带 sessionId / turnId);一个动静都没有 → unconfirmed,不说成送到', async () => {
    const agent = scriptedAgent()
    agent.answer(ACP_METHODS.prompt, (params) => {
      agent.notify(ACP_METHODS.update, { sessionId: params.sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '想一下' } } })
    })
    const { adapter, link } = rig({ agent, ackMs: 300 })
    const out = await adapter.run(job({ expect: 'ack' }))
    expect(out).toMatchObject({ delivered: 'confirmed', evidence: 'receipt', sessionId: 'S1' })
    expect(out.turnId).toMatch(/\S/)

    const quiet = scriptedAgent()
    quiet.answer(ACP_METHODS.prompt, () => { /* 一个字都不回 */ })
    const q = rig({ agent: quiet, ackMs: 30 })
    const none = await q.adapter.run(job({ expect: 'ack' }))
    expect(none.delivered).toBe('unconfirmed')
    expect(none.why).toContain('没等到它开跑')
    link.close()
    q.link.close()
  })

  it('捎话到她指名的那一段:这条进程里没见过 → 先 session/load(带目录)再 prompt;见过的直接 prompt', async () => {
    const agent = scriptedAgent()
    agent.answer(ACP_METHODS.prompt, (params, id) => { agent.say(params.sessionId as string, ['收到']); agent.reply(id, { stopReason: 'end_turn' }) })
    const { adapter, link } = rig({ agent })
    const out = await adapter.run(job({ kind: 'relay', target: { kind: 'session', sessionId: 'OLD' }, text: '补一句', cwd: '/Users/example/tmp/acp-x' }))
    expect(out).toMatchObject({ delivered: 'confirmed', reply: '收到', sessionId: 'OLD' })
    expect(agent.paramsOf(ACP_METHODS.loadSession)).toMatchObject({ sessionId: 'OLD', cwd: '/Users/example/tmp/acp-x', mcpServers: [] })
    // 捎话不改她那条对话的权限档。
    expect(agent.methods()).not.toContain(ACP_METHODS.setMode)
    const before = agent.allParamsOf(ACP_METHODS.loadSession).length
    await adapter.run(job({ kind: 'relay', target: { kind: 'session', sessionId: 'OLD' }, text: '再补一句' }))
    expect(agent.allParamsOf(ACP_METHODS.loadSession).length).toBe(before)
    link.close()
  })

  it('「只填不发」/「它此刻开着的那条」/ 写提问面板 → unsupported(换窗口那条路),一条请求都不发', async () => {
    const agent = scriptedAgent()
    const { adapter, link } = rig({ agent })
    expect(await adapter.run(job({ submit: false }))).toMatchObject({ delivered: 'not_sent', unsupported: true })
    expect(await adapter.run(job({ kind: 'relay', target: { kind: 'current' }, text: 'x' }))).toMatchObject({ delivered: 'not_sent', unsupported: true })
    expect(await adapter.run(job({ kind: 'write_ask', target: { kind: 'session', sessionId: 'S1' }, text: 'x', expect: 'ack' }))).toMatchObject({ delivered: 'not_sent', unsupported: true })
    expect(agent.methods()).not.toContain(ACP_METHODS.prompt)
    link.close()
  })

  it('不认识的那一问(fs/read_text_file)回「没这个方法」,不装作会;凭据刷新那一类一个字段都不回', async () => {
    const agent = scriptedAgent()
    const { adapter, link } = rig({ agent })
    await adapter.capabilities()
    const answered = await agent.ask('fs/read_text_file', { sessionId: 'S1', path: '/etc/passwd' })
    expect(answered.result).toBeUndefined()
    expect((answered.error as { code: number }).code).toBe(-32601)
    link.close()
  })

  it('选项标签那张表:只给三种,放宽那一种不在表里', () => {
    expect(Object.keys(ACP_OPTION_LABELS).sort()).toEqual(['allow_once', 'cancel', 'decline'])
    expect(acpQuestionOf({ who: 'Codex', title: 'ls', kind: 'execute' })).toContain('跑一条命令')
    expect(acpQuestionOf({ who: 'Codex', title: 'hello.txt', kind: 'edit' })).toContain('改文件')
    expect([...acpQuestionOf({ who: 'Codex', title: 'x'.repeat(200), kind: 'other' })].length).toBeLessThanOrEqual(60)
  })
})

/** 让 `vi` 在这个文件里有用处(一个假定时器都不装;保留给以后要钉节拍的用例)。 */
void vi

describe('起进程那几样', () => {
  it('npx:PATH 上有就用 PATH 上的;没有按 homebrew / usr/local 找;都没有回 npx 让 ENOENT 走退路', async () => {
    const { findNpx, NPX_FALLBACKS } = await import('../src/server/engine/adapters/acpClient.ts')
    expect(findNpx('/a/bin:/b/bin', file => file === '/b/bin/npx')).toBe('/b/bin/npx')
    expect(findNpx('/a/bin', file => file === NPX_FALLBACKS[0])).toBe(NPX_FALLBACKS[0])
    expect(findNpx(undefined, () => false)).toBe('npx')
  })
})
