// @vitest-environment node
/**
 * **派活收回答从它自己的记录里取**(2026-10-09,卡「千问派活收回答」;交接 `docs/交接-1009-千问派活收回答.md`)。
 *
 * 千问办公被窗口槽藏着时辅助功能树停在藏起那一刻,读窗读到的回答是旧的 / 半截的。
 * 它的库里按「送进去那句」能找到那一轮、那一轮 completed 后取回答正文 —— 这是第一级来源。
 * 引擎里多一条只读的「记录文件」通道(`via:'file'`,契约里早有这一种),**读**的时候排在窗口前;
 * 读不了(库缺席 / 表变了 / 还没找到那一句)回 `unsupported`,引擎照旧换到读窗口(兜底)。
 */
import { describe, expect, it } from 'vitest'
import { createActionGate } from '../src/server/actionGate.ts'
import type { AgentRecordReaders, AgentRecordReply } from '../src/server/agentRecords.ts'
import type { Adapter, AdapterCapabilities, AdapterReadResult, Job, JobResult } from '../src/server/engine/adapter.ts'
import { READ_SEEN_EVIDENCE } from '../src/server/engine/adapter.ts'
import { RECORDS_NOT_YET_WHY, RECORDS_UNREADABLE_WHY, createRecordsAdapter } from '../src/server/engine/adapters/records.ts'
import { READ_BUSY_WHY } from '../src/server/engine/adapters/window.ts'
import { createEngine } from '../src/server/engine/engine.ts'
import { createRegistry } from '../src/server/engine/registry.ts'
import { createEngineWiring } from '../src/server/engine/wire.ts'
import { createJobLog } from '../src/server/jobLog.ts'

const BUNDLE = 'cn.example.records'
const MARK = '工作台派活 abc123'

function readers(reply: (marker: string) => AgentRecordReply | undefined, opts: { readable?: boolean } = {}): AgentRecordReaders & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    has: bundleId => bundleId === BUNDLE,
    hasReply: bundleId => bundleId === BUNDLE,
    read: () => undefined,
    canReply: bundleId => bundleId === BUNDLE && opts.readable !== false,
    reply: async (bundleId, marker) => {
      asked.push(`${bundleId}|${marker}`)
      return bundleId === BUNDLE ? reply(marker) : undefined
    },
  }
}

function job(over: Partial<Job> = {}): Job {
  return {
    id: 't-abc123',
    itemId: 't-abc123',
    family: BUNDLE,
    kind: 'dispatch',
    target: { kind: 'current' },
    text: `【${MARK}】帮我改短一点`,
    marks: [MARK],
    expect: 'reply',
    ...over,
  }
}

describe('记录文件这条通道(只读)', () => {
  it('★那一轮收了 → 回答正文,证据是 transcript,走的是记录文件', async () => {
    const adapter = createRecordsAdapter(BUNDLE, { bundleIds: [BUNDLE], readers: readers(() => ({ found: true, status: 'done', reply: '改好了' })) })
    expect(adapter.via).toBe('file')
    expect(await adapter.read?.(job())).toEqual({ via: 'file', evidence: 'transcript', reply: '改好了' })
  })

  it('★还在跑 → busy、没有 reply(不给半截)', async () => {
    const adapter = createRecordsAdapter(BUNDLE, { bundleIds: [BUNDLE], readers: readers(() => ({ found: true, status: 'running' })) })
    expect(await adapter.read?.(job())).toEqual({ via: 'file', evidence: 'transcript', busy: true, why: READ_BUSY_WHY })
  })

  it('★库读不了 / 库里还没这一句 → unsupported(引擎换窗口),不说成「它还没回」', async () => {
    const broken = createRecordsAdapter(BUNDLE, { bundleIds: [BUNDLE], readers: readers(() => undefined) })
    expect(await broken.read?.(job())).toEqual({ via: 'file', evidence: 'none', unsupported: true, why: RECORDS_UNREADABLE_WHY })
    const notYet = createRecordsAdapter(BUNDLE, { bundleIds: [BUNDLE], readers: readers(() => ({ found: false })) })
    expect(await notYet.read?.(job())).toEqual({ via: 'file', evidence: 'none', unsupported: true, why: RECORDS_NOT_YET_WHY })
  })

  it('按 marks[0] 找;没给记号就取她那句的第一行(同捎话的认法);点名的包不归这条记录管 → unsupported', async () => {
    const r = readers(() => ({ found: true, status: 'running' }))
    const adapter = createRecordsAdapter(BUNDLE, { bundleIds: [BUNDLE], readers: r })
    await adapter.read?.(job())
    const { marks: _marks, ...bare } = job({ text: '帮我看看这份逐字稿\n第二行' })
    await adapter.read?.(bare)
    expect(r.asked).toEqual([`${BUNDLE}|${MARK}`, `${BUNDLE}|帮我看看这份逐字稿`])
    expect((await adapter.read?.(job({ package: 'other.bundle' })))?.unsupported).toBe(true)
  })

  it('停掉的那一轮有字照样交回来;没字 → 看见了那一句、但没有回答(交给上层等 / 超时如实说)', async () => {
    const withText = createRecordsAdapter(BUNDLE, { bundleIds: [BUNDLE], readers: readers(() => ({ found: true, status: 'done', reply: '写到一半', stopped: true })) })
    expect((await withText.read?.(job()))?.reply).toBe('写到一半')
    const empty = createRecordsAdapter(BUNDLE, { bundleIds: [BUNDLE], readers: readers(() => ({ found: true, status: 'done', stopped: true })) })
    const out = await empty.read?.(job())
    expect(out?.reply).toBeUndefined()
    expect(out?.evidence).toBe('transcript')
    expect(out?.busy).toBeUndefined()
  })

  it('★只会读:送 / 点 / 停一样都不会;库不在时连读都不报', async () => {
    const adapter = createRecordsAdapter(BUNDLE, { bundleIds: [BUNDLE], readers: readers(() => undefined) })
    const caps = await adapter.capabilities()
    expect(caps).toEqual({ open: false, send: false, read: true, press: false, approve: false, writeAsk: false, stop: false, openSession: false })
    const gone = createRecordsAdapter(BUNDLE, { bundleIds: [BUNDLE], readers: readers(() => undefined, { readable: false }) })
    expect((await gone.capabilities()).read).toBe(false)
    expect((await adapter.run(job())).delivered).toBe('not_sent')
  })

  it('读到了算「在它那边看见我们那一句」:transcript 在 READ_SEEN_EVIDENCE 里', () => {
    expect(READ_SEEN_EVIDENCE).toContain('transcript')
    expect(READ_SEEN_EVIDENCE).toContain('window')
    expect(READ_SEEN_EVIDENCE).not.toContain('none')
  })
})

/* ───────────── 引擎那一头:读的时候记录在前、窗口兜底 ───────────── */

const ALL_CAPS: AdapterCapabilities = { open: true, send: true, read: true, press: true, approve: true, writeAsk: true, stop: true, openSession: false }

function fakeWindow(read: () => AdapterReadResult): Adapter & { reads: () => number } {
  let reads = 0
  return {
    family: BUNDLE,
    via: 'window',
    capabilities: () => Promise.resolve(ALL_CAPS),
    run: () => Promise.resolve<JobResult>({ delivered: 'confirmed', via: 'window', evidence: 'window' }),
    read: () => { reads += 1; return Promise.resolve(read()) },
    reads: () => reads,
  }
}

function engineWith(adapters: readonly Adapter[]) {
  const now = (): Date => new Date(1_000_000)
  const log = createJobLog({ now })
  const gate = createActionGate({ phaseOf: () => 'open', log, now, name: () => '千问办公' })
  const registry = createRegistry({ now })
  for (const one of adapters) registry.register(one)
  return createEngine({ registry, gate, log, now, name: () => '千问办公', sleep: () => Promise.resolve(), warn: () => {} })
}

describe('引擎:派活读回话先问它的记录,读不了再读窗口', () => {
  it('★派活(派活送话时窗口排在记录前)读的时候记录在前:窗口一眼都不读', async () => {
    const window = fakeWindow(() => ({ via: 'window', evidence: 'window', reply: '窗口里读到的旧画面' }))
    const records = createRecordsAdapter(BUNDLE, { bundleIds: [BUNDLE], readers: readers(() => ({ found: true, status: 'done', reply: '库里的答' })) })
    const engine = engineWith([window, records])
    const got = await engine.read(job())
    expect(got.reply).toBe('库里的答')
    expect(got.via).toBe('file')
    expect(window.reads()).toBe(0)
  })

  it('★库读不了 → 换到窗口那一条(兜底)', async () => {
    const window = fakeWindow(() => ({ via: 'window', evidence: 'window', reply: '窗口里读到的' }))
    const records = createRecordsAdapter(BUNDLE, { bundleIds: [BUNDLE], readers: readers(() => undefined) })
    const engine = engineWith([window, records])
    const got = await engine.read(job())
    expect(got.reply).toBe('窗口里读到的')
    expect(window.reads()).toBe(1)
  })

  it('库说还在跑 → 照实回在跑,不去读那扇可能停住的窗', async () => {
    const window = fakeWindow(() => ({ via: 'window', evidence: 'window', reply: '停住的画面' }))
    const records = createRecordsAdapter(BUNDLE, { bundleIds: [BUNDLE], readers: readers(() => ({ found: true, status: 'running' })) })
    const got = await engineWith([window, records]).read(job())
    expect(got.busy).toBe(true)
    expect(got.reply).toBeUndefined()
    expect(window.reads()).toBe(0)
  })

  it('送话照旧走窗口(记录这一条不会送)', async () => {
    const window = fakeWindow(() => ({ via: 'window', evidence: 'none' }))
    const records = createRecordsAdapter(BUNDLE, { bundleIds: [BUNDLE], readers: readers(() => undefined) })
    const out = await engineWith([records, window]).run(job({ expect: 'ack' }))
    expect(out.via).toBe('window')
  })
})

describe('接线:有记录这一路的那一家,登记窗口那一条时一起登记记录那一条', () => {
  const windowDeps = {
    helper: { connected: () => false, request: () => Promise.reject(new Error('no')) },
  } as unknown as NonNullable<Parameters<typeof createEngineWiring>[0]['window']>

  it('★问到那一家才登记(不凭空把一家列进候选);判断里不写包名', () => {
    const now = (): Date => new Date(1_000_000)
    const log = createJobLog({ now })
    const gate = createActionGate({ phaseOf: () => 'open', log, now })
    const wiring = createEngineWiring({ gate, log, window: windowDeps, records: readers(() => undefined) })
    expect(wiring.registry.all().some(one => one.via === 'file')).toBe(false)
    const vias = wiring.registry.channelsOf(BUNDLE).map(one => one.via)
    expect(vias).toEqual(['file', 'window'])
    // 没有记录这一路的家不多一条
    expect(wiring.registry.channelsOf('com.example.other').map(one => one.via)).toEqual(['window'])
    wiring.close()
  })

  it('没接记录(用例 / 老接线)→ 一字不变,只有窗口', () => {
    const now = (): Date => new Date(1_000_000)
    const log = createJobLog({ now })
    const gate = createActionGate({ phaseOf: () => 'open', log, now })
    const wiring = createEngineWiring({ gate, log, window: windowDeps })
    expect(wiring.registry.channelsOf(BUNDLE).map(one => one.via)).toEqual(['window'])
    wiring.close()
  })
})
