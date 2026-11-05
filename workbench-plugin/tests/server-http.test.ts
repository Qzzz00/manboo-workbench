// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { LiveMessage, WorkbenchState } from '../src/protocol.ts'
import { RING_AFTER_SEC } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { resolveWorkbenchHost, resolveWorkbenchPort, startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const T0 = 1_755_500_000

const started: WorkbenchServer[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
})

/** 起一台监听随机端口的服务，时钟可控。 */
async function serve(now: () => number = () => T0, over: { heartbeatMs?: number } = {}) {
  const service = createWorkbenchService({ now })
  // 关掉自动 tick，响铃推送在测试里手动触发，避免定时器污染
  // 心跳同样缺省关掉，只有心跳自己的用例才打开。
  const server = await startWorkbenchServer({
    port: 0, service, tickIntervalMs: 0, heartbeatMs: 0, ...over,
  })
  started.push(server)
  return { server, service, url: server.url }
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

/** 连上 /live 并把收到的消息攒起来。 */
async function live(url: string) {
  const ws = new WebSocket(`${url.replace('http://', 'ws://')}/live`)
  const messages: LiveMessage[] = []
  ws.on('message', raw => messages.push(JSON.parse(String(raw)) as LiveMessage))
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  return {
    messages,
    close: () => ws.close(),
    /** 停止读取：收得到 ping，但不会回 pong——用来伪造半开连接。 */
    pause: () => ws.pause(),
    /** 等到至少收到 n 条消息，超时即失败。 */
    async waitFor(n: number, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs
      while (messages.length < n) {
        if (Date.now() > deadline) throw new Error(`只收到 ${messages.length} 条消息，期望 ${n} 条`)
        await new Promise(r => setTimeout(r, 10))
      }
      return messages
    },
  }
}

describe('POST /event', () => {
  it('收下上报并写进快照', async () => {
    const { url } = await serve()

    const res = await post(url, '/event', {
      agent: 'dsh',
      session_id: 'a7c1',
      cwd: '/Users/example/GitHub/扣扣直聘',
      type: 'waiting',
      reason: 'permission_prompt',
      title: '要改 config/schema.ts',
    })
    expect(res.status).toBe(200)

    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(state.sessions).toHaveLength(1)
    expect(state.sessions[0]).toMatchObject({
      agent: 'dsh',
      session_id: 'a7c1',
      project: '扣扣直聘',
      status: 'waiting',
      elapsed_sec: 0,
      unread: false,
    })
    expect(state.stale).toBe(false)
  })

  it('字段不合法时返回 400 并说明原因，不写进状态', async () => {
    const { url } = await serve()

    expect((await post(url, '/event', { agent: 'gemini', session_id: 'x', type: 'waiting' })).status).toBe(400)
    expect((await post(url, '/event', { agent: 'dsh', type: 'waiting' })).status).toBe(400)
    expect((await post(url, '/event', { agent: 'dsh', session_id: 'x', type: '飞起来' })).status).toBe(400)

    expect((await post(url, '/event', {
      agent: 'codex', session_id: 'x', type: 'error', reason: 'made_up_reason',
    })).status).toBe(400)

    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(state.sessions).toHaveLength(0)
  })

  it('body 不是 JSON 时返回 400 而不是崩掉', async () => {
    const { url } = await serve()

    const res = await fetch(`${url}/event`, { method: 'POST', body: '{不是 json' })
    expect(res.status).toBe(400)
    expect((await res.json() as { error?: string }).error).toBeTruthy()
  })
})

describe('POST /read', () => {
  it('把「刚完成」标成已读', async () => {
    const { url } = await serve()
    await post(url, '/event', { agent: 'dsh', session_id: 'a7c1', type: 'done', reason: 'stop' })

    const res = await post(url, '/read', { agent: 'dsh', session_id: 'a7c1' })
    expect(res.status).toBe(200)

    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(state.sessions[0]?.unread).toBe(false)
  })

  it('未知会话返回 404', async () => {
    const { url } = await serve()

    expect((await post(url, '/read', { agent: 'dsh', session_id: '不存在' })).status).toBe(404)
  })
})

describe('GET /state', () => {
  it('上游掉线后仍然返回上次已知快照，只是 stale 为 true（C1）', async () => {
    const { url, service } = await serve()
    await post(url, '/event', { agent: 'dsh', session_id: 'a7c1', type: 'waiting', reason: 'permission_prompt' })

    service.markUpstreamOffline()

    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(state.stale).toBe(true)
    expect(state.sessions[0]?.session_id).toBe('a7c1')
  })

  it('未知路径返回 404', async () => {
    const { url } = await serve()

    expect((await fetch(`${url}/不存在`)).status).toBe(404)
  })
})

describe('WS /live', () => {
  it('连上先推整份快照', async () => {
    const { url } = await serve()
    await post(url, '/event', { agent: 'dsh', session_id: 'a7c1', type: 'running' })

    const client = await live(url)
    const [first] = await client.waitFor(1)
    expect(first?.kind).toBe('snapshot')
    expect(first?.kind === 'snapshot' && first.state.sessions[0]?.session_id).toBe('a7c1')
    client.close()
  })

  it('之后推增量事件', async () => {
    const { url } = await serve()
    const client = await live(url)
    await client.waitFor(1)

    await post(url, '/event', { agent: 'claude', session_id: 'b1', type: 'waiting', reason: 'permission_prompt' })

    const messages = await client.waitFor(2)
    expect(messages[1]).toMatchObject({ kind: 'event', event: { agent: 'claude', session_id: 'b1' } })
    client.close()
  })

  it('推响铃信号', async () => {
    let now = T0
    const { url, server } = await serve(() => now)
    await post(url, '/event', { agent: 'dsh', session_id: 'a7c1', type: 'waiting', reason: 'permission_prompt' })
    const client = await live(url)
    await client.waitFor(1)

    now += RING_AFTER_SEC + 1
    server.tick()

    const messages = await client.waitFor(2)
    expect(messages[1]).toEqual({ kind: 'ring', agent: 'dsh', session_id: 'a7c1' })
    client.close()
  })

  it('非 /live 的 WS 升级请求被拒绝', async () => {
    const { url } = await serve()
    const ws = new WebSocket(`${url.replace('http://', 'ws://')}/别的`)

    await expect(new Promise((resolve, reject) => {
      ws.once('open', () => resolve('open'))
      ws.once('error', reject)
    })).rejects.toThrow()
  })
})

describe('端口', () => {
  it('只监听 127.0.0.1', async () => {
    const { server } = await serve()

    expect(server.host).toBe('127.0.0.1')
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`)
  })

  it('端口被占用时报清楚的错，而不是静默失败', async () => {
    const { server } = await serve()
    const service = createWorkbenchService({ now: () => T0 })

    await expect(startWorkbenchServer({ port: server.port, service, tickIntervalMs: 0 }))
      .rejects.toThrow(/端口 \d+ 已被占用/)
  })

  it('端口从环境变量读，缺省有默认值', () => {
    expect(resolveWorkbenchPort({})).toBe(8791)
    expect(resolveWorkbenchPort({ WORKBENCH_PORT: '9123' })).toBe(9123)
  })

  it('环境变量写坏了要立刻报错，不要退回默认端口让人以为在用自己配的那个', () => {
    expect(() => resolveWorkbenchPort({ WORKBENCH_PORT: '八千' })).toThrow(/WORKBENCH_PORT/)
    expect(() => resolveWorkbenchPort({ WORKBENCH_PORT: '70000' })).toThrow(/WORKBENCH_PORT/)
  })
})

describe('对外 bind（展示台在另一台设备上，够不到 127.0.0.1）', () => {
  it('不配就仍然只监听本机——这台服务承载各 agent 的会话状态，默认不该出本机', () => {
    expect(resolveWorkbenchHost({})).toBe('127.0.0.1')
    expect(resolveWorkbenchHost({ WORKBENCH_HOST: '' })).toBe('127.0.0.1')
  })

  it('显式配了才对外监听，值原样生效', () => {
    expect(resolveWorkbenchHost({ WORKBENCH_HOST: '0.0.0.0' })).toBe('0.0.0.0')
    expect(resolveWorkbenchHost({ WORKBENCH_HOST: '172.20.10.3' })).toBe('172.20.10.3')
  })

  it('写坏了立刻报错，不要静默退回本机让人对着连不上的地址查半天', () => {
    expect(() => resolveWorkbenchHost({ WORKBENCH_HOST: 'not a host' })).toThrow(/WORKBENCH_HOST/)
    expect(() => resolveWorkbenchHost({ WORKBENCH_HOST: '999.1.1.1' })).toThrow(/WORKBENCH_HOST/)
  })

  it('起服务时 host 能落到实处，url 用的也是它——展示台照着 url 连', async () => {
    const service = createWorkbenchService({ now: () => T0 })
    const server = await startWorkbenchServer({ port: 0, host: '0.0.0.0', service, tickIntervalMs: 0 })
    started.push(server)
    expect(server.host).toBe('0.0.0.0')
    expect(server.url).toBe(`http://0.0.0.0:${server.port}`)
  })
})

describe('/live 心跳（半开连接的服务端一半）', () => {
  it('★周期性发应用层 ping——展示台的看门狗只看得见这一层，协议层 ping 帧浏览器不给 JS', async () => {
    const { server } = await serve(() => T0, { heartbeatMs: 40 })
    const client = await live(server.url)

    const messages = await client.waitFor(3, 10_000)

    expect(messages[0]?.kind).toBe('snapshot')
    expect(messages.slice(1).every(m => m.kind === 'ping')).toBe(true)
    client.close()
  })

  it('★pong 不回来就把这条连接清出广播列表——否则半开连接会一直攒着', async () => {
    const { server } = await serve(() => T0, { heartbeatMs: 40 })
    const client = await live(server.url)
    expect(server.liveClients()).toBe(1)

    // 暂停读取 = 收得到 ping 但永远不回 pong，正是半开连接在服务端的样子。
    client.pause()

    const deadline = Date.now() + 10_000
    while (server.liveClients() > 0) {
      if (Date.now() > deadline) break
      await new Promise(r => setTimeout(r, 20))
    }
    expect(server.liveClients()).toBe(0)
    client.close()
  })
})

describe('/event · wait_reason(等待原因分类)', () => {
  it('合法的四个 id 原样进快照;认不出的回 400 且不写状态', async () => {
    const { url } = await serve()
    expect((await post(url, '/event', {
      agent: 'dsh', session_id: 'q1', type: 'waiting', reason: 'permission_prompt', wait_reason: 'approval',
    })).status).toBe(200)
    expect((await post(url, '/event', {
      agent: 'dsh', session_id: 'q2', type: 'waiting', wait_reason: 'sleepy',
    })).status).toBe(400)

    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(state.sessions).toHaveLength(1)
    expect(state.sessions[0]).toMatchObject({ session_id: 'q1', wait_reason: 'approval' })
  })
})
