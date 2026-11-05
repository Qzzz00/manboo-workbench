// @vitest-environment node
/**
 * 诊断那几条路经 8791 的门(2026-09-22)。
 *
 *   POST /diag/export  GET|POST /diag/settings  POST /diag/notice-seen
 *
 * **一律只认回环**:导出会把这台机器上的日志与配置写成一个文件放到桌面,
 * 而那个文件里有路径、项目名、应用名。手机拿着有效的设备令牌也碰不到 —— 这一条有用例钉着,
 * 与 `/setup/*`、`/update/*` 同一条规矩。
 *
 * 另外钉住:整块没接线时 404(而不是 500),以及**报错带编号**那条新契约。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'

import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createPairingService } from '../src/server/devices.ts'
import type { DiagService } from '../src/server/diagnostics/service.ts'
import { DIAG_CODE_RE, type DiagSendView } from '../src/diag.ts'
import { lanOn } from './helpers/lanOn.ts'

const PHONE_ADDRESS = '172.20.10.5'
const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** 一个什么都不真做的诊断服务:这一组验的是**门**,不是打包。 */
function fakeDiag(): DiagService & { calls: string[] } {
  const calls: string[] = []
  let enabled = true
  let seen = false
  let last: DiagSendView | undefined
  return {
    calls,
    async export() {
      calls.push('export')
      return {
        ok: true, file: '/Users/example/Desktop/包.zip', file_redacted: '/Users/<用户>/Desktop/包.zip',
        bytes: 1234, entries: [], skipped: [], revealed: true,
      }
    },
    async settings() {
      return { report_enabled: enabled, notice_seen: seen, sent_this_hour: 0, hourly_limit: 20 }
    },
    async setReportEnabled(next) {
      enabled = next
      return { report_enabled: enabled, notice_seen: seen, sent_this_hour: 0, hourly_limit: 20 }
    },
    async markNoticeSeen() {
      seen = true
      return { report_enabled: enabled, notice_seen: seen, sent_this_hour: 0, hourly_limit: 20 }
    },
    async report() { calls.push('report'); return { code: 'WB-000001', sent: false, merged: 1 } },
    pump() { calls.push('pump') },
    lastRotate: () => undefined,
    send() {
      calls.push('send')
      last = { id: 'send-1', state: 'running', started_at: '2026-10-21T02:00:00.000Z' }
      return { ...last }
    },
    sendView: () => (last === undefined ? undefined : { ...last }),
    async waitSend() {},
  }
}

async function serve(options: { diag?: DiagService } = {}) {
  const home = temp('wb-diag-http-')
  let who: 'local' | 'phone' = 'local'
  const pairing = createPairingService({ file: join(home, 'devices.json'), now: () => Date.now() })
  const server = await startWorkbenchServer({
    port: 0,
    host: '127.0.0.1',
    service: createWorkbenchService(),
    pairing,
    ...(options.diag === undefined ? {} : { diag: options.diag }),
    remoteAddress: (_req: IncomingMessage) => (who === 'local' ? '127.0.0.1' : PHONE_ADDRESS),
    // 2026-10-01:手机热点网段那条来源门例外撤掉了,扮演手机的用例照真机的样子把
    // 「允许手机在局域网访问」开着;验的还是设备令牌那道门(见 helpers/lanOn.ts)。
    lan: lanOn(),
  })
  started.push(server)
  pairing.start()
  const claimed = await pairing.claim({ code: pairing.current()?.code ?? '', device_name: '手机', platform: 'android' })
  if (!claimed.ok) throw new Error('配对桩没配上')
  return {
    base: server.url,
    who: (value: 'local' | 'phone') => { who = value },
    token: claimed.token,
  }
}

describe('没接线', () => {
  it('整块 404,而且是一句人话', async () => {
    const h = await serve()
    const res = await fetch(`${h.base}/diag/settings`)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('诊断未启用')
  })
})

describe('只认回环', () => {
  it('手机带着有效设备令牌也导不了包', async () => {
    const diag = fakeDiag()
    const h = await serve({ diag })
    h.who('phone')
    const res = await fetch(`${h.base}/diag/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${h.token}` },
      body: '{}',
    })
    expect(res.status).toBe(403)
    expect(diag.calls).not.toContain('export')
  })

  it('手机也改不动那颗开关、看不到诊断设置', async () => {
    const h = await serve({ diag: fakeDiag() })
    h.who('phone')
    for (const [path, init] of [
      ['/diag/settings', {}],
      ['/diag/settings', { method: 'POST', body: JSON.stringify({ report_enabled: false }) }],
      ['/diag/notice-seen', { method: 'POST', body: '{}' }],
    ] as const) {
      const res = await fetch(`${h.base}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${h.token}` },
      })
      expect(res.status).toBe(403)
    }
  })

  it('**403 那句话带编号** —— Ben 念六个数字就能在日志里对上', async () => {
    const h = await serve({ diag: fakeDiag() })
    h.who('phone')
    const res = await fetch(`${h.base}/diag/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${h.token}` },
      body: '{}',
    })
    const body = await res.json() as { error: string, code: string }
    expect(body.error).toBe('只能在本机导出诊断包')
    expect(DIAG_CODE_RE.test(body.code)).toBe(true)
  })
})

describe('发诊断包(2026-10-21):手机与电脑同一颗键', () => {
  it('★手机带着有效设备令牌就能发(它只把包交到中转,不把任何文件交给手机),也看得到那一趟', async () => {
    const diag = fakeDiag()
    const h = await serve({ diag })
    h.who('phone')
    const auth = { 'content-type': 'application/json', authorization: `Bearer ${h.token}` }
    const res = await fetch(`${h.base}/diag/send`, { method: 'POST', headers: auth, body: '{}' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as DiagSendView).state).toBe('running')
    expect(diag.calls).toContain('send')
    const view = await (await fetch(`${h.base}/diag/send`, { headers: auth })).json() as DiagSendView
    expect(view.id).toBe('send-1')
  })

  it('没带令牌的手机 → 401,一趟都不起', async () => {
    const diag = fakeDiag()
    const h = await serve({ diag })
    h.who('phone')
    const res = await fetch(`${h.base}/diag/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(401)
    expect(diag.calls).not.toContain('send')
  })

  it('本机也能发;还没发过时 GET 回 state:none', async () => {
    const h = await serve({ diag: fakeDiag() })
    expect(await (await fetch(`${h.base}/diag/send`)).json()).toEqual({ state: 'none' })
    expect((await fetch(`${h.base}/diag/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(200)
  })
})

describe('本机', () => {
  it('导得出来,回包里那条路径是**脱敏过**的那一份也一起给', async () => {
    const diag = fakeDiag()
    const h = await serve({ diag })
    const res = await fetch(`${h.base}/diag/export`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean, file_redacted: string }
    expect(body.ok).toBe(true)
    expect(body.file_redacted).toBe('/Users/<用户>/Desktop/包.zip')
    expect(diag.calls).toContain('export')
  })

  it('开关读得到、改得动', async () => {
    const h = await serve({ diag: fakeDiag() })
    expect((await (await fetch(`${h.base}/diag/settings`)).json()).report_enabled).toBe(true)
    const off = await fetch(`${h.base}/diag/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ report_enabled: false }),
    })
    expect((await off.json()).report_enabled).toBe(false)
    expect((await (await fetch(`${h.base}/diag/settings`)).json()).report_enabled).toBe(false)
  })

  it('开关只认真正的布尔 —— 写成字符串就 400(而且带编号)', async () => {
    const h = await serve({ diag: fakeDiag() })
    const res = await fetch(`${h.base}/diag/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ report_enabled: 'false' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string, code: string }
    expect(body.error).toContain('true 或 false')
    expect(DIAG_CODE_RE.test(body.code)).toBe(true)
  })

  it('「那段说明我看过了」记得住', async () => {
    const h = await serve({ diag: fakeDiag() })
    expect((await (await fetch(`${h.base}/diag/settings`)).json()).notice_seen).toBe(false)
    await fetch(`${h.base}/diag/notice-seen`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect((await (await fetch(`${h.base}/diag/settings`)).json()).notice_seen).toBe(true)
  })
})

describe('后台活挂在 /state 那一拍上', () => {
  it('读一次 /state 就泵一拍(收拾日志 + 把攒着的合并上报发出去)', async () => {
    const diag = fakeDiag()
    const h = await serve({ diag })
    await fetch(`${h.base}/state`)
    expect(diag.calls).toContain('pump')
  })
})
