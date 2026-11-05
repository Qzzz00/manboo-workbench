import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { contentHash, openLedger, type Actor, type AnswerInput, type Ledger } from '../index.ts'
import { ALICE, BOB, clock, HAND, tmpDb } from './helpers.ts'

const OPTIONS = ['allow_once', 'reject_once']
const TARGET = { family: 'claude', session_id: 's-1', turn_id: 't-1', tool_call_id: 'call-1' }
const CONTENT = { tool: 'Bash', command: 'rm -rf build' }

let ledger: Ledger
let c: ReturnType<typeof clock>
let objectId: string
let deliveryId: string
let askId: string
let cleanup: () => void

beforeEach(() => {
  const db = tmpDb()
  cleanup = db.cleanup
  c = clock()
  ledger = openLedger(db.path, { origin: 'mac-a', now: c.now })
  const created = ledger.objects.create({ request_id: 'o1', actor: ALICE, owner: 'alice', status: 'doing', data: { title: '清构建目录' } })
  if (!created.ok) throw new Error(created.error.code)
  objectId = created.result.object_id
  const d = ledger.deliveries.create({ request_id: 'd1', actor: ALICE, object_id: objectId, expected_owner_epoch: 1, family: 'claude', channel: 'socket', target: TARGET })
  if (!d.ok) throw new Error(d.error.code)
  deliveryId = d.result.delivery_id
  askId = openAsk('ask-open-1')
})

afterEach(() => {
  ledger.close()
  cleanup()
})

function openAsk(request_id: string, content: unknown = CONTENT): string {
  const out = ledger.asks.open({
    request_id,
    actor: HAND,
    delivery_id: deliveryId,
    target: TARGET,
    kind: 'permission',
    options: OPTIONS,
    content_hash: contentHash(content),
    expires_at: c.now() + 60_000,
  })
  if (!out.ok) throw new Error(out.error.code)
  return out.result.ask_id
}

function answer(over: Partial<AnswerInput> & { request_id: string }, by: Actor = ALICE) {
  const ask = ledger.asks.get(over.ask_id ?? askId)
  return ledger.asks.answer({
    ask_id: askId,
    ask_version: ask?.ask_version ?? 1,
    content_hash: ask?.content_hash ?? contentHash(CONTENT),
    option: 'allow_once',
    by,
    targetAlive: () => true,
    ...over,
  })
}

describe('ask 的身份', () => {
  it('开问:绑在委派 + 第几次执行 + 手的目标上,版本 1,状态 open', () => {
    expect(ledger.asks.get(askId)).toMatchObject({
      ask_id: askId,
      object_id: objectId,
      delivery_id: deliveryId,
      attempt_id: 1,
      ask_version: 1,
      content_hash: contentHash(CONTENT),
      target: TARGET,
      kind: 'permission',
      options: OPTIONS,
      owner: 'alice',
      owner_epoch: 1,
      status: 'open',
    })
    expect(askId).toMatch(/^mac-a\./)
  })

  it('答对了:回手的目标;答复者与时刻进账;同一 request_id 重发只回存着的;换个请求再答被拒', () => {
    const before = ledger.maxSeq()
    const ok = answer({ request_id: 'ans-1' })
    expect(ok).toMatchObject({ ok: true, replayed: false, result: { ask_id: askId, option: 'allow_once', target: TARGET, delivery_id: deliveryId, attempt_id: 1 } })
    expect(ledger.maxSeq()).toBe(before + 1)
    expect(ledger.asks.get(askId)).toMatchObject({ status: 'answered', answer: { option: 'allow_once', by: ALICE, at: c.now(), request_id: 'ans-1' } })

    expect(answer({ request_id: 'ans-1' })).toMatchObject({ ok: true, replayed: true })
    expect(answer({ request_id: 'ans-2' })).toMatchObject({ ok: false, error: { code: 'ask_answered' } })
    expect(ledger.maxSeq()).toBe(before + 1)
  })

  it('选项不在列表里 → invalid_option', () => {
    expect(answer({ request_id: 'ans-1', option: 'allow_always' })).toMatchObject({ ok: false, error: { code: 'invalid_option' } })
  })

  it('答复者此刻无权(不是负责人) → answerer_not_allowed;调用方可以传自己的判定', () => {
    expect(answer({ request_id: 'ans-bob' }, BOB)).toMatchObject({ ok: false, error: { code: 'answerer_not_allowed' } })
    const delegated = answer({ request_id: 'ans-bob-2', canAnswer: ({ by, object }) => by.person === 'bob' && object.owner === 'alice' }, BOB)
    expect(delegated).toMatchObject({ ok: true })
  })

  it('手那边的目标已经不在 → target_gone,不写事件', () => {
    const before = ledger.maxSeq()
    const seenTarget: unknown[] = []
    const out = answer({ request_id: 'ans-1', targetAlive: (t) => { seenTarget.push(t); return false } })
    expect(out).toMatchObject({ ok: false, error: { code: 'target_gone' } })
    expect(seenTarget).toEqual([TARGET])
    expect(ledger.maxSeq()).toBe(before)
    expect(ledger.asks.get(askId)?.status).toBe('open')
  })

  it('不存在的 ask → ask_not_found', () => {
    expect(answer({ request_id: 'x', ask_id: 'mac-a.NOPE' })).toMatchObject({ ok: false, error: { code: 'ask_not_found' } })
  })
})

describe('ask 的五种失效', () => {
  it('① 过期:到点后答复被拒;扫一遍 expire 把它记成 expired', () => {
    c.advance(60_001)
    expect(answer({ request_id: 'late' })).toMatchObject({ ok: false, error: { code: 'ask_expired' } })
    expect(ledger.asks.get(askId)?.status).toBe('open')
    const swept = ledger.asks.expire()
    expect(swept).toEqual([askId])
    expect(ledger.asks.get(askId)).toMatchObject({ status: 'expired', closed_reason: 'expired' })
    expect(ledger.objectEvents(objectId).at(-1)).toMatchObject({ kind: 'ask.closed', payload: { ask_id: askId, status: 'expired' } })
    expect(ledger.asks.expire()).toEqual([])
    expect(answer({ request_id: 'later' })).toMatchObject({ ok: false, error: { code: 'ask_expired' } })
  })

  it('② 取消:取消后答复被拒', () => {
    const out = ledger.asks.cancel({ request_id: 'cx', actor: ALICE, ask_id: askId, reason: 'user_cancelled' })
    expect(out).toMatchObject({ ok: true })
    expect(ledger.asks.get(askId)).toMatchObject({ status: 'cancelled', closed_reason: 'user_cancelled' })
    expect(answer({ request_id: 'after-cancel' })).toMatchObject({ ok: false, error: { code: 'ask_cancelled' } })
    // 已收场的再取消 → 拒,不写事件
    expect(ledger.asks.cancel({ request_id: 'cx2', actor: ALICE, ask_id: askId, reason: 'again' })).toMatchObject({ ok: false, error: { code: 'ask_cancelled' } })
  })

  it('③ 手重启 / 改路:attempt_id +1,旧 ask 一律 superseded;新一轮的问能答', () => {
    const sibling = openAsk('ask-open-sibling', { tool: 'Edit', file: 'b.ts' })
    const out = ledger.deliveries.newAttempt({ request_id: 'att-2', actor: ALICE, delivery_id: deliveryId, expected_owner_epoch: 1, reason: 'hand_restart' })
    expect(out).toMatchObject({ ok: true, result: { attempt_id: 2, superseded_asks: [askId, sibling] } })
    expect(ledger.deliveries.get(deliveryId)).toMatchObject({ attempt_id: 2 })
    expect(ledger.asks.get(askId)).toMatchObject({ status: 'superseded', closed_reason: 'hand_restart' })
    expect(ledger.asks.get(sibling)).toMatchObject({ status: 'superseded' })
    expect(answer({ request_id: 'old-turn' })).toMatchObject({ ok: false, error: { code: 'ask_superseded' } })
    // 旧一轮的手迟到了才来登记问 → stale_attempt
    const late = ledger.asks.open({ request_id: 'late-open', actor: HAND, delivery_id: deliveryId, attempt_id: 1, target: TARGET, kind: 'permission', options: OPTIONS, content_hash: contentHash(CONTENT), expires_at: c.now() + 60_000 })
    expect(late).toMatchObject({ ok: false, error: { code: 'stale_attempt', detail: { attempt_id: 2 } } })

    const fresh = openAsk('ask-open-2')
    expect(ledger.asks.get(fresh)).toMatchObject({ attempt_id: 2, status: 'open' })
    expect(answer({ request_id: 'new-turn', ask_id: fresh })).toMatchObject({ ok: true })

    const reroute = ledger.deliveries.newAttempt({ request_id: 'att-3', actor: ALICE, delivery_id: deliveryId, expected_owner_epoch: 1, reason: 'reroute', target: { family: 'claude', session_id: 's-2' } })
    expect(reroute).toMatchObject({ ok: true, result: { attempt_id: 3, superseded_asks: [] } })
    expect(ledger.deliveries.get(deliveryId)?.target).toEqual({ family: 'claude', session_id: 's-2' })
  })

  it('④ 改派 / 交接:旧负责人名下 open 的 ask 全部 cancelled;交接后旧负责人的答复拒', () => {
    const second = openAsk('ask-open-2', { tool: 'Edit', file: 'a.ts' })
    const out = ledger.transfer({ request_id: 't1', actor: ALICE, object_id: objectId, new_owner: 'bob', expected_owner_epoch: 1 })
    expect(out).toMatchObject({ ok: true, result: { owner_epoch: 2 } })
    if (!out.ok) return
    expect([...out.result.cancelled_asks].sort()).toEqual([askId, second].sort())
    expect(ledger.asks.get(askId)).toMatchObject({ status: 'cancelled', closed_reason: 'transferred' })
    expect(answer({ request_id: 'old-owner' })).toMatchObject({ ok: false, error: { code: 'ask_cancelled' } })

    // 手向新负责人重新发问(新 ask_id):旧负责人答 → 无权;新负责人答 → 过
    const reask = openAsk('ask-open-3')
    expect(reask).not.toBe(askId)
    expect(ledger.asks.get(reask)).toMatchObject({ owner: 'bob', owner_epoch: 2 })
    expect(answer({ request_id: 'alice-late', ask_id: reask })).toMatchObject({ ok: false, error: { code: 'answerer_not_allowed' } })
    expect(answer({ request_id: 'bob-ok', ask_id: reask }, BOB)).toMatchObject({ ok: true })
  })

  it('⑤ 内容变了:同一工具再问但参数不同 → ask_version +1;按旧版本或旧哈希答的都拒', () => {
    const oldHash = contentHash(CONTENT)
    const newContent = { tool: 'Bash', command: 'rm -rf build dist' }
    const revised = ledger.asks.revise({ request_id: 'rev-1', actor: HAND, ask_id: askId, content_hash: contentHash(newContent) })
    expect(revised).toMatchObject({ ok: true, result: { ask_version: 2 } })

    const byOldVersion = answer({ request_id: 'a-v1', ask_version: 1, content_hash: oldHash })
    expect(byOldVersion).toMatchObject({ ok: false, error: { code: 'ask_version_mismatch', detail: { ask_version: 2 } } })
    const byOldHash = answer({ request_id: 'a-h1', ask_version: 2, content_hash: oldHash })
    expect(byOldHash).toMatchObject({ ok: false, error: { code: 'ask_content_mismatch' } })
    expect(answer({ request_id: 'a-ok', ask_version: 2, content_hash: contentHash(newContent) })).toMatchObject({ ok: true })

    // 内容没变的「再问」不升版本
    const other = openAsk('ask-open-x', { tool: 'Read' })
    const same = ledger.asks.revise({ request_id: 'rev-same', actor: HAND, ask_id: other, content_hash: contentHash({ tool: 'Read' }) })
    expect(same).toMatchObject({ ok: true, result: { ask_version: 1 } })
  })
})

describe('contentHash', () => {
  it('键的顺序不影响哈希;内容不同哈希不同', () => {
    expect(contentHash({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(contentHash({ b: [1, { d: 3, c: 2 }], a: 1 }))
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }))
    expect(contentHash('x')).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})
