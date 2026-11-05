// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const started: WorkbenchServer[] = []
afterEach(async () => { while (started.length) await started.pop()?.close() })

async function serve() {
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => 1_755_500_000 }),
    tickIntervalMs: 0,
  })
  started.push(server)
  return server
}

describe('跨源访问', () => {
  it('工作台界面在 DSH 的 :3080，服务在 :8791——不给 CORS 头，浏览器连 /state 都读不到', async () => {
    const server = await serve()

    const res = await fetch(`${server.url}/state`, { headers: { Origin: 'http://127.0.0.1:3080' } })

    expect(res.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:3080')
  })

  it('预检要放行，否则带 content-type 的 POST 直接发不出去', async () => {
    const server = await serve()

    const res = await fetch(`${server.url}/credentials`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3080',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    })

    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3080')
    expect(String(res.headers.get('access-control-allow-headers')).toLowerCase()).toContain('content-type')
  })

  it('非回环来源不给 CORS 头——服务绑了 0.0.0.0，不能对任意网页开门', async () => {
    const server = await serve()

    const res = await fetch(`${server.url}/state`, { headers: { Origin: 'https://evil.example.com' } })

    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('没有 Origin 的普通请求照常工作（curl、展示台的 WS 握手）', async () => {
    const server = await serve()

    expect((await fetch(`${server.url}/state`)).status).toBe(200)
  })
})
