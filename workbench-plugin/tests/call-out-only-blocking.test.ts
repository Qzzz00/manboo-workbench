// @vitest-environment node
/**
 * 来电降噪 + 批准卡一眼看清(2026-09-28,卡 UX)。
 *
 * 现场:维护者 09-28 10:1x 的 Pixel 上「未接来电 18」——「那 18 条我看着都像垃圾短信,实际上真事没几个」。
 * 台账(`~/.dsh/workbench/call-out.json`,124 通)上没收过的 31 条未接实际是:
 *   25 条 `ask`(其中 10 条「进度要你说一句」、9 条同一件事的「这张派给 Claude 开工?」)、5 条 `confirm`、
 *   1 条 `failed`,另外还有 1 条**只发通知**的被记成了未接(工人没回话 → sweepStale 一律记 missed)。
 *
 * 这一份钉的规矩(维护者 09-27 卡 WY 已拍板的口径往座机上落):**只有他不点头就卡住的事才打电话** ——
 * 派活要批、执行中停下来问他、捎话回来了;进度提问、事务官自己的提议、做完了、例程播报**不打**,只进列表 / 通知。
 * 「未接来电」只数**真打过、他没接**的那几通。
 */
import { describe, expect, it } from 'vitest'
import type { CallOutEntry, PendingApprovalView } from '../src/protocol.ts'
import { askCallOutEvents } from '../src/server/butlerAsks.ts'
import {
  callOutKey,
  callOutRings,
  dismissMissedEntries,
  isRoutineItem,
  planCallOuts,
} from '../src/server/callOut.ts'
import { dispatchApprovalFace, waitingOnHim } from '../src/waiting.ts'

const now = Date.parse('2026-09-28T10:15:00+08:00')
const quiet = { from: '23:00', to: '08:00' }
let seq = 0
const newId = (): string => `call-${++seq}`

function event(reason: 'confirm' | 'failed' | 'done' | 'ask' | 'relay', itemId: string) {
  return { key: callOutKey(reason, itemId), reason, item_id: itemId, title: `为 ${itemId}`, at: '2026-09-28T02:10:00.000Z' }
}

function plan(events: ReturnType<typeof event>[], doneCall = false) {
  seq = 0
  return planCallOuts({ events, seen: new Set(), waiting: [], now, quiet, newId, ...(doneCall ? { doneCall } : {}) })
}

describe('只有他不点头就卡住的事才打电话(卡 UX)', () => {
  it('打的三样:派活要批 / 执行中停下来问他(ask)、捎话回来了(relay)、那件事卡住了(failed)', () => {
    const created = plan([event('ask', 't-1'), event('relay', 'r-1'), event('failed', 't-2')]).created
    expect(created.map(one => [one.reason, one.silent])).toEqual([['ask', false], ['relay', false], ['failed', false]])
  })

  it('「办完了等你验收」只发通知 —— 做完了是一条汇报,不是他不点头就卡住的事', () => {
    const created = plan([event('confirm', 't-3')]).created
    expect(created[0]).toMatchObject({ reason: 'confirm', silent: true, silent_reason: 'confirm' })
  })

  it('他把「办完了也打电话给我」打开:办完了那一类照响(不写死,同一个开关管 confirm 与 done)', () => {
    expect(plan([event('confirm', 't-3')], true).created[0]).toMatchObject({ reason: 'confirm', silent: false })
    expect(plan([event('done', 't-4')], true).created[0]).toMatchObject({ reason: 'done', silent: false })
  })

  it('例程播报不打:跑完(done)与跑挂了(failed)都只发通知', () => {
    const created = plan([event('done', 'routine:evening:2026-09-28'), event('failed', 'routine:lint:2026-09-28')]).created
    expect(created.map(one => [one.reason, one.silent, one.silent_reason])).toEqual([
      ['done', true, 'routine'],
      ['failed', true, 'routine'],
    ])
  })

  it('例程那一条连「办完了也打给我」都不认(它是播报,不是他要判的事)', () => {
    expect(plan([event('failed', 'routine:morning:2026-09-28')], true).created[0]).toMatchObject({ silent: true, silent_reason: 'routine' })
    expect(isRoutineItem('routine:morning:2026-09-28')).toBe(true)
    expect(isRoutineItem('t-1')).toBe(false)
  })

  it('判据只有一处:callOutRings', () => {
    expect(callOutRings({ reason: 'ask', item_id: 't-1' }, false)).toBe(true)
    expect(callOutRings({ reason: 'relay', item_id: 'r-1' }, false)).toBe(true)
    expect(callOutRings({ reason: 'failed', item_id: 't-1' }, false)).toBe(true)
    expect(callOutRings({ reason: 'confirm', item_id: 't-1' }, false)).toBe(false)
    expect(callOutRings({ reason: 'done', item_id: 't-1' }, false)).toBe(false)
    expect(callOutRings({ reason: 'failed', item_id: 'routine:lint:2026-09-28' }, true)).toBe(false)
  })
})

describe('事务官自己的提议:座机不为它响,也不进「等你」(卡 WY 的口径,判据换成 proposal 那一格)', () => {
  const at = '2026-09-28T02:00:00.000Z'
  const proposal: PendingApprovalView = {
    id: 'a-1', session_id: 'dispatch:t-9', task_id: 't-9', task_title: '验证自我迭代能力',
    tool: '派给 Claude', reason: '这张派给 Claude 开工?现在:还没看到这件事的进展', say: '这张派给 Claude 开工?', at,
    proposal: true,
  }
  const his: PendingApprovalView = {
    id: 'a-2', session_id: 'dispatch:t-8', task_id: 't-8', task_title: '【工作台自测】让 Manus 帮我查国庆假期',
    tool: '派给 Manus(剩 2,690 积分)', say: '派给 Manus(剩 2,690 积分)', at,
  }

  it('提议那一条一条来电事件都不出;他自己交代之后那一问照旧响(会话 id 前缀一模一样,只有这一格分得开)', () => {
    const events = askCallOutEvents([], [proposal, his])
    expect(events).toHaveLength(1)
    expect(events[0]!.title).toContain('派给 Manus')
  })

  it('「等你」那一堆里也没有它(从前靠认「要你批:这张派给」那句话,漏了别的路)', () => {
    const view = waitingOnHim({ approvals: [proposal, his] } as never)
    expect(view.count).toBe(1)
    expect(view.items[0]!.key).toBe('approval:a-2')
  })
})

describe('「未接来电」只数真打过、他没接的那几通', () => {
  const base = { reason: 'confirm' as const, item_id: 't-1', title: '甲', at: '', queued_at: '2026-09-28T01:00:00.000Z', due_at: '' }
  it('只发过通知的那一条不算未接(它压根没响过)', () => {
    const log: CallOutEntry[] = [
      { ...base, id: 'c1', state: 'missed', silent: false },
      { ...base, id: 'c2', state: 'missed', silent: true },
    ]
    // view() 里那一行的逻辑:真响过、没收过的才数。
    expect(log.filter(one => one.state === 'missed' && !one.silent && one.dismissed_at === undefined)).toHaveLength(1)
  })

  it('「清空」照旧只标记不删,静音那几条一并标上(台账一条不删)', () => {
    const log: CallOutEntry[] = [{ ...base, id: 'c1', state: 'missed', silent: false }]
    const result = dismissMissedEntries(log, now)
    expect(result.dismissed).toBe(1)
    expect(result.log[0]!.dismissed_at).toBeDefined()
  })
})

describe('批准卡一眼看清(卡 UX):大字第一行写着哪件事、派给谁', () => {
  const approval: PendingApprovalView = {
    id: 'a-1', session_id: 'dispatch:t-9', task_id: 't-9', task_title: '验证自我迭代能力',
    tool: '派给 Claude(本周还剩约 28%)', say: '派给 Claude(本周还剩约 28%)', at: '2026-09-28T02:00:00.000Z',
    options: [
      { family: 'claude', title: 'Claude', quota: '本周还剩约 28%', chosen: true },
      { family: 'codex', title: 'Codex', quota: '5 小时窗口还剩约 46%' },
    ],
  }

  it('大字第一行 = 把这件事派给谁;「允许」那颗键带着对象;只留被选中那家的额度', () => {
    const face = dispatchApprovalFace(approval)
    expect(face.headline).toBe('把「验证自我迭代能力」派给 Claude?')
    expect(face.yes).toBe('允许派给 Claude')
    expect(face.chosen?.family).toBe('claude')
    expect(face.others.map(one => one.family)).toEqual(['codex'])
    expect(face.othersLine).toBe('其他可选:Codex')
  })

  it('★卡 BS2(2026-09-28):选项里再也没有「事务官自己做」—— 只有一家时那一行不出现', () => {
    const face = dispatchApprovalFace({
      ...approval,
      options: [{ family: 'claude', title: 'Claude', quota: '本周还剩约 28%', chosen: true }],
    })
    expect(face.headline).toBe('把「验证自我迭代能力」派给 Claude?')
    expect(face.yes).toBe('允许派给 Claude')
    expect(face.othersLine).toBeUndefined()
  })

  it('不是派活那一问(越界写文件之类):一个字没变 —— 还是那句人话 + 「允许这一次」', () => {
    const face = dispatchApprovalFace({
      id: 'a-2', session_id: 'session-07ed', tool: 'bash', say: '要开一个看不见的浏览器,把页面截下来看',
      at: '2026-09-28T02:00:00.000Z',
    })
    expect(face.headline).toBe('要开一个看不见的浏览器,把页面截下来看')
    expect(face.yes).toBe('允许这一次')
    expect(face.chosen).toBeUndefined()
  })
})
