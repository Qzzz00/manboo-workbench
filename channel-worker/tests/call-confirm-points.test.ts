/**
 * 电话里的确认点(2026-09-23,维护者 13:05)。他的原话:
 *
 * > 「不只是这张卡的问题,是如果后面这种自然语言需求的传递都会被曲解,那么用户的体验
 * > 会非常差,这里最好是能当场给一些确认的点,**不能假装自己搞懂了**。」
 *
 * 那天的例子就发生在电话里:「把音色改成可配置、通话中能改」一路传下来做成了
 * 「念三个名字让他挑」。这一份钉的是那道门:
 *
 * 1. **三个入口都先出确认点**(交给事务官办 / 派需求卡 / 给已在办的事补一句;「只记」不过门),**第一次一定不办**;
 * 2. 他点头之后(`confirmed: true`)才真办;
 * 3. 他说「先记着」(`hold: true`)= **只建卡不派活**,卡上标「未确认」;
 * 4. 电话里**最多念三条**;
 * 5. 问不到 8791 那张表时**门照样关着**,并如实说这一次没拿到表 —— 不装作问过了。
 */
import { describe, expect, it } from 'vitest'
import { TOOL_DISPATCH, TOOL_HAND, createChannelTools,
} from '../src/tools.ts'
import { UNCONFIRMED_MARK, fallbackSpoken, isHoldPhrase, spokenPoints } from '../src/confirm.ts'
import { createWorkbenchClient } from '../src/workbench.ts'

/** 09-23 那一句原话。 */
const NEED = '把音色改成可配置的,而且我在电话通话中能够改'

interface FakeTool { execute: (args: Record<string, unknown>, ctx: never) => Promise<unknown> }
function toolOf(tools: unknown, name: string): FakeTool {
  return (tools as Record<string, FakeTool>)[name] as FakeTool
}

/** 8791 的假回包。`/confirm/points` 那条回的是工作台真会回的形状。 */
function stubFetch(reply: (path: string, method: string) => { status: number, body: unknown }) {
  const calls: { path: string, method: string, body: unknown }[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const method = init?.method ?? 'GET'
    calls.push({ path, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined })
    const result = reply(path, method)
    return new Response(JSON.stringify(result.body), {
      status: result.status, headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { impl, calls }
}

const SPOKEN = spokenPoints({
  understanding: NEED,
  points: [
    { ask: '他从哪儿触发这件事', guess: '在他此刻正看着的那一处直接说' },
    { ask: '他说不清楚的时候怎么办', guess: '她照他那句模糊的描述自己挑一个' },
    { ask: '怎么算做完', guess: '他照着走一遍、结果跟他说的一样' },
  ],
})

function client(over?: (path: string, method: string) => { status: number, body: unknown } | undefined) {
  const stub = stubFetch((path, method) => {
    const custom = over?.(path, method)
    if (custom !== undefined) return custom
    if (path === '/confirm/points') return { status: 200, body: { ok: true, spoken: SPOKEN, block: SPOKEN } }
    return { status: 200, body: { ok: true, id: 't-9' } }
  })
  return { stub, workbench: createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub.impl }) }
}

describe('三个入口都先出确认点', () => {

  // 「只记」那一件(wb_remember_item)**不过这道门**:门拦的是派活,不是记。见 call-remember-direct.test.ts。

  it('★ 电话里那一段**最多三条**', () => {
    expect(SPOKEN).not.toContain('④')
    expect(SPOKEN.split('\n').filter(line => /^[①②③]/.test(line)).length).toBeLessThanOrEqual(3)
  })
})

describe('★★ 他说「先记着」= 只建卡不派活', () => {

  it('「先记着」这几种说法都认得出来(一条规则,不交给模型)', () => {
    expect(isHoldPhrase('先记着吧')).toBe(true)
    expect(isHoldPhrase('回头再说')).toBe(true)
    expect(isHoldPhrase('你去办吧')).toBe(false)
  })
})

describe('★ 问不到那张表时', () => {

  it('兜底那一条里**验收永远不能省**', () => {
    expect(fallbackSpoken(NEED)).toContain('怎么算做完')
  })
})

