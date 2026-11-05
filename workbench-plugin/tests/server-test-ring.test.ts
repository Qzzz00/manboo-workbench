// @vitest-environment node
/**
 * 手动试铃（来电链 v0 的运维口）。
 *
 * 正常响铃要等「waiting+permission_prompt 超 3 分钟」，试铃声不该这么折腾——
 * POST /ring/test 直接对 /live 广播一条 ring；再按一次广播 call/offhook 停铃。
 * 翻转型接口（与 /pause 同款），会话键固定 dsh:test-ring，不建会话、不进 /state：
 * 试铃只试铃，屏上不该多出一行假会话。
 */
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { LiveMessage } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const started: WorkbenchServer[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
})

async function serve(testRingResetMs?: number) {
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => 1_755_500_000 }),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    ...(testRingResetMs === undefined ? {} : { testRingResetMs }),
  })
  started.push(server)
  return server
}

async function subscribe(server: WorkbenchServer) {
  const messages: LiveMessage[] = []
  const ws = new WebSocket(`${server.url.replace('http://', 'ws://')}/live`)
  ws.on('message', raw => messages.push(JSON.parse(String(raw)) as LiveMessage))
  await new Promise(resolve => ws.once('open', resolve))
  return { messages, ws }
}

function post(server: WorkbenchServer) {
  return fetch(`${server.url}/ring/test`, { method: 'POST' })
}

describe('POST /ring/test', () => {
  it('第一按广播 ring（固定会话键 dsh:test-ring），返回 ringing:true', async () => {
    const server = await serve()
    const { messages, ws } = await subscribe(server)

    const res = await post(server)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, ringing: true })

    await new Promise(resolve => setTimeout(resolve, 50))
    expect(messages.find(m => m.kind === 'ring'))
      .toEqual({ kind: 'ring', agent: 'dsh', session_id: 'test-ring' })
    ws.close()
  })

  it('响着再按一次是停铃：广播 call/offhook，返回 ringing:false', async () => {
    const server = await serve()
    const { messages, ws } = await subscribe(server)

    await post(server)
    const res = await post(server)
    expect(await res.json()).toEqual({ ok: true, ringing: false })

    await new Promise(resolve => setTimeout(resolve, 50))
    expect(messages.find(m => m.kind === 'call'))
      .toEqual({ kind: 'call', phase: 'offhook', agent: 'dsh', session_id: 'test-ring' })
    ws.close()
  })

  it('超时后翻转态自动归零：展示台 60 秒早就自停了，下一按必须是重新试铃而不是空停铃', async () => {
    const server = await serve(30)
    const { messages, ws } = await subscribe(server)

    await post(server)
    await new Promise(resolve => setTimeout(resolve, 80))
    const res = await post(server)
    expect(await res.json()).toEqual({ ok: true, ringing: true })

    await new Promise(resolve => setTimeout(resolve, 50))
    expect(messages.filter(m => m.kind === 'ring')).toHaveLength(2)
    expect(messages.filter(m => m.kind === 'call')).toHaveLength(0)
    ws.close()
  })

  it('试铃不建会话：/state 里不出现 test-ring', async () => {
    const server = await serve()
    await post(server)

    const state = await (await fetch(`${server.url}/state`)).json() as {
      sessions: { session_id: string }[]
    }
    expect(state.sessions.find(s => s.session_id === 'test-ring')).toBeUndefined()
  })

  it('翻转态进 /state.test_ringing——按钮文案的真相在服务端，浏览器不许自己猜', async () => {
    const server = await serve()

    const before = await (await fetch(`${server.url}/state`)).json() as { test_ringing?: boolean }
    expect(before.test_ringing).toBe(false)

    await post(server)
    const during = await (await fetch(`${server.url}/state`)).json() as { test_ringing?: boolean }
    expect(during.test_ringing).toBe(true)

    await post(server)
    const after = await (await fetch(`${server.url}/state`)).json() as { test_ringing?: boolean }
    expect(after.test_ringing).toBe(false)
  })

  it('★POP 摘机停掉试铃（/phone/event dsh:test-ring）要顺手清掉翻转态，否则下一按变成空停铃', async () => {
    const server = await serve()
    const { messages, ws } = await subscribe(server)

    await post(server)
    await fetch(`${server.url}/phone/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'offhook', agent: 'dsh', session_id: 'test-ring' }),
    })

    const state = await (await fetch(`${server.url}/state`)).json() as { test_ringing?: boolean }
    expect(state.test_ringing).toBe(false)

    // 清了之后再按必须是重新响铃，不是空停铃。
    const res = await post(server)
    expect(await res.json()).toEqual({ ok: true, ringing: true })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(messages.filter(m => m.kind === 'ring')).toHaveLength(2)
    ws.close()
  })

  it('别的会话的摘挂机与试铃无关，不碰翻转态', async () => {
    const server = await serve()
    await post(server)

    await fetch(`${server.url}/phone/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'offhook', agent: 'claude', session_id: 'real-call' }),
    })

    const state = await (await fetch(`${server.url}/state`)).json() as { test_ringing?: boolean }
    expect(state.test_ringing).toBe(true)
  })
})
