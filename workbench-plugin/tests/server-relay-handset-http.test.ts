// @vitest-environment node
/**
 * `POST /channel/relay-handset`(2026-09-27,卡 HS)。**电脑替座机在账号里登记**。
 *
 * 为什么有这一条:手机上「设置 → 座机 → 添加座机」最后一步要给座机换一把中转设备令牌,
 * 而领它要账号会话 —— 扫码配对进来的手机按设计**没有**账号会话(密码只在电脑上)。
 * 维护者 09-27 走到这一步时蓝牙、Wi-Fi 全通了,屏上却是「这台手机还没登录账号」。
 *
 * 这一份盯五件事:
 *   1. 已配对的手机报一个 `handset-…` 的编号 → 电脑拿**自己的**会话去中转领,回令牌;
 *   2. 记到中转的种类是 **handset**(记成手机的话通话的声音会送错台);
 *   3. 编号形状不对 → 400,**不往账号里记**(否则「我的设备」里会多出一台不存在的设备);
 *   4. 电脑没登录账号 → 409 + 一句人话(「去电脑上登录一次」),不是 500;
 *   5. 没配对的手机进不来(401),令牌一个字节都不进日志式的回包。
 */
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createPairingService } from '../src/server/devices.ts'
import type { AccountService } from '../src/server/account.ts'
import { RELAY_LINK_NO_RELAY } from '../src/server/modelConfig.ts'
import type { ModelService } from '../src/server/modelService.ts'
import { lanOn } from './helpers/lanOn.ts'

const HANDSET = 'handset-3f2a7c91b04d4e0f'
const NOW_SEC = Math.floor(Date.parse('2026-09-27T05:00:00Z') / 1000)

const started: WorkbenchServer[] = []
const relays: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (relays.length) await new Promise<void>(done => relays.pop()?.close(() => done()))
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/** 一个只回 /register-device 的假中转。`seen` 让用例看得见它被怎么调过(**不含令牌**)。 */
async function fakeRelay(options: { ok?: boolean } = {}) {
  const seen: { session: string, body: Record<string, unknown> }[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += String(c) })
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0]
      res.writeHead(path === '/register-device' && options.ok !== false ? 200 : 503, { 'content-type': 'application/json' })
      if (path !== '/register-device') { res.end(JSON.stringify({ error: { message: '没有这个路径' } })); return }
      if (options.ok === false) { res.end(JSON.stringify({ error: { message: '中转这会儿忙,过一会儿再试' } })); return }
      seen.push({
        session: String(req.headers.authorization ?? ''),
        body: JSON.parse(raw === '' ? '{}' : raw) as Record<string, unknown>,
      })
      res.end(JSON.stringify({ token: 'wb_handset_secret' }))
    })
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  relays.push(server)
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { url: `http://127.0.0.1:${port}`, seen }
}

/**
 * 账号与模型服务都只用到一两个方法,所以这里是**桩**而不是真服务:
 * `devices` 只为让 `isServerAccount` 认它是服务器账号,`sessionToken` 是这条路真正要的那一样。
 */
function stubAccount(session: string | undefined): AccountService {
  return {
    devices: async () => ({ ok: true as const, view: { devices: [] } }),
    revokeDevice: async () => ({ ok: true as const, view: { devices: [] } }),
    logout: async () => {},
    sessionToken: async () => session,
  } as unknown as AccountService
}

function stubModel(relayUrl: string): ModelService {
  return { status: async () => ({ relay_url: relayUrl, relay_configured: relayUrl !== '' }) } as unknown as ModelService
}

/**
 * `loggedIn: false` = 电脑上没登录账号。**用一个显式的开关而不是 `session: undefined`**:
 * JS 的 `??` 在显式传 undefined 时照样给默认值,那条用例会悄悄测到"登录着"。
 */
async function serve(options: { loggedIn?: false, relayOk?: boolean, account?: boolean, model?: boolean, noRelay?: true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-relay-handset-'))
  dirs.push(dir)
  const relay = await fakeRelay(options.relayOk === false ? { ok: false } : {})
  const pairing = createPairingService({ file: join(dir, 'devices.json'), now: () => NOW_SEC })
  let actor: 'local' | 'phone' = 'phone'
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    pairing,
    ...(options.account === false ? {} : { account: stubAccount(options.loggedIn === false ? undefined : 'wbs_session-1') }),
    ...(options.model === false ? {} : { model: stubModel(options.noRelay === true ? '' : relay.url) }),
    remoteAddress: () => (actor === 'local' ? '127.0.0.1' : '172.20.10.7'),
    // 2026-10-01:手机热点网段那条来源门例外撤掉了,扮演手机的用例照真机的样子把
    // 「允许手机在局域网访问」开着;验的还是设备令牌那道门(见 helpers/lanOn.ts)。
    lan: lanOn(),
  })
  started.push(server)

  pairing.start()
  const code = pairing.current()?.code ?? ''
  const claimed = await pairing.claim({ code, device_name: '手机', platform: 'android' })
  if (!claimed.ok) throw new Error('测试装置:配对没成')

  const call = async (body: unknown, init: { token?: boolean, from?: 'local' | 'phone' } = {}) => {
    actor = init.from ?? 'phone'
    const res = await fetch(`${server.url}/channel/relay-handset`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(init.token === false ? {} : { authorization: `Bearer ${claimed.token}` }),
      },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> }
  }
  return { call, relay }
}

describe('POST /channel/relay-handset', () => {
  it('已配对的手机报一个座机编号 → 电脑用自己的会话替它领,回中转地址与令牌', async () => {
    const { call, relay } = await serve()
    const res = await call({ device_id: HANDSET, name: '工作台座机-9A4C' })
    expect(res.status).toBe(200)
    expect(res.body.device_id).toBe(HANDSET)
    expect(res.body.token).toBe('wb_handset_secret')
    expect(res.body.relay_url).toBe(relay.url)
    // 领的是**座机的**那一把:中转那边收到的 device_id 是座机的,不是这台手机的。
    expect(relay.seen[0]?.body.device_id).toBe(HANDSET)
    // 用的是电脑自己的账号会话(手机一个字都没给过)。
    expect(relay.seen[0]?.session).toContain('wbs_session-1')
    /**
     * **记到了谁名下**(2026-09-27,卡 RM ②)。手机成功那一屏要写「记到了 <电脑名> · <账号名> 下」
     * —— 比赛现场那只座机记到的是另一台电脑的账号,而屏上那句「已经记到你的账号下」照样是绿的。
     * 账号名问不出来时(这个装置里的假账号就没有 `view`)整格缺席,**不编** ——
     * 而且那一问绝不能把整条路带崩(那正是这一条第一次写出来时的错)。
     */
    expect(typeof res.body.computer).toBe('string')
    expect(String(res.body.computer)).not.toBe('')
  })

  it('★ 种类记成 handset —— 中转按它签 wb_kind,记成手机的话通话的声音会送错台', async () => {
    const { call, relay } = await serve()
    await call({ device_id: HANDSET })
    expect(relay.seen[0]?.body.kind).toBe('handset')
    // 没报名字时给一个稳的,不编一个假机型。
    expect(relay.seen[0]?.body.name).toBe('座机话筒')
  })

  it('编号不像座机报上来的那种 → 400,而且一个字都没往账号里记', async () => {
    const { call, relay } = await serve()
    for (const bad of ['', '随手写的', 'phone-1', 'handset-', 'handset-ZZZZ', `handset-${'a'.repeat(40)}`]) {
      const res = await call({ device_id: bad })
      expect(res.status).toBe(400)
      expect(String(res.body.error)).toContain('handset-')
    }
    expect(relay.seen).toHaveLength(0)
  })

  it('电脑上还没登录账号 → 409,话里说的是「去电脑上登录一次」', async () => {
    const { call, relay } = await serve({ loggedIn: false })
    const res = await call({ device_id: HANDSET })
    expect(res.status).toBe(409)
    expect(String(res.body.error)).toContain('电脑')
    expect(String(res.body.error)).toContain('登录')
    expect(relay.seen).toHaveLength(0)
  })

  it('这台没接中转(零服务器档)→ 409 + code no_relay,说「没接中转、座机只走局域网」,不说「去登录」', async () => {
    const { call, relay } = await serve({ loggedIn: false, noRelay: true })
    const res = await call({ device_id: HANDSET })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: RELAY_LINK_NO_RELAY, code: 'no_relay' })
    expect(String(res.body.error)).not.toContain('登录')
    expect(relay.seen).toHaveLength(0)
  })

  it('账号还在这台电脑上(没搬服务器)→ 404,如实说,不是 500', async () => {
    const { call } = await serve({ account: false })
    const res = await call({ device_id: HANDSET })
    expect(res.status).toBe(404)
    expect(String(res.body.error)).toContain('账号')
  })

  it('中转拒了 → 503,把中转那句话带上来', async () => {
    const { call } = await serve({ relayOk: false })
    const res = await call({ device_id: HANDSET })
    expect(res.status).toBe(503)
    expect(typeof res.body.error).toBe('string')
  })

  it('没配对的手机进不来(401)', async () => {
    const { call } = await serve()
    const res = await call({ device_id: HANDSET }, { token: false })
    expect(res.status).toBe(401)
  })

  it('本机自己也能用(电脑上将来做这一步走同一条)', async () => {
    const { call } = await serve()
    const res = await call({ device_id: HANDSET }, { from: 'local', token: false })
    expect(res.status).toBe(200)
  })
})
