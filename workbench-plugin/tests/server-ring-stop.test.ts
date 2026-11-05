// @vitest-environment node
/**
 * 真响铃的「谁在响」与「怎么停」（2026-08-25 补）。
 *
 * 在此之前响铃只活在消息流里，谁也不持有，真机上撞出两条：
 * - 派一断线重连就永久丢失这次响铃，回到待机态，POP 按键按下去什么也不做；
 * - 网页那个「🔕停铃」只认 dsh:test-ring，真响铃停不掉，只能干等 60 秒兜底自停。
 */
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { LiveMessage, WorkbenchState } from '../src/protocol.ts'
import { RING_AFTER_SEC } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const T0 = 1_755_500_000
const started: WorkbenchServer[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
})

async function serve(now: () => number = () => T0) {
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now }),
    tickIntervalMs: 0,
    heartbeatMs: 0,
  })
  started.push(server)
  return server
}

const post = (server: WorkbenchServer, path: string, body?: unknown) =>
  fetch(`${server.url}${path}`, {
    method: 'POST',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })

const state = async (server: WorkbenchServer): Promise<WorkbenchState> =>
  await (await fetch(`${server.url}/state`)).json() as WorkbenchState

async function subscribe(server: WorkbenchServer) {
  const messages: LiveMessage[] = []
  const ws = new WebSocket(`${server.url.replace('http://', 'ws://')}/live`)
  ws.on('message', raw => messages.push(JSON.parse(String(raw)) as LiveMessage))
  await new Promise(resolve => ws.once('open', resolve))
  return { messages, ws }
}

/** 造一次真响铃：等审批的会话放过响铃阈值，再敲一拍。 */
async function realRing(server: WorkbenchServer, advance: () => void) {
  await post(server, '/event', { agent: 'claude', session_id: 's1', type: 'waiting', reason: 'permission_prompt' })
  advance()
  server.tick()
}

describe('快照里的 ringing（重连的订阅者靠它恢复响铃态）', () => {
  it('真响铃之后，快照里能查到正在响的是谁', async () => {
    let now = T0
    const server = await serve(() => now)

    await realRing(server, () => { now += RING_AFTER_SEC + 1 })

    expect((await state(server)).ringing).toEqual([{ agent: 'claude', session_id: 's1' }])
  })

  it('没有铃在响时是空数组，不是缺字段——订阅者不必分辨"没响"和"没这功能"', async () => {
    const server = await serve()

    expect((await state(server)).ringing).toEqual([])
  })

  it('话机摘机之后销账，快照里不再有它', async () => {
    let now = T0
    const server = await serve(() => now)
    await realRing(server, () => { now += RING_AFTER_SEC + 1 })

    await post(server, '/phone/event', { type: 'offhook', agent: 'claude', session_id: 's1' })

    expect((await state(server)).ringing).toEqual([])
  })
})

describe('POST /ring/stop', () => {
  it('对正在响的那条真实会话键广播 call/offhook——这是真响铃唯一能被停掉的方式', async () => {
    let now = T0
    const server = await serve(() => now)
    await realRing(server, () => { now += RING_AFTER_SEC + 1 })
    const { messages, ws } = await subscribe(server)

    const res = await post(server, '/ring/stop')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, stopped: [{ agent: 'claude', session_id: 's1' }] })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(messages.find(m => m.kind === 'call'))
      .toEqual({ kind: 'call', phase: 'offhook', agent: 'claude', session_id: 's1' })
    ws.close()
  })

  it('停完之后台账清空', async () => {
    let now = T0
    const server = await serve(() => now)
    await realRing(server, () => { now += RING_AFTER_SEC + 1 })

    await post(server, '/ring/stop')

    expect((await state(server)).ringing).toEqual([])
  })

  it('没有铃在响时是安全空操作，不广播任何东西', async () => {
    const server = await serve()
    const { messages, ws } = await subscribe(server)

    expect(await (await post(server, '/ring/stop')).json()).toEqual({ ok: true, stopped: [] })

    await new Promise(resolve => setTimeout(resolve, 50))
    expect(messages.filter(m => m.kind === 'call')).toEqual([])
    ws.close()
  })
})

describe('真响铃期间按「试铃」', () => {
  it('停掉真的那个，而不是再加一个测试铃——否则界面上那个按钮只会让事情更糟', async () => {
    let now = T0
    const server = await serve(() => now)
    await realRing(server, () => { now += RING_AFTER_SEC + 1 })
    const { messages, ws } = await subscribe(server)

    await post(server, '/ring/test')

    await new Promise(resolve => setTimeout(resolve, 50))
    expect(messages.filter(m => m.kind === 'ring')).toEqual([])
    expect(messages.find(m => m.kind === 'call'))
      .toEqual({ kind: 'call', phase: 'offhook', agent: 'claude', session_id: 's1' })
    ws.close()
  })
})
