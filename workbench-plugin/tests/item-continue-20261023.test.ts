// @vitest-environment node
/**
 * 「同事项接续与动作契约」(2026-10-23,卡 A `t-0c770bc0`;交接 `docs/交接-1023-协作A同事项接续.md`)。
 *
 * 一件事从电脑 / 手机「继续」时,服务端统一下发:
 *   - 这条事项有哪几条**来源**(它自己的事务官会话 + links 里的外部会话),各能不能接着发话;
 *   - 发出去之后那件**结果**是哪一档 —— 记下了 / 留着等它醒 / 送到了(还没核上) / 这条路走不通 / 要先选来源。
 *
 * 这里钉纯函数三样(判据全部来自既有的门,一处不重写):
 *   1. `continueSourcesOf`:来源清单与每条的动作(能续 / 为什么这会儿不能);
 *   2. `resolveContinueTarget`:发给谁 —— 目标明确就用;不明确**不猜最新**:一条直接用,多条回 pick,没有如实说;
 *   3. `continueFactOf`:把 `sessionAnswer.relay` 的结果翻成上面那几档(开工那一档只有真实回执才许出现 —— 这里钉死接续动作**永不**报 started)。
 */
import { describe, expect, it } from 'vitest'
import type { TaskView } from '../src/protocol.ts'
import type { RelayResult } from '../src/server/sessionAnswer.ts'
import {
  BUTLER_SOURCE_KEY,
  CONTINUE_FACTS,
  continueFactOf,
  continueSourcesOf,
  resolveContinueTarget,
  type ContinueEnv,
} from '../src/server/itemContinue.ts'

function task(over: Partial<TaskView> = {}): TaskView {
  return {
    id: 't-1',
    title: '梳理报告',
    status: 'doing',
    created_at: '2026-10-23T00:00:00.000Z',
    updated_at: '2026-10-23T00:00:00.000Z',
    ...over,
  } as TaskView
}

/** 环境:事务官会话这会儿说得进去;外部会话按表答(认不到的缺席)。 */
function env(over: Partial<ContinueEnv> = {}): ContinueEnv {
  return {
    butlerSayReady: () => ({ ok: true as const }),
    relayReady: () => ({ can: true as const }),
    sessionTitle: (agent, id) => `${agent}/${id}`,
    ...over,
  }
}

describe('continueSourcesOf:一条事项的来源清单', () => {
  it('没有会话也没挂外部会话 → 来源为空(普通记录总可以,不在来源里)', () => {
    expect(continueSourcesOf(task(), env())).toEqual([])
  })

  it('事项自己的事务官会话 → 一条 kind:butler 的来源', () => {
    const sources = continueSourcesOf(task({ conversation: { agent: 'dsh', session_id: 's-1' } }), env())
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({ key: BUTLER_SOURCE_KEY, agent: 'dsh', session_id: 's-1', action: { kind: 'butler' } })
  })

  it('archived(做完/取消的记号)→ 与 /butler/item/say 同一道梯:会话还在就照样可续,不由任务章判死', () => {
    const sources = continueSourcesOf(
      task({ conversation: { agent: 'dsh', session_id: 's-1', archived_at: '2026-10-23T01:00:00.000Z' } }),
      env(),
    )
    expect(sources[0]?.action).toEqual({ kind: 'butler' })
  })

  it('会话通道没接上 → none + 那句人话(与 /butler/item/say 的 409 同一个出处)', () => {
    const sources = continueSourcesOf(
      task({ conversation: { agent: 'dsh', session_id: 's-1' } }),
      env({ butlerSayReady: () => ({ ok: false as const, why: '会话通道没接上,这句话说不进去' }) }),
    )
    expect(sources[0]?.action).toEqual({ kind: 'none', why: '会话通道没接上,这句话说不进去' })
  })

  it('links 里的外部会话 → 逐条 kind:relay / none;标题取会话表那份,取不到给「X 的会话」', () => {
    const one = task({
      links: [
        { agent: 'claude', session_id: 'c-1' },
        { agent: 'codex', session_id: 'x-1' },
        { agent: 'kimi', session_id: 'k-1' },
      ],
    })
    const sources = continueSourcesOf(one, env({
      relayReady: (agent) => (agent === 'codex' ? { can: false, why: '这一家我不去打断' } : { can: true }),
      sessionTitle: (agent, id) => (agent === 'kimi' ? undefined : `${agent}/${id}`),
    }))
    expect(sources.map(s => [s.key, s.action.kind])).toEqual([
      ['claude:c-1', 'relay'],
      ['codex:x-1', 'none'],
      ['kimi:k-1', 'relay'],
    ])
    expect(sources[1]?.action).toEqual({ kind: 'none', why: '这一家我不去打断' })
    expect(sources[2]?.title).toBe('kimi 的会话')
  })

  it('links 里重复的键只出一条(一张卡挂多条同名会话不重复列)', () => {
    const one = task({ links: [{ agent: 'claude', session_id: 'c-1' }, { agent: 'claude', session_id: 'c-1' }] })
    expect(continueSourcesOf(one, env())).toHaveLength(1)
  })

  it('事务官会话 + 外部会话同时列出(各是各的来源)', () => {
    const one = task({ conversation: { agent: 'dsh', session_id: 's-1' }, links: [{ agent: 'claude', session_id: 'c-1' }] })
    const sources = continueSourcesOf(one, env())
    expect(sources.map(s => s.key)).toEqual([BUTLER_SOURCE_KEY, 'claude:c-1'])
  })
})

describe('resolveContinueTarget:发给谁 —— 不猜最新', () => {
  const two = continueSourcesOf(
    task({ conversation: { agent: 'dsh', session_id: 's-1' }, links: [{ agent: 'claude', session_id: 'c-1' }, { agent: 'codex', session_id: 'x-1' }] }),
    env({ relayReady: (agent) => (agent === 'codex' ? { can: false, why: '这家这会儿送不进' } : { can: true }) }),
  )

  it('目标带了 → 用那一条;外部会话给 (agent, sessionId)', () => {
    expect(resolveContinueTarget(two, BUTLER_SOURCE_KEY)).toEqual({ kind: 'one', target: { kind: 'butler' }, key: BUTLER_SOURCE_KEY })
    expect(resolveContinueTarget(two, 'claude:c-1')).toEqual({ kind: 'one', target: { kind: 'relay', agent: 'claude', sessionId: 'c-1' }, key: 'claude:c-1' })
  })

  it('★目标不认识 → 不当没听见,回 unknown(不让话掉进另一条会话)', () => {
    expect(resolveContinueTarget(two, 'grok:z-9')).toMatchObject({ kind: 'unknown' })
  })

  it('★目标指了一条这会儿不能续的来源 → blocked + 那句 why', () => {
    expect(resolveContinueTarget(two, 'codex:x-1')).toEqual({ kind: 'blocked', why: '这家这会儿送不进' })
  })

  it('★不带目标、能续的只有一条 → 直接用那一条', () => {
    const one = continueSourcesOf(task({ conversation: { agent: 'dsh', session_id: 's-1' } }), env())
    expect(resolveContinueTarget(one, undefined)).toEqual({ kind: 'one', target: { kind: 'butler' }, key: BUTLER_SOURCE_KEY })
  })

  it('★不带目标、能续的多条 → pick,候选只列能续的,不猜最新', () => {
    const outcome = resolveContinueTarget(two, undefined)
    expect(outcome.kind).toBe('pick')
    if (outcome.kind !== 'pick') return
    expect(outcome.candidates.map(s => s.key)).toEqual([BUTLER_SOURCE_KEY, 'claude:c-1'])
  })

  it('★不带目标、一条能续的都没有 → none + 原因', () => {
    const zero = continueSourcesOf(task(), env())
    expect(resolveContinueTarget(zero, undefined)).toMatchObject({ kind: 'none' })
  })
})

describe('continueFactOf:relay 结果 → 结果那一档', () => {
  it('送到了 → fact:sent', () => {
    const got = continueFactOf({ ok: true, route: 'window', mark: 'm1' }, 'Claude')
    expect(got).toMatchObject({ ok: true, fact: 'sent', delivered: 'sent' })
    expect(got.note).toContain('Claude')
  })

  it('★它正在跑、这句话排进去 → 还是 sent,note 里照实说排着队', () => {
    const got = continueFactOf({ ok: true, route: 'window', mark: 'm1', queued: true }, 'Claude')
    expect(got.fact).toBe('sent')
    expect(got.note).toContain('排在它后面')
  })

  it('★那条会话没开着、留言排上队了 → fact:kept(暂存待上线,不是失败)', () => {
    const got = continueFactOf({ ok: true, route: 'window', mark: 'm1', sessionClosed: true, note: '那条会话没开着,这句我留着,它一开就送进去' }, 'Codex')
    expect(got).toMatchObject({ ok: true, fact: 'kept', delivered: 'kept' })
    expect(got.note).toBe('那条会话没开着,这句我留着,它一开就送进去')
  })

  it('按了发送、当场没核上 → sent + delivered:unconfirmed,note 说先别重发', () => {
    const got = continueFactOf({ ok: false, status: 200, where: 'desk', why: '没看见它收下', reveal: false, unconfirmed: true }, 'Claude')
    expect(got).toMatchObject({ ok: true, fact: 'sent', delivered: 'unconfirmed' })
    expect(got.note).toContain('先别重发')
  })

  it('★捎不进、得去电脑上办 → fact:unsupported(可回溯的替代在 why 里),不是 failed', () => {
    const got = continueFactOf({ ok: false, status: 200, where: 'desk', why: '这句话得你到电脑上的 Kimi 里自己说', reveal: true }, 'Kimi')
    expect(got).toMatchObject({ ok: false, fact: 'unsupported' })
    expect(got.note).toContain('电脑上的 Kimi')
  })

  it('那条会话的记录都没了(404)→ unsupported', () => {
    const got = continueFactOf({ ok: false, status: 404, error: '没有这条会话' }, 'Codex')
    expect(got).toMatchObject({ ok: false, fact: 'unsupported', note: '没有这条会话' })
  })

  it('真办砸了(400)→ failed', () => {
    const got = continueFactOf({ ok: false, status: 400, error: '要捎的话是空的' }, 'Codex')
    expect(got).toMatchObject({ ok: false, fact: 'failed' })
  })

  it('★事实档全集齐(卡 A 六档 + 卡「事务官机制A」redirected/recalled),没有 started —— 开工只认真实回执', () => {
    expect(CONTINUE_FACTS).toEqual(['saved', 'kept', 'sent', 'failed', 'unsupported', 'pick', 'redirected', 'recalled'])
    expect(CONTINUE_FACTS).not.toContain('started')
  })
})
