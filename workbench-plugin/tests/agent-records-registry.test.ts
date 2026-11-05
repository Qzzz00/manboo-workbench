// @vitest-environment node
/**
 * **窗口型那几家里有本机对话库的,在跑 / 做完以它的库为准,读窗口退成兜底**(2026-10-08,千问办公)。
 *
 * 真机现场:千问办公被窗口槽藏起来后,Chromium 的辅助功能树停在藏起那一刻 —— 窗口上「规划中 ... 13.7s」挂着不动,
 * 读屏判不准在跑 / 做完。夹具里那扇窗就是这个样子(停在「在跑」那一拍),而它的库说的是实话。
 */
import { describe, expect, it } from 'vitest'
import { registryOnlySession } from '../src/protocol.ts'
import { createAgentDiscovery, READ_IDLE_MS } from '../src/server/agentDiscovery.ts'
import type { AgentRecordRead, AgentRecordReaders } from '../src/server/agentRecords.ts'
import { RECORD_LEVEL_LINE, RECORD_SOURCE_LABEL, SCREEN_ONLY_NOTE, SCREEN_SOURCE_LABEL } from '../src/server/agentRecords.ts'
import { createMemoryRegistryStore, windowSessionId } from '../src/server/agentRegistry.ts'
import { chatProbe, chatRead, fakeModel, fakeShell } from './fixtures/agentWorld.ts'

const BUNDLE = 'cn.qwenwork.desktop.mac'

function world(initial: AgentRecordRead | undefined, options: { bundle?: string, name?: string } = {}) {
  const bundle = options.bundle ?? BUNDLE
  const logs: string[] = []
  let clock = new Date('2026-10-08T12:00:00Z')
  let records = initial
  let active = false
  const app = {
    bundle_id: bundle, name: options.name ?? '千问办公', category: 'public.app-category.productivity', running: true,
    get active() { return active },
    probe: chatProbe(),
    // 窗口停在藏起那一刻:一直「在跑」。
    read: () => chatRead({ busy: true, answer: '规划中' }),
  }
  const shell = fakeShell([app])
  const readers: AgentRecordReaders = { has: id => id === BUNDLE, hasReply: () => false, read: () => records, canReply: () => false, reply: async () => undefined }
  const discovery = createAgentDiscovery({
    store: createMemoryRegistryStore(),
    helper: shell.helper,
    judge: fakeModel({ [options.name ?? '千问办公']: 'ai_agent' }, {}).judge,
    remainingCny: async () => 4.5,
    inCall: () => false,
    sessions: () => [],
    records: readers,
    log: line => { logs.push(line) },
    now: () => clock,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
  })
  return {
    discovery,
    set: (next: AgentRecordRead | undefined) => { records = next },
    setActive: (value: boolean) => { active = value },
    advance: (ms: number) => { clock = new Date(clock.getTime() + ms) },
    at: () => clock.toISOString(),
    entry: () => discovery.view().entries.find(one => one.id === bundle),
    logs,
  }
}

const running = (at: string): AgentRecordRead => ({ chats: [
  { id: 'a', title: '起草众筹发货邮件', status: 'running', latest: '正在整理', updated_at: at, started_at: at },
  { id: 'b', title: '审阅会议逐字稿', status: 'done', latest: '有三处要改。', updated_at: '2026-10-08T05:53:58.000Z', finished_at: '2026-10-08T05:53:58.000Z' },
] })
const done = (at: string): AgentRecordRead => ({ chats: [
  { id: 'a', title: '起草众筹发货邮件', status: 'done', latest: '邮件草稿好了。', updated_at: at, finished_at: at },
  { id: 'b', title: '审阅会议逐字稿', status: 'done', latest: '有三处要改。', updated_at: '2026-10-08T05:53:58.000Z', finished_at: '2026-10-08T05:53:58.000Z' },
] })

describe('读它自己的记录:登记表里那一家的会话从它的库长出来', () => {
  it('★来源那一格写明「它自己的记录」,读窗口标成兜底;会话 via=records、一条对话一条,会话号与读窗口同一个算法', async () => {
    const w = world(undefined)
    await w.discovery.tick()
    w.set(running(w.at()))
    await w.discovery.tick()
    const entry = w.entry()
    expect(entry?.sources[0]).toEqual({ kind: 'records', label: RECORD_SOURCE_LABEL, ok: true })
    expect(entry?.sources[1]).toMatchObject({ kind: 'window', note: expect.stringContaining('兜底') })
    expect(entry?.status).toBe('running')
    expect(entry?.title).toBe('起草众筹发货邮件')
    expect(entry?.latest).toBe('正在整理')
    expect(entry?.titles).toEqual(['起草众筹发货邮件', '审阅会议逐字稿'])
    expect(entry?.sessions.map(one => [one.title, one.status, one.via])).toEqual([
      ['起草众筹发货邮件', 'running', 'records'],
      ['审阅会议逐字稿', 'done', 'records'],
    ])
    expect(entry?.sessions[0]?.session_id).toBe(windowSessionId({ title: '起草众筹发货邮件' }))
    expect(entry?.counts.running).toBe(1)
    // 捎话候选、「在等你」、手机最近会话都按这一处判把它并进来。
    expect(entry?.sessions.every(registryOnlySession)).toBe(true)
    // 接上之前就做完的旧对话不算没看过。
    expect(entry?.counts.unread).toBe(0)
  })

  it('★窗口停在「在跑」那一拍(藏着不刷新),库说做完了 → 做完、蓝点、冒「回了」', async () => {
    const w = world(undefined)
    await w.discovery.tick()
    w.set(running(w.at()))
    await w.discovery.tick()
    w.advance(10_000)
    w.set(done(w.at()))
    await w.discovery.tick()
    const entry = w.entry()
    expect(entry?.status).toBe('idle')
    expect(entry?.sessions[0]).toMatchObject({ status: 'done', unread: true, summary: '邮件草稿好了。' })
    expect(entry?.counts.unread).toBe(1)
    expect(entry?.bubble).toMatchObject({ kind: 'replied', text: '千问办公 回了:邮件草稿好了。' })
    // 她看过了 → 蓝点收掉。
    await w.discovery.markRead(BUNDLE)
    expect(w.entry()?.counts.unread).toBe(0)
  })

  it('开始跑了冒「开始跑了」;她正停在它那扇窗前时不冒、做完也不记没看过', async () => {
    const w = world(undefined)
    await w.discovery.tick()
    w.set(done('2026-10-08T05:00:00.000Z'))
    await w.discovery.tick()
    w.set(running(w.at()))
    await w.discovery.tick()
    expect(w.entry()?.bubble).toMatchObject({ kind: 'started', text: '千问办公 开始跑了' })

    await w.discovery.markRead(BUNDLE)
    w.discovery.handleAppEvent({ event: 'activated', bundle_id: BUNDLE })
    w.advance(5000)
    w.set(done(w.at()))
    await w.discovery.tick()
    expect(w.entry()?.bubble).toBeUndefined()
    expect(w.entry()?.counts.unread).toBe(0)
  })

  it('★库读不了(表的样子变了)→ 来源那一格如实说,整家退回读窗口', async () => {
    const w = world(undefined)
    await w.discovery.tick()
    w.advance(READ_IDLE_MS)
    await w.discovery.tick()
    const entry = w.entry()
    expect(entry?.sources[0]).toMatchObject({ kind: 'records', ok: false, note: expect.stringContaining('退回读它的窗口') })
    expect(entry?.sessions[0]?.via).toBe('window')
    // 读窗口照旧判(窗口上有停止键)。
    expect(entry?.status).toBe('running')
  })

  it('「在等你」那一份拿到的是库里最新那条对话(同一个会话号)', async () => {
    const w = world(undefined)
    await w.discovery.tick()
    w.set(done(w.at()))
    await w.discovery.tick()
    expect(w.discovery.windows()).toEqual([expect.objectContaining({
      agent: BUNDLE, session_id: windowSessionId({ title: '起草众筹发货邮件' }), latest: '邮件草稿好了。', status: 'done', answered: true,
    })])
  })
})

describe('新接一家时先找它的记录(根治方案第三节第 2 条)', () => {
  it('★有记录这一路的那一家:接上那一刻说「先读它自己的记录」', async () => {
    const w = world(running('2026-10-08T12:00:00.000Z'))
    await w.discovery.tick()
    expect(w.logs.some(line => line.includes('新接上一家:千问办公'))).toBe(true)
    expect(w.logs).toContain(`[agents] 千问办公:${RECORD_LEVEL_LINE}`)
  })

  it('★本机没有它能读的记录:接上那一刻如实说只能看屏幕,来源那一格同样写明', async () => {
    const w = world(undefined, { bundle: 'com.example.screenonly', name: '某家' })
    await w.discovery.tick()
    expect(w.logs).toContain(`[agents] 某家:${SCREEN_ONLY_NOTE}`)
    expect(w.entry()?.sources.map(one => one.kind)).toEqual(['window'])
    expect(w.entry()?.sources[0]?.label).toBe(SCREEN_SOURCE_LABEL)
  })
})

