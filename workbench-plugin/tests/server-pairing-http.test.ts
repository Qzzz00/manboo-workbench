// @vitest-environment node
/**
 * 手机配对与设备令牌的 HTTP 层(2026-09-11):
 * 配对码只给本机、claim 换令牌、非本机一律要令牌、本机照旧、开关关着非本机进不来、/live 也认令牌。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { WorkbenchState } from '../src/protocol.ts'
import { createAppConfig } from '../src/server/appConfig.ts'
import { createPairingService, hashToken } from '../src/server/devices.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import type { MdnsAdvertiser } from '../src/server/mdns.ts'
import { createNotesService } from '../src/server/notes.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const T0 = 1_757_580_000_000
const LOOPBACK = '127.0.0.1'
const PHONE = '192.168.1.20'

const started: WorkbenchServer[] = []
afterEach(async () => { while (started.length) await started.pop()?.close() })

function fakeMdns(): MdnsAdvertiser & { starts: number } {
  let on = false
  return {
    starts: 0,
    async start() { on = true; this.starts += 1 },
    async stop() { on = false },
    active: () => on,
  }
}

async function serve(over: { lanAddress?: () => string | undefined, lanOn?: boolean, codes?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-pair-'))
  let clock = T0
  const codes = over.codes ?? ['004217']
  let codeIndex = 0
  const pairing = createPairingService({
    file: join(dir, 'devices.json'),
    now: () => clock,
    randomCode: () => codes[Math.min(codeIndex++, codes.length - 1)]!,
  })
  const config = createAppConfig({ file: join(dir, 'app.json') })
  if (over.lanOn) await config.set({ lan_access: true })
  const mdns = fakeMdns()
  const remote = { address: LOOPBACK }
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => Math.floor(clock / 1000) }),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    notes: createNotesService({ file: join(dir, 'notes.json') }),
    pairing,
    lan: { config, mdns, lanAddress: over.lanAddress ?? (() => '10.86.37.27'), name: '测试工作台', version: '0.0.0' },
    remoteAddress: () => remote.address,
  })
  started.push(server)
  const call = async (path: string, init: { method?: string, body?: unknown, token?: string, from?: string } = {}) => {
    remote.address = init.from ?? LOOPBACK
    const res = await fetch(`${server.url}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    const text = await res.text()
    remote.address = LOOPBACK
    return { status: res.status, text, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> }
  }
  /** 开局域网访问(本机操作),之后的用例才能模拟手机。 */
  const enableLan = async () => { expect((await call('/lan', { body: { enabled: true } })).status).toBe(200) }
  const pair = async (name = 'Ben 的 iPhone') => {
    await enableLan()
    const startRes = await call('/pair/start', { method: 'POST' })
    const code = (startRes.body.pairing as { code: string }).code
    const claim = await call('/pair/claim', { body: { code, device_name: name, platform: 'ios' }, from: PHONE })
    expect(claim.status).toBe(200)
    return { token: claim.body.token as string, device_id: claim.body.device_id as string }
  }
  const liveOutcome = async (query: string, from: string) => {
    // 远端地址只在这里设与还原;事件回调里绝不碰它——上一条连接迟到的 close 事件会在
    // 下一条正在握手时把地址改回回环(全量并行跑时真的撞上过一次)。
    remote.address = from
    const ws = new WebSocket(`${server.url.replace('http://', 'ws://')}/live${query}`)
    const result = await new Promise<{ outcome: 'open' | 'rejected', first?: WorkbenchState }>((resolve) => {
      ws.on('message', (raw) => {
        const message = JSON.parse(String(raw)) as { kind: string, state?: WorkbenchState }
        if (message.kind === 'snapshot') resolve({ outcome: 'open', first: message.state! })
      })
      ws.on('error', () => resolve({ outcome: 'rejected' }))
      ws.on('close', () => resolve({ outcome: 'rejected' }))
    })
    ws.terminate()
    remote.address = LOOPBACK
    return result
  }
  return { server, pairing, config, mdns, call, enableLan, pair, liveOutcome, tick: (ms: number) => { clock += ms } }
}

describe('配对码只给本机', () => {
  it('本机 POST /pair/start 生成码;GET /state.pairing 带 code/expires_at/qr', async () => {
    const t = await serve()
    const res = await t.call('/pair/start', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(res.body.pairing).toMatchObject({ code: '004217', expires_at: new Date(T0 + 5 * 60_000).toISOString() })

    const state = (await t.call('/state')).body as unknown as WorkbenchState
    expect(state.pairing).toEqual({
      code: '004217',
      expires_at: new Date(T0 + 5 * 60_000).toISOString(),
      qr: 'workbench://pair?host=10.86.37.27&port=' + String(t.server.port) + '&code=004217',
    })
    expect(state.lan).toMatchObject({ enabled: false, host: '10.86.37.27', port: t.server.port, advertising: false })
    expect(state.devices).toEqual([])
  })

  it('/state.workbench.name 与 mDNS 广播的名字同一来源(2026-09-17 手机登录:设置页「已登录:工作台 · <主机名>」读它)', async () => {
    const t = await serve()
    const state = (await t.call('/state')).body as unknown as WorkbenchState
    expect(state.workbench).toEqual({ name: '测试工作台' })
  })

  it('取不到局域网 IP 时 qr 缺省,只有数字码——不编地址', async () => {
    const t = await serve({ lanAddress: () => undefined })
    await t.call('/pair/start', { method: 'POST' })
    const state = (await t.call('/state')).body as unknown as WorkbenchState
    expect(state.pairing).toEqual({ code: '004217', expires_at: new Date(T0 + 5 * 60_000).toISOString() })
    expect(state.lan?.host).toBeUndefined()
  })

  it('非本机 POST /pair/start 是 403;没生成过码时 /state 没有 pairing 字段', async () => {
    const t = await serve()
    const state = (await t.call('/state')).body as unknown as WorkbenchState
    expect(state.pairing).toBeUndefined()
    const { token } = await t.pair()
    expect((await t.call('/pair/start', { method: 'POST', from: PHONE, token })).status).toBe(403)
  })
})

describe('鉴权:本机照旧,非本机要令牌', () => {
  it('本机不带令牌:读 /state、写 /note/add 都照常(现有壳与网页前端行为不变)', async () => {
    const t = await serve()
    expect((await t.call('/state')).status).toBe(200)
    const added = await t.call('/note/add', { body: { text: '本机照旧' } })
    expect(added.status).toBe(200)
    // 本机带一个错令牌也不受影响:回环本身就是凭证。
    expect((await t.call('/note/add', { body: { text: '带错令牌也行' }, token: 'nonsense' })).status).toBe(200)
  })

  it('非本机不带令牌:读 /state 401、写 /note/add 401,状态不被污染', async () => {
    const t = await serve()
    await t.enableLan()
    expect((await t.call('/state', { from: PHONE })).status).toBe(401)
    expect((await t.call('/note/add', { body: { text: '闯入' }, from: PHONE })).status).toBe(401)
    const state = (await t.call('/state')).body as unknown as WorkbenchState
    expect(state.notes).toEqual([])
  })

  it('配对全流程:claim 拿到令牌 → 带令牌读写成功 → /state 不给 pairing、devices 里没有哈希 → 解除配对后 401', async () => {
    const t = await serve()
    const { token, device_id } = await t.pair()
    expect(token.length).toBeGreaterThan(20)

    const read = await t.call('/state', { from: PHONE, token })
    expect(read.status).toBe(200)
    const state = read.body as unknown as WorkbenchState
    expect(state.pairing).toBeUndefined()
    expect(state.devices).toHaveLength(1)
    expect(state.devices![0]).toMatchObject({ id: device_id, name: 'Ben 的 iPhone', platform: 'ios' })
    expect(read.text).not.toContain(hashToken(token))
    expect(read.text).not.toContain(token)

    expect((await t.call('/note/add', { body: { text: '手机写的' }, from: PHONE, token })).status).toBe(200)

    const revoked = await t.call('/pair/revoke', { body: { id: device_id } })
    expect(revoked.status).toBe(200)
    expect((await t.call('/state', { from: PHONE, token })).status).toBe(401)
    expect((await t.call('/note/add', { body: { text: '撤销后' }, from: PHONE, token })).status).toBe(401)
    expect(((await t.call('/state')).body as unknown as WorkbenchState).devices).toEqual([])
  })

  it('凭据、登录、配对管理、开关这些「只有 Ben 在电脑前才能做」的口子,带令牌的手机也进不去', async () => {
    const t = await serve()
    const { token, device_id } = await t.pair()
    const from = PHONE
    expect((await t.call('/credentials', { body: { provider: 'deepseek', key: 'x' }, from, token })).status).toBe(403)
    expect((await t.call('/login', { body: { provider: 'kimi_web' }, from, token })).status).toBe(403)
    expect((await t.call('/pair/revoke', { body: { id: device_id }, from, token })).status).toBe(403)
    expect((await t.call('/lan', { body: { enabled: false }, from, token })).status).toBe(403)
    // 它自己还活着:没被那些 403 顺手撤掉。
    expect((await t.call('/state', { from, token })).status).toBe(200)
  })

  it('错码:5 次之后 429,并把当前码清掉', async () => {
    const t = await serve()
    await t.enableLan()
    await t.call('/pair/start', { method: 'POST' })
    for (let i = 0; i < 4; i++) {
      const wrong = await t.call('/pair/claim', { body: { code: '000000', device_name: '手机', platform: 'ios' }, from: PHONE })
      expect(wrong.status).toBe(401)
    }
    const fifth = await t.call('/pair/claim', { body: { code: '000000', device_name: '手机', platform: 'ios' }, from: PHONE })
    expect(fifth.status).toBe(429)
    expect(typeof fifth.body.locked_until).toBe('string')
    expect(((await t.call('/state')).body as unknown as WorkbenchState).pairing).toBeUndefined()
    // 错误信息里不含配对码。
    expect(fifth.text).not.toContain('004217')
  })

  it('claim 的 body 不合法回 400;不是 JSON 回 400', async () => {
    const t = await serve()
    await t.enableLan()
    await t.call('/pair/start', { method: 'POST' })
    expect((await t.call('/pair/claim', { body: { code: '004217' }, from: PHONE })).status).toBe(400)
    const raw = await fetch(`${t.server.url}/pair/claim`, { method: 'POST', body: '{nope' })
    expect(raw.status).toBe(400)
  })

  it('预检放行 authorization 头:手机 App(Capacitor 的 localhost 源)带令牌的 POST 才发得出去', async () => {
    const t = await serve()
    const res = await fetch(`${t.server.url}/note/add`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'capacitor://localhost',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type, authorization',
      },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('capacitor://localhost')
    expect(String(res.headers.get('access-control-allow-headers')).toLowerCase()).toContain('authorization')
  })
})

describe('「允许手机在局域网访问」开关', () => {
  it('默认关:非本机哪怕拿着令牌也是 403(生产里根本没监听 0.0.0.0)', async () => {
    const t = await serve()
    const { token } = await t.pair()
    expect((await t.call('/lan', { body: { enabled: false } })).status).toBe(200)
    expect((await t.call('/state', { from: PHONE, token })).status).toBe(403)
    expect((await t.call('/pair/claim', { body: { code: '004217', device_name: 'x', platform: 'ios' }, from: PHONE })).status).toBe(403)
  })

  it('开:落盘 app.json、同时监听 0.0.0.0、mDNS 开播;关:全部收回', async () => {
    const t = await serve()
    const on = await t.call('/lan', { body: { enabled: true } })
    expect(on.status).toBe(200)
    expect(on.body.lan).toMatchObject({ enabled: true, advertising: true, port: t.server.port })
    expect(await t.config.get()).toEqual({ lan_access: true })
    expect(t.mdns.active()).toBe(true)
    expect(t.server.lanListening()).toBe(true)

    const off = await t.call('/lan', { body: { enabled: false } })
    expect(off.body.lan).toMatchObject({ enabled: false, advertising: false })
    expect(await t.config.get()).toEqual({ lan_access: false })
    expect(t.mdns.active()).toBe(false)
    expect(t.server.lanListening()).toBe(false)
  })

  it('重复开不重复起监听;body 不合法 400;非本机 403', async () => {
    const t = await serve()
    await t.call('/lan', { body: { enabled: true } })
    await t.call('/lan', { body: { enabled: true } })
    expect(t.mdns.starts).toBe(1)
    expect((await t.call('/lan', { body: { enabled: 'yes' } })).status).toBe(400)
    // 没令牌的手机先吃鉴权那道 401;带令牌的手机是 403(上面「只有 Ben 在电脑前」那条用例)。
    expect((await t.call('/lan', { body: { enabled: false }, from: PHONE })).status).toBe(401)
  })

  it('app.json 里已经开着:服务一起来就监听并广播(重启不丢)', async () => {
    const t = await serve({ lanOn: true })
    expect(t.server.lanListening()).toBe(true)
    expect(t.mdns.active()).toBe(true)
    const state = (await t.call('/state')).body as unknown as WorkbenchState
    expect(state.lan).toMatchObject({ enabled: true, advertising: true })
  })
})

describe('/live 订阅也认令牌', () => {
  it('本机照常;非本机没令牌断开;?token= 带对了收到快照且快照里没有 pairing;撤销后断开', async () => {
    const t = await serve()
    const { token, device_id } = await t.pair()
    await t.call('/pair/start', { method: 'POST' }) // 让本机 /state 有 pairing,验证广播快照里没有它

    expect((await t.liveOutcome('', LOOPBACK)).outcome).toBe('open')
    expect((await t.liveOutcome('', PHONE)).outcome).toBe('rejected')
    expect((await t.liveOutcome('?token=wrong', PHONE)).outcome).toBe('rejected')

    const ok = await t.liveOutcome(`?token=${encodeURIComponent(token)}`, PHONE)
    expect(ok.outcome).toBe('open')
    expect(ok.first?.pairing).toBeUndefined()
    expect(ok.first?.devices).toHaveLength(1)

    await t.call('/pair/revoke', { body: { id: device_id } })
    expect((await t.liveOutcome(`?token=${encodeURIComponent(token)}`, PHONE)).outcome).toBe('rejected')
    // 上面几条 open 之后的 close 由客户端发起,服务端记账要晚一拍,等它清零。
    for (let i = 0; i < 50 && t.server.liveClients() > 0; i++) await new Promise(r => setTimeout(r, 10))
    expect(t.server.liveClients()).toBe(0)
  })
})

/**
 * 设置 → 手机与设备 → 改名(2026-09-25,卡 fix/evening-gaps 第 2 条)。
 * 与解除配对同一道门:只认回环;带令牌的手机碰不到。
 */
describe('给已配对的设备改名', () => {
  it('★ 本机 POST /pair/rename 改名,/state.devices 立刻是新名字;首尾空白去掉', async () => {
    const t = await serve()
    const { device_id } = await t.pair('小米测试机')
    const res = await t.call('/pair/rename', { body: { id: device_id, name: '  客厅那台  ' } })
    expect(res.status).toBe(200)
    const state = (await t.call('/state')).body as unknown as WorkbenchState
    expect(state.devices?.[0]).toMatchObject({ id: device_id, name: '客厅那台' })
  })

  it('空名字 400;没有这台 404;带令牌的手机 403(它自己也改不了)', async () => {
    const t = await serve()
    const { token, device_id } = await t.pair()
    expect((await t.call('/pair/rename', { body: { id: device_id, name: '   ' } })).status).toBe(400)
    expect((await t.call('/pair/rename', { body: { id: 'nope', name: '新名字' } })).status).toBe(404)
    expect((await t.call('/pair/rename', { body: { id: device_id, name: '偷改' }, from: PHONE, token })).status).toBe(403)
    const state = (await t.call('/state')).body as unknown as WorkbenchState
    expect(state.devices?.[0]?.name).toBe('Ben 的 iPhone')
  })

  it('解除配对之后就改不了了', async () => {
    const t = await serve()
    const { device_id } = await t.pair()
    await t.call('/pair/revoke', { body: { id: device_id } })
    expect((await t.call('/pair/rename', { body: { id: device_id, name: '新名字' } })).status).toBe(404)
  })
})
