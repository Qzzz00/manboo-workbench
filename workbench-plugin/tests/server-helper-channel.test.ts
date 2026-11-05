import { describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createWorkbenchService } from '../src/server/service.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createHelperChannel } from '../src/server/helperChannel.ts'

/** 条件等待,禁固定 tick。 */
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('等待超时')
    await new Promise(r => setTimeout(r, 10))
  }
}

describe('helperChannel(WS /helper)', () => {
  it('未连接时 view=未接入+原因;request 直接拒绝', async () => {
    const helper = createHelperChannel()
    expect(helper.view()).toEqual({ connected: false, authorized: false, reason: '工作台 App 未运行' })
    await expect(helper.request({ op: 'screen_info' })).rejects.toThrow('工作台 App 未运行')
  })

  it('壳连上发 hello 后 connected=true;authorized=false 时 request 拒绝并给原因', async () => {
    const helper = createHelperChannel()
    const server = await startWorkbenchServer({
      port: 0, service: createWorkbenchService(), tickIntervalMs: 0, heartbeatMs: 0, helper,
    })
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
    await new Promise(r => ws.on('open', r))
    ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: false, version: '1' }))
    await until(() => helper.view().connected)
    expect(helper.view()).toEqual({ connected: true, authorized: false, reason: '辅助功能未授权' })
    await expect(helper.request({ op: 'screen_info' })).rejects.toThrow('辅助功能未授权')
    ws.close(); await server.close()
  })

  it('★壳的 hello 里带 caps(2026-09-24,卡 F):新壳报「会开新对话 / 会读回复」,旧壳不报就是不会', async () => {
    const helper = createHelperChannel()
    const server = await startWorkbenchServer({
      port: 0, service: createWorkbenchService(), tickIntervalMs: 0, heartbeatMs: 0, helper,
    })
    expect(helper.supports?.('new_conversation')).toBe(false)
    const oldShell = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
    await new Promise(r => oldShell.on('open', r))
    oldShell.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1' }))
    await until(() => helper.view().connected)
    expect(helper.supports?.('new_conversation')).toBe(false)
    oldShell.close()
    await until(() => !helper.view().connected)
    const newShell = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
    await new Promise(r => newShell.on('open', r))
    newShell.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1', caps: ['new_conversation', 'read_reply'] }))
    await until(() => helper.view().connected)
    expect(helper.supports?.('new_conversation')).toBe(true)
    expect(helper.supports?.('read_reply')).toBe(true)
    expect(helper.supports?.('something_else')).toBe(false)
    newShell.close(); await server.close()
  })

  it('壳一连上,服务端先发 hello 带插件版本号(壳据此判断插件换版要不要重载页面)', async () => {
    const helper = createHelperChannel({ version: '0.2.23' })
    const server = await startWorkbenchServer({
      port: 0, service: createWorkbenchService(), tickIntervalMs: 0, heartbeatMs: 0, helper,
    })
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
    const received: unknown[] = []
    ws.on('message', (data) => { received.push(JSON.parse(String(data))) })
    await new Promise(r => ws.on('open', r))
    // 壳还没发自己的 hello,服务端的 hello 就该到了——版本号不依赖壳先开口。
    await until(() => received.length > 0)
    expect(received[0]).toEqual({ kind: 'hello', role: 'server', version: '0.2.23' })
    ws.close(); await server.close()
  })

  it('没传 version 时服务端 hello 的 version 是 "0"(与 mDNS 的兜底一致,不猜)', async () => {
    const helper = createHelperChannel()
    const server = await startWorkbenchServer({
      port: 0, service: createWorkbenchService(), tickIntervalMs: 0, heartbeatMs: 0, helper,
    })
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
    const received: unknown[] = []
    ws.on('message', (data) => { received.push(JSON.parse(String(data))) })
    await new Promise(r => ws.on('open', r))
    await until(() => received.length > 0)
    expect(received[0]).toEqual({ kind: 'hello', role: 'server', version: '0' })
    ws.close(); await server.close()
  })

  it('req/res 往返:authorized 壳收到 req 并回 res,request resolve result', async () => {
    const helper = createHelperChannel()
    const server = await startWorkbenchServer({
      port: 0, service: createWorkbenchService(), tickIntervalMs: 0, heartbeatMs: 0, helper,
    })
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
    await new Promise(r => ws.on('open', r))
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as { kind: string, id: number, op: string }
      if (msg.kind === 'req' && msg.op === 'screen_info') {
        ws.send(JSON.stringify({ kind: 'res', id: msg.id, ok: true, result: { webview: { x: 0, y: 0, w: 1440, h: 2560 }, scale: 1 } }))
      }
    })
    ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1' }))
    await until(() => helper.view().authorized)
    const result = await helper.request({ op: 'screen_info' })
    expect(result).toEqual({ webview: { x: 0, y: 0, w: 1440, h: 2560 }, scale: 1 })
    ws.close(); await server.close()
  })

  it('ax_probe op 往返(Chromium AX 修复):壳收到 req 并回 res,request resolve result', async () => {
    const helper = createHelperChannel()
    const server = await startWorkbenchServer({
      port: 0, service: createWorkbenchService(), tickIntervalMs: 0, heartbeatMs: 0, helper,
    })
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
    await new Promise(r => ws.on('open', r))
    let received: unknown
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as { kind: string, id: number, op: string, action?: string, bundle_id?: string, attr?: string, value?: boolean }
      if (msg.kind === 'req' && msg.op === 'ax_probe') {
        received = { action: msg.action, bundle_id: msg.bundle_id, attr: msg.attr, value: msg.value }
        ws.send(JSON.stringify({ kind: 'res', id: msg.id, ok: true, result: { probed: true } }))
      }
    })
    ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1' }))
    await until(() => helper.view().authorized)

    const result = await helper.request({ op: 'ax_probe', action: 'get', bundle_id: 'com.example.app', attr: 'AXFocused', value: true })
    expect(result).toEqual({ probed: true })
    expect(received).toEqual({ action: 'get', bundle_id: 'com.example.app', attr: 'AXFocused', value: true })
    ws.close(); await server.close()
  })

  it('壳回 ok:false 时 request reject 带 error 原文', async () => {
    const helper = createHelperChannel()
    const server = await startWorkbenchServer({
      port: 0, service: createWorkbenchService(), tickIntervalMs: 0, heartbeatMs: 0, helper,
    })
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
    await new Promise(r => ws.on('open', r))
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as { kind: string, id: number, op: string }
      if (msg.kind === 'req' && msg.op === 'raise_window') {
        ws.send(JSON.stringify({ kind: 'res', id: msg.id, ok: false, error: '没有第 3 个窗口' }))
      }
    })
    ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1' }))
    await until(() => helper.view().authorized)
    await expect(helper.request({ op: 'raise_window', bundle_id: 'com.example.app', index: 3 }))
      .rejects.toThrow('没有第 3 个窗口')
    ws.close(); await server.close()
  })

  it('断开后 view 退回未接入;挂起中的 request 全部立即拒绝', async () => {
    const helper = createHelperChannel()
    const server = await startWorkbenchServer({
      port: 0, service: createWorkbenchService(), tickIntervalMs: 0, heartbeatMs: 0, helper,
    })
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
    await new Promise(r => ws.on('open', r))
    ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1' }))
    await until(() => helper.view().authorized)

    const pending = helper.request({ op: 'screen_info' })
    ws.close()
    await expect(pending).rejects.toThrow('工作台 App 断开')
    await until(() => !helper.view().connected)
    expect(helper.view()).toEqual({ connected: false, authorized: false, reason: '工作台 App 未运行' })
    await server.close()
  })

  it('新连接顶掉旧连接(壳重启重连是常态)', async () => {
    const helper = createHelperChannel()
    const server = await startWorkbenchServer({
      port: 0, service: createWorkbenchService(), tickIntervalMs: 0, heartbeatMs: 0, helper,
    })
    const ws1 = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
    await new Promise(r => ws1.on('open', r))
    ws1.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1' }))
    await until(() => helper.view().authorized)

    let ws1Closed = false
    ws1.on('close', () => { ws1Closed = true })

    const ws2 = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
    await new Promise(r => ws2.on('open', r))
    ws2.on('message', (data) => {
      const msg = JSON.parse(String(data)) as { kind: string, id: number, op: string }
      if (msg.kind === 'req' && msg.op === 'screen_info') {
        ws2.send(JSON.stringify({ kind: 'res', id: msg.id, ok: true, result: { via: 'ws2' } }))
      }
    })
    ws2.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1' }))
    await until(() => ws1Closed)

    const result = await helper.request({ op: 'screen_info' })
    expect(result).toEqual({ via: 'ws2' })
    ws2.close(); await server.close()
  })

  it('request 超时(传 timeoutMs: 50,壳不回)→ reject 「壳响应超时」', async () => {
    const helper = createHelperChannel()
    const server = await startWorkbenchServer({
      port: 0, service: createWorkbenchService(), tickIntervalMs: 0, heartbeatMs: 0, helper,
    })
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
    await new Promise(r => ws.on('open', r))
    ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1' }))
    await until(() => helper.view().authorized)

    await expect(helper.request({ op: 'screen_info' }, 50)).rejects.toThrow('壳响应超时')
    ws.close(); await server.close()
  })

  it('/helper 升级只认回环:isRemoteAllowed 放行但非回环来源直接 destroy', async () => {
    /* startWorkbenchServer 传 isLoopback: () => false 的注入方式不存在——upgrade 用的是内部
       defaultIsLoopback,这里改成:传 host 缺省(127.0.0.1)时本机连接天然是回环,正向路径已被
       上面用例覆盖;此用例改为验证 /state.helper 字段:GET /state 在 helper 未连时返回
       { connected:false, authorized:false, reason:'工作台 App 未运行' }。 */
    const helper = createHelperChannel()
    const server = await startWorkbenchServer({
      port: 0, service: createWorkbenchService(), tickIntervalMs: 0, heartbeatMs: 0, helper,
    })
    const state = await (await fetch(`${server.url}/state`)).json() as { helper?: unknown }
    expect(state.helper).toEqual({ connected: false, authorized: false, reason: '工作台 App 未运行' })
    await server.close()
  })

  /** 最小假 WebSocket:只实现 attach()/request() 用到的 on/send/terminate,不起真连接——
   *  用来直接摆弄 attach() 的顶替时序与 send() 同步抛出这两个边界,不必等真实网络往返。 */
  function fakeWs(sendImpl: (data: string) => void): {
    on: (event: string, cb: (...args: unknown[]) => void) => void
    send: (data: string) => void
    terminate: () => void
    emit: (event: string, ...args: unknown[]) => void
  } {
    const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
    return {
      on(event, cb) {
        const list = handlers.get(event) ?? []
        list.push(cb)
        handlers.set(event, list)
      },
      send: sendImpl,
      terminate() {},
      emit(event, ...args) {
        for (const cb of handlers.get(event) ?? []) cb(...args)
      },
    }
  }

  it('attach() 顶替旧连接时立即 notify,不用等新壳发 hello', () => {
    const helper = createHelperChannel()
    const ws1 = fakeWs(() => {})
    helper.attach(ws1 as unknown as WebSocket)
    ws1.emit('message', JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1' }))
    expect(helper.view().authorized).toBe(true)

    let calls = 0
    helper.onChange(() => { calls++ })

    const ws2 = fakeWs(() => {})
    helper.attach(ws2 as unknown as WebSocket) // 故意不发 hello,验证顶替这一步本身已经 notify

    expect(calls).toBeGreaterThan(0)
    expect(helper.view()).toEqual({ connected: false, authorized: false, reason: '工作台 App 未运行' })
  })

  it('request 时 ws.send 同步抛出 → 立即 reject 并清理挂起项,不用等到超时', async () => {
    const helper = createHelperChannel()
    const ws = fakeWs(() => { throw new Error('send 炸了') })
    helper.attach(ws as unknown as WebSocket)
    ws.emit('message', JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1' }))
    expect(helper.view().authorized).toBe(true)

    await expect(helper.request({ op: 'screen_info' })).rejects.toThrow('send 炸了')
  })

  it('非回环来源升级 /helper 直接 destroy socket,helper 连不上', async () => {
    const helper = createHelperChannel()
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService(),
      tickIntervalMs: 0,
      heartbeatMs: 0,
      helper,
      // 模拟"判定为非回环"——真实场景是局域网/公网来源碰这条只指挥本机窗口的通道。
      isLoopback: () => false,
    })
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
    await new Promise<void>((resolve) => {
      // socket.destroy() 在 upgrade 阶段做,客户端这边看到的是 close 或 error,
      // 绝不会走到 open——两者都算"连不上",谁先到都算数。
      ws.once('close', () => resolve())
      ws.once('error', () => resolve())
    })
    expect(helper.view().connected).toBe(false)
    await server.close()
  })
})
