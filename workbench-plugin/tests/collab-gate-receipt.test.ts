// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { UNSORTED_GOAL_ID } from '../src/protocol.ts'
import { DISPATCH_GATE_ERROR, NOTE_GATE_ERROR_HEAD, dispatchGate, noteGate } from '../src/server/noteGate.ts'
import { RECEIPT_ASK_LINE, acceptanceBlock, parseReceipt } from '../src/server/noteReceipt.ts'
import { dispatchPrompt } from '../src/server/dispatchReply.ts'

describe('贴便签的门:四样', () => {
  it('四样齐 → 过;目标写不出就贴「未归目标」并说目标待定', () => {
    expect(noteGate({ from: { kind: 'said', quote: '换铃声' }, acceptance: ['能响'], assignee: 'codex' }))
      .toEqual({ ok: true, goal_id: UNSORTED_GOAL_ID, goal_pending: true })
    expect(noteGate({ goal_id: 'g-1', from: { kind: 'meeting', ref: 'm-1' }, acceptance: ['能响'], assignee: 'me' }))
      .toEqual({ ok: true, goal_id: 'g-1', goal_pending: false })
  })
  it('缺来源 / 验收 / 负责人 → 不贴,一句话说缺哪几样', () => {
    const gate = noteGate({ acceptance: [] })
    expect(gate.ok).toBe(false)
    if (gate.ok) return
    expect(gate.missing).toEqual(['from', 'acceptance', 'assignee'])
    expect(gate.error.startsWith(NOTE_GATE_ERROR_HEAD)).toBe(true)
  })
})

describe('派活那一处的门', () => {
  it('没写验收就不许派', () => {
    expect(dispatchGate({ acceptance: undefined })).toBe(DISPATCH_GATE_ERROR)
    expect(dispatchGate({ acceptance: ['页面能打开'] })).toBeUndefined()
  })
})

describe('回执三态', () => {
  it('认得三种开头', () => {
    expect(parseReceipt('做完:1、2 都做了,截图在 /tmp/a.png')?.kind).toBe('done')
    expect(parseReceipt('回执:有异议 —— 3 不该做')?.kind).toBe('objection')
    expect(parseReceipt('卡住:没有仓库权限')?.kind).toBe('blocked')
    expect(parseReceipt('Done: shipped')?.kind).toBe('done')
  })
  it('认不出就 undefined(章上标回执不规范)', () => {
    expect(parseReceipt('我看了一下,大概是这样的')).toBeUndefined()
    expect(parseReceipt('')).toBeUndefined()
  })
  it('原话整段留着', () => {
    expect(parseReceipt('做完:好了\n第二行')?.text).toBe('做完:好了\n第二行')
  })
})

describe('派活说明:验收带编号、要回执三态', () => {
  it('编号从 1 起,最后一句说只许三种', () => {
    const block = acceptanceBlock(['铃声换了', '手机上响一次'])
    expect(block).toContain('1. 铃声换了')
    expect(block).toContain('2. 手机上响一次')
    expect(block).toContain(RECEIPT_ASK_LINE)
  })
  it('没有验收就不加这一段', () => {
    expect(acceptanceBlock(undefined)).toBe('')
  })
  it('dispatchPrompt 带上验收那一段;不带时与今天一字不差', () => {
    const plain = dispatchPrompt({ taskId: 't-abcdef12', said: '换铃声' })
    expect(dispatchPrompt({ taskId: 't-abcdef12', said: '换铃声', acceptance: [] })).toBe(plain)
    expect(dispatchPrompt({ taskId: 't-abcdef12', said: '换铃声', acceptance: ['能响'] })).toBe(`${plain}\n${acceptanceBlock(['能响'])}`)
  })
})
