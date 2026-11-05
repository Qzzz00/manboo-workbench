/**
 * Codex 协议适配器(2026-10-02,卡「Codex 协议适配器」,契约见 `src/server/engine/adapter.ts`)。
 *
 * 假 stdio 对端**回放 10-02 本机验通的那串事件**:
 * `turn/start` 回包 → `turn/started` → `item/completed{agentMessage}` → `turn/completed`。
 * 一个真进程都不起、一个凭据都不读。真机那条在 `scripts/probe-codex-adapter.mjs`(手动跑)。
 */
import { describe, expect, it, vi } from 'vitest'
import { RetryableError } from '../src/server/engine/adapter.ts'
import type { Job } from '../src/server/engine/adapter.ts'
import type { CodexStdioPeer } from '../src/server/engine/adapters/codexAppServerClient.ts'
import { codexAppServerLink } from '../src/server/engine/adapters/codexAppServerClient.ts'
import {
  CODEX_APPROVAL_POLICY,
  CODEX_NAME_FALLBACK_MAX,
  CODEX_NAME_METHOD,
  CODEX_SANDBOX_READ_ONLY,
  CODEX_SANDBOX_WRITES,
  codexAdapter,
  codexThreadNameOf,
} from '../src/server/engine/adapters/codex.ts'

interface Sent { id?: unknown, method?: string, params?: Record<string, unknown> }

/**
 * 假对端 + 一个「它会怎么回」的脚本。
 * `answer(method, fn)` 说清某个方法的回包;没写的方法回 `{}`。
 */
function scriptedPeer() {
  const sent: Sent[] = []
  let onData: ((chunk: string) => void) | undefined
  let onGone: ((why: string) => void) | undefined
  let killed = false
  const answers = new Map<string, (params: Record<string, unknown>, id: unknown) => void>()

  const emit = (message: unknown): void => { onData?.(`${JSON.stringify(message)}\n`) }
  const reply = (id: unknown, result: unknown): void => { emit({ jsonrpc: '2.0', id, result }) }
  const refuse = (id: unknown, message: string): void => { emit({ jsonrpc: '2.0', id, error: { code: -32602, message } }) }

  const peer: CodexStdioPeer = {
    send: (line) => {
      if (killed) throw new Error('已经杀掉了')
      const message = JSON.parse(line) as Sent
      sent.push(message)
      if (message.method === undefined || message.id === undefined) return
      const scripted = answers.get(message.method)
      if (scripted !== undefined) { scripted(message.params ?? {}, message.id); return }
      if (message.method === 'initialize') { reply(message.id, { userAgent: 'test' }); return }
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
    die: (why = '提前退出') => onGone?.(why),
    answer: (method: string, fn: (params: Record<string, unknown>, id: unknown) => void) => { answers.set(method, fn) },
    paramsOf: (method: string) => sent.find(m => m.method === method)?.params,
    methods: () => sent.map(m => m.method),
  }
}

/** 一句话 = 一条事项:她常用的那几种活。 */
function job(over: Partial<Job> = {}): Job {
  return {
    id: 'J1',
    family: 'codex',
    kind: 'answer',
    target: { kind: 'session', sessionId: '01a0fc96-f6ac-78c1-a3e6-76e7ba72d97f' },
    text: '只回复两个字:收到',
    expect: 'reply',
    ...over,
  }
}

/** 把一个脚本化的对端接成适配器。 */
function rig(options: {
  peer: ReturnType<typeof scriptedPeer>
  writes?: boolean
  cwd?: string
  binary?: () => string | undefined
  /** 这件活的卡标题(宿主按 `job.itemId` 查卡)。缺席 = 查不到卡。 */
  title?: (job: Job) => string | undefined | Promise<string | undefined>
  warn?: (line: string) => void
}) {
  const link = codexAppServerLink({ clientName: 'test', spawnPeer: () => options.peer.peer })
  const adapter = codexAdapter({
    link,
    binary: options.binary ?? (() => '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'),
    workdir: () => ({ writes: options.writes ?? false, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) }),
    ...(options.title === undefined ? {} : { title: options.title }),
    // 用例里默认把那一行日志吞掉(真机默认是 console.log,见 codex.ts)。
    warn: options.warn ?? (() => {}),
  })
  return { adapter, link }
}

/** 回放「这一轮说完了」:`turn/started` → `item/completed` → `turn/completed`。 */
function playTurn(
  peer: ReturnType<typeof scriptedPeer>,
  options: { threadId: string, turnId?: string, items?: readonly Record<string, unknown>[], status?: string, error?: unknown } = { threadId: 'T' },
): void {
  const turnId = options.turnId ?? 'U1'
  const items = options.items ?? [{ id: 'I1', type: 'agentMessage', text: '收到', phase: 'final_answer' }]
  peer.emit({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: options.threadId, turn: { id: turnId, status: 'inProgress', items: [] } } })
  for (const item of items) {
    peer.emit({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: options.threadId, turnId, item, completedAtMs: 1 } })
  }
  peer.emit({
    jsonrpc: '2.0',
    method: 'turn/completed',
    params: {
      threadId: options.threadId,
      turn: { id: turnId, status: options.status ?? 'completed', items, ...(options.error === undefined ? {} : { error: options.error }) },
    },
  })
}

describe('capabilities:现查,不写死', () => {
  it('二进制在、握手得上 → 开 / 发 / 读 / 停 / 开到某一段都能;点键不能(协议点不了框上的键)', async () => {
    const peer = scriptedPeer()
    const { adapter, link } = rig({ peer })
    expect(await adapter.capabilities()).toEqual({
      open: true, send: true, read: true, press: false, approve: false, writeAsk: false, stop: true, openSession: true,
    })
    expect(adapter.family).toBe('codex')
    expect(adapter.via).toBe('protocol')
    link.close()
  })

  it('这台机器上找不到 codex → 一样都不能,**不去起进程**', async () => {
    const peer = scriptedPeer()
    const { adapter, link } = rig({ peer, binary: () => undefined })
    expect(await adapter.capabilities()).toEqual({
      open: false, send: false, read: false, press: false, approve: false, writeAsk: false, stop: false, openSession: false,
    })
    expect(peer.sent).toHaveLength(0)
    link.close()
  })

  it('握手握不上 → 一样都不能(不报「能」然后到送话时才崩)', async () => {
    const peer = scriptedPeer()
    peer.answer('initialize', (_params, id) => { peer.refuse(id, 'app-server 起不来') })
    const { adapter, link } = rig({ peer })
    expect(await adapter.capabilities()).toMatchObject({ send: false, stop: false })
    link.close()
  })
})

describe('替她答 / 捎话:thread/resume + turn/start', () => {
  it('expect reply:等 turn/completed 把 agentMessage 收回来,证据是回执', async () => {
    const peer = scriptedPeer()
    const threadId = '01a0fc96-f6ac-78c1-a3e6-76e7ba72d97f'
    peer.answer('turn/start', (_params, id) => {
      peer.reply(id, { turn: { id: 'U1', status: 'inProgress', items: [] } })
      playTurn(peer, { threadId })
    })
    const { adapter, link } = rig({ peer })
    const result = await adapter.run(job())

    // `turnId`:送进去的是它的哪一轮(回包里那个 U1;2026-10-03),消费方记在卡上 / 账上,读回话只认这一轮。
    expect(result).toEqual({
      delivered: 'confirmed', via: 'protocol', evidence: 'receipt', reply: '收到', sessionId: threadId, turnId: 'U1',
    })
    expect(peer.methods()).toEqual(['initialize', 'initialized', 'thread/resume', 'turn/start'])
    expect(peer.paramsOf('thread/resume')).toEqual({ threadId })
    expect(peer.paramsOf('turn/start')).toEqual({
      threadId, input: [{ type: 'text', text: '只回复两个字:收到' }],
    })
    link.close()
  })

  it('捎话走同一条路(kind relay)', async () => {
    const peer = scriptedPeer()
    peer.answer('turn/start', (params, id) => {
      peer.reply(id, { turn: { id: 'U1', status: 'inProgress', items: [] } })
      playTurn(peer, { threadId: String(params.threadId), items: [{ id: 'I1', type: 'agentMessage', text: '知道了', phase: 'final_answer' }] })
    })
    const { adapter, link } = rig({ peer })
    const result = await adapter.run(job({ kind: 'relay', text: '顺便把标题也改一下' }))
    expect(result.delivered).toBe('confirmed')
    expect(result.reply).toBe('知道了')
    link.close()
  })

  it('**不改她那条对话的权限档**:resume / turn/start 里不带 sandbox、不带 approvalPolicy', async () => {
    const peer = scriptedPeer()
    peer.answer('turn/start', (params, id) => {
      peer.reply(id, { turn: { id: 'U1', status: 'inProgress', items: [] } })
      playTurn(peer, { threadId: String(params.threadId) })
    })
    const { adapter, link } = rig({ peer, writes: true })
    await adapter.run(job())
    for (const method of ['thread/resume', 'turn/start']) {
      expect(peer.paramsOf(method)).not.toHaveProperty('sandbox')
      expect(peer.paramsOf(method)).not.toHaveProperty('approvalPolicy')
    }
    link.close()
  })

  it('expect ack:收到 turn/started 就算送到,**不等**它说完', async () => {
    const peer = scriptedPeer()
    peer.answer('turn/start', (params, id) => {
      peer.reply(id, { turn: { id: 'U1', status: 'inProgress', items: [] } })
      peer.emit({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: String(params.threadId), turn: { id: 'U1', status: 'inProgress', items: [] } } })
    })
    const { adapter, link } = rig({ peer })
    const result = await adapter.run(job({ expect: 'ack' }))
    expect(result).toMatchObject({ delivered: 'confirmed', evidence: 'receipt', via: 'protocol' })
    expect(result.reply).toBeUndefined()
    link.close()
  })

  it('它这一轮只有过场话(commentary)、没有收尾那句 → 仍然把那句收回来,不编一句', async () => {
    const peer = scriptedPeer()
    peer.answer('turn/start', (params, id) => {
      peer.reply(id, { turn: { id: 'U1', status: 'inProgress', items: [] } })
      playTurn(peer, {
        threadId: String(params.threadId),
        items: [{ id: 'I1', type: 'agentMessage', text: '我先看看文件', phase: 'commentary' }],
      })
    })
    const { adapter, link } = rig({ peer })
    const result = await adapter.run(job())
    expect(result.reply).toBe('我先看看文件')
    link.close()
  })

  it('有收尾那句就只认收尾那句(过场话不当回答)', async () => {
    const peer = scriptedPeer()
    peer.answer('turn/start', (params, id) => {
      peer.reply(id, { turn: { id: 'U1', status: 'inProgress', items: [] } })
      playTurn(peer, {
        threadId: String(params.threadId),
        items: [
          { id: 'I1', type: 'agentMessage', text: '我先看看文件', phase: 'commentary' },
          { id: 'I2', type: 'reasoning', text: '想一想' },
          { id: 'I3', type: 'agentMessage', text: '收到', phase: 'final_answer' },
        ],
      })
    })
    const { adapter, link } = rig({ peer })
    expect((await adapter.run(job())).reply).toBe('收到')
    link.close()
  })

  it('这一轮被打断 / 失败 → 话是送到了(confirmed),但**没有** reply,why 写清楚', async () => {
    const peer = scriptedPeer()
    peer.answer('turn/start', (params, id) => {
      peer.reply(id, { turn: { id: 'U1', status: 'inProgress', items: [] } })
      playTurn(peer, { threadId: String(params.threadId), items: [], status: 'failed', error: { message: '额度用完了' } })
    })
    const { adapter, link } = rig({ peer })
    const result = await adapter.run(job())
    expect(result.delivered).toBe('confirmed')
    expect(result.reply).toBeUndefined()
    expect(result.why).toContain('额度用完了')
    link.close()
  })

  it('认不准是哪一段(target new)→ 不送,why 是人话', async () => {
    const peer = scriptedPeer()
    const { adapter, link } = rig({ peer })
    const result = await adapter.run(job({ target: { kind: 'new' } }))
    expect(result.delivered).toBe('not_sent')
    expect(result.why).toBeTruthy()
    expect(peer.methods()).not.toContain('turn/start')
    link.close()
  })

  it('那条对话它找不着(resume 回错误)→ 不送,带上它的原话,**不**重试', async () => {
    const peer = scriptedPeer()
    peer.answer('thread/resume', (_params, id) => { peer.refuse(id, 'thread not found') })
    const { adapter, link } = rig({ peer })
    const result = await adapter.run(job())
    expect(result.delivered).toBe('not_sent')
    expect(result.why).toContain('thread not found')
    expect(peer.methods()).not.toContain('turn/start')
    link.close()
  })

  it('这台机器上找不到 codex → 不送,why 说清楚去装哪一份', async () => {
    const peer = scriptedPeer()
    const { adapter, link } = rig({ peer, binary: () => undefined })
    const result = await adapter.run(job())
    expect(result).toMatchObject({ delivered: 'not_sent', via: 'protocol' })
    expect(result.why).toContain('Codex')
    link.close()
  })

  it('连接起不来 / 中途断了 → 抛 RetryableError,由引擎那一处决定重试几回', async () => {
    const peer = scriptedPeer()
    peer.answer('initialize', () => { peer.die('app-server 崩了') })
    const { adapter, link } = rig({ peer })
    await expect(adapter.run(job())).rejects.toBeInstanceOf(RetryableError)
    link.close()
  })
})

describe('派活:thread/start(cwd 按卡上的工作目录)+ turn/start', () => {
  it('新开一条 → 回 sessionId = threadId;审批策略不放开、沙箱按「许不许改文件」', async () => {
    const peer = scriptedPeer()
    peer.answer('thread/start', (_params, id) => {
      peer.reply(id, { thread: { id: 'T-new', sessionId: 'T-new', cwd: '/Users/example/Code/x' }, approvalPolicy: 'never', sandbox: 'workspace-write' })
    })
    peer.answer('turn/start', (params, id) => {
      peer.reply(id, { turn: { id: 'U1', status: 'inProgress', items: [] } })
      peer.emit({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: String(params.threadId), turn: { id: 'U1', status: 'inProgress', items: [] } } })
    })
    const { adapter, link } = rig({ peer, writes: true, cwd: '/Users/example/Code/x' })
    const result = await adapter.run(job({ kind: 'dispatch', target: { kind: 'new' }, expect: 'ack', text: '加个导出 PDF' }))

    expect(result).toMatchObject({ delivered: 'confirmed', evidence: 'receipt', sessionId: 'T-new', via: 'protocol' })
    expect(peer.paramsOf('thread/start')).toEqual({
      cwd: '/Users/example/Code/x', approvalPolicy: CODEX_APPROVAL_POLICY, sandbox: CODEX_SANDBOX_WRITES,
    })
    expect(peer.paramsOf('turn/start')).toMatchObject({ threadId: 'T-new', input: [{ type: 'text', text: '加个导出 PDF' }] })
    expect(peer.methods()).not.toContain('thread/resume')
    link.close()
  })

  it('这张卡不许改文件 → read-only', async () => {
    const peer = scriptedPeer()
    peer.answer('thread/start', (_params, id) => { peer.reply(id, { thread: { id: 'T-new' } }) })
    peer.answer('turn/start', (params, id) => {
      peer.reply(id, { turn: { id: 'U1', status: 'inProgress', items: [] } })
      peer.emit({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: String(params.threadId), turn: { id: 'U1' } } })
    })
    const { adapter, link } = rig({ peer, writes: false, cwd: '/Users/example/Code/x' })
    await adapter.run(job({ kind: 'dispatch', target: { kind: 'new' }, expect: 'ack' }))
    expect(peer.paramsOf('thread/start')).toMatchObject({ sandbox: CODEX_SANDBOX_READ_ONLY })
    link.close()
  })

  it('审批策略写死不问人:never —— `danger-full-access` 不许出现在这条路上', () => {
    expect(CODEX_APPROVAL_POLICY).toBe('never')
    expect([CODEX_SANDBOX_WRITES, CODEX_SANDBOX_READ_ONLY]).toEqual(['workspace-write', 'read-only'])
    expect([CODEX_SANDBOX_WRITES, CODEX_SANDBOX_READ_ONLY]).not.toContain('danger-full-access')
  })

  it('没有工作目录 → thread/start 不带 cwd(让 Codex 用它自己的默认),不硬造一个路径', async () => {
    const peer = scriptedPeer()
    peer.answer('thread/start', (_params, id) => { peer.reply(id, { thread: { id: 'T-new' } }) })
    peer.answer('turn/start', (params, id) => {
      peer.reply(id, { turn: { id: 'U1' } })
      peer.emit({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: String(params.threadId), turn: { id: 'U1' } } })
    })
    const { adapter, link } = rig({ peer })
    await adapter.run(job({ kind: 'dispatch', target: { kind: 'new' }, expect: 'ack' }))
    expect(peer.paramsOf('thread/start')).not.toHaveProperty('cwd')
    link.close()
  })

  it('派进她指定的那一条 → resume,沙箱仍按卡说(是我们起的活)', async () => {
    const peer = scriptedPeer()
    peer.answer('turn/start', (params, id) => {
      peer.reply(id, { turn: { id: 'U1' } })
      peer.emit({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: String(params.threadId), turn: { id: 'U1' } } })
    })
    const { adapter, link } = rig({ peer, writes: true, cwd: '/Users/example/Code/x' })
    const result = await adapter.run(job({ kind: 'dispatch', expect: 'ack' }))
    expect(result.sessionId).toBe('01a0fc96-f6ac-78c1-a3e6-76e7ba72d97f')
    expect(peer.paramsOf('thread/resume')).toMatchObject({ sandbox: CODEX_SANDBOX_WRITES, approvalPolicy: CODEX_APPROVAL_POLICY })
    link.close()
  })

  it('thread/start 回包里没有 threadId → 不说成送到了', async () => {
    const peer = scriptedPeer()
    peer.answer('thread/start', (_params, id) => { peer.reply(id, { thread: {} }) })
    const { adapter, link } = rig({ peer })
    const result = await adapter.run(job({ kind: 'dispatch', target: { kind: 'new' }, expect: 'ack' }))
    expect(result.delivered).toBe('not_sent')
    expect(peer.methods()).not.toContain('turn/start')
    link.close()
  })
})

/**
 * 起名(2026-10-03,卡「Codex 线程起名」,维护者 10-03 早拍板 ③甲)。
 *
 * 10-02 的硬伤:协议开的线程**没名字**,于是 `~/.codex/session_index.jsonl`(每行带 `thread_name`)
 * 里不进这一条,她的 ChatGPT App 侧栏与 `codexThreads.ts` 都找不着派出去的活。
 * 方法名与参数形状**查实**自 codex-cli 0.159.2 自己的协议定义
 * (`codex app-server generate-ts` → `ClientRequest.ts` / `v2/ThreadSetNameParams.ts`)。
 */
describe('给我们自己开的那条新线程起名:thread/name/set', () => {
  /** `thread/start` + `turn/start` 都答得上的那个对端。 */
  function naming(): ReturnType<typeof scriptedPeer> {
    const peer = scriptedPeer()
    peer.answer('thread/start', (_params, id) => { peer.reply(id, { thread: { id: 'T-new', sessionId: 'T-new' } }) })
    peer.answer('turn/start', (params, id) => {
      peer.reply(id, { turn: { id: 'U1', status: 'inProgress', items: [] } })
      peer.emit({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: String(params.threadId), turn: { id: 'U1' } } })
    })
    return peer
  }

  it('方法名与参数形状照它自己的协议定义(0.159.2:ThreadSetNameParams{threadId,name})', () => {
    expect(CODEX_NAME_METHOD).toBe('thread/name/set')
    expect(CODEX_NAME_FALLBACK_MAX).toBe(30)
  })

  it('派活新开一条 → thread/start 之后、turn/start 之前补一句起名,名字就是卡标题', async () => {
    const peer = naming()
    const { adapter, link } = rig({ peer, title: () => '加个导出 PDF' })
    const result = await adapter.run(job({
      kind: 'dispatch', target: { kind: 'new' }, expect: 'ack', itemId: 'task-1', text: '【工作台派活 ab12cd】加个导出 PDF',
    }))

    expect(result).toMatchObject({ delivered: 'confirmed', sessionId: 'T-new' })
    expect(peer.paramsOf(CODEX_NAME_METHOD)).toEqual({ threadId: 'T-new', name: '加个导出 PDF' })
    const order = peer.methods()
    expect(order.indexOf('thread/start')).toBeLessThan(order.indexOf(CODEX_NAME_METHOD))
    expect(order.indexOf(CODEX_NAME_METHOD)).toBeLessThan(order.indexOf('turn/start'))
    link.close()
  })

  it('卡标题**原样**:不加前缀、不改一个字(长标题也不截)', async () => {
    const long = '把参赛网页的三幕叙事从首屏一路改到页脚,顺带把截图换成 10-02 那一版'
    const peer = naming()
    const { adapter, link } = rig({ peer, title: () => long })
    await adapter.run(job({ kind: 'dispatch', target: { kind: 'new' }, expect: 'ack', itemId: 'task-1' }))
    expect(peer.paramsOf(CODEX_NAME_METHOD)).toEqual({ threadId: 'T-new', name: long })
    link.close()
  })

  it('查不到卡 → 名字 = 交代第一行截 30 字(不编一个标题)', async () => {
    const first = '把参赛网页的三幕叙事从首屏一路改到页脚,顺带把里头的截图也换成 10-02 那一版'
    expect(first.length).toBeGreaterThan(CODEX_NAME_FALLBACK_MAX)
    const peer = naming()
    const { adapter, link } = rig({ peer })
    await adapter.run(job({ kind: 'dispatch', target: { kind: 'new' }, expect: 'ack', text: `${first}\n第二行不该进名字` }))
    const name = (peer.paramsOf(CODEX_NAME_METHOD) as { name: string }).name
    expect(name).toBe(first.slice(0, CODEX_NAME_FALLBACK_MAX))
    expect(name).toHaveLength(CODEX_NAME_FALLBACK_MAX)
    expect(name).not.toContain('第二行')
    link.close()
  })

  it('一个名字都取不出来(卡查不到、交代是空白)→ 不发那一问,只记一行', async () => {
    const peer = naming()
    const lines: string[] = []
    const { adapter, link } = rig({ peer, warn: line => lines.push(line), title: () => '   ' })
    const result = await adapter.run(job({ kind: 'dispatch', target: { kind: 'new' }, expect: 'ack', text: '  \n \n' }))
    expect(result.delivered).toBe('confirmed')
    expect(peer.methods()).not.toContain(CODEX_NAME_METHOD)
    expect(lines).toHaveLength(1)
    link.close()
  })

  it('起名失败**不影响派活**:话照送、结局照旧,只记一行人话', async () => {
    const peer = naming()
    peer.answer(CODEX_NAME_METHOD, (_params, id) => { peer.refuse(id, 'thread not loaded') })
    const lines: string[] = []
    const { adapter, link } = rig({ peer, warn: line => lines.push(line), title: () => '加个导出 PDF' })
    const result = await adapter.run(job({ kind: 'dispatch', target: { kind: 'new' }, expect: 'ack', itemId: 'task-1' }))

    expect(result).toMatchObject({ delivered: 'confirmed', evidence: 'receipt', sessionId: 'T-new', via: 'protocol' })
    expect(result.why).toBeUndefined()
    expect(peer.methods()).toContain('turn/start')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('thread not loaded')
    link.close()
  })

  it('查卡那一下自己抛了 → 照样派活,只记一行(宿主的毛病不该拖住这件活)', async () => {
    const peer = naming()
    const lines: string[] = []
    const { adapter, link } = rig({
      peer,
      warn: line => lines.push(line),
      title: () => { throw new Error('看板读不出来') },
    })
    const result = await adapter.run(job({ kind: 'dispatch', target: { kind: 'new' }, expect: 'ack', itemId: 'task-1' }))
    expect(result.delivered).toBe('confirmed')
    expect(peer.methods()).not.toContain(CODEX_NAME_METHOD)
    expect(lines).toHaveLength(1)
    link.close()
  })

  it('派进**她指定的那一条** → 一个字都不改她那条对话的名字', async () => {
    const peer = scriptedPeer()
    peer.answer('turn/start', (params, id) => {
      peer.reply(id, { turn: { id: 'U1' } })
      peer.emit({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: String(params.threadId), turn: { id: 'U1' } } })
    })
    const { adapter, link } = rig({ peer, title: () => '加个导出 PDF' })
    await adapter.run(job({ kind: 'dispatch', expect: 'ack', itemId: 'task-1' }))
    expect(peer.methods()).not.toContain(CODEX_NAME_METHOD)
    link.close()
  })

  it.each([['answer'], ['relay']])('替她答 / 捎话(%s)→ 不起名(那是她自己那条对话)', async (kind) => {
    const peer = scriptedPeer()
    peer.answer('turn/start', (params, id) => {
      peer.reply(id, { turn: { id: 'U1' } })
      peer.emit({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: String(params.threadId), turn: { id: 'U1' } } })
    })
    const { adapter, link } = rig({ peer, title: () => '加个导出 PDF' })
    await adapter.run(job({ kind: kind as Job['kind'], expect: 'ack', itemId: 'task-1' }))
    expect(peer.methods()).not.toContain(CODEX_NAME_METHOD)
    link.close()
  })
})

describe('起名字那一句话怎么来的(纯判断,不碰协议)', () => {
  it('有卡标题就用卡标题,原样', () => {
    expect(codexThreadNameOf('【工作台派活 ab12cd】加个导出 PDF', '加个导出 PDF')).toBe('加个导出 PDF')
    expect(codexThreadNameOf('随便', '  前后有空格  ')).toBe('前后有空格')
  })

  it('没卡标题 → 交代第一行(空白行跳过),最多 30 字', () => {
    expect(codexThreadNameOf('加个导出 PDF\n细节见卡')).toBe('加个导出 PDF')
    expect(codexThreadNameOf('\n\n  第一行在这儿  \n第二行')).toBe('第一行在这儿')
    expect(codexThreadNameOf('一'.repeat(40))).toBe('一'.repeat(30))
  })

  it('一个字都没有 → 缺席(不编一个名字)', () => {
    expect(codexThreadNameOf('')).toBeUndefined()
    expect(codexThreadNameOf('  \n \t \n')).toBeUndefined()
    expect(codexThreadNameOf('', '   ')).toBeUndefined()
  })
})

describe('停:turn/interrupt', () => {
  it('停掉我们刚起的那一轮(记着它的 turnId)', async () => {
    const peer = scriptedPeer()
    const threadId = '01a0fc96-f6ac-78c1-a3e6-76e7ba72d97f'
    peer.answer('turn/start', (params, id) => {
      peer.reply(id, { turn: { id: 'U7' } })
      peer.emit({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: String(params.threadId), turn: { id: 'U7' } } })
    })
    const { adapter, link } = rig({ peer })
    await adapter.run(job({ kind: 'relay', expect: 'ack' }))
    const result = await adapter.run(job({ kind: 'stop', text: '', expect: 'none' }))
    expect(result).toMatchObject({ delivered: 'confirmed', evidence: 'receipt', via: 'protocol' })
    expect(peer.paramsOf('turn/interrupt')).toEqual({ threadId, turnId: 'U7' })
    link.close()
  })

  it('不知道哪一轮在跑 → 现查(resume 看 turns 里 inProgress 那一轮)', async () => {
    const peer = scriptedPeer()
    const threadId = '01a0fc96-f6ac-78c1-a3e6-76e7ba72d97f'
    peer.answer('thread/resume', (_params, id) => {
      peer.reply(id, { thread: { id: threadId, turns: [{ id: 'U1', status: 'completed' }, { id: 'U2', status: 'inProgress' }] } })
    })
    const { adapter, link } = rig({ peer })
    const result = await adapter.run(job({ kind: 'stop', text: '', expect: 'none' }))
    expect(result.delivered).toBe('confirmed')
    expect(peer.paramsOf('turn/interrupt')).toEqual({ threadId, turnId: 'U2' })
    link.close()
  })

  it('它那条对话现在没有在跑的一轮 → 不说成停了,why 是人话', async () => {
    const peer = scriptedPeer()
    peer.answer('thread/resume', (_params, id) => {
      peer.reply(id, { thread: { id: 'T', turns: [{ id: 'U1', status: 'completed' }] } })
    })
    const { adapter, link } = rig({ peer })
    const result = await adapter.run(job({ kind: 'stop', text: '', expect: 'none' }))
    expect(result.delivered).toBe('not_sent')
    expect(result.why).toBeTruthy()
    expect(peer.methods()).not.toContain('turn/interrupt')
    link.close()
  })
})

describe('这条路做不了的:如实说 unsupported,让引擎换窗口那条路', () => {
  it.each([
    ['press', '替她点框上的一项'],
    ['write_ask', '往提问面板里写字'],
  ])('%s → unsupported,via 是 none(一条通道都没用上)', async (kind) => {
    const peer = scriptedPeer()
    const { adapter, link } = rig({ peer })
    const result = await adapter.run(job({ kind: kind as Job['kind'], expect: 'none' }))
    expect(result).toMatchObject({ delivered: 'not_sent', unsupported: true, via: 'none' })
    expect(result.why).toBeTruthy()
    // 一个请求都不该发出去(除了握手之前什么都没有)。
    expect(peer.methods()).not.toContain('turn/start')
    link.close()
  })
})

describe('只读一眼(read):不送、不点、不开新 turn', () => {
  const threadId = '01a0fcc1-4e2c-7dd0-a9a6-37a6e47f0cb0'

  it('resume 回来的 turns 里最后那句 agentMessage 就是回话', async () => {
    const peer = scriptedPeer()
    peer.answer('thread/resume', (_params, id) => {
      peer.reply(id, {
        thread: {
          id: threadId,
          turns: [
            { id: 'U1', status: 'completed', items: [{ id: 'I1', type: 'agentMessage', text: '第一轮说的', phase: 'final_answer' }] },
            {
              id: 'U2',
              status: 'completed',
              items: [
                { id: 'I2', type: 'agentMessage', text: '我先看看文件', phase: 'commentary' },
                { id: 'I3', type: 'agentMessage', text: '收到', phase: 'final_answer' },
              ],
            },
          ],
        },
      })
    })
    const { adapter, link } = rig({ peer })
    const seen = await adapter.read?.(job({ kind: 'answer' }))
    expect(seen).toEqual({ reply: '收到', evidence: 'transcript', via: 'protocol' })
    // **一个 turn 都没开**,权限档也没碰。
    expect(peer.methods()).toEqual(['initialize', 'initialized', 'thread/resume'])
    expect(peer.paramsOf('thread/resume')).toEqual({ threadId: '01a0fc96-f6ac-78c1-a3e6-76e7ba72d97f' })
    link.close()
  })

  it('resume 没给 turns(分页的老对话)→ 退回 thread/items/list 倒着取一页', async () => {
    const peer = scriptedPeer()
    peer.answer('thread/resume', (_params, id) => { peer.reply(id, { thread: { id: threadId, turns: [] } }) })
    peer.answer('thread/items/list', (_params, id) => {
      peer.reply(id, {
        data: [
          { turnId: 'U2', item: { id: 'I3', type: 'agentMessage', text: '收到', phase: 'final_answer' } },
          { turnId: 'U2', item: { id: 'I2', type: 'reasoning', text: '想一想' } },
        ],
      })
    })
    const { adapter, link } = rig({ peer })
    expect(await adapter.read?.(job())).toEqual({ reply: '收到', evidence: 'transcript', via: 'protocol' })
    expect(peer.paramsOf('thread/items/list')).toMatchObject({ threadId: '01a0fc96-f6ac-78c1-a3e6-76e7ba72d97f', sortDirection: 'desc' })
    link.close()
  })

  it('它还一个字都没说 → reply 缺席,**不编一句**', async () => {
    const peer = scriptedPeer()
    peer.answer('thread/resume', (_params, id) => { peer.reply(id, { thread: { id: threadId, turns: [] } }) })
    peer.answer('thread/items/list', (_params, id) => { peer.reply(id, { data: [] }) })
    const { adapter, link } = rig({ peer })
    const seen = await adapter.read?.(job())
    expect(seen?.reply).toBeUndefined()
    expect(seen).toMatchObject({ via: 'protocol', evidence: 'none' })
    expect(seen?.why).toBeTruthy()
    link.close()
  })

  it('那条对话找不着 → 如实说,不当成「它没回」', async () => {
    const peer = scriptedPeer()
    peer.answer('thread/resume', (_params, id) => { peer.refuse(id, 'thread not found') })
    const { adapter, link } = rig({ peer })
    const seen = await adapter.read?.(job())
    expect(seen?.reply).toBeUndefined()
    expect(seen?.why).toContain('thread not found')
    link.close()
  })

  it('认不准是哪一段(target new)→ 不去问它', async () => {
    const peer = scriptedPeer()
    const { adapter, link } = rig({ peer })
    const seen = await adapter.read?.(job({ target: { kind: 'new' } }))
    expect(seen).toMatchObject({ via: 'none', evidence: 'none' })
    expect(peer.methods()).not.toContain('thread/resume')
    link.close()
  })

  it('这台机器上找不到 codex → 如实说,不去起进程', async () => {
    const peer = scriptedPeer()
    const { adapter, link } = rig({ peer, binary: () => undefined })
    const seen = await adapter.read?.(job())
    expect(seen?.reply).toBeUndefined()
    expect(seen?.why).toContain('Codex')
    expect(peer.sent).toHaveLength(0)
    link.close()
  })
})

describe('一个长连接:连着几件事只握一次手', () => {
  it('第二件事复用同一条连接', async () => {
    const peer = scriptedPeer()
    peer.answer('turn/start', (params, id) => {
      peer.reply(id, { turn: { id: 'U1' } })
      peer.emit({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: String(params.threadId), turn: { id: 'U1' } } })
    })
    const { adapter, link } = rig({ peer })
    await adapter.run(job({ expect: 'ack' }))
    await adapter.run(job({ expect: 'ack' }))
    expect(peer.methods().filter(m => m === 'initialize')).toHaveLength(1)
    link.close()
  })
})

describe('等不到就说等不到(不编一个回答)', () => {
  it('到了卡上的 deadline 还没说完 → 话送到了,why 说它还在做', async () => {
    vi.useFakeTimers()
    try {
      const peer = scriptedPeer()
      peer.answer('turn/start', (params, id) => {
        peer.reply(id, { turn: { id: 'U1' } })
        peer.emit({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: String(params.threadId), turn: { id: 'U1' } } })
      })
      const now = Date.UTC(2026, 9, 2, 20, 0, 0)
      const link = codexAppServerLink({ clientName: 'test', spawnPeer: () => peer.peer })
      const { codexAdapter: make } = await import('../src/server/engine/adapters/codex.ts')
      const adapter = make({ link, binary: () => '/bin/codex', workdir: () => ({ writes: false }), now: () => now })
      const running = adapter.run(job({ deadline: new Date(now + 30_000).toISOString() }))
      const landed = running.then(r => r)
      await vi.advanceTimersByTimeAsync(31_000)
      const result = await landed
      expect(result.delivered).toBe('confirmed')
      expect(result.reply).toBeUndefined()
      expect(result.why).toBeTruthy()
      link.close()
    }
    finally { vi.useRealTimers() }
  })
})

  it.each(['new', 'session'] as const)('名片配置进协议的本轮参数 %s', async kind => {
    const peer = scriptedPeer()
    peer.answer('thread/start', (_params, id) => peer.reply(id, { thread: { id: 'T1' } }))
    peer.answer('turn/start', (params, id) => {
      peer.reply(id, { turn: { id: 'U1', status: 'inProgress' } })
      playTurn(peer, { threadId: String(params.threadId) })
    })
    const { adapter, link } = rig({ peer, cwd: '/repo' })
    await adapter.run(job({ kind: 'dispatch', target: kind === 'new' ? { kind } : { kind, sessionId: 'T1' }, model: 'selected', effort: 'high' }))
    expect(peer.paramsOf(kind === 'new' ? 'thread/start' : 'thread/resume')).toMatchObject({ model: 'selected' })
    expect(peer.paramsOf('turn/start')).toMatchObject({ model: 'selected', effort: 'high' })
    link.close()
  })
