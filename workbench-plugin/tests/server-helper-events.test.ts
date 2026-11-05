import { describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createWorkbenchService } from '../src/server/service.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createHelperChannel } from '../src/server/helperChannel.ts'
import type { HelperEvent } from '../src/server/helperChannel.ts'

/** 条件等待,禁固定 tick,先例见 server-helper-channel.test.ts。 */
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('等待超时')
    await new Promise(r => setTimeout(r, 10))
  }
}

describe('helperChannel 事件通道(窗位叠 v2 spec V2)', () => {
  it('壳发 moved → onEvent 逐个回调,携带 bundle_id/frame', async () => {
    const helper = createHelperChannel()
    const server = await startWorkbenchServer({
      port: 0, service: createWorkbenchService(), tickIntervalMs: 0, heartbeatMs: 0, helper,
    })
    const events: HelperEvent[] = []
    helper.onEvent((event) => { events.push(event) })

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
    await new Promise(r => ws.on('open', r))
    ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1' }))
    await until(() => helper.view().authorized)

    ws.send(JSON.stringify({ kind: 'moved', bundle_id: 'com.example.app', frame: { x: 10, y: 20, w: 300, h: 400 } }))
    await until(() => events.length > 0)

    expect(events).toEqual([{ kind: 'moved', bundle_id: 'com.example.app', frame: { x: 10, y: 20, w: 300, h: 400 } }])
    ws.close(); await server.close()
  })

  it('多个 onEvent 监听者都收到同一条事件', async () => {
    const helper = createHelperChannel()
    const server = await startWorkbenchServer({
      port: 0, service: createWorkbenchService(), tickIntervalMs: 0, heartbeatMs: 0, helper,
    })
    const a: HelperEvent[] = []
    const b: HelperEvent[] = []
    helper.onEvent((event) => { a.push(event) })
    helper.onEvent((event) => { b.push(event) })

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
    await new Promise(r => ws.on('open', r))
    ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1' }))
    await until(() => helper.view().authorized)

    ws.send(JSON.stringify({ kind: 'moved', bundle_id: 'com.example.app', frame: { x: 0, y: 0, w: 1, h: 1 } }))
    await until(() => a.length > 0 && b.length > 0)

    expect(a).toEqual(b)
    ws.close(); await server.close()
  })

  it('坏帧 moved(缺 frame 字段/字段非数字/bundle_id 非字符串)全部原样忽略,不回调', async () => {
    const helper = createHelperChannel()
    const server = await startWorkbenchServer({
      port: 0, service: createWorkbenchService(), tickIntervalMs: 0, heartbeatMs: 0, helper,
    })
    const events: HelperEvent[] = []
    helper.onEvent((event) => { events.push(event) })

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
    await new Promise(r => ws.on('open', r))
    ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1' }))
    await until(() => helper.view().authorized)

    ws.send(JSON.stringify({ kind: 'moved', bundle_id: 'com.example.app' })) // 缺 frame
    ws.send(JSON.stringify({ kind: 'moved', bundle_id: 'com.example.app', frame: { x: 0, y: 0, w: 1 } })) // 少 h
    ws.send(JSON.stringify({ kind: 'moved', bundle_id: 'com.example.app', frame: { x: '0', y: 0, w: 1, h: 1 } })) // x 非数字
    ws.send(JSON.stringify({ kind: 'moved', bundle_id: 42, frame: { x: 0, y: 0, w: 1, h: 1 } })) // bundle_id 非字符串
    ws.send(JSON.stringify({ kind: 'moved', bundle_id: 'com.example.app', frame: { x: 0, y: 0, w: 1, h: Number.NaN } })) // NaN
    // 最后发一条合法的,证明前面几条坏帧确实没有把通道搞崩、后续消息处理照常。
    ws.send(JSON.stringify({ kind: 'moved', bundle_id: 'com.example.app', frame: { x: 5, y: 5, w: 5, h: 5 } }))
    await until(() => events.length > 0)

    expect(events).toEqual([{ kind: 'moved', bundle_id: 'com.example.app', frame: { x: 5, y: 5, w: 5, h: 5 } }])
    ws.close(); await server.close()
  })

  it('moved 带 dragged 布尔时原样透传;非布尔时丢弃该字段、事件照收(2026-08-26 微信重登归位修复)', async () => {
    const helper = createHelperChannel()
    const server = await startWorkbenchServer({
      port: 0, service: createWorkbenchService(), tickIntervalMs: 0, heartbeatMs: 0, helper,
    })
    const events: HelperEvent[] = []
    helper.onEvent((event) => { events.push(event) })

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
    await new Promise(r => ws.on('open', r))
    ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1' }))
    await until(() => helper.view().authorized)

    ws.send(JSON.stringify({ kind: 'moved', bundle_id: 'com.example.app', frame: { x: 1, y: 1, w: 2, h: 2 }, dragged: false }))
    ws.send(JSON.stringify({ kind: 'moved', bundle_id: 'com.example.app', frame: { x: 3, y: 3, w: 2, h: 2 }, dragged: true }))
    // 旧壳/坏字段:dragged 非布尔——事件照收,但不带 dragged(下游按缺省=用户拖拽处理)。
    ws.send(JSON.stringify({ kind: 'moved', bundle_id: 'com.example.app', frame: { x: 5, y: 5, w: 2, h: 2 }, dragged: 'yes' }))
    await until(() => events.length >= 3)

    expect(events).toEqual([
      { kind: 'moved', bundle_id: 'com.example.app', frame: { x: 1, y: 1, w: 2, h: 2 }, dragged: false },
      { kind: 'moved', bundle_id: 'com.example.app', frame: { x: 3, y: 3, w: 2, h: 2 }, dragged: true },
      { kind: 'moved', bundle_id: 'com.example.app', frame: { x: 5, y: 5, w: 2, h: 2 } },
    ])
    ws.close(); await server.close()
  })

  it('壳发 hover → onEvent 逐个回调,携带 inside(悬停高亮 v1)', async () => {
    const helper = createHelperChannel()
    const server = await startWorkbenchServer({
      port: 0, service: createWorkbenchService(), tickIntervalMs: 0, heartbeatMs: 0, helper,
    })
    const events: HelperEvent[] = []
    helper.onEvent((event) => { events.push(event) })

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
    await new Promise(r => ws.on('open', r))
    ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1' }))
    await until(() => helper.view().authorized)

    ws.send(JSON.stringify({ kind: 'hover', inside: true }))
    await until(() => events.length > 0)
    ws.send(JSON.stringify({ kind: 'hover', inside: false }))
    await until(() => events.length > 1)

    expect(events).toEqual([{ kind: 'hover', inside: true }, { kind: 'hover', inside: false }])
    ws.close(); await server.close()
  })

  it('坏帧 hover(inside 缺失/非布尔)原样忽略,不回调,后续正常消息照常处理', async () => {
    const helper = createHelperChannel()
    const server = await startWorkbenchServer({
      port: 0, service: createWorkbenchService(), tickIntervalMs: 0, heartbeatMs: 0, helper,
    })
    const events: HelperEvent[] = []
    helper.onEvent((event) => { events.push(event) })

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
    await new Promise(r => ws.on('open', r))
    ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1' }))
    await until(() => helper.view().authorized)

    ws.send(JSON.stringify({ kind: 'hover' })) // 缺 inside
    ws.send(JSON.stringify({ kind: 'hover', inside: 'true' })) // 非布尔
    ws.send(JSON.stringify({ kind: 'hover', inside: true })) // 合法的最后一条
    await until(() => events.length > 0)

    expect(events).toEqual([{ kind: 'hover', inside: true }])
    ws.close(); await server.close()
  })

  it('hover_zone op 往返:壳收到 req(rect/null)并回 res,request resolve', async () => {
    const helper = createHelperChannel()
    const server = await startWorkbenchServer({
      port: 0, service: createWorkbenchService(), tickIntervalMs: 0, heartbeatMs: 0, helper,
    })
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
    await new Promise(r => ws.on('open', r))
    const receivedRects: unknown[] = []
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as { kind: string, id: number, op: string, rect?: unknown }
      if (msg.kind === 'req' && msg.op === 'hover_zone') {
        receivedRects.push(msg.rect)
        ws.send(JSON.stringify({ kind: 'res', id: msg.id, ok: true, result: {} }))
      }
    })
    ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1' }))
    await until(() => helper.view().authorized)

    const rect = { x: 10, y: 20, w: 300, h: 400 }
    const result1 = await helper.request({ op: 'hover_zone', rect })
    expect(result1).toEqual({})
    const result2 = await helper.request({ op: 'hover_zone', rect: null })
    expect(result2).toEqual({})
    expect(receivedRects).toEqual([rect, null])
    ws.close(); await server.close()
  })

  it('壳发 ax_stale → onEvent 逐个回调,携带 bundle_id/ax_err/ax_count/cg_count(Chromium AX 修复)', async () => {
    const helper = createHelperChannel()
    const server = await startWorkbenchServer({
      port: 0, service: createWorkbenchService(), tickIntervalMs: 0, heartbeatMs: 0, helper,
    })
    const events: HelperEvent[] = []
    helper.onEvent((event) => { events.push(event) })

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
    await new Promise(r => ws.on('open', r))
    ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1' }))
    await until(() => helper.view().authorized)

    ws.send(JSON.stringify({ kind: 'ax_stale', bundle_id: 'com.example.app', ax_err: -25204, ax_count: 0, cg_count: 3 }))
    await until(() => events.length > 0)

    expect(events).toEqual([{ kind: 'ax_stale', bundle_id: 'com.example.app', ax_err: -25204, ax_count: 0, cg_count: 3 }])
    ws.close(); await server.close()
  })

  it('坏帧 ax_stale(缺字段/bundle_id 非字符串/数字字段非有限数)全部原样忽略,不回调', async () => {
    const helper = createHelperChannel()
    const server = await startWorkbenchServer({
      port: 0, service: createWorkbenchService(), tickIntervalMs: 0, heartbeatMs: 0, helper,
    })
    const events: HelperEvent[] = []
    helper.onEvent((event) => { events.push(event) })

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
    await new Promise(r => ws.on('open', r))
    ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1' }))
    await until(() => helper.view().authorized)

    ws.send(JSON.stringify({ kind: 'ax_stale', bundle_id: 'com.example.app', ax_err: -25204, ax_count: 0 })) // 缺 cg_count
    ws.send(JSON.stringify({ kind: 'ax_stale', bundle_id: 42, ax_err: -25204, ax_count: 0, cg_count: 3 })) // bundle_id 非字符串
    ws.send(JSON.stringify({ kind: 'ax_stale', bundle_id: 'com.example.app', ax_err: '-25204', ax_count: 0, cg_count: 3 })) // ax_err 非数字
    ws.send(JSON.stringify({ kind: 'ax_stale', bundle_id: 'com.example.app', ax_err: -25204, ax_count: Number.NaN, cg_count: 3 })) // NaN
    // 最后发一条合法的,证明前面几条坏帧确实没有把通道搞崩、后续消息处理照常。
    ws.send(JSON.stringify({ kind: 'ax_stale', bundle_id: 'com.example.app', ax_err: -25204, ax_count: 1, cg_count: 3 }))
    await until(() => events.length > 0)

    expect(events).toEqual([{ kind: 'ax_stale', bundle_id: 'com.example.app', ax_err: -25204, ax_count: 1, cg_count: 3 }])
    ws.close(); await server.close()
  })

  it('observe op 往返:壳收到 req 并回 res,request resolve result', async () => {
    const helper = createHelperChannel()
    const server = await startWorkbenchServer({
      port: 0, service: createWorkbenchService(), tickIntervalMs: 0, heartbeatMs: 0, helper,
    })
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
    await new Promise(r => ws.on('open', r))
    let received: unknown
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as { kind: string, id: number, op: string, bundle_ids?: string[] }
      if (msg.kind === 'req' && msg.op === 'observe') {
        received = msg.bundle_ids
        ws.send(JSON.stringify({ kind: 'res', id: msg.id, ok: true, result: {} }))
      }
    })
    ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1' }))
    await until(() => helper.view().authorized)

    const result = await helper.request({ op: 'observe', bundle_ids: ['com.a.app', 'com.b.app'] })
    expect(result).toEqual({})
    expect(received).toEqual(['com.a.app', 'com.b.app'])
    ws.close(); await server.close()
  })
})
