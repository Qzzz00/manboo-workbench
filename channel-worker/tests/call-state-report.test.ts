/**
 * 「现在在不在通话」报给工作台(卡 Q):翻转就报、通话中 30 秒一报、报不出去下一拍接着报、旧工作台 404 不反复敲门。
 */
import { describe, expect, it } from 'vitest'
import { CALL_STATE_HEARTBEAT_MS, CallStateReporter, postCallState } from '../src/callStateReport.ts'

function harness(sendOk: () => boolean = () => true) {
  let active = false
  let t = 0
  const sent: boolean[] = []
  const reporter = new CallStateReporter({
    isActive: () => active,
    send: async (value) => { sent.push(value); return sendOk() },
    now: () => t,
  })
  return { reporter, sent, setActive: (value: boolean) => { active = value }, advance: (ms: number) => { t += ms } }
}

describe('CallStateReporter', () => {
  it('★起来先报一次(清掉工作台那边可能挂着的旧状态);之后只在翻转时报', async () => {
    const h = harness()
    await h.reporter.tick()
    expect(h.sent).toEqual([false])
    h.advance(2000)
    await h.reporter.tick()
    expect(h.sent).toEqual([false])
    h.setActive(true)
    await h.reporter.tick()
    h.setActive(false)
    await h.reporter.tick()
    expect(h.sent).toEqual([false, true, false])
  })

  it('★通话中每 30 秒再报一次(工作台那边「在通话」只算 90 秒)', async () => {
    const h = harness()
    h.setActive(true)
    await h.reporter.tick()
    h.advance(CALL_STATE_HEARTBEAT_MS - 1)
    await h.reporter.tick()
    expect(h.sent).toEqual([true])
    h.advance(1)
    await h.reporter.tick()
    expect(h.sent).toEqual([true, true])
  })

  it('报不出去:下一拍接着报', async () => {
    let ok = false
    const h = harness(() => ok)
    h.setActive(true)
    await h.reporter.tick()
    ok = true
    await h.reporter.tick()
    await h.reporter.tick()
    expect(h.sent).toEqual([true, true])
  })

  it('postCallState:报 { in_call };旧工作台 404 当报过了;连不上当没报到', async () => {
    const bodies: string[] = []
    const ok = postCallState('http://127.0.0.1:8791/', (async (url: string, init: RequestInit) => {
      bodies.push(`${url} ${String(init.body)}`)
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch)
    expect(await ok(true)).toBe(true)
    expect(bodies).toEqual(['http://127.0.0.1:8791/channel/call-state {"in_call":true}'])
    const old = postCallState('http://x', (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch)
    expect(await old(false)).toBe(true)
    const down = postCallState('http://x', (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch)
    expect(await down(false)).toBe(false)
  })
})
