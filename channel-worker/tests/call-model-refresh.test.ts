// @vitest-environment node
/**
 * 工人接话模型「每通刷新」的接线钉桩(2026-10-23 源审退修,第三处):
 * - greet 在返回 ok 之前 await refreshCallModel —— textTurnPort.say 在 await greet 后
 *   立刻投首句,模型刷新必须在此之前完成(本地读文件 + updateOptions,毫秒级;
 *   不等无关的 families/persona 网络);
 * - refreshCallModel 不再挂在 refreshSelfBrief 里 —— families 那条无关网络不再 gate 模型刷新。
 *
 * agent.ts 需要 LiveKit 才有测试台(startChannelAgent 要真进房),与 family-pool-per-call
 * 同一种办法:读源码钉接线位置。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const agent = readFileSync(join(import.meta.dirname, '..', 'src', 'agent.ts'), 'utf8')

describe('每通模型刷新的接线(2026-10-23 源审退修)', () => {
  it('★greet 在返回 ok 之前 await refreshCallModel(首句投给 LLM 前模型已刷新)', () => {
    const greetStart = agent.indexOf('async greet(')
    const greetEnd = agent.indexOf('async answer(', greetStart)
    expect(greetStart).toBeGreaterThan(-1)
    expect(greetEnd).toBeGreaterThan(greetStart)
    const refreshInGreet = agent.indexOf('await refreshCallModel()', greetStart)
    // greet 里有几处提前 return(引导、来电已接起那两条不算新一通):钉的是**最后一个** ok。
    const finalReturn = agent.lastIndexOf('return { ok: true }', greetEnd)
    expect(refreshInGreet).toBeGreaterThan(greetStart)
    expect(finalReturn).toBeGreaterThan(refreshInGreet)
  })

  it('★refreshCallModel 不再挂在 refreshSelfBrief 里:families 那条无关网络不 gate 模型刷新', () => {
    const briefStart = agent.indexOf('async function refreshSelfBrief')
    const briefEnd = agent.indexOf('await session.start(')
    expect(briefStart).toBeGreaterThan(-1)
    expect(briefEnd).toBeGreaterThan(briefStart)
    const briefBody = agent.slice(briefStart, briefEnd)
    expect(briefBody.includes('await refreshCallModel()')).toBe(false)
    // refreshCallModel 仍在文件里(定义没被删),只是挪到了调用点。
    expect(agent.includes('async function refreshCallModel')).toBe(true)
  })
})
