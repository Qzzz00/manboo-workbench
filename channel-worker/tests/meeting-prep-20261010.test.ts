/**
 * 会前(2026-10-10,卡「会前画像与预案」):电话里登记一场会、答还差的那一问;出门的手机经房间代理的白名单。
 */
import { describe, expect, it } from 'vitest'
import { createWorkbenchClient } from '../src/workbench.ts'
import { RPC_ALLOWED } from '../src/rpc.ts'
import { INTENT_TOOLS } from '../src/intentTools.ts'
import { TOOL_ANSWER_MEETING, TOOL_PLAN_MEETING } from '../src/tools.ts'

function stub(status: number, body: unknown) {
  const calls: { path: string, body: unknown }[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ path: new URL(String(input)).pathname, body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('电话里的会前', () => {
  it('登记 → POST /meeting/plan(原话);照工作台那句说,并叮嘱拟好的问话不替她发', async () => {
    const s = stub(200, { ok: true, note: '记下了这场会:「跟 B 客户谈」(下午三点)。还差一问:什么类型的会?' })
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: s.impl })
    const got = await client.planMeeting!('下午三点跟 B 客户谈')
    expect(s.calls).toEqual([{ path: '/meeting/plan', body: { text: '下午三点跟 B 客户谈' } }])
    expect(got.ok).toBe(true)
    expect(got.text).toContain('还差一问:什么类型的会?')
    expect(got.text).toContain('不要替她发')
  })
  it('答 → POST /meeting/answer(不带 id = 最近那场还在问的会);空话不发', async () => {
    const s = stub(200, { ok: true, note: '还差一问:谁来' })
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: s.impl })
    expect((await client.answerMeeting!('  ')).ok).toBe(false)
    await client.answerMeeting!('谈判会')
    expect(s.calls).toEqual([{ path: '/meeting/answer', body: { answer: '谈判会' } }])
  })
  it('旧版工作台(404)/ 答错(409)如实说', async () => {
    const old = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub(404, {}).impl })
    expect((await old.planMeeting!('下午三点开会')).text).toContain('还不会登记会议')
    const bad = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub(409, { error: '内部会还是外部会?选一个。' }).impl })
    expect((await bad.answerMeeting!('火星')).text).toContain('内部会还是外部会')
  })
  it('「记一下」那一组带上登记与答那两件', () => {
    const remember = INTENT_TOOLS.find(one => one.id === 'remember')!
    expect(remember.tools).toContain(TOOL_PLAN_MEETING)
    expect(remember.tools).toContain(TOOL_ANSWER_MEETING)
  })
})

describe('房间代理白名单', () => {
  const allowed = (method: string, path: string) => RPC_ALLOWED.some(one => one.method === method && (typeof one.path === 'string' ? one.path === path : one.path.test(path)))
  it('会前那五条文字路由进;花名档案不进(只在她电脑上)', () => {
    for (const path of ['/meeting/plan', '/meeting/answer', '/meeting/card', '/meeting/drop', '/meeting/outcome']) expect(allowed('POST', path)).toBe(true)
    expect(allowed('GET', '/meeting/people')).toBe(false)
    expect(allowed('POST', '/meeting/people/forget')).toBe(false)
  })
})
