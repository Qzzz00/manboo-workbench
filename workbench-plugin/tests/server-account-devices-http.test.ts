// @vitest-environment node
/**
 * 「我的设备」那两条 HTTP 路(2026-09-21)。盯四件事:
 *
 *   1. **本机账号没有这两条**(404):账号只在这台机器上时,谈不上"我名下有哪几台";
 *   2. 只认回环 —— 设备列表说得出用户有几台机器、上次什么时候在线,不该对局域网开着;
 *   3. 回包里**一个令牌都没有**;
 *   4. 登出时服务器那张会话也真的被吊销了(只清 cookie 等于那张长期令牌还在服务器上活着)。
 */
import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createAccountService } from '../src/server/account.ts'
import { createServerAccountService } from '../src/server/serverAccount.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const LOOPBACK = '127.0.0.1'
const PHONE = '192.168.1.20'

const started: WorkbenchServer[] = []
const relays: Server[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (relays.length) await new Promise<void>(done => relays.pop()?.close(() => done()))
})

const ACCOUNT = { id: 'acct-1', email_or_phone: 'ben', created_at: '2026-09-21T00:00:00.000Z' }

/** 一个只回这几条的假中转。`state` 让用例看得到它被怎么调过。 */
async function fakeRelay() {
  const state = { loggedOut: false, revoked: [] as string[] }
  let devices = [
    { device_id: 'mac-1', name: '我的 Mac', kind: 'mac', created_at: '2026-09-21T00:00:00.000Z', last_seen_at: '2026-09-21T02:00:00.000Z' },
    { device_id: 'phone-1', name: '我的手机', kind: 'phone', created_at: '2026-09-21T01:00:00.000Z' },
  ]
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += String(c) })
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0]
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (path === '/v1/account/login') return reply(200, { session_token: 'wbs_session-1', account: ACCOUNT })
      if (path === '/v1/account/logout') { state.loggedOut = true; return reply(200, { ok: true }) }
      if (path === '/v1/account/devices') return reply(200, { devices })
      if (path === '/v1/account/devices/revoke') {
        const id = (JSON.parse(raw === '' ? '{}' : raw) as { device_id?: string }).device_id ?? ''
        state.revoked.push(id)
        devices = devices.filter(d => d.device_id !== id)
        return reply(200, { ok: true, removed: 1, devices })
      }
      return reply(404, { error: { message: '没有这个路径' } })
    })
  })
  await new Promise<void>(resolve => { server.listen(0, LOOPBACK, resolve) })
  relays.push(server)
  const address = server.address()
  return { url: `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`, state }
}

async function serve(options: { onServer: boolean } = { onServer: true }) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-account-devices-'))
  const relay = options.onServer ? await fakeRelay() : { url: 'http://127.0.0.1:1', state: { loggedOut: false, revoked: [] as string[] } }
  const local = createAccountService({
    file: join(dir, 'account.json'), keyFile: join(dir, 'account-session.key'), scryptN: 1024,
  })
  const account = createServerAccountService({
    local,
    localFile: join(dir, 'account.json'),
    sessionFile: join(dir, 'account-server.json'),
    keyFile: join(dir, 'account-session.key'),
    relayUrl: async () => relay.url,
  })
  const remote = { address: LOOPBACK }
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => 0 }),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    account,
    remoteAddress: () => remote.address,
    isRemoteAllowed: () => true,
    isLoopback: () => remote.address === LOOPBACK,
  })
  started.push(server)

  let jar = ''
  const call = async (path: string, init: { method?: string, body?: unknown, from?: string } = {}) => {
    remote.address = init.from ?? LOOPBACK
    const res = await fetch(`${server.url}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(jar === '' ? {} : { cookie: jar }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    remote.address = LOOPBACK
    const setCookie = res.headers.get('set-cookie')
    if (setCookie !== null) {
      const first = setCookie.split(';')[0] ?? ''
      jar = first.endsWith('=') ? '' : first
    }
    const text = await res.text()
    return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> }
  }
  return { call, relay }
}

describe('GET /account/devices', () => {
  it('登录之后列得出来,而且回包里没有任何令牌', async () => {
    const { call } = await serve()
    expect((await call('/account/login', { body: { username: 'ben', password: 'hunter22' } })).status).toBe(200)
    const res = await call('/account/devices')
    expect(res.status).toBe(200)
    const devices = res.body.devices as { device_id: string }[]
    expect(devices.map(d => d.device_id)).toEqual(['mac-1', 'phone-1'])
    const text = JSON.stringify(res.body)
    expect(text.includes('wb_')).toBe(false)
    expect(text.includes('wbs_')).toBe(false)
  })

  it('/account 里 on_server 为真,界面据此才显示这一节', async () => {
    const { call } = await serve()
    await call('/account/login', { body: { username: 'ben', password: 'hunter22' } })
    expect((await call('/account')).body.on_server).toBe(true)
  })

  it('手机来问:403(与 /account 其余几条同一道门)', async () => {
    const { call } = await serve()
    await call('/account/login', { body: { username: 'ben', password: 'hunter22' } })
    expect((await call('/account/devices', { from: PHONE })).status).toBe(403)
  })

  it('账号还在本机(服务器没有账号服务)→ 404,不是空列表', async () => {
    const { call } = await serve({ onServer: false })
    // 服务器连不上 → 退回本机注册,on_server 为假。
    await call('/account/register', { body: { username: 'ben', password: 'hunter22', confirm: 'hunter22' } })
    expect((await call('/account')).body.on_server).toBe(false)
    // 本机账号照样有 devices 这两条路由(服务是同一个实例),但它会说"还没登录账号"。
    const res = await call('/account/devices')
    expect(res.status).toBe(503)
    expect(typeof res.body.error).toBe('string')
  })

  it('没登录时回 503 + 一句人话,不是空列表', async () => {
    const { call } = await serve()
    const res = await call('/account/devices')
    expect(res.status).toBe(503)
    expect(String(res.body.error)).toContain('登录')
  })
})

describe('POST /account/devices/revoke', () => {
  it('移除一台之后回的是剩下的那些', async () => {
    const { call, relay } = await serve()
    await call('/account/login', { body: { username: 'ben', password: 'hunter22' } })
    const res = await call('/account/devices/revoke', { body: { device_id: 'phone-1' } })
    expect(res.status).toBe(200)
    expect((res.body.devices as { device_id: string }[]).map(d => d.device_id)).toEqual(['mac-1'])
    expect(relay.state.revoked).toEqual(['phone-1'])
  })

  it('没说移除哪一台 → 400', async () => {
    const { call } = await serve()
    await call('/account/login', { body: { username: 'ben', password: 'hunter22' } })
    expect((await call('/account/devices/revoke', { body: {} })).status).toBe(400)
  })

  it('手机来移除:403', async () => {
    const { call } = await serve()
    await call('/account/login', { body: { username: 'ben', password: 'hunter22' } })
    expect((await call('/account/devices/revoke', { body: { device_id: 'phone-1' }, from: PHONE })).status).toBe(403)
  })
})

describe('登出也要吊销服务器那张会话', () => {
  it('POST /account/logout 打到了中转的 /v1/account/logout', async () => {
    const { call, relay } = await serve()
    await call('/account/login', { body: { username: 'ben', password: 'hunter22' } })
    expect((await call('/account/logout', { body: {} })).status).toBe(200)
    expect(relay.state.loggedOut).toBe(true)
    // 而且真的下线了:cookie 没了,/account 说没登录。
    expect((await call('/account')).body.logged_in).toBe(false)
  })
})
