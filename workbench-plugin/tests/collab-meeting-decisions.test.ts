import { describe, expect, it } from 'vitest'
import { meetingDecisionsOf, renderNotesMd } from '../src/server/meetingText.ts'

const parsed = {
  solved: ['定了派活方案'],
  topics: [
    { name: '远程派活', discussed: ['手机离开电脑怎么派'], claims: [{ kind: '已确定' as const, text: '先验通手机,再做桌面入口' }, { kind: '当前判断' as const, text: '中转够用' }], why: ['手机是主路'], chain: [] },
    { name: '回执', discussed: [], claims: [{ kind: '已确定' as const, text: '交回必须对着验收编号答' }, { kind: '初步想法' as const, text: '加一个周报' }], why: [], chain: [] },
  ],
  keep: [], todos: [], unsure: [], dropped: [],
}

describe('会议卡的决定 = 纪要里标「已确定」的判断', () => {
  it('从代码拼出的纪要里读回「已确定」那几条,原话照抄;别的分量不充数', () => {
    const md = renderNotesMd({ title: '评审', date: '2026-10-21', startedAt: '14:00', parsed })
    expect(meetingDecisionsOf(md)).toEqual(['先验通手机,再做桌面入口', '交回必须对着验收编号答'])
  })
  it('没有纪要 / 一条已确定都没有 → 空数组', () => {
    expect(meetingDecisionsOf(undefined)).toEqual([])
    expect(meetingDecisionsOf('# x\n\n- 当前判断 · 中转够用\n')).toEqual([])
  })
  it('「判断」段外面碰巧以「已确定 ·」开头的行不算(比如「最值得保留」里抄的一句)', () => {
    const md = renderNotesMd({ title: '评审', date: '2026-10-21', startedAt: '14:00', parsed: { ...parsed, keep: ['已确定 · 这不是判断段'] } })
    expect(meetingDecisionsOf(md)).not.toContain('这不是判断段')
  })
})
