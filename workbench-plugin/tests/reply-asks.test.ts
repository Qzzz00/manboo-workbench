// @vitest-environment node
/**
 * 「回答里含确认点 / 问句」≠ 做完(2026-09-27,卡 MS)。
 *
 * 现场(维护者 21:17):他在电话里说「给 minus 发个信息问他国庆节中国法定节日是放几天」。
 * 那条 DSH 会话什么都没发出去,最后在电脑上列了四条:「①Minus 是哪一家 ②怎么发 ③回了怎么给你
 * ④怎么算做完 —— 哪条不对说一下,都对我就开工」。
 *
 * 然后:/state 里这件 `status: done`、note「只是问了一句」。维护者:
 * 「你看,要确认,但是却没打电话给我,那怎么确认?」「这个事项又要出问题,根本禁不起查验」。
 *
 * 这份用例钉三件:
 *   1. 那段回答是在问他 → 卡进「阻塞 · 等你输入」(「等你」那一堆),**不是 done、不盖 casual 章**;
 *   2. 「只是问了一句」的三问加了第四问(在等他 = 一定算一件事);
 *   3. 电话来的那一件,「等你输入」会排一通电话(从哪来的就从哪问)。
 */
import { describe, expect, it } from 'vitest'
import type { TaskView } from '../src/protocol.ts'
import { itemTransitionOnSessionEnd } from '../src/server/butlerLifecycle.ts'
import { casualAskVerdict, isCasualAsk } from '../src/server/casualAsk.ts'
import { replyAsksHim } from '../src/server/replyAsks.ts'
import { taskCallOutEvent } from '../src/server/callOut.ts'

const END_TS = Math.floor(Date.parse('2026-09-27T13:17:00Z') / 1000)

/** 21:17 那一件:电话来的、事务官自己办、只开了一条 dsh 会话、一个字没发出去。 */
function task(over: Partial<TaskView> = {}): TaskView {
  return {
    id: 't-a81c7ec9', title: '给 Manus 发个信息问国庆放几天', status: 'doing', direction: 'mine',
    source: { kind: 'manual' }, origin: 'call',
    conversation: { agent: 'dsh', session_id: 's-1' }, links: [{ agent: 'dsh', session_id: 's-1' }],
    created_at: '2026-09-27T13:17:00.000Z', updated_at: '2026-09-27T13:17:00.000Z',
    ...over,
  }
}

/** 会话最后那一段(照现场那四条的样子)。 */
const ASKED = [
  '我理解的是:给 Manus 这个 agent 发条信息。要确认四点:',
  '① Minus 是哪一家 ② 怎么发 ③ 回了怎么给你 ④ 怎么算做完',
  '哪条不对说一下,都对我就开工。',
].join('\n')

describe('这段回答是在问他吗(纯函数)', () => {
  it('★确认点那几句都认得出来', () => {
    expect(replyAsksHim(ASKED)).toEqual({ what: '她列了几条要你确认' })
    expect(replyAsksHim('没认出「minus」是哪条会话,你说的是哪一条?')?.what).toBeTypeOf('string')
    expect(replyAsksHim('要不要我先存下来再发')?.what).toBeTypeOf('string')
    expect(replyAsksHim('这一版先做最小的一条路,对吗?')?.what).toBeTypeOf('string')
  })

  it('最后一句是问号收尾的问句也算在问他', () => {
    expect(replyAsksHim('查完了,国庆放 8 天。还要我发给谁吗?')).not.toBeUndefined()
  })

  it('结论不算在问他(宁可漏认不错认)', () => {
    expect(replyAsksHim('捎到了,你那句话已经送进 Manus 那条会话里了。')).toBeUndefined()
    expect(replyAsksHim('我是 DeepSeek')).toBeUndefined()
    expect(replyAsksHim('')).toBeUndefined()
    expect(replyAsksHim(undefined)).toBeUndefined()
  })
})

describe('「只是问了一句」的第四问:她在等他', () => {
  it('★在等他 → 一定算一件事(不许盖 casual 章)', () => {
    expect(isCasualAsk(task(), { filesChanged: 0 })).toBe(true)
    expect(isCasualAsk(task(), { filesChanged: 0, asksHim: true })).toBe(false)
    expect(casualAskVerdict(task(), { asksHim: true })).toMatchObject({ real: true, asksHim: true, dispatched: false })
  })
})

describe('会话回合以确认问句结束 → 等你,不是完成', () => {
  it('★现场那一件:blocked · 等你输入,note 说在等你回话,回答照样挂上', () => {
    const next = itemTransitionOnSessionEnd(task(), { kind: 'done', ts: END_TS, filesChanged: 0 }, ASKED)
    expect(next?.status).toBe('blocked')
    expect(next?.update.blockReason).toBe('input')
    expect(next?.update.note).toBe('她列了几条要你确认,在等你回话')
    // **不许**盖「只是问了一句」那一章、也不许写「只是问了一句」
    expect(next?.update.casual).toBeUndefined()
    expect(next?.update.note).not.toContain('只是问了一句')
    expect(next?.update.deliverables).toEqual([{ kind: 'reply', ref: ASKED, session_id: 's-1' }])
  })

  it('答完了不是在问他的,照旧「只是问了一句」/「等我确认」(这一条没改)', () => {
    expect(itemTransitionOnSessionEnd(task(), { kind: 'done', ts: END_TS, filesChanged: 0 }, '我是 DeepSeek')?.status).toBe('done')
    expect(itemTransitionOnSessionEnd(task({ assignee: 'codex' }), { kind: 'done', ts: END_TS }, '做完了')?.status).toBe('confirm')
  })
})

describe('从哪来的就从哪问:等你输入要排一通电话', () => {
  it('★「阻塞 · 等你输入」出一条「等你回答」的来电事件(以前一条都不出)', () => {
    const event = taskCallOutEvent(task({ status: 'blocked', block_reason: 'input', note: '她列了几条要你确认,在等你回话' }))
    expect(event).toMatchObject({ reason: 'ask', item_id: 't-a81c7ec9', note: '她列了几条要你确认,在等你回话' })
    expect(event?.key).toBe('ask:t-a81c7ec9')
  })

  it('别的阻塞理由行为不变(出错照旧 failed,额度不足照旧不打)', () => {
    expect(taskCallOutEvent(task({ status: 'blocked', block_reason: 'error', note: '会话出错' }))?.reason).toBe('failed')
    expect(taskCallOutEvent(task({ status: 'blocked', block_reason: 'quota' }))).toBeUndefined()
  })
})
