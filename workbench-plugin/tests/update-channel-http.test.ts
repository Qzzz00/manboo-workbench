// @vitest-environment node
/**
 * 更新通道经 8791 的那两条路(2026-10-21,内测发版底座)。
 *
 *   GET  /update/channel            这台机器收哪条
 *   POST /update/channel {channel}  切过去,当场按新通道查一次并回那一趟的结论
 *
 * 清单由本地起的 http 假服务器发(`latest.json` 与 `beta.json` 两份),一次都不去 api.aibooo.cn。
 * 同 `/update/*` 一律只认回环 —— 手机拿着有效设备令牌也切不了。
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createPairingService } from '../src/server/devices.ts'
import { nodeSetupIo } from '../src/server/setup/io.ts'
import { setupPaths } from '../src/server/setup/paths.ts'
import { appJsonChannelStore } from '../src/server/update/channel.ts'
import { createUpdateService } from '../src/server/update/service.ts'
import type { UpdateCheckView } from '../src/server/update/types.ts'
import type { WorkbenchState } from '../src/protocol.ts'
import { lanOn } from './helpers/lanOn.ts'

const NOW_SEC = Math.floor(Date.parse('2026-10-21T10:00:00Z') / 1000)
const PHONE_ADDRESS = '172.20.10.5'

const started: WorkbenchServer[] = []
const fakes: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (fakes.length) await new Promise<void>((resolve) => { fakes.pop()?.close(() => resolve()) })
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function updatesServer(): Promise<string> {
  let origin = ''
  const manifests: Record<string, string> = {
    '/updates/latest.json': '0.4.142',
    '/updates/beta.json': '0.4.145',
  }
  const server = createServer((req, res) => {
    const version = manifests[req.url ?? '']
    if (version === undefined) { res.writeHead(404); res.end('no'); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      version,
      notes: `${version} 改了什么`,
      assets: { plugin_tgz: { url: `${origin}/updates/${version}/plugin.tgz`, sha256: '1'.repeat(64), size: 1100 } },
    }))
  })
  fakes.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()) })
  const address = server.address()
  origin = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`
  return origin
}

async function serve() {
  const home = mkdtempSync(join(tmpdir(), 'wb-update-channel-http-'))
  dirs.push(home)
  const paths = setupPaths({ home })
  const origin = await updatesServer()
  const update = createUpdateService({
    io: nodeSetupIo(),
    paths,
    now: () => Date.now(),
    newId: () => 'up-1',
    currentVersion: '0.4.142',
    manifestUrl: `${origin}/updates/latest.json`,
    checkIntervalMs: 0,
    channel: appJsonChannelStore(paths.appJson),
  })
  const pairing = createPairingService({ file: join(home, 'devices.json'), now: () => NOW_SEC })
  let from: 'local' | 'phone' = 'local'
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService(),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    usageIntervalMs: 0,
    update,
    pairing,
    remoteAddress: (_req: IncomingMessage) => (from === 'local' ? '127.0.0.1' : PHONE_ADDRESS),
    lan: lanOn(),
    credentialFile: join(home, 'credentials.json'),
  })
  started.push(server)
  pairing.start()
  const claimed = await pairing.claim({ code: pairing.current()?.code ?? '', device_name: '手机', platform: 'android' })
  if (!claimed.ok) throw new Error('配对桩没配上')
  return { server, paths, update, token: claimed.token, phone: () => { from = 'phone' } }
}

const post = (channel: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ channel }),
})

describe('更新通道 · HTTP', () => {
  it('缺省收稳定版;切到热修 → 落盘、回热修那一趟的结论,/state.update 也跟着说', async () => {
    const h = await serve()
    const before = await (await fetch(`${h.server.url}/update/channel`)).json() as { channel: string }
    expect(before.channel).toBe('stable')

    const res = await fetch(`${h.server.url}/update/channel`, post('hotfix'))
    expect(res.status).toBe(200)
    const view = await res.json() as UpdateCheckView
    expect(view.channel).toBe('hotfix')
    expect(view.latest).toBe('0.4.145')
    expect(view.available).toBe(true)
    expect((JSON.parse(readFileSync(h.paths.appJson, 'utf8')) as { update_channel?: string }).update_channel).toBe('hotfix')

    const state = await (await fetch(`${h.server.url}/state`)).json() as WorkbenchState
    expect(state.update?.channel).toBe('hotfix')

    const back = await (await fetch(`${h.server.url}/update/channel`, post('stable'))).json() as UpdateCheckView
    expect(back.channel).toBe('stable')
    expect(back.latest).toBe('0.4.142')
    expect(back.available).toBe(false)
  })

  it('认不出的通道 → 400,不写盘', async () => {
    const h = await serve()
    expect((await fetch(`${h.server.url}/update/channel`, post('beta'))).status).toBe(400)
    expect(await h.update.channel()).toBe('stable')
  })

  it('手机带着有效设备令牌也看不了、切不了(只认回环)', async () => {
    const h = await serve()
    h.phone()
    const auth = { authorization: `Bearer ${h.token}` }
    expect((await fetch(`${h.server.url}/update/channel`, { headers: auth })).status).toBe(403)
    expect((await fetch(`${h.server.url}/update/channel`, post('hotfix', auth))).status).toBe(403)
    expect(await h.update.channel()).toBe('stable')
  })
})
