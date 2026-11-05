/**
 * 卡 `claude/answer-comes-to-her`(2026-10-04,随 0.4.98)。
 *
 * 维护者原话(经工作台捎话):「我刚给事务官发信息,好消息是信息准确,回复也很快,
 * 坏消息是信息直接从正在办切到办完了,我是自己追过去点开查看的……这个交互你得想想咋整」。
 *
 * 钉三件事:
 *   ① 问一句 → **不建事项**(不进「正在办 / 办完」卡片)+ 答案进字幕那一格 + 通知正文**就是答案**;
 *   ② 交代一件事 → 办完**先挂「刚办完」**,她看过才进「办完」;
 *   ③ 两端「看过」同步(服务端就一格)。
 */
import { describe, expect, it } from 'vitest'
import type { AnswerView, TaskView, WorkbenchState } from '../src/protocol.ts'
import {
  ANSWER_SEEN_LINGER_MS,
  FRESH_RESULT_MAX,
  FRESH_RESULT_TTL_MS,
  answerToShow,
  answerWorthNotifying,
  answersCellOf,
  freshResultsOf,
  resultLineOf,
} from '../src/answerCell.ts'
import { createDirectAnswerStore } from '../src/server/directAnswer.ts'
import { parseAnswerRow, parseDirectAnswerFile } from '../src/server/directAnswerFile.ts'
import { CASUAL_ASK_NOTE, itemTransitionOnSessionEnd } from '../src/server/butlerLifecycle.ts'
import { orbCellOf } from '../src/orbCell.ts'

const NOW = Date.parse('2026-10-04T18:00:00.000Z')

function task(over: Partial<TaskView> = {}): TaskView {
  return {
    id: 't-1',
    title: '官网逐字稿改到第几版了',
    status: 'doing',
    direction: 'mine',
    assignee: 'dsh',
    created_at: '2026-10-04T17:50:00.000Z',
    updated_at: '2026-10-04T17:55:00.000Z',
    conversation: { session_id: 'session-1' },
    ...over,
  } as TaskView
}

describe('① 问一句:不建事项、答案往她那儿送', () => {
  it('会话答完判出「问一句」时,卡照旧盖 casual 章,而且**另报一条答案**', () => {
    const next = itemTransitionOnSessionEnd(
      task(),
      { kind: 'done', ts: Math.floor(NOW / 1000) } as never,
      '第三版,昨天 18:40 改完的。',
    )
    expect(next?.status).toBe('done')
    expect(next?.update.note).toBe(CASUAL_ASK_NOTE)
    expect(next?.update.casual).toBe(true)
    // ★ 这一条是这张卡的全部意义:答案不再只留在卡里等她去找。
    expect(next?.answer).toEqual({
      question: '官网逐字稿改到第几版了',
      answer: '第三版,昨天 18:40 改完的。',
      session_id: 'session-1',
    })
  })

  it('答案与挂上去那条 reply 交付物**逐字同一段**(不另洗一遍)', () => {
    const said = '第三版。另外第二段我按你上次说的收短了。'
    const next = itemTransitionOnSessionEnd(task(), { kind: 'done', ts: Math.floor(NOW / 1000) } as never, said)
    const reply = (next?.update.deliverables ?? []).filter(one => one.kind === 'reply').pop()
    expect(reply?.ref).toBe(said)
    expect(next?.answer?.answer).toBe(said)
  })

  it('交代一件事(派出去了)照旧进「等我确认」,**不报答案**', () => {
    const next = itemTransitionOnSessionEnd(
      task({ dispatch: { status: 'sent', agent: 'codex' } as never }),
      { kind: 'done', ts: Math.floor(NOW / 1000) } as never,
      '派给 Codex 了,它在跑。',
    )
    expect(next?.status).toBe('confirm')
    expect(next?.answer).toBeUndefined()
  })

  it('答案是空白时**什么都不记**(取不到就缺席,不编一个)', () => {
    const store = createDirectAnswerStore({ now: () => NOW })
    expect(store.record({ itemId: 't-1', question: '问了一句', answer: '   ' })).toBeUndefined()
    expect(store.list()).toEqual([])
  })

  it('同一张卡再答一次 = 覆盖,而且「看过」跟着擦掉(她看过的是上一句)', () => {
    const store = createDirectAnswerStore({ now: () => NOW })
    store.record({ itemId: 't-1', question: '问', answer: '第一句' })
    store.markSeen('t-1', '2026-10-04T18:01:00.000Z')
    expect(store.get('t-1')?.seen_at).toBe('2026-10-04T18:01:00.000Z')
    store.record({ itemId: 't-1', question: '问', answer: '第二句' })
    expect(store.get('t-1')?.answer).toBe('第二句')
    expect(store.get('t-1')?.seen_at).toBeUndefined()
    expect(store.list()).toHaveLength(1)
  })

  it('字幕那一格一次只摆一条:最新那条还没看过的', () => {
    const items: AnswerView[] = [
      { id: 'a', question: '问 A', answer: '答 A', at: '2026-10-04T17:00:00.000Z' },
      { id: 'b', question: '问 B', answer: '答 B', at: '2026-10-04T17:30:00.000Z' },
    ]
    const cell = answersCellOf(items, NOW)
    expect(cell.unseen).toBe(2)
    expect(answerToShow(cell)?.id).toBe('b')
    const seen = answersCellOf([{ ...items[1]!, seen_at: '2026-10-04T17:31:00.000Z' }, items[0]!], NOW)
    expect(seen.unseen).toBe(1)
    expect(answerToShow(seen)?.id).toBe('a')
  })

  it('看过的那一条留一会儿再掉出去(字幕不该当场空掉),过了窗就不发了', () => {
    const one: AnswerView = { id: 'a', question: '问', answer: '答', at: '2026-10-04T17:00:00.000Z', seen_at: new Date(NOW - 60_000).toISOString() }
    expect(answersCellOf([one], NOW).items).toHaveLength(1)
    const old: AnswerView = { ...one, seen_at: new Date(NOW - ANSWER_SEEN_LINGER_MS - 1000).toISOString() }
    expect(answersCellOf([old], NOW).items).toHaveLength(0)
  })

  it('答案**一个字不截**(通知正文就是答案本身)', () => {
    const long = '很'.repeat(400)
    const store = createDirectAnswerStore({ now: () => NOW })
    expect(store.record({ itemId: 't-1', question: '问', answer: long })?.answer).toBe(long)
    expect(answersCellOf(store.list(), NOW).items[0]?.answer).toHaveLength(400)
  })

  it('电话里问的那一条**不再推一次通知**(她刚听过了),别的路推', () => {
    const base: AnswerView = { id: 'a', question: '问', answer: '答', at: '2026-10-04T17:00:00.000Z' }
    expect(answerWorthNotifying({ ...base, where: 'call' })).toBe(false)
    expect(answerWorthNotifying({ ...base, where: 'phone' })).toBe(true)
    expect(answerWorthNotifying({ ...base, where: 'desk' })).toBe(true)
    // 认不出她在哪问的:照样推 —— 宁可多推一处,不能让答案没去处。
    expect(answerWorthNotifying(base)).toBe(true)
    // 已经看过的不推。
    expect(answerWorthNotifying({ ...base, seen_at: '2026-10-04T17:01:00.000Z' })).toBe(false)
  })
})

describe('② 办完先挂「刚办完 · 结果一句话」', () => {
  function state(tasks: readonly TaskView[]): Pick<WorkbenchState, 'tasks'> {
    return { tasks: { tasks } } as never
  }

  it('办完、她还没看过 → 摆在「刚办完」里,结果一句话取交付物里那段回答', () => {
    const done = task({
      status: 'done',
      updated_at: new Date(NOW - 60_000).toISOString(),
      deliverables: [{ kind: 'reply', ref: '导出 PDF 做好了,在设置里。', session_id: 'session-1' }],
    } as never)
    const view = freshResultsOf(state([done]), NOW)
    expect(view.items).toHaveLength(1)
    expect(view.items[0]).toMatchObject({ task_id: 't-1', title: done.title, result: '导出 PDF 做好了,在设置里。' })
  })

  it('她看过了(seen_result_at 盖了章)→ 从「刚办完」里掉出去,收进「办完」', () => {
    const done = task({ status: 'done', updated_at: new Date(NOW - 60_000).toISOString(), seen_result_at: new Date(NOW).toISOString() } as never)
    expect(freshResultsOf(state([done]), NOW).items).toHaveLength(0)
  })

  it('还在办 / 等你确认 / 取消了的都不在「刚办完」里', () => {
    for (const status of ['doing', 'todo', 'blocked', 'confirm', 'canceled'] as const) {
      expect(freshResultsOf(state([task({ status })]), NOW).items, status).toHaveLength(0)
    }
  })

  it('「只是问了一句」那一张不在这儿(它的答案在字幕上,两处都摆就是同一句话出现两回)', () => {
    const casual = task({ status: 'done', casual: true, updated_at: new Date(NOW - 60_000).toISOString() } as never)
    expect(freshResultsOf(state([casual]), NOW).items).toHaveLength(0)
  })

  it('挂满 24 小时自己沉下去(首页不该挂着十几张等她划)', () => {
    const stale = task({ status: 'done', updated_at: new Date(NOW - FRESH_RESULT_TTL_MS - 1000).toISOString() } as never)
    expect(freshResultsOf(state([stale]), NOW).items).toHaveLength(0)
  })

  it('新的在前,最多摆 FRESH_RESULT_MAX 张', () => {
    const many = Array.from({ length: FRESH_RESULT_MAX + 3 }, (_, i) => task({
      id: `t-${i}`,
      status: 'done',
      updated_at: new Date(NOW - i * 60_000).toISOString(),
    } as never))
    const view = freshResultsOf(state(many), NOW)
    expect(view.items).toHaveLength(FRESH_RESULT_MAX)
    expect(view.items[0]?.task_id).toBe('t-0')
  })

  it('结果一句话取不到就缺席,**不编一句「这件事办完了」**', () => {
    expect(resultLineOf(task({ deliverables: [], note: undefined } as never))).toBeUndefined()
    expect(resultLineOf(task({ note: '  ' } as never))).toBeUndefined()
    // 没有 reply 交付物时退到卡上那句 note。
    expect(resultLineOf(task({ note: '只是问了一句' } as never))).toBe('只是问了一句')
  })
})

describe('③ 球的那两格:一处算、两端只显示', () => {
  const base = { sessions: [], agents: [], stale: false }

  it('有没看过的回答 / 有「刚办完」时那两格立起来', () => {
    const cell = orbCellOf({
      ...base,
      answers: { items: [{ id: 'a', question: '问', answer: '答', at: '2026-10-04T17:00:00.000Z' }], unseen: 1 },
      fresh_results: { items: [{ task_id: 't-1', title: '导出 PDF', done_at: '2026-10-04T17:50:00.000Z' }] },
    } as never)
    expect(cell.answer).toBe(true)
    expect(cell.fresh_result).toBe(true)
  })

  it('★ 两样都**不染琥珀**:琥珀只留给「有事停着等你回话」', () => {
    const cell = orbCellOf({
      ...base,
      answers: { items: [{ id: 'a', question: '问', answer: '答', at: '2026-10-04T17:00:00.000Z' }], unseen: 1 },
      fresh_results: { items: [{ task_id: 't-1', title: '导出 PDF', done_at: '2026-10-04T17:50:00.000Z' }] },
      waiting: { count: 0, items: [] } as never,
    } as never)
    expect(cell.notice).toBe('neutral')
  })

  it('老服务 / 没有回答时那两格缺席(additive,老客户端读不到即当无)', () => {
    const cell = orbCellOf(base as never)
    expect(cell.answer).toBeUndefined()
    expect(cell.fresh_result).toBeUndefined()
  })
})

describe('账落盘:老数据读得懂,看不懂的那一条丢掉', () => {
  it('缺 id / 答案 / 时刻的那一行丢掉;问句缺席按空串读回(答案是要紧的那一半)', () => {
    expect(parseAnswerRow({ answer: '答', at: '2026-10-04T17:00:00.000Z' })).toBeUndefined()
    expect(parseAnswerRow({ id: 'a', at: '2026-10-04T17:00:00.000Z' })).toBeUndefined()
    expect(parseAnswerRow({ id: 'a', answer: '答' })).toBeUndefined()
    expect(parseAnswerRow({ id: 'a', answer: '答', at: '看不懂' })).toBeUndefined()
    expect(parseAnswerRow({ id: 'a', answer: '答', at: '2026-10-04T17:00:00.000Z' })).toMatchObject({ question: '', answer: '答' })
  })

  it('认不出的 where 丢掉那一格(不编一个),认得出的留着', () => {
    expect(parseAnswerRow({ id: 'a', answer: '答', at: '2026-10-04T17:00:00.000Z', where: '天上' })?.where).toBeUndefined()
    expect(parseAnswerRow({ id: 'a', answer: '答', at: '2026-10-04T17:00:00.000Z', where: 'phone' })?.where).toBe('phone')
  })

  it('整份文件看不懂就当空的,不抛', () => {
    expect(parseDirectAnswerFile(null)).toEqual([])
    expect(parseDirectAnswerFile({ answers: '不是数组' })).toEqual([])
    expect(parseDirectAnswerFile({ answers: [{ 坏: 1 }, { id: 'a', answer: '答', at: '2026-10-04T17:00:00.000Z' }] })).toHaveLength(1)
  })

  it('重启读回来:过期的丢掉,「看过」那一格跟着回来(不会再推一次通知)', () => {
    const rows: AnswerView[] = [
      { id: 'a', question: '问 A', answer: '答 A', at: new Date(NOW - 60_000).toISOString(), seen_at: new Date(NOW - 30_000).toISOString() },
      { id: 'b', question: '问 B', answer: '答 B', at: new Date(NOW - 25 * 60 * 60 * 1000).toISOString() },
    ]
    const store = createDirectAnswerStore({ now: () => NOW, persist: { load: () => rows, save: () => {} } })
    const list = store.list()
    expect(list.map(one => one.id)).toEqual(['a'])
    expect(list[0]?.seen_at).toBe(rows[0]!.seen_at)
  })

  it('账一动就写一次(她看过那一下也写)', () => {
    const saved: AnswerView[][] = []
    const store = createDirectAnswerStore({ now: () => NOW, persist: { load: () => undefined, save: rows => { saved.push([...rows]) } } })
    store.record({ itemId: 't-1', question: '问', answer: '答' })
    store.markSeen('t-1', new Date(NOW).toISOString())
    expect(saved).toHaveLength(2)
    expect(saved[1]?.[0]?.seen_at).toBe(new Date(NOW).toISOString())
  })

  it('写不下去只是没落盘,账照旧在内存里管事(不抛)', () => {
    const store = createDirectAnswerStore({
      now: () => NOW,
      persist: { load: () => undefined, save: () => { throw new Error('盘满了') } },
    })
    expect(() => store.record({ itemId: 't-1', question: '问', answer: '答' })).not.toThrow()
    expect(store.list()).toHaveLength(1)
  })
})
