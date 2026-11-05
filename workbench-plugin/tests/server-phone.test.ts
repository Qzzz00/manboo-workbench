// @vitest-environment node
/**
 * 话机事件（来电链 v0，spec：docs/设计-来电链-v0.md）。
 *
 * 树莓派上的 phone-bridge 在摘机/挂机/未接时 POST /phone/event，
 * 工作台原样翻成 { kind: 'call' } 广播给 /live 的订阅者——
 * 展示台靠它停铃/切画面。工作台在这里只做转发与校验，不做判断（判断都在响铃侧）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { LiveMessage } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { parsePhoneEvent, startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const started: WorkbenchServer[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
})

async function serve() {
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => 1_755_500_000 }),
    tickIntervalMs: 0,
    heartbeatMs: 0,
  })
  started.push(server)
  return server
}

describe('parsePhoneEvent（纯函数）', () => {
  it('合法事件三种类型都收', () => {
    for (const type of ['offhook', 'onhook', 'missed'] as const) {
      const parsed = parsePhoneEvent({ type, agent: 'claude', session_id: 's1' })
      expect(parsed).toEqual({ event: { type, agent: 'claude', session_id: 's1' } })
    }
  })

  it('带合法 ts 就透传', () => {
    const parsed = parsePhoneEvent({ type: 'offhook', agent: 'dsh', session_id: 's1', ts: 123 })
    expect('event' in parsed && parsed.event.ts).toBe(123)
  })

  it('类型不认识、agent 不在四家、session_id 为空都拒绝', () => {
    expect('error' in parsePhoneEvent({ type: 'pickup', agent: 'claude', session_id: 's1' })).toBe(true)
    expect('error' in parsePhoneEvent({ type: 'offhook', agent: 'pi', session_id: 's1' })).toBe(true)
    expect('error' in parsePhoneEvent({ type: 'offhook', agent: 'claude', session_id: '' })).toBe(true)
    expect('error' in parsePhoneEvent(null)).toBe(true)
  })
})

describe('POST /phone/event', () => {
  it('合法上报返回 ok 并广播 call 消息给 /live 订阅者', async () => {
    const server = await serve()
    const messages: LiveMessage[] = []
    const ws = new WebSocket(`${server.url.replace('http://', 'ws://')}/live`)
    ws.on('message', raw => messages.push(JSON.parse(String(raw)) as LiveMessage))
    await new Promise(resolve => ws.once('open', resolve))

    const res = await fetch(`${server.url}/phone/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'offhook', agent: 'claude', session_id: 'call-1' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    await new Promise(resolve => setTimeout(resolve, 50))
    const call = messages.find(m => m.kind === 'call')
    expect(call).toEqual({ kind: 'call', phase: 'offhook', agent: 'claude', session_id: 'call-1' })
    ws.close()
  })

  it('非法 body 返回 400，不广播', async () => {
    const server = await serve()
    const res = await fetch(`${server.url}/phone/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'offhook', agent: 'nobody', session_id: 'x' }),
    })
    expect(res.status).toBe(400)
  })
})
