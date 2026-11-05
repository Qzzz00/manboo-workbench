// @vitest-environment node
/**
 * 通话那一句摘要 = **聊了什么**(2026-10-13,卡「固定流程留痕 + 通话纪要标题」)。
 *
 * 维护者 10-13 原话:「已完成里面不要再写什么和事务官通了个电话了,有什么意义,你得写出来聊了什么啊」。
 * 那一句从**她说的那几件**拼(不经模型),应声词不算一件事;她一句没说就说事务官说了什么。
 *
 * 2026-10-22 起这一句写在**通话记录**上,不再落卡(决策记录同日「通电话是记录不是事项」;
 * 落记录那几条用例在 `tests/call-records-20261022.test.ts`)。10-13「没实质内容的那一通不建卡」随之作废。
 */
import { describe, expect, it } from 'vitest'
import {
  CALL_NO_TRANSCRIPT_SUMMARY,
  CALL_ONLY_BACKCHANNEL_SUMMARY,
  CALL_TITLE_PREFIX,
  CALL_TITLE_TOPICS,
  FIRST_LINE_MAX,
  plainCallSummary,
} from '../src/server/callSummary.ts'

describe('① 那一句摘要 = 聊了什么(不经模型,全从字幕拼)', () => {
  it('她说的那几件就是聊了什么;事务官的开场与她的应声都不算', () => {
    expect(plainCallSummary([
      { who: 'butler', text: '在呢。' },
      { who: 'me', text: '把待办改成按日期汇总' },
      { who: 'butler', text: '好,改成按日期汇总了。' },
      { who: 'me', text: '嗯' },
    ])).toBe(`${CALL_TITLE_PREFIX}把待办改成按日期汇总`)
  })

  it('她说了好几件 → 摆前两件,其余只报件数(标题不许长成一整段)', () => {
    const summary = plainCallSummary([
      { who: 'me', text: '把待办改成按日期汇总' },
      { who: 'me', text: '计划 18 号发秋天穿搭' },
      { who: 'me', text: '再帮我看一下报价单' },
    ])
    expect(summary.startsWith(`${CALL_TITLE_PREFIX}把待办改成按日期汇总;计划 18 号发秋天穿搭`)).toBe(true)
    expect(summary).toContain(`还说了 ${3 - CALL_TITLE_TOPICS} 件`)
  })

  it('一件事太长 → 截到 FIRST_LINE_MAX 字 + 省略号', () => {
    expect(plainCallSummary([{ who: 'me', text: '一'.repeat(40) }]))
      .toBe(`${CALL_TITLE_PREFIX}${'一'.repeat(FIRST_LINE_MAX)}…`)
  })

  it('她一句实质的都没说 → 说事务官说了什么(来电那一通的价值在这一句)', () => {
    expect(plainCallSummary([{ who: 'butler', text: '老板,参赛网页要看一个文件,等你批' }, { who: 'me', text: '行' }]))
      .toBe(`${CALL_TITLE_PREFIX}事务官说「老板,参赛网页要看一个文件,等你批」`)
  })

  it('两边都只有应声 → 如实说没说什么事;一句字幕都没有 → 如实说没留下字幕', () => {
    expect(plainCallSummary([{ who: 'butler', text: '在呢。' }, { who: 'me', text: '好的' }])).toBe(CALL_ONLY_BACKCHANNEL_SUMMARY)
    expect(plainCallSummary([])).toBe(CALL_NO_TRANSCRIPT_SUMMARY)
  })
})
