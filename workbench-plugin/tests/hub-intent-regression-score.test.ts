// @vitest-environment node
/**
 * 回归集 harness 的打分(`dev/intent-regression/score.ts`)与用例表自洽:
 * 「对 / 过度 / 不足 / 模糊 / 错」各有判据;每条用例的期望都指向预置板上真有的卡、目标、手;
 * 回归集里的句子不会被电脑入口前面保留的那几道专项岔口(今天视图 / 会 / 发布计划)截走。
 */
import { describe, expect, it } from 'vitest'
import { grade } from '../dev/intent-regression/score.ts'
import { mergeReport, reportRows, summaryOf } from '../dev/intent-regression/report.ts'
import { CASES, FIXTURE } from '../dev/intent-regression/cases.ts'
import { understand } from '../src/server/understand.ts'

describe('grade', () => {
  const want = { expect: [[{ name: 'reassign', card_id: 't-ea1e8702', to: 'agent:me:k1' }]] }
  it('对', () => expect(grade(want, [{ name: 'reassign', card_id: 't-ea1e8702', to: 'agent:me:k1' }, { name: 'chat' }])).toBe('对'))
  it('过度', () => expect(grade(want, [{ name: 'reassign', card_id: 't-ea1e8702', to: 'agent:me:k1' }, { name: 'rename', card_id: 't-ea1e8702' }])).toBe('过度'))
  it('错:改派落成改名', () => expect(grade(want, [{ name: 'rename', card_id: 't-c323ffa6' }])).toBe('错'))
  it('不足', () => expect(grade(want, [{ name: 'chat' }])).toBe('不足'))
  it('模糊', () => expect(grade(want, [{ name: 'ask' }])).toBe('模糊'))
  it('ask_ok 的用例问一句算对', () => expect(grade({ ...want, ask_ok: true }, [{ name: 'ask' }])).toBe('对'))
  it('allow 里的顺带命令不算过度', () => expect(grade({ ...want, allow: ['move_status'] }, [{ name: 'reassign', card_id: 't-ea1e8702', to: 'agent:me:k1' }, { name: 'move_status' }])).toBe('对'))
  it('几组可接受的办法取最好的', () => expect(grade({ expect: [[{ name: 'supplement' }], [{ name: 'dispatch' }]] }, [{ name: 'dispatch' }])).toBe('对'))
})

describe('用例表自洽', () => {
  const cards = new Set(FIXTURE.tasks.map(one => one.id))
  const goals = new Set(FIXTURE.goals.map(one => one.id))
  const hands = new Set(FIXTURE.hands.map(one => one.id))
  it('每条期望指向的卡 / 目标 / 手都在预置板上', () => {
    for (const c of CASES) {
      for (const group of c.expect) {
        for (const want of group) {
          if (want.card_id !== undefined) expect(cards.has(want.card_id) || (c.add ?? []).some(one => one.id === want.card_id), `${c.row} ${want.card_id}`).toBe(true)
          if (want.goal_id !== undefined) expect(goals.has(want.goal_id), `${c.row} ${want.goal_id}`).toBe(true)
          if (typeof want.to === 'string') expect(hands.has(want.to), `${c.row} ${want.to}`).toBe(true)
        }
      }
    }
  })
  it('回归集的电脑入口句子不会被保留的专项岔口截走(今天视图 / 会 / 发布计划 / 文件)', () => {
    for (const c of CASES) {
      const got = understand(c.said, { nowMs: Date.parse('2026-10-28T09:40:00+08:00'), source: 'desk', canFileAsk: true, canMeetingPlan: true })
      expect(['today_view', 'meeting_plan', 'publish_plan', 'file'], `${c.row}:${got.kind}`).not.toContain(got.kind)
    }
  })
})

describe('grade:新活必须建新卡', () => {
  it('fresh 的期望遇到挂到已有卡上 → 错', () => {
    expect(grade({ expect: [[{ name: 'dispatch', to: 'agent:me:k1', fresh: true }]] }, [{ name: 'dispatch', card_id: 't-98ce35df', to: 'agent:me:k1' }])).toBe('错')
    expect(grade({ expect: [[{ name: 'dispatch', to: 'agent:me:k1', fresh: true }]] }, [{ name: 'dispatch', to: 'agent:me:k1' }])).toBe('对')
  })
})

describe('report.json / summary.md(A3 发版门读的契约)', () => {
  const row = (id: string, entrance: 'desktop' | 'call' | 'phone', grades: string[]) => ({ id, entrance, said: `说 ${id}`, expect: ['dispatch'], got: ['dispatch'], grades })
  it('一行跑几遍取最差;「错」记成过度并注明;「失败」记成不足;只有「对」算 passed', () => {
    const rows = reportRows([row('a', 'desktop', ['对', '对']), row('b', 'desktop', ['对', '错']), row('c', 'desktop', ['失败'])])
    expect(rows.map(one => one.verdict)).toEqual(['对', '过度', '不足'])
    expect(rows[1]!.note).toContain('错')
    expect(rows[2]!.note).toContain('模型')
    const report = mergeReport(undefined, rows, '2026-10-28T08:00:00.000Z')
    expect(report).toMatchObject({ at: '2026-10-28T08:00:00.000Z', entrances: ['desktop'], total: 3, passed: 1 })
    expect(report.rate).toBeCloseTo(1 / 3)
  })
  it('按 id 覆盖、不丢别的入口的行', () => {
    const prev = mergeReport(undefined, reportRows([row('call-1', 'call', ['对']), row('d-1', 'desktop', ['错'])]), 't0')
    const next = mergeReport(prev, reportRows([row('d-1', 'desktop', ['对'])]), 't1')
    expect(next.rows.map(one => [one.id, one.verdict])).toEqual([['call-1', '对'], ['d-1', '对']])
    expect(next).toMatchObject({ at: 't1', entrances: ['call', 'desktop'], total: 2, passed: 2, rate: 1 })
  })
  it('summary.md:通过率、各入口、每行一句', () => {
    const md = summaryOf(mergeReport(undefined, reportRows([row('d-1', 'desktop', ['对']), row('d-2', 'desktop', ['不足'])]), 't'))
    expect(md).toContain('1 / 2')
    expect(md).toContain('50%')
    expect(md).toContain('d-2')
    expect(md).toContain('不足')
  })
})
