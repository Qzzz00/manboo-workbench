// @vitest-environment node
/**
 * A2(2026-10-28):电话与手机两个入口接到同一个理解中枢 —— 入口映射与电话那份回包。
 * 执行口 / 上下文包的函数是 `hub/run.ts` 的 hubExecute / hubContext(A1 的用例钉着),路由的真服务用例在 `hub-call-phone-http-a2.test.ts`。
 */
import { describe, expect, it } from 'vitest'
import { CALL_HUB_BAD_OUTPUT, CALL_HUB_UNREACHABLE, callReplyOf, hubEntranceOf } from '../src/server/hubEntrances.ts'

describe('hubEntranceOf:入口映射', () => {
  it('desktop → desktop;call → call', () => {
    expect(hubEntranceOf('desktop', undefined)).toBe('desktop')
    expect(hubEntranceOf('call', undefined)).toBe('call')
  })
  it('电话工人的老写法(phone + in_call)→ call', () => {
    expect(hubEntranceOf('phone', true)).toBe('call')
  })
  it('手机文字:phone(新)与 phone_text(老包)→ phone', () => {
    expect(hubEntranceOf('phone', undefined)).toBe('phone')
    expect(hubEntranceOf('phone_text', undefined)).toBe('phone')
  })
  it('不带 entrance / 不认识的 → undefined(走旧路,老调用方一字不变)', () => {
    expect(hubEntranceOf(undefined, true)).toBeUndefined()
    expect(hubEntranceOf('hold_to_talk', undefined)).toBeUndefined()
    expect(hubEntranceOf(42, undefined)).toBeUndefined()
  })
})

describe('callReplyOf:电话那份回包', () => {
  it('502 坏输出 / 503 接不上 → 200 标准形状念「没动」', () => {
    expect(callReplyOf({ status: 502, body: { error: 'x', hub: { why: 'bad_output' } } }, () => 's1')).toEqual({
      status: 200, body: { say_id: 's1', items: [], say: { screen: CALL_HUB_BAD_OUTPUT, spoken: CALL_HUB_BAD_OUTPUT }, hub: { why: 'bad_output' } },
    })
    expect((callReplyOf({ status: 503, body: {} }, () => 's2').body.say as { spoken: string }).spoken).toBe(CALL_HUB_UNREACHABLE)
  })
  it('其余原样(200 / 409)', () => {
    const ok = { status: 200, body: { say_id: 'a' } }
    expect(callReplyOf(ok)).toBe(ok)
    expect(callReplyOf({ status: 409, body: {} }).status).toBe(409)
  })
})
