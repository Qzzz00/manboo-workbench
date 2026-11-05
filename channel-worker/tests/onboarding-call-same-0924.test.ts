/**
 * 引导那一通与平时电话同一套(2026-09-24,卡 `fix/onboarding-call-same-as-call`)在工人这一头的部分:
 * **先回话,换提示词在后台接着做** —— 手机拿到回话就算接通,所以回话不能再排在换提示词后面。
 *
 * 钉住的顺序(`beginOnboardingCall`,纯编排,每一步用假的):
 *   1. 回话在开场白发出去那一刻就落定,不等换提示词;
 *   2. 开场白只说一次,换上的提示词按「已经说过了」拼;
 *   3. 接着做那一句排在换完之后;换完时已经停了就不说;
 *   4. 换失败:日志有原因、她说一句人话(wearFailed)、回话照旧是接通(手机早就接通了);
 *   5. 归电脑管 / 取不到简报 / 做完了:与以前一模一样,不开口、不换;
 *   6. 同一通里又开一次:等上一次换完再换。
 * agent.ts 里的接线(停引导、打字那句都排在后台那一下后面)用源码断言钉一下。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { OnboardingBrief } from '../src/onboarding.ts'
import { ONBOARDING_OPENING_LINE } from '../src/onboarding.ts'
import { ONBOARDING_WEAR_FAILED_LINE, beginOnboardingCall, type OnboardingBeginSteps } from '../src/agent.ts'

function brief(over: Partial<OnboardingBrief> = {}): OnboardingBrief {
  return {
    stage: 'opening',
    label: '① 开场',
    done: false,
    seed: ONBOARDING_OPENING_LINE,
    speak_seed: true,
    goals: ['用户希望被怎么称呼'],
    keys: [{ name: 'nickname', kind: 'string', desc: '称呼(以后就这么叫)', required: true }],
    answered: {},
    ...over,
  }
}

interface Gate {
  promise: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
}

function gate(): Gate {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((res, rej) => { resolve = () => res(); reject = rej })
  return { promise, resolve, reject }
}

/** 一套假的步骤:每一步记进 `events`;换提示词由用例手动放行(`wears[i].gate.resolve()`)。 */
function fakeSteps(input: { brief?: OnboardingBrief, fetch?: { ok: false, error: string } } = {}) {
  const events: string[] = []
  const logs: string[] = []
  const wears: { brief: OnboardingBrief, gate: Gate }[] = []
  let on = false
  const steps: OnboardingBeginSteps = {
    fetchBrief: async () => {
      events.push('fetch')
      return input.fetch ?? { ok: true, brief: input.brief ?? brief() }
    },
    open: (b) => { on = true; events.push(`open:${b.stage}`) },
    speakSeed: (seed, stage) => { events.push(`seed:${stage}:${seed === ONBOARDING_OPENING_LINE ? 'opening-line' : seed}`) },
    wear: async (b) => {
      const g = gate()
      wears.push({ brief: b, gate: g })
      events.push('wear:start')
      await g.promise
      events.push('wear:done')
    },
    stillOn: () => on,
    resumeReply: () => { events.push('resume-reply') },
    wearFailed: async (why) => { on = false; events.push(`wear-failed:${why}`) },
    log: (line) => { logs.push(line) },
  }
  return { steps, events, logs, wears, stop: () => { on = false } }
}

/** 让已经排着的微任务都跑完(不推进任何计时器)。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

describe('先回话,换提示词在后台接着做', () => {
  it('回话在开场白发出去那一刻落定:这时换提示词才刚开始,还没换完', async () => {
    const fake = fakeSteps()
    const outcome = await beginOnboardingCall(fake.steps)
    expect(outcome.reply).toEqual({ ok: true, stage: 'opening' })
    // 回话拿到手时:开场白已经发出去、换提示词开始了但没换完。
    expect(fake.events).toEqual(['fetch', 'open:opening', 'seed:opening:opening-line', 'wear:start'])
    expect(outcome.wearing).toBeDefined()
    fake.wears[0]!.gate.resolve()
    await expect(outcome.wearing).resolves.toBe(true)
    expect(fake.events.at(-1)).toBe('wear:done')
  })

  it('开场白只说一次:换上的提示词按「已经说过了」拼,不让模型再念一遍;说过开场白就不另起续接那句', async () => {
    const fake = fakeSteps()
    const outcome = await beginOnboardingCall(fake.steps)
    fake.wears[0]!.gate.resolve()
    await outcome.wearing
    expect(fake.events.filter(e => e.startsWith('seed:'))).toHaveLength(1)
    expect(fake.wears).toHaveLength(1)
    expect(fake.wears[0]!.brief.speak_seed).toBe(false)
    expect(fake.wears[0]!.brief.seed).toBe(ONBOARDING_OPENING_LINE)
    expect(fake.events).not.toContain('resume-reply')
  })

  it('接着做(这一段说过了):不重说开场白;续接那一句排在换完之后,换完之前一个字都不说', async () => {
    const fake = fakeSteps({ brief: brief({ stage: 'habits', label: '④ 习惯偏好', speak_seed: false }) })
    const outcome = await beginOnboardingCall(fake.steps)
    expect(outcome.reply).toEqual({ ok: true, stage: 'habits' })
    expect(fake.events).toEqual(['fetch', 'open:habits', 'wear:start'])
    await settle()
    expect(fake.events).not.toContain('resume-reply')
    fake.wears[0]!.gate.resolve()
    await expect(outcome.wearing).resolves.toBe(true)
    expect(fake.events.slice(-2)).toEqual(['wear:done', 'resume-reply'])
  })

  it('换完之前他已经挂了(引导停了):续接那一句不说', async () => {
    const fake = fakeSteps({ brief: brief({ speak_seed: false }) })
    const outcome = await beginOnboardingCall(fake.steps)
    fake.stop()
    fake.wears[0]!.gate.resolve()
    await expect(outcome.wearing).resolves.toBe(true)
    expect(fake.events).not.toContain('resume-reply')
  })

  it('换提示词失败:日志一行原因、她说一句人话并换回平时那套;回话照旧是接通(手机早就接通了)', async () => {
    const fake = fakeSteps({ brief: brief({ speak_seed: false }) })
    const outcome = await beginOnboardingCall(fake.steps)
    expect(outcome.reply.ok).toBe(true)
    fake.wears[0]!.gate.reject(new Error('活动已经关了'))
    await expect(outcome.wearing).resolves.toBe(false)
    expect(fake.logs.some(line => line.includes('引导的提示词没换上') && line.includes('活动已经关了'))).toBe(true)
    expect(fake.events).toContain('wear-failed:活动已经关了')
    expect(fake.events).not.toContain('resume-reply')
    // 那句人话:短、第一人称、给一条能走的路,不带技术原因、不说「她」。
    expect(ONBOARDING_WEAR_FAILED_LINE).toContain('先挂断')
    expect(ONBOARDING_WEAR_FAILED_LINE).not.toMatch(/Error|updateAgent|提示词|她/)
  })

  it('换失败时这一通已经停了:不再说那句(没人听),也不抛', async () => {
    const fake = fakeSteps()
    const outcome = await beginOnboardingCall(fake.steps)
    fake.stop()
    fake.wears[0]!.gate.reject(new Error('x'))
    await expect(outcome.wearing).resolves.toBe(false)
    expect(fake.events.some(e => e.startsWith('wear-failed'))).toBe(false)
  })

  it('收场那一步自己抛了也不把后台那一段带崩', async () => {
    const fake = fakeSteps()
    fake.steps.wearFailed = async () => { throw new Error('说不出来') }
    const outcome = await beginOnboardingCall(fake.steps)
    fake.wears[0]!.gate.reject(new Error('x'))
    await expect(outcome.wearing).resolves.toBe(false)
    expect(fake.logs.some(line => line.includes('说不出来'))).toBe(true)
  })
})

describe('与以前一模一样的三条', () => {
  it('归电脑管:一个字都不说、什么都不换,如实回 leader:desktop', async () => {
    const fake = fakeSteps({ brief: brief({ leader: 'desktop' }) })
    const outcome = await beginOnboardingCall(fake.steps)
    expect(outcome.reply).toEqual({ ok: true, stage: 'opening', leader: 'desktop' })
    expect(outcome.wearing).toBeUndefined()
    expect(fake.events).toEqual(['fetch'])
    expect(fake.logs.some(line => line.includes('归电脑管'))).toBe(true)
  })

  it('取不到简报:如实回原话,不开口', async () => {
    const fake = fakeSteps({ fetch: { ok: false, error: '工作台连不上,引导接不上' } })
    const outcome = await beginOnboardingCall(fake.steps)
    expect(outcome.reply).toEqual({ ok: false, error: '工作台连不上,引导接不上' })
    expect(outcome.wearing).toBeUndefined()
    expect(fake.events).toEqual(['fetch'])
  })

  it('引导已经做完:回 done,不开口', async () => {
    const fake = fakeSteps({ brief: brief({ done: true }) })
    const outcome = await beginOnboardingCall(fake.steps)
    expect(outcome.reply).toEqual({ ok: true, stage: 'done' })
    expect(fake.events).toEqual(['fetch'])
  })
})

describe('同一通里又开一次(「改回手机」)', () => {
  it('等上一次换完再换,两下不交错', async () => {
    const first = fakeSteps()
    const one = await beginOnboardingCall(first.steps)
    const second = fakeSteps({ brief: brief({ speak_seed: false }) })
    const two = await beginOnboardingCall(second.steps, one.wearing)
    expect(two.reply.ok).toBe(true)
    await settle()
    // 上一次还没换完:这一次还没开始换。
    expect(second.wears).toHaveLength(0)
    first.wears[0]!.gate.resolve()
    await one.wearing
    await settle()
    expect(second.wears).toHaveLength(1)
    second.wears[0]!.gate.resolve()
    await expect(two.wearing).resolves.toBe(true)
  })
})

describe('agent.ts 的接线', () => {
  const agent = readFileSync(join(import.meta.dirname, '..', 'src', 'agent.ts'), 'utf8')
  it('begin 走 beginOnboardingCall,回话不再等换提示词', () => {
    expect(agent).toContain('const begun = await beginOnboardingCall({')
    expect(agent).toContain('return begun.reply')
    expect(agent).not.toContain('await wearOnboarding(spokeSeed ?')
  })
  it('停引导、打字那一句都排在后台那一下后面(不然引导那套会盖回来 / 那句落在平时人设上)', () => {
    const stop = agent.slice(agent.indexOf('async function stopOnboarding'), agent.indexOf('onboarding = {'))
    expect(stop.indexOf('await onboardingWearing')).toBeGreaterThan(-1)
    expect(stop.indexOf('await onboardingWearing')).toBeLessThan(stop.indexOf('await wearBase()'))
    const say = agent.slice(agent.indexOf('async say(text) {'), agent.indexOf('stop: stopOnboarding'))
    expect(say.indexOf('await onboardingWearing')).toBeGreaterThan(-1)
    expect(say.indexOf('await onboardingWearing')).toBeLessThan(say.indexOf('generateReply({ userInput: trimmed })'))
  })
})
