// @vitest-environment node
/**
 * Agent 自动发现走**真的** helperChannel(卡 Q)。
 *
 * 不用假 helper:起真的 `createHelperChannel()`,再用一个 WebSocket 客户端扮演壳 ——
 * hello 里报 `caps: ['agent_window']`,回包形状与 `workbench-app/Sources/HelperSocket.swift` 逐字一样
 * (`{kind:'res', id, ok, result|error}`),App 事件的形状与 `HelperSocket.sendAppEvent` 逐字一样
 * (`{kind:'app', event, bundle_id, name, pid}`)。通道那一层的约定、事件的字段改了,这里会红。
 */
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { WorkbenchState } from '../src/protocol.ts'
import { createAgentDiscovery } from '../src/server/agentDiscovery.ts'
import { createMemoryRegistryStore } from '../src/server/agentRegistry.ts'
import { createHelperChannel } from '../src/server/helperChannel.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { chatProbe, chatRead, fakeModel } from './fixtures/agentWorld.ts'

const started: WorkbenchServer[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  while (sockets.length) sockets.pop()?.close()
  while (started.length) await started.pop()?.close()
})

async function until(ok: () => boolean, tries = 300): Promise<void> {
  for (let i = 0; i < tries && !ok(); i += 1) await new Promise(resolve => setTimeout(resolve, 10))
}

describe('真的 helperChannel', () => {
  it('★壳报 agent_window → 扫、看结构、读,四样进 /state;壳推来的 App 事件走到登记表;微信壳连结构都不会被要', async () => {
    const helper = createHelperChannel()
    const model = fakeModel({ 'Foo AI': 'ai_agent', WeChat: 'human_chat' })
    const discovery = createAgentDiscovery({
      store: createMemoryRegistryStore(),
      helper,
      judge: model.judge,
      remainingCny: async () => 4,
      setInterval: () => 1,
      clearInterval: () => {},
    })
    // 与 index.ts 同一种接线。
    helper.onEvent((event) => {
      if (event.kind !== 'app') return
      discovery.handleAppEvent({ event: event.event, bundle_id: event.bundle_id, ...(event.name === undefined ? {} : { name: event.name }) })
    })
    helper.onChange(() => { discovery.helperChanged() })
    const server = await startWorkbenchServer({ port: 0, service: createWorkbenchService({}), tickIntervalMs: 0, heartbeatMs: 0, helper, agents: discovery })
    started.push(server)

    const ops: Record<string, unknown>[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
    sockets.push(ws)
    await new Promise(resolve => ws.on('open', resolve))
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as Record<string, unknown>
      if (msg.kind !== 'req') return
      ops.push(msg)
      let result: Record<string, unknown>
      if (msg.op === 'running_apps') {
        result = { apps: [
          { bundle_id: 'com.example.fooai', name: 'Foo AI', pid: 7, active: false, hidden: true, electron: true, category: 'public.app-category.productivity' },
          { bundle_id: 'com.tencent.xinWeChat', name: 'WeChat', name_zh: '微信', pid: 8, active: true, hidden: false, electron: false, category: 'public.app-category.social-networking' },
        ] }
      }
      else if (msg.op === 'agent_probe') result = { running: true, ...chatProbe() }
      else if (msg.op === 'agent_read') result = { running: true, ...chatRead({ answer: '好的,这是本周周报的草稿。' }) }
      else {
        ws.send(JSON.stringify({ kind: 'res', id: msg.id, ok: false, error: `未知 op:${String(msg.op)}` }))
        return
      }
      ws.send(JSON.stringify({ kind: 'res', id: msg.id, ok: true, result }))
    })
    ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1', caps: ['new_conversation', 'read_reply', 'agent_window'] }))
    await until(() => helper.connected())

    await discovery.tick()
    const state = await (await fetch(`${server.url}/state`)).json() as WorkbenchState
    const foo = state.agent_registry?.entries.find(one => one.id === 'com.example.fooai')
    expect(foo).toMatchObject({ name: 'Foo AI', status: 'idle', title: '周报怎么写', latest: '好的,这是本周周报的草稿。' })
    expect(ops.map(one => one.op)).toEqual(['running_apps', 'agent_probe', 'agent_read'])
    expect(ops.every(one => one.bundle_id !== 'com.tencent.xinWeChat')).toBe(true)

    // 壳推来的事件:他切到 Foo AI → 过一会儿读一次。
    ws.send(JSON.stringify({ kind: 'app', event: 'activated', bundle_id: 'com.example.fooai', name: 'Foo AI', pid: 7 }))
    ws.send(JSON.stringify({ kind: 'app', event: 'bogus', bundle_id: 'com.example.fooai' }))
    await until(() => false, 5)
    const before = ops.length
    await new Promise(resolve => setTimeout(resolve, 1600))
    await discovery.tick()
    expect(ops.slice(before).map(one => `${String(one.op)}:${String(one.bundle_id)}`)).toEqual(['agent_read:com.example.fooai'])
  })

  it('★壳还没有辅助功能授权(第一次装):只问正在跑的 App(真通道的授权门放它过),一扇窗不碰;/state 里那一句点名、带「去打开」那一种', async () => {
    const helper = createHelperChannel()
    const model = fakeModel({ 'Foo AI': 'ai_agent' })
    const discovery = createAgentDiscovery({ store: createMemoryRegistryStore(), helper, judge: model.judge, remainingCny: async () => 4, setInterval: () => 1, clearInterval: () => {} })
    const server = await startWorkbenchServer({ port: 0, service: createWorkbenchService({}), tickIntervalMs: 0, heartbeatMs: 0, helper, agents: discovery })
    started.push(server)
    const ops: Record<string, unknown>[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
    sockets.push(ws)
    await new Promise(resolve => ws.on('open', resolve))
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as Record<string, unknown>
      if (msg.kind !== 'req') return
      ops.push(msg)
      const result = msg.op === 'running_apps'
        ? { apps: [{ bundle_id: 'com.example.fooai', name: 'Foo AI', pid: 7, active: false, hidden: false, electron: false, category: 'public.app-category.productivity' }] }
        : { running: true, ...chatProbe() }
      ws.send(JSON.stringify({ kind: 'res', id: msg.id, ok: true, result }))
    })
    ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: false, version: '1', caps: ['new_conversation', 'read_reply', 'agent_window'] }))
    await until(() => helper.connected())
    await discovery.tick()
    expect(ops.map(one => one.op)).toEqual(['running_apps'])
    const state = await (await fetch(`${server.url}/state`)).json() as WorkbenchState
    expect(state.agent_registry?.blocked).toEqual({ kind: 'accessibility', text: '还看不到 Foo AI 在忙什么:得给工作台开「辅助功能」权限', apps: ['Foo AI'] })
  })

  it('旧壳(hello 里没有 agent_window):一个请求都不发,登记表明说要装新版', async () => {
    const helper = createHelperChannel()
    const discovery = createAgentDiscovery({ store: createMemoryRegistryStore(), helper, setInterval: () => 1, clearInterval: () => {} })
    const server = await startWorkbenchServer({ port: 0, service: createWorkbenchService({}), tickIntervalMs: 0, heartbeatMs: 0, helper, agents: discovery })
    started.push(server)
    const ops: unknown[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
    sockets.push(ws)
    await new Promise(resolve => ws.on('open', resolve))
    ws.on('message', (data) => { const msg = JSON.parse(String(data)) as Record<string, unknown>; if (msg.kind === 'req') ops.push(msg) })
    ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1', caps: ['new_conversation', 'read_reply'] }))
    await until(() => helper.connected())
    await discovery.tick()
    expect(ops).toEqual([])
    const state = await (await fetch(`${server.url}/state`)).json() as WorkbenchState
    expect(state.agent_registry?.note).toContain('装上新版工作台 App')
    expect(state.agent_registry?.entries.map(one => one.id)).toEqual(['dsh'])
  })
})
