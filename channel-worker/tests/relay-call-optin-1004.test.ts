/**
 * **电话里也是「说了才盯」**(2026-10-04,卡 `claude/relay-call-optin`)。
 *
 * 维护者当天的原话:「不是每次都要的,能不能给个勾选,勾了才需要盯和打电话」。
 * 手机上那是一个勾选框;**电话里没有框** —— 所以口径定成:她**明说**「回了打给我 / 回了告诉我 /
 * 有回复给我打电话」才盯回电,否则不盯(交接与待拍板里写着这一条)。
 *
 * 判据与「打断再发」「新开一条」同一处:`relayIntent(她的原话)` —— **按她的原话判,不按模型填的参数**。
 *
 * 这一份钉三件:
 * ① `relayIntent().callBack`:说了才真,反话(「不用打电话」)不算;
 * ② 捎话那件工具:她没说 → 请求里**没有** `call_on_reply`;说了 → 带 `call_on_reply:true`;
 * ③ `wb_watch_reply`(「盯着刚才那句,回了就打电话」)**本身就是她明说的那一下** → 一定带 `call_on_reply:true`。
 */
import { describe, expect, it } from 'vitest'
import { relayIntent } from '../src/relayIntent.ts'
import { TOOL_RELAY_SESSION, TOOL_WATCH_REPLY, createChannelTools } from '../src/tools.ts'
import { createWorkbenchClient } from '../src/workbench.ts'

interface FakeTool { execute: (args: Record<string, unknown>, ctx: never) => Promise<unknown> }
function toolOf(tools: unknown, name: string): FakeTool {
  return (tools as Record<string, FakeTool>)[name] as FakeTool
}

function client(body: unknown = { ok: true, note: '捎到了。' }) {
  const calls: { path: string, body: Record<string, unknown> | undefined }[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ path: url.pathname, body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined })
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { calls, workbench: createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: impl }) }
}

describe('relayIntent().callBack:她明说了才盯', () => {
  it('★这几句算说了', () => {
    for (const said of [
      '跟 Claude 说一句现在到哪了,回了打给我',
      '问问豆包国庆放几天,回了告诉我',
      '给 Codex 发个信息问进度,有回复给我打电话',
      '跟它说一句先停下,它回了打个电话告诉我',
    ]) expect(relayIntent(said).callBack, said).toBe(true)
  })

  it('★这几句都不算(她没提回电,或者明着说了不用)', () => {
    for (const said of [
      '跟 Claude 说一句现在到哪了',
      '问问豆包国庆放几天',
      '跟它说一句先停下,不用打电话给我',
      '别给我打电话,就把这句话送进去',
    ]) expect(relayIntent(said).callBack, said).toBe(false)
  })
})

describe('捎话那件工具:她没说就不盯', () => {
  it('★她没说「回了打给我」→ 请求里没有 call_on_reply(= 不盯回电)', async () => {
    const { calls, workbench } = client()
    const tools = createChannelTools({ workbench, lastSaid: () => '跟 Codex 那条说一句:先停下等我' })
    await toolOf(tools, TOOL_RELAY_SESSION).execute({ who: 'Codex 那条', text: '先停下等我' }, {} as never)
    expect(calls.map(one => one.path)).toEqual(['/sessions/relay'])
    expect(calls[0]?.body).not.toHaveProperty('call_on_reply')
  })

  it('★她明说了 → 带 call_on_reply:true', async () => {
    const { calls, workbench } = client()
    const tools = createChannelTools({ workbench, lastSaid: () => '跟 Codex 那条说一句:先停下等我,回了打给我' })
    await toolOf(tools, TOOL_RELAY_SESSION).execute({ who: 'Codex 那条', text: '先停下等我' }, {} as never)
    expect(calls[0]?.body).toMatchObject({ call_on_reply: true })
  })

  it('★「盯着刚才那句,回了就打电话」那件工具本身就是明说 → 一定带上', async () => {
    const { calls, workbench } = client({ ok: true, watched: true, note: '已登记后台跟踪。' })
    const tools = createChannelTools({ workbench, lastSaid: () => '盯着豆包,它回了打电话给我' })
    await toolOf(tools, TOOL_WATCH_REPLY).execute({ who: '豆包', message: '国庆放几天' }, {} as never)
    expect(calls.map(one => one.path)).toEqual(['/sessions/relay'])
    expect(calls[0]?.body).toMatchObject({ watch_only: true, call_on_reply: true })
  })
})
