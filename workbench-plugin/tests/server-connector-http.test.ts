// @vitest-environment node
/**
 * 连接器那几条路由(卡 OC2,2026-09-27)。
 *
 * 钉三件事:
 * - 不接连接器时 `/connector/*` 一律 404,`/state.connector` 缺席 —— 这块功能之前的行为一字不变;
 * - `status` 谁都能看,**写的那四条只认回环**(手机不该能把她机器上的连接器卸掉);
 * - 业务失败 HTTP 层照样 200,把 `{ ok:false, error }` 如实回去(界面原样转达,不自己编话)。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConnectorService } from '../src/server/connector/service.ts'
import { CONNECTOR_DEFAULT_PORT, CONNECTOR_VERSION } from '../src/server/connector/manifest.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createNotesService } from '../src/server/notes.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import type { ConnectorView } from '../src/protocol.ts'

const LOOPBACK = '127.0.0.1'
const PHONE = '192.168.1.20'
const started: WorkbenchServer[] = []
afterEach(async () => { while (started.length) await started.pop()?.close() })

const VIEW: ConnectorView = {
  phase: 'ready', installed: true, running: true, port: CONNECTOR_DEFAULT_PORT,
  version: CONNECTOR_VERSION, downloadBytes: 229 * 1024 * 1024, apps: 1554, connected: 0,
  hosts: [{ id: 'dsh', label: '事务官(DSH)', connected: true }],
}

function fakeConnector(): ConnectorService & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    view: async () => VIEW,
    ensure: () => { calls.push('ensure') },
    install: async () => { calls.push('install'); return { ok: false, error: '这会儿下载不了(网络不通),等有网了下次开机自己接着装。' } },
    start: async () => { calls.push('start'); return { ok: true } },
    stop: async () => { calls.push('stop'); return { ok: true } },
    uninstall: async () => { calls.push('uninstall'); return { ok: true } },
  }
}

async function serve(options: { wired?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-connector-http-'))
  const connector = fakeConnector()
  const remote = { address: LOOPBACK }
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService(),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    notes: createNotesService({ file: join(dir, 'notes.json') }),
    ...(options.wired === false ? {} : { connector }),
    remoteAddress: () => remote.address,
  })
  started.push(server)
  const call = async (path: string, init: { method?: string, from?: string } = {}) => {
    remote.address = init.from ?? LOOPBACK
    const res = await fetch(`${server.url}${path}`, { method: init.method ?? 'GET' })
    const text = await res.text()
    remote.address = LOOPBACK
    return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> }
  }
  return { connector, call }
}

describe('/connector/*', () => {
  it('没接连接器 → 一律 404,/state 里也没有那一格', async () => {
    const t = await serve({ wired: false })
    for (const [path, method] of [['/connector/status', 'GET'], ['/connector/install', 'POST'], ['/connector/uninstall', 'POST']] as const) {
      const res = await t.call(path, { method })
      expect(res.status, path).toBe(404)
      expect(res.body.error).toBe('连接器未接线')
    }
    const state = await t.call('/state')
    expect(state.body.connector).toBeUndefined()
  })

  it('status 回的就是 view(),/state 里也是同一份', async () => {
    const t = await serve()
    const res = await t.call('/connector/status')
    expect(res.status).toBe(200)
    expect(res.body).toEqual(VIEW)
    const state = await t.call('/state')
    expect(state.body.connector).toEqual(VIEW)
  })

  it('写的那四条只认回环:手机打 → 403,而且一件事都没做', async () => {
    const t = await serve()
    for (const path of ['/connector/install', '/connector/start', '/connector/stop', '/connector/uninstall']) {
      const res = await t.call(path, { method: 'POST', from: PHONE })
      expect(res.status, path).toBe(403)
      // 没配对的来源先被外层那道来源闸挡下(「此来源不允许访问」),连路由都进不去;
      // 就算将来那道闸放宽了,路由里还有自己那一句「只能在本机操作连接器」。两道都在。
      expect(res.body.error, path).toMatch(/此来源不允许访问|只能在本机操作连接器/)
    }
    expect(t.connector.calls).toEqual([])
  })

  it('本机点「卸掉」→ 真卸;业务失败照样 200 并原样带话', async () => {
    const t = await serve()
    expect((await t.call('/connector/uninstall', { method: 'POST' })).body).toEqual({ ok: true })
    const failed = await t.call('/connector/install', { method: 'POST' })
    expect(failed.status).toBe(200)
    expect(failed.body.ok).toBe(false)
    expect(failed.body.error).toContain('网络不通')
    expect(t.connector.calls).toEqual(['uninstall', 'install'])
  })
})
