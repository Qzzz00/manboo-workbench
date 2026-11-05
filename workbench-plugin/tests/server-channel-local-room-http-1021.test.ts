// @vitest-environment node
/**
 * `/channel/status` 多一格 `local_room`(局域网主路卡 M1,2026-10-21):本机房间在不在、地址、上次重起的时刻。
 * 接缝「安装器 / launchd(交付链路)→ 8791 `/channel/status`」的这一头;字段表 `channelWire.cases.json` 同步加了这一格。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createChannelService } from '../src/server/channel.ts'
import type { LocalRoomView } from '../src/server/localRoom.ts'
import { CALL_TOOL_DOING, CALL_TOOL_REMEMBER } from '../src/server/rtcCall.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const NOW_SEC = Math.floor(Date.parse('2026-10-21T09:00:00Z') / 1000)
const SECRET = 'S'.repeat(43)
const wire = JSON.parse(readFileSync(join(import.meta.dirname, '../src/server/channelWire.cases.json'), 'utf8')) as { fields: Record<string, string[]> }

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function server(localRoom?: { view: () => Promise<LocalRoomView> }): Promise<WorkbenchServer> {
  const dir = mkdtempSync(join(tmpdir(), 'wb-channel-local-room-'))
  dirs.push(dir)
  const agentsFile = join(dir, 'AGENTS.md')
  writeFileSync(agentsFile, '我叫 周到。\n', 'utf8')
  const configFile = join(dir, 'channel.json')
  writeFileSync(configFile, JSON.stringify({ url: 'ws://127.0.0.1:7880', api_key: 'APIkey', api_secret: SECRET }))
  const channel = createChannelService({
    agentsFile,
    env: {},
    configFile,
    fetchImpl: (async () => new Response(JSON.stringify({ participants: [] }), { status: 200 })) as unknown as typeof fetch,
    nowSeconds: () => NOW_SEC,
    rememberTool: CALL_TOOL_REMEMBER,
    doingTool: CALL_TOOL_DOING,
  })
  const s = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    channel,
    ...(localRoom === undefined ? {} : { localRoom }),
  })
  started.push(s)
  return s
}

describe('GET /channel/status 的 local_room', () => {
  it('接了看管就报那一格;格子在字段表里;没有 secret', async () => {
    const view: LocalRoomView = {
      installed: true,
      running: true,
      url: 'ws://127.0.0.1:7880',
      lan_urls: ['ws://192.168.31.8:7880'],
      restarted_at: '2026-10-21T08:59:30.000Z',
      restart_reason: '局域网地址变了(10.0.0.5 → 192.168.31.8)',
    }
    const s = await server({ view: async () => view })
    const res = await fetch(`${s.url}/channel/status`)
    expect(res.status).toBe(200)
    const text = await res.text()
    const body = JSON.parse(text) as Record<string, unknown>
    expect(body.local_room).toEqual(view)
    for (const key of Object.keys(body)) expect(wire.fields.status).toContain(key)
    expect(text).not.toContain(SECRET)
  })

  it('没接(老装法、测试):没有这一格,其余照旧', async () => {
    const s = await server()
    const body = await (await fetch(`${s.url}/channel/status`)).json() as Record<string, unknown>
    expect(body).not.toHaveProperty('local_room')
    expect(body.configured).toBe(true)
  })

  it('看管那一头抛了:这一格缺席,整条路由不跟着 500', async () => {
    const s = await server({ view: async () => { throw new Error('探不到') } })
    const res = await fetch(`${s.url}/channel/status`)
    expect(res.status).toBe(200)
    expect(await res.json()).not.toHaveProperty('local_room')
  })
})
