/**
 * 1a 原范围补齐的纯核负例/正例(2026-10-24,卡 t-1fc4c898 补轮):
 * 挂起确认(她明说先确认)→ 肯定短句解冻;改口并件(rename 保护 custom 名/cancel/merge);
 * 同家多卡点名解析(不静默挑一张);running 真实证据(终态/过旧/未纳管=unknown)。
 */
import { describe, expect, it } from 'vitest'
import { affirmFast } from '../src/server/butlerSay.ts'
import { resolveSayWho, runningEvidenceOf } from '../src/server/sayCards.ts'

describe('affirmFast:挂起确认后的肯定短句', () => {
  it.each([
    ['好,去建吧', true],
    ['行,去建吧', true],
    ['嗯,去办', true],
    ['可以,去做', true],
    ['好的', true],
    ['行', true],
    ['可以', true],
    ['确认', true],
    ['就这么办', true],
    ['嗯去吧', true],
    ['不用了', false],
    ['先别建', false],
    ['改成周五再发', false],
    ['帮我记一下周四的事', false],
  ])('%s → %s', (said, want) => {
    expect(affirmFast(said)).toBe(want)
  })
})


describe('resolveSayWho:同家多卡不静默挑一张', () => {
  const card = (id: string, family: string): { id: `agent:${string}`, runtime?: { family: string } } =>
    ({ id: `agent:${id}`, runtime: { family } })

  it('名片 id 直接解析(已有行为)', () => {
    expect(resolveSayWho('agent:k1', [card('k1', 'kimi')], [], 0))
      .toEqual({ ok: true, family: 'kimi', cardId: 'agent:k1' })
  })
  it('家名只有一张名片 → 那张(带 cardId)', () => {
    expect(resolveSayWho('kimi', [card('k1', 'kimi'), card('c1', 'claude')], [], 0))
      .toEqual({ ok: true, family: 'kimi', cardId: 'agent:k1' })
  })
  it('家名多张、恰有一张在跑 → 选那张并如实带 cardId', () => {
    const tasks = [{ assignee: 'agent:k2', dispatch: { status: 'running', started_at: new Date().toISOString() } }] as never
    const out = resolveSayWho('kimi', [card('k1', 'kimi'), card('k2', 'kimi')], tasks, Date.now())
    expect(out).toEqual({ ok: true, family: 'kimi', cardId: 'agent:k2' })
  })
  it('家名多张、都没跑 → 明确拒(指名片 id),不静默挑', () => {
    const out = resolveSayWho('kimi', [card('k1', 'kimi'), card('k2', 'kimi')], [], Date.now())
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.why).toContain('两张')
  })
  it('已删的 id 明确拒(已有)', () => {
    expect(resolveSayWho('agent:gone', [card('k1', 'kimi')], [], 0).ok).toBe(false)
  })
})

describe('runningEvidenceOf:只按真实开工事实', () => {
  const now = Date.parse('2026-10-24T12:00:00Z')
  const iso = (min: number): string => new Date(now - min * 60_000).toISOString()

  it('running + 24h 内开工 → running', () => {
    expect(runningEvidenceOf({ dispatch: { family: 'kimi', status: 'running', started_at: iso(30) } }, now)).toBe('running')
  })
  it('running 但 24h 前开工(可能没收场)→ 不算在忙', () => {
    expect(runningEvidenceOf({ dispatch: { family: 'kimi', status: 'running', started_at: iso(25 * 60) } }, now)).toBe('unknown')
  })
  it('running 但已有收场时刻(重启丢的僵尸态)→ unknown', () => {
    expect(runningEvidenceOf({ dispatch: { family: 'kimi', status: 'running', started_at: iso(10), ended_at: iso(5) } }, now)).toBe('unknown')
  })
  it('终态 done/failed → unknown', () => {
    expect(runningEvidenceOf({ dispatch: { family: 'kimi', status: 'done', started_at: iso(10), ended_at: iso(5) } }, now)).toBe('unknown')
  })
  it('没有派活账(外部手工 CLI 未纳管)→ unknown,不编', () => {
    expect(runningEvidenceOf(undefined, now)).toBe('unknown')
  })
  it('started_at 读不出 → unknown', () => {
    expect(runningEvidenceOf({ dispatch: { family: 'kimi', status: 'running', started_at: '' } }, now)).toBe('unknown')
  })
})

describe('resolveSayWho:名字里夹带名片 id', () => {
  it('「QA 链路 Kimi(agent:local:x1)」→ 抽出 id 解析成那张卡', () => {
    const card = { id: 'agent:local:x1' as `agent:${string}`, runtime: { family: 'kimi' } }
    expect(resolveSayWho('QA 链路 Kimi(agent:local:x1)', [card], [], 0))
      .toEqual({ ok: true, family: 'kimi', cardId: 'agent:local:x1' })
  })
})
