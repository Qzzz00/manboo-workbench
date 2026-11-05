/**
 * ★ **Codex 那条线程被别人占着的时候换路**(2026-10-04,卡「Codex 线程被占时换路」;
 * 查实与量数写在 `docs/交接-1004-Codex线程被占时换路.md`)。
 *
 * 真机那一行(`~/.dsh/logs/web.stdout.log` 10-04 10:18–10:20,五次捎话同一个原因):
 *
 * ```
 * session:codex/01a0ccd1-… · not_sent · relay_send · codex · 协议 · com.openai.codex ·
 *   thread 01a0ccd1-5e62-7eb2-a0af-224d9d844cfd already has an active writer
 * ```
 *
 * 查实(交接第二节):`codex app-server` 对每条线程有一把**跨进程文件锁**
 * (`~/.codex/thread-writer-locks/<threadId>.lock`,`thread-store/src/local/live_writer.rs`),
 * 她的 Codex / ChatGPT 桌面 App 自己那个 app-server 开着那条线程就一直握着它。
 * 本机量过:同一条连接重复 `thread/resume` **不冲突**(所以不是我们自己没放手),
 * 另一个进程 resume 同一条就回这句原话;锁随握着的那个进程退出而放。
 *
 * 所以这是「**协议这条路此刻做不了**」,不是普通失败:适配器回 `unsupported`,
 * 引擎按既有规矩换到窗口那只手(深链 `codex://threads/<id>`),锁着屏就排进队等解锁。
 */
import { describe, expect, it } from 'vitest'
import { createActionGate } from '../src/server/actionGate.ts'
import { createJobLog } from '../src/server/jobLog.ts'
import type { Adapter, AdapterCapabilities, AdapterReadResult, Job, JobResult } from '../src/server/engine/adapter.ts'
import {
  CODEX_THREAD_TAKEN_WHY,
  codexAdapter,
  codexThreadTaken,
} from '../src/server/engine/adapters/codex.ts'
import type { CodexStdioPeer } from '../src/server/engine/adapters/codexAppServerClient.ts'
import { codexAppServerLink } from '../src/server/engine/adapters/codexAppServerClient.ts'
import { createEngine } from '../src/server/engine/engine.ts'
import { createRegistry } from '../src/server/engine/registry.ts'
import { sessionJobId } from '../src/server/jobKey.ts'
import { screenLockedSay } from '../src/server/screenLock.ts'

/** 真机上那一行原话(10-04 10:18 的日志,逐字)。 */
const REAL_LINE = 'thread 01a0ccd1-5e62-7eb2-a0af-224d9d844cfd already has an active writer'
const THREAD = '01a0ccd1-5e62-7eb2-a0af-224d9d844cfd'

interface Sent { id?: unknown, method?: string, params?: Record<string, unknown> }

/** 假对端:`thread/resume` 回真机那一行。 */
function peerThatRefusesResume(message = REAL_LINE) {
  const sent: Sent[] = []
  let onData: ((chunk: string) => void) | undefined
  const emit = (one: unknown): void => { onData?.(`${JSON.stringify(one)}\n`) }
  const peer: CodexStdioPeer = {
    send: (line) => {
      const one = JSON.parse(line) as Sent
      sent.push(one)
      if (one.method === undefined || one.id === undefined) return
      if (one.method === 'initialize') { emit({ jsonrpc: '2.0', id: one.id, result: { userAgent: 'test' } }); return }
      if (one.method === 'thread/resume') {
        // 真机回的就是这个:JSON-RPC code -32600(通用的 Invalid Request),分不出来,只能认原话。
        emit({ jsonrpc: '2.0', id: one.id, error: { code: -32600, message } })
        return
      }
      emit({ jsonrpc: '2.0', id: one.id, result: {} })
    },
    onData: (listen) => { onData = listen },
    onGone: () => { /* 这一组用例里它不死 */ },
    kill: () => { /* 同上 */ },
  }
  return { peer, methods: () => sent.map(one => one.method) }
}

function codexRig(message = REAL_LINE) {
  const fake = peerThatRefusesResume(message)
  const link = codexAppServerLink({ clientName: 'test', spawnPeer: () => fake.peer })
  const adapter = codexAdapter({
    link,
    binary: () => '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
    workdir: () => ({ writes: false }),
    warn: () => {},
  })
  return { adapter, link, ...fake }
}

function job(over: Partial<Job> = {}): Job {
  return {
    id: 'J1',
    family: 'codex',
    kind: 'relay',
    target: { kind: 'session', sessionId: THREAD },
    text: '再补一句:先别动那个文件',
    expect: 'ack',
    ...over,
  }
}

describe('认出「这条线程已经有一个写入方」', () => {
  it('真机那一行、以及本机 strings 里另一句(live local writer)都认得;别的失败不认', () => {
    expect(codexThreadTaken(REAL_LINE)).toBe(true)
    expect(codexThreadTaken(`thread ${THREAD} already has a live local writer`)).toBe(true)
    expect(codexThreadTaken('thread not found: ' + THREAD)).toBe(false)
    expect(codexThreadTaken('codex app-server 超时未回 thread/resume')).toBe(false)
  })
})

describe('适配器:被占 = 这条路此刻做不了(unsupported),不是普通失败', () => {
  it('捎话:回 unsupported,引擎据此换路', async () => {
    const { adapter, link } = codexRig()
    const out = await adapter.run(job())
    expect(out).toMatchObject({ delivered: 'not_sent', unsupported: true, via: 'none', why: CODEX_THREAD_TAKEN_WHY })
    link.close()
  })

  it('替她答:同一条路(同一个判法,不另写一份)', async () => {
    const { adapter, link } = codexRig()
    const out = await adapter.run(job({ kind: 'answer', expect: 'reply' }))
    expect(out.unsupported).toBe(true)
    expect(out.why).toBe(CODEX_THREAD_TAKEN_WHY)
    link.close()
  })

  it('按停止:也回 unsupported(停那一轮也要先 resume)', async () => {
    const { adapter, link } = codexRig()
    const out = await adapter.run(job({ kind: 'stop', expect: 'none' }))
    expect(out.unsupported).toBe(true)
    expect(out.why).toBe(CODEX_THREAD_TAKEN_WHY)
    link.close()
  })

  it('那一句失败话里**没有英文原句**(不把 already has an active writer 甩给她)', async () => {
    const { adapter, link } = codexRig()
    const out = await adapter.run(job())
    expect(out.why ?? '').not.toContain('active writer')
    expect(out.why ?? '').toContain('Codex App')
    link.close()
  })

  it('读一眼:回 unsupported + 人话,**不说成「它还没回」**', async () => {
    const { adapter, link } = codexRig()
    const seen = await adapter.read?.(job({ expect: 'reply' }))
    expect(seen?.reply).toBeUndefined()
    expect(seen?.busy).toBeUndefined()
    expect(seen?.unsupported).toBe(true)
    expect(seen?.why ?? '').not.toContain('active writer')
    link.close()
  })

  it('别的 resume 失败照旧是普通失败(不换路、原话带上)', async () => {
    const { adapter, link } = codexRig('thread not found: ' + THREAD)
    const out = await adapter.run(job())
    expect(out.unsupported).toBeUndefined()
    expect(out.via).toBe('protocol')
    expect(out.why).toContain('thread not found')
    link.close()
  })
})

/* ───────────── 引擎那一头:换到窗口那只手 ───────────── */

const ALL_CAPS: AdapterCapabilities = { open: true, send: true, read: true, press: true, approve: true, writeAsk: true, stop: true, openSession: true }

function fakeAdapter(input: {
  via: JobResult['via']
  answer: (job: Job) => JobResult
  read?: (job: Job) => AdapterReadResult
  caps?: Partial<AdapterCapabilities>
}): Adapter & { calls: () => number } {
  let calls = 0
  return {
    family: 'codex',
    via: input.via,
    capabilities: () => Promise.resolve({ ...ALL_CAPS, ...input.caps }),
    run: (one) => { calls += 1; return Promise.resolve(input.answer(one)) },
    ...(input.read === undefined ? {} : { read: (one: Job) => Promise.resolve((input.read as (j: Job) => AdapterReadResult)(one)) }),
    calls: () => calls,
  }
}

function engineWith(adapters: readonly Adapter[], options: { lockQueue?: { add: (job: Job) => boolean } } = {}) {
  const clock = { value: 1_000_000 }
  const now = (): Date => new Date(clock.value)
  const log = createJobLog({ now })
  const gate = createActionGate({ phaseOf: () => 'open', log, now, name: () => 'Codex' })
  const registry = createRegistry({ now })
  for (const one of adapters) registry.register(one)
  const engine = createEngine({
    registry,
    gate,
    log,
    now,
    name: () => 'Codex',
    sleep: (ms) => { clock.value += ms; return Promise.resolve() },
    warn: () => {},
    ...(options.lockQueue === undefined ? {} : { lockQueue: options.lockQueue }),
  })
  return { engine, log }
}

describe('引擎:协议说做不了 → 窗口那只手(她的那句话不丢)', () => {
  it('窗口送成了 → confirmed,走的是窗口', async () => {
    const protocol = fakeAdapter({
      via: 'protocol',
      answer: () => ({ delivered: 'not_sent', via: 'none', evidence: 'none', unsupported: true, why: CODEX_THREAD_TAKEN_WHY }),
    })
    const window = fakeAdapter({
      via: 'window',
      answer: () => ({ delivered: 'confirmed', via: 'window', evidence: 'window', bundle_id: 'com.openai.codex' }),
    })
    const { engine } = engineWith([protocol, window])
    const out = await engine.run(job())
    expect(out).toMatchObject({ delivered: 'confirmed', via: 'window' })
    expect(protocol.calls()).toBe(1)
    expect(window.calls()).toBe(1)
  })

  it('窗口撞上锁屏 → 排进队、记 waiting、说的是锁屏那句人话(不是英文原句)', async () => {
    const queued: Job[] = []
    const protocol = fakeAdapter({
      via: 'protocol',
      answer: () => ({ delivered: 'not_sent', via: 'none', evidence: 'none', unsupported: true, why: CODEX_THREAD_TAKEN_WHY }),
    })
    const window = fakeAdapter({
      via: 'window',
      answer: () => ({ delivered: 'not_sent', via: 'window', evidence: 'none', screenLocked: true, why: '锁着屏' }),
    })
    const { engine, log } = engineWith([protocol, window], {
      lockQueue: { add: (one) => { queued.push(one); return true } },
    })
    const out = await engine.run(job())
    expect(out.screenLocked).toBe(true)
    expect(queued).toHaveLength(1)
    expect(out.why).toBe(screenLockedSay({ agentName: 'Codex', queued: true, protocols: [] }))
    expect(out.why ?? '').not.toContain('active writer')
    expect(log.events(sessionJobId('codex', THREAD)).some(one => one.step === 'waiting')).toBe(true)
  })
})

describe('引擎 read:协议读不了这一段 → 换下一条读得到的通道', () => {
  it('协议回 unsupported → 读窗那条接着读,读到了', async () => {
    const protocol = fakeAdapter({
      via: 'protocol',
      answer: () => ({ delivered: 'not_sent', via: 'none', evidence: 'none', unsupported: true }),
      read: () => ({ via: 'protocol', evidence: 'none', unsupported: true, why: CODEX_THREAD_TAKEN_WHY }),
    })
    const window = fakeAdapter({
      via: 'window',
      answer: () => ({ delivered: 'confirmed', via: 'window' }),
      read: () => ({ reply: '好,我不动那个文件', evidence: 'window', via: 'window' }),
    })
    const { engine } = engineWith([protocol, window])
    const seen = await engine.read(job({ expect: 'reply' }))
    expect(seen).toMatchObject({ reply: '好,我不动那个文件', via: 'window' })
  })

  it('两条都说读不了 → 如实说,**不说成「它还没回」**', async () => {
    const protocol = fakeAdapter({
      via: 'protocol',
      answer: () => ({ delivered: 'not_sent', via: 'none', evidence: 'none', unsupported: true }),
      read: () => ({ via: 'protocol', evidence: 'none', unsupported: true, why: CODEX_THREAD_TAKEN_WHY }),
    })
    const { engine } = engineWith([protocol])
    const seen = await engine.read(job({ expect: 'reply' }))
    expect(seen.reply).toBeUndefined()
    expect(seen.why).toBe(CODEX_THREAD_TAKEN_WHY)
  })
})
