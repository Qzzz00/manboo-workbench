// @vitest-environment node
/**
 * **那一问已经不在了 → 排着的那一通撤掉**(2026-09-28,卡 AQ)。
 *
 * 现场(维护者本机 + Codex 桌面版,0.4.55,18:0x):Codex 弹的那道选项题她在电脑上答掉了
 * (`/asks/answer {choice:'川菜'}` → `confirmed:true`),可 `call-out.json` 里那一通还挂着
 * `state:'queued'` —— 当时房里没有在线手机,没响。等手机上线,它就要为**一个已经答掉的问**打过去。
 *
 * 那通电话响起来说的是假话:「Codex 在等你选:你最喜欢哪种菜系?」—— 它不等了。
 * 所以这一份钉住三条:
 *   1. 那一问没了(会话不再 waiting)→ 排着的那一通撤掉,记一笔「已经答了,不打了」;
 *   2. **同一条会话换了一问**(`ask.since` 变了)→ 老那一通撤掉,新那一问照旧排一通(别把新问吞了);
 *   3. **事项那一路同一规矩**:卡停在「阻塞 · 等你输入」时排的那一通,他答完卡不再阻塞 → 撤掉。
 * 另外两条纪律:**已经被工人领走(`ringing`)的不动**(那通正在响,撤不回来,不假装撤了);
 * **事实源这一拍取不到时一通都不撤**(读不到看板 ≠ 那一问没了)。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallOutEntry, TaskView, TasksState } from '../src/protocol.ts'
import { createCallOutService, mootQueuedAsks, CALL_OUT_MOOT_ASK_ERROR } from '../src/server/callOut.ts'

const dirs: string[] = []
function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-ask-drop-'))
  dirs.push(dir)
  return join(dir, 'call-out.json')
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const since = '2026-09-28T10:05:00.000Z'
const item = 'session:01a0e710'
const key = `ask:session:01a0e710:${since}`

function askEvent(patch: { key?: string, item_id?: string, at?: string } = {}) {
  return {
    key: patch.key ?? key,
    reason: 'ask' as const,
    item_id: patch.item_id ?? item,
    title: 'Codex 在等你选:你最喜欢哪种菜系?',
    at: patch.at ?? since,
  }
}

function queued(patch: Partial<CallOutEntry> = {}): CallOutEntry {
  return {
    id: 'call-1',
    key,
    reason: 'ask',
    item_id: item,
    title: 'Codex 在等你选:你最喜欢哪种菜系?',
    at: since,
    state: 'queued',
    silent: false,
    queued_at: since,
    due_at: since,
    ...patch,
  }
}

describe('那一问没了 → 排着的那一通撤掉(纯函数)', () => {
  it('★事件里已经没有这一问了 → 这一通该撤', () => {
    expect(mootQueuedAsks({ log: [queued()], events: [] }).map(one => one.id)).toEqual(['call-1'])
  })

  it('那一问还在 → 一通都不撤', () => {
    expect(mootQueuedAsks({ log: [queued()], events: [askEvent()] })).toEqual([])
  })

  it('★同一条会话换了一问(since 变了)→ 老那一通撤掉(那一句已经不对了)', () => {
    const next = askEvent({ key: 'ask:session:01a0e710:2026-09-28T10:09:00.000Z', at: '2026-09-28T10:09:00.000Z' })
    expect(mootQueuedAsks({ log: [queued()], events: [next] }).map(one => one.id)).toEqual(['call-1'])
  })

  it('★已经被工人领走的那通(ringing)不动 —— 撤不回来,不假装撤了', () => {
    expect(mootQueuedAsks({ log: [queued({ state: 'ringing' })], events: [] })).toEqual([])
  })

  it('已经收场的(未接 / 已接 / 只发了通知 / 没打出去)一条都不碰', () => {
    const log = (['missed', 'answered', 'notified', 'failed'] as const).map((state, i) => queued({ id: `c-${i}`, state }))
    expect(mootQueuedAsks({ log, events: [] })).toEqual([])
  })

  it('只撤「等你答」那一档:等你确认 / 办完了 / 失败那几通不归这条规矩管', () => {
    const log = (['confirm', 'done', 'failed', 'relay'] as const).map((reason, i) => queued({ id: `c-${i}`, reason, key: `${reason}:${item}` }))
    expect(mootQueuedAsks({ log, events: [] })).toEqual([])
  })

  it('老台账里那几条没有 key → 不动(宁可多响一次,也不按猜测撤一通)', () => {
    const old = { ...queued() }
    delete (old as { key?: string }).key
    expect(mootQueuedAsks({ log: [old], events: [] })).toEqual([])
  })

  it('★并进这一通的另一问还在等 → 不撤(那一通里还有正事)', () => {
    const merged = queued({ merged: [{ item_id: 'session:other', title: 'Kimi 在等你答:要不要继续?' }] })
    const other = askEvent({ key: 'ask:session:other:x', item_id: 'session:other' })
    expect(mootQueuedAsks({ log: [merged], events: [other] })).toEqual([])
  })
})

describe('走一拍就把它撤了(service.pump)', () => {
  function tasksOf(...list: TaskView[]): { list: () => Promise<TasksState> } {
    return { list: async () => ({ tasks: list, updated_at: since } as unknown as TasksState) }
  }

  it('★她答完那一问:下一拍那一通记成「没打出去」,理由是人话,工人再也领不走它', async () => {
    let live = true
    const service = createCallOutService({
      file: tmpFile(),
      newId: () => 'call-1',
      askEvents: async () => (live ? [askEvent()] : []),
      now: () => Date.parse('2026-09-28T18:05:00+08:00'),
    })
    await service.load()
    await service.pump()
    expect(service.view().entries[0]).toMatchObject({ id: 'call-1', reason: 'ask', state: 'queued', silent: false })
    live = false
    await service.pump()
    expect(service.view().entries[0]).toMatchObject({ id: 'call-1', state: 'failed', error: CALL_OUT_MOOT_ASK_ERROR })
    // 撤掉的那一通工人领不走(claim 只认 queued)。
    expect(await service.claim()).toEqual([])
    // 答过的那一问不会再排第二通(key 还记在「打过了」里)。
    await service.pump()
    expect(service.view().entries).toHaveLength(1)
  })

  it('★事实源这一拍取不到(看板读炸了)→ 一通都不撤', async () => {
    let live = true
    const service = createCallOutService({
      file: tmpFile(),
      newId: () => 'call-1',
      tasks: { list: async () => { if (live) return { tasks: [], updated_at: since } as unknown as TasksState; throw new Error('读不到看板') } },
      askEvents: async () => (live ? [askEvent()] : []),
      now: () => Date.parse('2026-09-28T18:05:00+08:00'),
    })
    await service.load()
    await service.pump()
    expect(service.view().entries[0]).toMatchObject({ state: 'queued' })
    live = false
    await service.pump()
    expect(service.view().entries[0]).toMatchObject({ state: 'queued' })
  })

  it('★事项那一路同一规矩:卡不再「阻塞 · 等你输入」→ 排着的那一通撤掉', async () => {
    const blocked: TaskView = {
      id: 't-1', title: '导出 PDF', direction: 'mine', source: 'manual',
      status: 'blocked', block_reason: 'input', note: '她在等你回话',
      created_at: since, updated_at: since,
    } as unknown as TaskView
    const done: TaskView = { ...blocked, status: 'running', block_reason: undefined } as unknown as TaskView
    let answered = false
    const service = createCallOutService({
      file: tmpFile(),
      newId: () => 'call-1',
      tasks: { list: async () => ({ tasks: [answered ? done : blocked], updated_at: since } as unknown as TasksState) },
      now: () => Date.parse('2026-09-28T18:05:00+08:00'),
    })
    await service.load()
    await service.pump()
    expect(service.view().entries[0]).toMatchObject({ reason: 'ask', item_id: 't-1', state: 'queued' })
    answered = true
    await service.pump()
    expect(service.view().entries[0]).toMatchObject({ state: 'failed', error: CALL_OUT_MOOT_ASK_ERROR })
  })

  it('★她答完就撤(不等下一拍):/asks/answer 那一路直接叫 drop', async () => {
    const service = createCallOutService({
      file: tmpFile(),
      newId: () => 'call-1',
      askEvents: async () => [askEvent()],
      now: () => Date.parse('2026-09-28T18:05:00+08:00'),
    })
    await service.load()
    await service.pump()
    expect(await service.drop({ reason: 'ask', item_id: item })).toEqual({ ok: true, dropped: 1 })
    expect(service.view().entries[0]).toMatchObject({ state: 'failed', error: CALL_OUT_MOOT_ASK_ERROR })
    // 再叫一次没得撤,也不写盘。
    expect(await service.drop({ reason: 'ask', item_id: item })).toEqual({ ok: true, dropped: 0 })
    // 那一问在事实源里还挂着(那家窗口还没重读)也不会再排一通:key 记过了。
    await service.pump()
    expect(service.view().entries).toHaveLength(1)
  })

  it('正在响的那一通:drop 撤不掉它,如实回 0', async () => {
    const service = createCallOutService({
      file: tmpFile(),
      newId: () => 'call-1',
      askEvents: async () => [askEvent()],
      now: () => Date.parse('2026-09-28T18:05:00+08:00'),
    })
    await service.load()
    await service.pump()
    await service.claim()
    expect(await service.drop({ reason: 'ask', item_id: item })).toEqual({ ok: true, dropped: 0 })
    expect(service.view().entries[0]).toMatchObject({ state: 'ringing' })
  })
})
