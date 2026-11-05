// @vitest-environment node
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createAppConfig } from '../src/server/appConfig.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { isAllowedRemoteAddress, startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const started: WorkbenchServer[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
})

async function serve(options: { isRemoteAllowed?: () => boolean } = {}) {
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => 1_755_500_000 }),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    ...options,
  })
  started.push(server)
  return server
}

describe('来源允许判定（纯函数）', () => {
  it('本机回环一律放行，IPv6 与映射形式也算', () => {
    expect(isAllowedRemoteAddress('127.0.0.1')).toBe(true)
    expect(isAllowedRemoteAddress('127.0.0.53')).toBe(true)
    expect(isAllowedRemoteAddress('::1')).toBe(true)
    expect(isAllowedRemoteAddress('::ffff:127.0.0.1')).toBe(true)
  })

  /**
   * 2026-10-01 维护者拍板撤掉手机热点网段(172.20.10.0/28)那条例外:
   * 它凭网段放行，绕过了「允许手机在局域网访问」这一个开关。
   * 这条用例从「热点放行」改成「热点不再是例外;要进来就得把开关打开」。
   */
  it('手机热点网段 172.20.10.0/28 不再是例外——纯函数一律拒', () => {
    expect(isAllowedRemoteAddress('172.20.10.2')).toBe(false)
    expect(isAllowedRemoteAddress('172.20.10.4')).toBe(false)
    expect(isAllowedRemoteAddress('172.20.10.15')).toBe(false)
    expect(isAllowedRemoteAddress('::ffff:172.20.10.2')).toBe(false)
  })

  it('公司网段与其他一切来源都挡掉', () => {
    expect(isAllowedRemoteAddress('10.86.37.42')).toBe(false)
    expect(isAllowedRemoteAddress('192.168.1.10')).toBe(false)
    expect(isAllowedRemoteAddress('172.20.10.16')).toBe(false)
    expect(isAllowedRemoteAddress('172.20.11.2')).toBe(false)
  })

  it('拿不到地址或看不懂的地址按拒绝处理，绝不默认放行', () => {
    expect(isAllowedRemoteAddress(undefined)).toBe(false)
    expect(isAllowedRemoteAddress('')).toBe(false)
    expect(isAllowedRemoteAddress('not-an-address')).toBe(false)
    expect(isAllowedRemoteAddress('172.20.10.999')).toBe(false)
  })
})

describe('HTTP 层按来源拦截', () => {
  it('不在允许名单里的来源：读状态 403，看不到任何会话信息', async () => {
    const server = await serve({ isRemoteAllowed: () => false })

    const res = await fetch(`${server.url}/state`)
    const body = await res.text()

    expect(res.status).toBe(403)
    expect(body).not.toContain('sessions')
  })

  it('不在允许名单里的来源：POST /event 403，状态不被污染', async () => {
    const service = createWorkbenchService({ now: () => 1_755_500_000 })
    const server = await startWorkbenchServer({
      port: 0,
      service,
      tickIntervalMs: 0,
      heartbeatMs: 0,
      isRemoteAllowed: () => false,
    })
    started.push(server)

    const res = await fetch(`${server.url}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'claude', session_id: 'fake', type: 'running' }),
    })

    expect(res.status).toBe(403)
    expect(service.getState().sessions).toHaveLength(0)
  })

  it('允许的来源一切照旧——测试本身走回环，不注入时就该直接通', async () => {
    const server = await serve()

    expect((await fetch(`${server.url}/state`)).status).toBe(200)
  })

  /**
   * 整条门(2026-10-01):`isLoopbackAddress(address) || lanEnabled || isAllowedRemoteAddress(address)`。
   * 热点上的手机现在和任何局域网来源一视同仁:开关关着进不来，开着才进得来。
   */
  it('热点地址:开关关着 403，开着 200——走的是默认那道门，不注入 isRemoteAllowed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-allow-'))
    const config = createAppConfig({ file: join(dir, 'app.json') })
    const mdns = { async start() {}, async stop() {}, active: () => false }
    const remote = { address: '127.0.0.1' }
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService({ now: () => 1_755_500_000 }),
      tickIntervalMs: 0,
      heartbeatMs: 0,
      lan: { config, mdns, lanAddress: () => '172.20.10.1', name: '测试工作台', version: '0.0.0' },
      remoteAddress: () => remote.address,
    })
    started.push(server)
    const state = async (from: string) => {
      remote.address = from
      const res = await fetch(`${server.url}/state`)
      await res.text()
      remote.address = '127.0.0.1'
      return res.status
    }

    expect(await state('172.20.10.2')).toBe(403)

    // 本机把开关打开(这一步本身走回环)。
    const on = await fetch(`${server.url}/lan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    expect(on.status).toBe(200)

    expect(await state('172.20.10.2')).toBe(200)
  })
})

describe('WS 层按来源拦截', () => {
  it('不在允许名单里的来源连 /live：直接断开，不发快照也不留在广播列表里', async () => {
    const server = await serve({ isRemoteAllowed: () => false })

    const ws = new WebSocket(`${server.url.replace('http://', 'ws://')}/live`)
    const outcome = await new Promise<'open' | 'rejected'>((resolve) => {
      ws.on('open', () => resolve('open'))
      ws.on('error', () => resolve('rejected'))
      ws.on('close', () => resolve('rejected'))
    })
    ws.terminate()

    expect(outcome).toBe('rejected')
    expect(server.liveClients()).toBe(0)
  })

  it('允许的来源照常拿到快照', async () => {
    const server = await serve()

    const ws = new WebSocket(`${server.url.replace('http://', 'ws://')}/live`)
    const first = await new Promise<string>((resolve, reject) => {
      ws.on('message', raw => resolve(String(raw)))
      ws.on('error', reject)
    })
    ws.close()

    expect(JSON.parse(first).kind).toBe('snapshot')
  })
})
