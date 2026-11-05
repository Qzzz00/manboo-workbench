/**
 * 「等你回答」的 5 分钟合并窗,**上一通里的问都答完了就照响**(2026-10-12 晚,维护者拍板:「改,现在演示等五分钟要死人的」)。
 *
 * 之前:上一通收场后 5 分钟内又来一问 → 只发通知(`silent_reason:'ask'`)。
 * 现在:上一通里那几问(主角 + 并进来的)此刻一个都不在等了 → 新的一问照响;还有在等的 → 照旧只通知。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CallOutEntry } from '../src/protocol.ts'
import { askStillOpen, createCallOutService, lastAskRingEntry, planCallOuts } from '../src/server/callOut.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-call-out-'))
  dirs.push(dir)
  return join(dir, 'call-out.json')
}

const quiet = { from: '23:00', to: '08:00' }
const ask = (key: string, itemId: string, title: string) => ({ key, reason: 'ask' as const, item_id: itemId, title, at: '2026-10-12T06:00:00.000Z' })

describe('askStillOpen:上一通里的问还有没有在等的', () => {
  const rang: Pick<CallOutEntry, 'key' | 'item_id' | 'merged'> = {
    key: 'ask:session:s-1:100', item_id: 's-1',
    merged: [{ item_id: 's-2', title: '乙', key: 'ask:session:s-2:200' }, { item_id: 't-old', title: '老台账没 key' }],
  }
  it('不知道上一通是哪一通(老台账 / 没传)→ 当还在等(照旧的 5 分钟窗)', () => {
    expect(askStillOpen(undefined, [])).toBe(true)
  })
  it('主角那一问的 key 还在 → 在等', () => {
    expect(askStillOpen(rang, [ask('ask:session:s-1:100', 's-1', '甲')])).toBe(true)
  })
  it('并进来的那一问按 key 认:还在 → 在等;同一条会话换了新的一问(新 key)不算', () => {
    expect(askStillOpen(rang, [ask('ask:session:s-2:200', 's-2', '乙')])).toBe(true)
    expect(askStillOpen(rang, [ask('ask:session:s-2:300', 's-2', '乙的下一问')])).toBe(false)
  })
  it('老台账里并进来的没有 key → 按 item_id 兜底', () => {
    expect(askStillOpen(rang, [ask('ask:approval:x', 't-old', '老')])).toBe(true)
  })
  it('一个都不在了 → 不在等', () => {
    expect(askStillOpen(rang, [ask('ask:question:q-9', 't-9', '别的')])).toBe(false)
  })
})

describe('planCallOuts:窗里新来的一问', () => {
  const now = Date.parse('2026-10-12T14:00:00+08:00')
  const rang: Pick<CallOutEntry, 'key' | 'item_id' | 'merged'> = { key: 'ask:session:s-1:100', item_id: 's-1' }
  it('上一通的问答完了(事件里没它了)→ 哪怕才过 1 分钟也照响', () => {
    const plan = planCallOuts({
      events: [ask('ask:session:s-2:200', 's-2', '豆包问你:喝什么')],
      seen: new Set(), waiting: [], now, quiet, newId: () => 'call-1',
      lastAskRingAt: now - 60_000, lastAskRing: rang,
    })
    expect(plan.created[0]).toMatchObject({ reason: 'ask', silent: false })
  })
  it('上一通的问还在等 → 照旧只发通知(silent_reason ask)', () => {
    const plan = planCallOuts({
      events: [ask('ask:session:s-1:100', 's-1', '甲还在等'), ask('ask:session:s-2:200', 's-2', '新的一问')],
      seen: new Set(['ask:session:s-1:100']), waiting: [], now, quiet, newId: () => 'call-1',
      lastAskRingAt: now - 60_000, lastAskRing: rang,
    })
    expect(plan.created[0]).toMatchObject({ reason: 'ask', item_id: 's-2', silent: true, silent_reason: 'ask' })
  })
  it('没传上一通是哪一通(只有时刻)→ 行为与以前逐字相同:窗里只通知', () => {
    const plan = planCallOuts({
      events: [ask('ask:session:s-2:200', 's-2', '新的一问')],
      seen: new Set(), waiting: [], now, quiet, newId: () => 'call-1',
      lastAskRingAt: now - 60_000,
    })
    expect(plan.created[0]).toMatchObject({ silent: true, silent_reason: 'ask' })
  })
})

describe('lastAskRingEntry:上一次真响的那一通', () => {
  it('跳过只通知的、没打出去的;回整条(带 key 与 merged)', () => {
    const log: CallOutEntry[] = [
      { id: 'c1', key: 'ask:a', reason: 'ask', item_id: 't-1', title: '甲', at: '', state: 'answered', silent: false, queued_at: '2026-10-12T06:00:00.000Z', due_at: '', merged: [{ item_id: 't-2', title: '乙', key: 'ask:b' }] },
      { id: 'c2', key: 'ask:c', reason: 'ask', item_id: 't-3', title: '丙', at: '', state: 'notified', silent: true, silent_reason: 'ask', queued_at: '2026-10-12T06:01:00.000Z', due_at: '' },
      { id: 'c3', key: 'ask:d', reason: 'ask', item_id: 't-4', title: '丁', at: '', state: 'failed', silent: false, queued_at: '2026-10-12T06:02:00.000Z', due_at: '' },
    ]
    expect(lastAskRingEntry(log)).toMatchObject({ id: 'c1', key: 'ask:a' })
    expect(lastAskRingEntry([])).toBeUndefined()
  })
})

describe('整条路(服务):豆包连着两问', () => {
  it('第一问响了、她答了、豆包那题没了;1 分钟后第二问(新对话)→ 照响', async () => {
    let clock = new Date('2026-10-12T14:00:00').getTime()
    let asks = [ask('ask:session:s-1:100', 's-1', '豆包问你:喝什么')]
    let seq = 0
    const service = createCallOutService({ file: tmpFile(), newId: () => `call-${++seq}`, askEvents: async () => asks, now: () => clock })
    await service.load()
    await service.pump()
    const [first] = await service.claim()
    expect(first).toMatchObject({ reason: 'ask', silent: false, key: 'ask:session:s-1:100' })
    await service.ack({ id: first!.id, result: 'answered' })
    // 她答了,豆包那一题不在了;1 分钟后另一条对话又问 → 响。
    clock += 60_000
    asks = [ask('ask:session:s-2:200', 's-2', '豆包问你:吃什么')]
    await service.pump()
    expect(service.view().entries.find(entry => entry.item_id === 's-2')).toMatchObject({ silent: false })
  })
  it('第一问响了、她挂了没答、那题还在;1 分钟后第二问 → 照旧只通知', async () => {
    let clock = new Date('2026-10-12T14:00:00').getTime()
    let asks = [ask('ask:session:s-1:100', 's-1', '豆包问你:喝什么')]
    let seq = 0
    const service = createCallOutService({ file: tmpFile(), newId: () => `call-${++seq}`, askEvents: async () => asks, now: () => clock })
    await service.load()
    await service.pump()
    const [first] = await service.claim()
    await service.ack({ id: first!.id, result: 'missed' })
    clock += 60_000
    asks = [...asks, ask('ask:session:s-2:200', 's-2', '豆包问你:吃什么')]
    await service.pump()
    expect(service.view().entries.find(entry => entry.item_id === 's-2')).toMatchObject({ silent: true, silent_reason: 'ask' })
  })
})
