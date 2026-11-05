/**
 * 电话少说几句(2026-10-12,维护者:「现在跟事务官电话,真的好啰嗦」)。
 *
 * 「电话每轮不超过两句」以前只管模型自己吐的字;系统替她插的固定话(先应「好,我去安排。」、
 * 垫场「等我一下。」、现生的首句)不进那两句,一轮叠出四五句。现在:
 *   ① 固定话也记进同一回合的额度,但**至少给模型留一句**(不然她只会「好的」不说结果);
 *   ② 先应过,就告诉模型只剩一句、直接说结果;
 *   ③ 她说话时插的「嗯」一轮最多一声。
 */
import { describe, expect, it } from 'vitest'
import { ACK_MAX_PER_TURN } from '../src/backchannel.ts'
import { SentenceBudget } from '../src/sentenceCap.ts'
import { ackedNote } from '../src/turnRoute.ts'

describe('固定话记进这一回合的额度', () => {
  it('先应一句之后,模型只剩一句', () => {
    const budget = new SentenceBudget()
    budget.charge('好,我去安排。', 2)
    expect(budget.take('我让 Codex 去改了。它做完我告诉你。', 2)).toBe('我让 Codex 去改了。')
  })

  it('先应 + 垫场两句固定话:也至少给模型留一句', () => {
    const budget = new SentenceBudget()
    budget.charge('好,我去安排。', 2)
    budget.charge('等我一下。', 2)
    expect(budget.take('派出去了。还有别的吗?', 2)).toBe('派出去了。')
  })

  it('没有句末标点的固定话(「我想想」)也算一句', () => {
    const budget = new SentenceBudget()
    budget.charge('我想想', 3)
    expect(budget.spent).toBe(1)
  })

  it('没有上限(规矩被删了)就不记、不掐', () => {
    const budget = new SentenceBudget()
    budget.charge('好,我去安排。', undefined)
    expect(budget.spent).toBe(0)
  })

  it('上限是 1:固定话一句都不占(那一句留给结果)', () => {
    const budget = new SentenceBudget()
    budget.charge('好,我去安排。', 1)
    expect(budget.take('派出去了。', 1)).toBe('派出去了。')
  })

  it('新的一回合重来', () => {
    const budget = new SentenceBudget()
    budget.charge('好,我去安排。', 2)
    budget.reset()
    expect(budget.take('一。二。三。', 2)).toBe('一。二。')
  })
})

describe('先应过之后那一行', () => {
  it('告诉模型只剩一句、直接说结果', () => {
    const note = ackedNote('好,我去安排。')
    expect(note).toContain('一句话')
    expect(note).toContain('不要再应一次')
  })
})

describe('她说话时插的「嗯」', () => {
  it('一轮最多一声', () => {
    expect(ACK_MAX_PER_TURN).toBe(1)
  })
})
