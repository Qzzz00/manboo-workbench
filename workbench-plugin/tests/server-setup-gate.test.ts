/**
 * 「这台机器装好了没有」(2026-09-23 从零重装验收第 3 件)。判据:注册过账号 + 引导走完了。
 */
import { describe, expect, it } from 'vitest'
import { SETUP_GATE_NOT_REGISTERED, SETUP_GATE_ONBOARDING_PENDING, createSetupGate } from '../src/server/setupGate.ts'

describe('装好了没有', () => {
  it('还没问到过账号:当没注册(宁可晚一拍,不在没注册时跑)', () => {
    const gate = createSetupGate({ registered: async () => true, onboardingDone: () => true })
    expect(gate.reason()).toBe(SETUP_GATE_NOT_REGISTERED)
  })

  it('注册了、引导没走完 → 引导那一句;走完 → 好了', async () => {
    let done = false
    const gate = createSetupGate({ registered: async () => true, onboardingDone: () => done })
    await gate.refresh()
    expect(gate.reason()).toBe(SETUP_GATE_ONBOARDING_PENDING)
    done = true
    expect(gate.reason()).toBeUndefined()
  })

  it('没有引导可走的机器(undefined)算走完', async () => {
    const gate = createSetupGate({ registered: async () => true, onboardingDone: () => undefined })
    await gate.refresh()
    expect(gate.reason()).toBeUndefined()
  })

  it('账号那一格过了 refreshMs 在后台再问;问的时候抛了当没注册', async () => {
    let clock = 0
    let registered: () => Promise<boolean> = async () => false
    const gate = createSetupGate({ registered: () => registered(), onboardingDone: () => true, now: () => clock, refreshMs: 100 })
    await gate.refresh()
    expect(gate.reason()).toBe(SETUP_GATE_NOT_REGISTERED)
    registered = async () => true
    clock = 50
    gate.reason()
    await new Promise(r => setTimeout(r, 0))
    expect(gate.reason()).toBe(SETUP_GATE_NOT_REGISTERED)
    clock = 150
    gate.reason()
    await new Promise(r => setTimeout(r, 0))
    expect(gate.reason()).toBeUndefined()
    registered = async () => { throw new Error('读不了盘') }
    clock = 300
    gate.reason()
    await new Promise(r => setTimeout(r, 0))
    expect(gate.reason()).toBe(SETUP_GATE_NOT_REGISTERED)
  })
})
