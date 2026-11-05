// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { LiveMessage, WorkbenchState } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createSentinelService, type SentinelDeps, type SentinelService } from '../src/server/sentinel.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-sentinel-route-'))
  dirs.push(dir)
  return join(dir, 'sentinel.json')
}

const T0 = 1_788_300_000

function fakeDeps(over: Partial<SentinelDeps> = {}): SentinelDeps {
  return {
    statFile: async () => undefined,
    fetchHttp: async () => ({ status: 200, head: '' }),
    runCommand: async () => ({ ok: false, stdout: '' }),
    probePort: async () => false,
    ...over,
  }
}

async function serve(options: {
  sentinel?: SentinelService
  isLoopback?: () => boolean
  tickIntervalMs?: number
} = {}) {
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => T0 }),
    tickIntervalMs: options.tickIntervalMs ?? 0,
    ...(options.sentinel === undefined ? {} : { sentinel: options.sentinel }),
    ...(options.isLoopback === undefined ? {} : { isLoopback: options.isLoopback }),
  })
  started.push(server)
  return server
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('哨兵接口:增删查', () => {
  it('★加一条 → 出现在 /state.sentinel 里', async () => {
    const sentinel = createSentinelService({ file: tempFile(), now: () => T0, deps: fakeDeps() })
    const server = await serve({ sentinel })

    const res = await post(`${server.url}/sentinel/add`, {
      kind: 'port', target: '127.0.0.1:3080', note: 'DSH 掉了要知道',
    })
    expect(res.status).toBe(200)

    const state = await (await fetch(`${server.url}/state`)).json() as WorkbenchState
    expect(state.sentinel?.watches).toHaveLength(1)
    expect(state.sentinel?.watches[0]).toMatchObject({ kind: 'port', note: 'DSH 掉了要知道' })
  })

  it('GET /sentinel 也能查(跟 /state 同一份真相)', async () => {
    const sentinel = createSentinelService({ file: tempFile(), now: () => T0, deps: fakeDeps() })
    const server = await serve({ sentinel })
    await post(`${server.url}/sentinel/add`, { kind: 'file', target: '/tmp/a', note: '看着' })

    const body = await (await fetch(`${server.url}/sentinel`)).json() as { watches: unknown[] }
    expect(body.watches).toHaveLength(1)
  })

  it('删一条 → 表里没了', async () => {
    const sentinel = createSentinelService({ file: tempFile(), now: () => T0, deps: fakeDeps() })
    const server = await serve({ sentinel })
    const added = await (await post(`${server.url}/sentinel/add`, {
      kind: 'file', target: '/tmp/a', note: '看着',
    })).json() as { watch: { id: string } }

    const res = await post(`${server.url}/sentinel/remove`, { id: added.watch.id })
    expect(res.status).toBe(200)
    expect(sentinel.list()).toEqual([])
  })

  it('★command 类被路由挡下并说清理由(400,不是 500)', async () => {
    const sentinel = createSentinelService({ file: tempFile(), now: () => T0, deps: fakeDeps() })
    const server = await serve({ sentinel })
    const res = await post(`${server.url}/sentinel/add`, { kind: 'command', target: 'rm -rf /', note: '不许' })
    expect(res.status).toBe(400)
    expect(await res.text()).toMatch(/command/)
  })

  it('note 缺失回 400', async () => {
    const sentinel = createSentinelService({ file: tempFile(), now: () => T0, deps: fakeDeps() })
    const server = await serve({ sentinel })
    expect((await post(`${server.url}/sentinel/add`, { kind: 'file', target: '/tmp/a' })).status).toBe(400)
  })

  it('没接哨兵服务:写路由 404「哨兵未启用」,/state.sentinel 缺省', async () => {
    const server = await serve()
    expect((await post(`${server.url}/sentinel/add`, { kind: 'file', target: '/tmp/a', note: 'x' })).status).toBe(404)
    const state = await (await fetch(`${server.url}/state`)).json() as WorkbenchState
    expect(state.sentinel).toBeUndefined()
  })
})

describe('哨兵接口:写只认回环(同 /credentials 那条纪律)', () => {
  it('★远端加监视项 403——8791 对热点网段开放,不能让同一个热点下的任何人往这台机器塞监视项', async () => {
    const sentinel = createSentinelService({ file: tempFile(), now: () => T0, deps: fakeDeps() })
    const server = await serve({ sentinel, isLoopback: () => false })

    const res = await post(`${server.url}/sentinel/add`, { kind: 'file', target: '/tmp/a', note: 'x' })
    expect(res.status).toBe(403)
    expect(sentinel.list()).toEqual([])
  })

  it('远端删监视项也 403', async () => {
    const sentinel = createSentinelService({ file: tempFile(), now: () => T0, deps: fakeDeps() })
    await sentinel.add({ kind: 'file', target: '/tmp/a', note: 'x' })
    const server = await serve({ sentinel, isLoopback: () => false })

    expect((await post(`${server.url}/sentinel/remove`, { id: sentinel.list()[0]!.id })).status).toBe(403)
    expect(sentinel.list()).toHaveLength(1)
  })

  it('查不受限制——展示台在另一台机器上也要能看见在盯什么', async () => {
    const sentinel = createSentinelService({ file: tempFile(), now: () => T0, deps: fakeDeps() })
    await sentinel.add({ kind: 'file', target: '/tmp/a', note: 'x' })
    const server = await serve({ sentinel, isLoopback: () => false })
    const body = await (await fetch(`${server.url}/sentinel`)).json() as { watches: unknown[] }
    expect(body.watches).toHaveLength(1)
  })
})

describe('哨兵触发:走的是现有会话/铃那条通道,不另起一套', () => {
  it('★变化 → 会话表里多一条 waiting(黄),标题就是那句 note', async () => {
    let open = false
    let now = T0
    const sentinel = createSentinelService({
      file: tempFile(), now: () => now, deps: fakeDeps({ probePort: async () => open }),
    })
    await sentinel.add({ kind: 'port', target: '3080', note: 'DSH 起来了', interval_sec: 5 })
    const server = await serve({ sentinel })

    server.tick() // 基线
    await new Promise(resolve => setTimeout(resolve, 30))
    open = true
    now += 60
    server.tick()
    await new Promise(resolve => setTimeout(resolve, 30))

    const state = await (await fetch(`${server.url}/state`)).json() as WorkbenchState
    const session = state.sessions.find(s => s.session_id.startsWith('sentinel:'))
    expect(session).toMatchObject({ agent: 'dsh', status: 'waiting', reason: 'idle_prompt', title: 'DSH 起来了' })
  })

  it('★触发把事件推给展示台(跟 hook 入口同一条"写了就推"纪律)', async () => {
    let open = false
    let now = T0
    const sentinel = createSentinelService({
      file: tempFile(), now: () => now, deps: fakeDeps({ probePort: async () => open }),
    })
    await sentinel.add({ kind: 'port', target: '3080', note: '端口通了', interval_sec: 5 })
    const server = await serve({ sentinel })

    const ws = new WebSocket(`${server.url.replace('http://', 'ws://')}/live`)
    const got: LiveMessage[] = []
    ws.on('message', raw => got.push(JSON.parse(String(raw)) as LiveMessage))
    await new Promise<void>(resolve => ws.on('open', () => resolve()))
    server.tick()
    await new Promise(resolve => setTimeout(resolve, 30))
    open = true
    now += 60
    server.tick()
    await new Promise(resolve => setTimeout(resolve, 50))
    ws.close()

    expect(got.some(m => m.kind === 'event' && m.event.session_id.startsWith('sentinel:'))).toBe(true)
  })

  it('★取消监视项 → 那条会话也收掉(不留一个永远黄着的点)', async () => {
    let open = false
    let now = T0
    const sentinel = createSentinelService({
      file: tempFile(), now: () => now, deps: fakeDeps({ probePort: async () => open }),
    })
    const watch = await sentinel.add({ kind: 'port', target: '3080', note: '端口', interval_sec: 5 })
    const server = await serve({ sentinel })
    server.tick()
    await new Promise(resolve => setTimeout(resolve, 30))
    open = true
    now += 60
    server.tick()
    await new Promise(resolve => setTimeout(resolve, 30))

    await post(`${server.url}/sentinel/remove`, { id: watch.id })
    const state = await (await fetch(`${server.url}/state`)).json() as WorkbenchState
    const session = state.sessions.find(s => s.session_id.startsWith('sentinel:'))
    expect(session?.status).toBe('offline')
  })
})
