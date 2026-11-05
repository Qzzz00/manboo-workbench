// @vitest-environment node
/**
 * 某家会话真在等他答 → 座机响、进「等你」那一堆(2026-09-28,卡 WQ)。
 *
 * 现场(维护者 16:1x,Air 0.4.53):他在 Codex 里让它发一道选项题,Codex 弹了框问「你最喜欢哪种菜系?」。
 * `/state.waiting` 里有这一条、电脑上「当前聚焦事项」也画出来了,可 `call-out.json` 一条都没有 ——
 * 「为什么有需要确认的,事务官都读到了,但是不给我打电话……这可是核心功能啊。」
 *
 * 这一份钉三件:
 *   1. 会话 ask(真证据,`by:'form'`)→ 有一条 `ask` 事件,过 `planCallOuts` 真响;
 *   2. 说完一轮顺口问一句(卡 KM 那个场景,`by:'rules'`)→ 一条都没有;
 *   3. 事项已经认走那条会话(卡 RC「一件事一条」)→ 不再另出一条,不重复打。
 */
import { describe, expect, it } from 'vitest'
import type { SessionAskView } from '../src/protocol.ts'
import { planCallOuts } from '../src/server/callOut.ts'
import {
  SESSION_ASK_MIN_AGE_MS,
  isSessionAskItem,
  sessionAskCallKey,
  sessionAskCallOutEvents,
  sessionAskItemId,
  sessionAskRef,
  sessionAskSessionId,
  sessionAskTooFresh,
} from '../src/server/sessionAskCalls.ts'

const since = '2026-09-28T08:11:46.574Z'

/** 现场那一问(诊断包 `快照/state.json` 里那条 codex 会话的 `ask`,逐格照抄)。 */
function codexAsk(patch: Partial<SessionAskView> = {}): SessionAskView {
  return {
    kind: 'choose',
    question: '你最喜欢哪种菜系?',
    options: [{ label: '川菜' }, { label: '粤菜' }, { label: '湘菜' }, { label: '江浙菜' }],
    since,
    quote: '你最喜欢哪种菜系?',
    by: 'form',
    reply: 'desk',
    where: '这一问得在电脑上的 Codex 里回答(它那边弹了个框等你点)',
    reveal: true,
    ...patch,
  }
}

const codexSession = (ask = codexAsk()) => ({ agent: 'codex', session_id: '01a0e710-7851-7223-bf1e-c09944d64dc0', ask })

describe('会话在等他答 → 有一条来电事件(卡 WQ)', () => {
  it('Codex 弹了框问菜系:一条 ask 事件,那句话由代码从事实拼、与「等你」里那一行逐字相同', () => {
    const events = sessionAskCallOutEvents({ sessions: [codexSession()] })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      reason: 'ask',
      item_id: 'session:codex/01a0e710-7851-7223-bf1e-c09944d64dc0',
      title: 'Codex 在等你选:你最喜欢哪种菜系?',
      at: since,
    })
    // 选项念得出来,送不回去的那一句原样带走(电话里如实说要去电脑上点,不假装替他点了)。
    expect(events[0]?.note).toBe('选项:川菜 / 粤菜 / 湘菜 / 江浙菜 · 这一问得在电脑上的 Codex 里回答(它那边弹了个框等你点)')
  })

  it('这一条过 planCallOuts 真响(不是只发通知)—— 他不点头那个框就一直停在那儿', () => {
    const events = sessionAskCallOutEvents({ sessions: [codexSession()] })
    const plan = planCallOuts({
      events,
      seen: new Set(),
      waiting: [],
      now: Date.parse('2026-09-28T16:13:00+08:00'),
      quiet: { from: '23:00', to: '08:00' },
      newId: () => 'call-1',
    })
    expect(plan.created).toHaveLength(1)
    expect(plan.created[0]).toMatchObject({ reason: 'ask', silent: false, item_id: 'session:codex/01a0e710-7851-7223-bf1e-c09944d64dc0' })
  })

  it('同一件只打一次:key = 会话 id + 这一问的 since;台账里记过就不再排', () => {
    const events = sessionAskCallOutEvents({ sessions: [codexSession()] })
    const key = sessionAskCallKey('01a0e710-7851-7223-bf1e-c09944d64dc0', since)
    expect(events[0]?.key).toBe(key)
    const again = planCallOuts({
      events,
      seen: new Set([key]),
      waiting: [],
      now: Date.parse('2026-09-28T16:13:00+08:00'),
      quiet: { from: '23:00', to: '08:00' },
      newId: () => 'call-2',
    })
    expect(again.created).toEqual([])
  })

  it('它接着问第二道题(新的 since)→ 是新的一件,照旧响(合并窗管它并不并进上一通)', () => {
    const second = sessionAskCallOutEvents({
      sessions: [codexSession(codexAsk({ question: '那最想吃哪一道?', since: '2026-09-28T08:14:00.000Z' }))],
    })
    expect(second[0]?.key).not.toBe(sessionAskCallKey('01a0e710-7851-7223-bf1e-c09944d64dc0', since))
    expect(second[0]?.title).toBe('Codex 在等你选:那最想吃哪一道?')
  })
})

describe('不该打的那几种', () => {
  it('说完一轮顺口问了一句(卡 KM:by=rules,没有真证据)→ 一条事件都没有', () => {
    const events = sessionAskCallOutEvents({
      sessions: [{ agent: 'kimi', session_id: 's-kimi', ask: codexAsk({ by: 'rules', reply: 'window' }) }],
    })
    expect(events).toEqual([])
  })

  it('问模型判出来的(by=model)也不响 —— 不经模型的地方坚决不经模型', () => {
    expect(sessionAskCallOutEvents({ sessions: [{ agent: 'claude', session_id: 's-c', ask: codexAsk({ by: 'model' }) }] })).toEqual([])
  })

  it('事务官自己那条会话不在这里(她问他的走提问 / 审批经纪人,已经数过了)', () => {
    expect(sessionAskCallOutEvents({ sessions: [{ agent: 'dsh', session_id: 's-dsh', ask: codexAsk() }] })).toEqual([])
  })

  it('事项已经认走这条会话(卡 RC 一件事一条:卡停在「阻塞 · 等你输入」)→ 不再另出一条', () => {
    const events = sessionAskCallOutEvents({
      sessions: [codexSession()],
      tasks: [{
        status: 'blocked',
        block_reason: 'input',
        conversation: { session_id: '01a0e710-7851-7223-bf1e-c09944d64dc0' },
      }],
    })
    expect(events).toEqual([])
  })

  it('那件事没停在「等你输入」上(在办)→ 会话这一问照旧算一件:那个框真停着', () => {
    const events = sessionAskCallOutEvents({
      sessions: [codexSession()],
      tasks: [{ status: 'doing', conversation: { session_id: '01a0e710-7851-7223-bf1e-c09944d64dc0' } }],
    })
    expect(events).toHaveLength(1)
  })

  it('一条会话没挂 ask → 没有事件', () => {
    expect(sessionAskCallOutEvents({ sessions: [{ agent: 'codex', session_id: 's-idle' }] })).toEqual([])
  })
})

/**
 * ★ **一问刚挂上不到 20 秒不响铃**(2026-10-13,卡 H;统筹定的数)。
 *
 * 现场:14:4x 统筹开了五个 Claude 子任务,工作台把统筹会话与子任务的权限提示
 * (「Claude 要提交改动,等你批准」「Claude 的子任务「卡 A…」在等你点头」)当成「等你点头」连着打电话 ——
 * 台账上 14:44–14:47 四条(一条 ringing、三条 missed)。维护者原话:「你的子任务又在给我疯狂打电话了」。
 * 自动模式下这几种提示几秒就自己过了,挂满 20 秒还在那儿的才是真停住了。
 */
describe('★ 一问挂着不到 20 秒不响铃(卡 H)', () => {
  const NOW = Date.parse('2026-10-13T06:44:00.000Z')
  /** 挂了多久的那一问(时长一律从常量算,不逐字抄秒数)。 */
  const askOld = (ageMs: number, patch: Partial<SessionAskView> = {}) =>
    codexAsk({ since: new Date(NOW - ageMs).toISOString(), ...patch })
  const FRESH = SESSION_ASK_MIN_AGE_MS / 2
  const AGED = SESSION_ASK_MIN_AGE_MS + 5_000

  it('刚弹出来(不到门槛,10 秒)→ 一条事件都没有:自动模式下它几秒就自己过了', () => {
    expect(sessionAskCallOutEvents({ sessions: [codexSession(askOld(FRESH))], nowMs: NOW })).toEqual([])
  })

  it('下一拍它还挂着(过了门槛,25 秒)→ 照响:这一件真停在那儿了', () => {
    const events = sessionAskCallOutEvents({ sessions: [codexSession(askOld(AGED))], nowMs: NOW })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ reason: 'ask', item_id: 'session:codex/01a0e710-7851-7223-bf1e-c09944d64dc0' })
  })

  it('门槛整好那一刻算挂满了 → 响(边界在「不到」那一侧)', () => {
    expect(sessionAskCallOutEvents({ sessions: [codexSession(askOld(SESSION_ASK_MIN_AGE_MS))], nowMs: NOW })).toHaveLength(1)
  })

  it('★ 子任务那一问走同一道门(14:4x 那四通里就有它,不另写一套)', () => {
    const child = { child: { id: 'c-a1', title: '卡 A 查找文件' }, kind: 'approve' as const, question: '要查找文件,批准吗' }
    const claude = (ageMs: number) => ({ agent: 'claude', name: 'Claude', session_id: 's-sub', ask: askOld(ageMs, child) })
    expect(sessionAskCallOutEvents({ sessions: [claude(FRESH)], nowMs: NOW })).toEqual([])
    const events = sessionAskCallOutEvents({ sessions: [claude(AGED)], nowMs: NOW })
    expect(events).toHaveLength(1)
    expect(events[0]?.title).toContain('Claude 的子任务「卡 A 查找文件」')
  })

  it('权限弹窗那一问(统筹会话那几通)也走同一道门', () => {
    const permission = { permission: { readable: true as const }, kind: 'approve' as const, question: '要提交改动,批准吗' }
    const one = (ageMs: number) => ({ agent: 'claude', name: 'Claude', session_id: 's-main', ask: askOld(ageMs, permission) })
    expect(sessionAskCallOutEvents({ sessions: [one(FRESH)], nowMs: NOW })).toEqual([])
    expect(sessionAskCallOutEvents({ sessions: [one(AGED)], nowMs: NOW })).toHaveLength(1)
  })

  it('两样时刻都读不出来 → 照响(宁可响:与 24 小时那条同一取舍、同一种时刻来源)', () => {
    expect(sessionAskTooFresh({}, NOW)).toBe(false)
    // 这一问没时刻、但这条会话最后动过的时刻在 → 按会话那一格算(与 sessionAskTooOld 读同一处)
    expect(sessionAskTooFresh({ updated_at: new Date(NOW - FRESH).toISOString() }, NOW)).toBe(true)
    expect(sessionAskTooFresh({ updated_at: new Date(NOW - AGED).toISOString() }, NOW)).toBe(false)
    // 时刻比此刻还晚(钟不对)= 这个时刻不可信,照响
    expect(sessionAskTooFresh({ updated_at: new Date(NOW + AGED).toISOString() }, NOW)).toBe(false)
  })

  it('不传 nowMs = 不按时间筛(与这一版之前逐字相同)', () => {
    expect(sessionAskCallOutEvents({ sessions: [codexSession(askOld(FRESH))] })).toHaveLength(1)
  })

  it('20 秒是统筹定的数,钉在导出的常量上', () => {
    expect(SESSION_ASK_MIN_AGE_MS).toBe(20_000)
  })
})

describe('台账上认得出这一路', () => {
  /*
   * ★ 2026-10-03(卡「两条接缝」;审计第二表第 15 条):`item_id` 从 `session:<会话 id>`
   * 改成与闸、账、`/state.waiting` **同一个定法** `jobKey.sessionJobId`(`session:<家>/<会话 id>`)。
   * 从前它没有家名,于是闸对它永远答「查不出」,「收场了就不动那一家」在座机这一路压根不生效。
   * 落了盘的老行由 `callOutMigrate.ts` 启动时迁一次;迁不动的老行**照旧读得出会话 id**(下面那一条)。
   */
  it('★ item_id 是 session:<家>/<会话 id>,认得回来(电话里答那一条据此如实说去哪儿点)', () => {
    expect(sessionAskItemId('codex', 's-1')).toBe('session:codex/s-1')
    expect(isSessionAskItem('session:codex/s-1')).toBe(true)
    expect(isSessionAskItem('t-9c3af00e')).toBe(false)
    expect(sessionAskRef('session:codex/s-1')).toEqual({ agent: 'codex', sessionId: 's-1' })
    expect(sessionAskSessionId('session:codex/s-1')).toBe('s-1')
    expect(sessionAskSessionId('t-9c3af00e')).toBeUndefined()
  })

  it('★ 窗口型那几条会话 id 自己带冒号,照旧拆得对(冒号那一版正是在这里拆错的)', () => {
    expect(sessionAskItemId('doubao', 'window:825f1900')).toBe('session:doubao/window:825f1900')
    expect(sessionAskRef('session:doubao/window:825f1900')).toEqual({ agent: 'doubao', sessionId: 'window:825f1900' })
  })

  it('★ 迁不动的老行(认不出家):照旧读得出会话 id、家名缺席 —— 电话里那一问答得进去', () => {
    expect(sessionAskRef('session:s-1')).toEqual({ sessionId: 's-1' })
    expect(sessionAskSessionId('session:s-1')).toBe('s-1')
  })

  it('能替他点的那一问(press)不再在电话里说「去电脑上点」—— 那句话会变成假话', () => {
    const events = sessionAskCallOutEvents({ sessions: [codexSession(codexAsk({ press: true }))] })
    expect(events[0]?.note).toBe('选项:川菜 / 粤菜 / 湘菜 / 江浙菜')
  })
})
