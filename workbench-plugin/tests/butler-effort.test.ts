// @vitest-environment node
/**
 * 思考档(2026-09-28,卡 BS):分档表本身、以及「这个模型没有那一档」怎么办。
 * 接到会话上的那一段在 `server-composer-wiring.test.ts`;落成 YAML 的那几行在 `dsh-profile-patch.test.ts`。
 */
import { describe, expect, it } from 'vitest'
import { BUTLER_EFFORT, BUTLER_EFFORT_DEFAULT, effortFor, resolveEffort } from '../src/server/butlerEffort.ts'
import { relayThinkingLevels } from '../src/server/dshModelSettings.ts'

describe('分档表(设计 6.2)', () => {
  it('默认是关', () => {
    expect(BUTLER_EFFORT_DEFAULT).toBe('off')
  })

  it('有人在等 / 答案就在记录里的那几件:关', () => {
    for (const job of ['intake', 'dispatchNamed', 'relay', 'morning', 'onboarding'] as const) {
      expect(effortFor(job)).toBe('off')
    }
  })

  it('在几个选项里挑、从记录里摘的那几件:low', () => {
    for (const job of ['dispatchChoose', 'brief', 'screenshotCheck'] as const) {
      expect(effortFor(job)).toBe('low')
    }
  })

  it('真判断、错了会学歪的那两件:high', () => {
    expect(effortFor('evening')).toBe('high')
    expect(effortFor('lint')).toBe('high')
  })

  it('表里每一档都是线上真有的那四个之一', () => {
    for (const level of Object.values(BUTLER_EFFORT)) {
      expect(['off', 'low', 'high', 'max']).toContain(level)
    }
  })
})

describe('这个模型没有那一档', () => {
  it('pro 线上没有 low —— 登记里也没有,不骗 DSH 说有', () => {
    expect(relayThinkingLevels('deepseek-v4-pro').map(one => one.level)).toEqual(['off', 'high', 'max'])
    expect(relayThinkingLevels('deepseek-v4-flash').map(one => one.level)).toEqual(['off', 'low', 'high', 'max'])
  })

  it('要 low 而模型没有 → 往上挪一档,不掉到关', () => {
    expect(resolveEffort('deepseek-v4-pro', 'low')).toBe('high')
    expect(resolveEffort('deepseek-v4-flash', 'low')).toBe('low')
  })

  it('本来就有那一档 / 关那一档:原样', () => {
    expect(resolveEffort('deepseek-v4-pro', 'off')).toBe('off')
    expect(resolveEffort('deepseek-v4-pro', 'max')).toBe('max')
  })

  it('没给模型名(他切回了自己的 Key,那边有哪几档我们不知道):原样递,由 DSH 那边拒', () => {
    expect(resolveEffort(undefined, 'high')).toBe('high')
    expect(resolveEffort('', 'low')).toBe('low')
  })
})
