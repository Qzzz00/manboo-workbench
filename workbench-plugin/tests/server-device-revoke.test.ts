// @vitest-environment node
/**
 * 「从账号里移除一台手机,要把它撤干净」(2026-10-03,分支 claude/device-revoke-complete,
 * 审计附证 A:`docs/审计材料/2026-10-03/devices.md` 第 39 行起)。
 *
 * 审计查实的洞:移除设备只调 `account.revokeDevice`,**本机局域网配对一个字没动** ——
 * 那台手机回到同一个 Wi-Fi 还能照常用 8791,还能再签一张进房票。撤销「整台设备」的承诺
 * 当时只撤了一个凭据体系。
 *
 * 所以这一份盯的是「一处撤销、三处生效」,**全部走真实入口**(真 HTTP、真配对服务、
 * 真 devices.json、真账号服务 + 假中转),不去单独调某个函数:
 *
 *   ① 移除之后,那台手机带旧设备令牌从局域网来 → 401,而且那句话说的是「从账号里移除」;
 *   ② 移除之后再要进房凭证 → 拒,回包里没有 token;
 *   ③ 关掉工作台再起一遍(同一份 devices.json)→ 仍然拒(撤销落盘了,重启不复活);
 *   ④ 重新配对之后照旧能用(这条路不能被这张卡堵上);
 *   ⑤ 工人替它来办事(`X-Workbench-Channel-Device`)也一律拒 —— 它手上那张房票还没过期,
 *      房里那条代理是它唯一还剩的手;
 *   ⑥ 在**别处**(另一台电脑)把它从账号里移除:本机配对没人动过,签票那一处自己核归属,
 *      当场拒并把本机配对也作废;
 *   ⑦ 从来没挂到账号下的纯局域网手机(电脑那时还没登录账号)→ 照旧签得出票,**不许拦**;
 *   ⑧ 账号设备表问不到(中转连不上)→ 也不许拦:取不到就缺席,不编一个「它被移除了」。
 */
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createAccountService } from '../src/server/account.ts'
import { createServerAccountService } from '../src/server/serverAccount.ts'
import { createChannelService } from '../src/server/channel.ts'
import { createPairingService } from '../src/server/devices.ts'
import { DEVICE_LEFT_ACCOUNT_TEXT } from '../src/server/deviceAccountGate.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { CALL_TOOL_DOING, CALL_TOOL_REMEMBER } from '../src/server/rtcCall.ts'
import { lanOn } from './helpers/lanOn.ts'

const LOOPBACK = '127.0.0.1'
const PHONE = '192.168.1.20'
const NOW_SEC = Math.floor(Date.parse('2026-10-03T09:00:00Z') / 1000)
const ENV = { WORKBENCH_CHANNEL_API_KEY: 'devkey', WORKBENCH_CHANNEL_API_SECRET: 'secret' }
const ACCOUNT = { id: 'acct-1', email_or_phone: 'ben', created_at: '2026-09-21T00:00:00.000Z' }

const started: WorkbenchServer[] = []
const relays: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (relays.length) await new Promise<void>(done => relays.pop()?.close(() => done()))
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/**
 * 假中转。`devices` 是**这个账号名下有哪几台**,用例自己往里加 / 从外面删 ——
 * 「在另一台电脑上移除了这台手机」就是直接改它,本机一个字都不知道。
 */
async function fakeRelay(options: { down?: boolean } = {}) {
  const state = { revoked: [] as string[], deviceIds: ['mac-1'] as string[], listed: 0 }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += String(c) })
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0]
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      const view = () => ({ devices: state.deviceIds.map(id => ({ device_id: id, name: id, kind: 'phone' })) })
      if (path === '/v1/account/login') return reply(200, { session_token: 'wbs_session-1', account: ACCOUNT })
      if (path === '/v1/account/devices') {
        state.listed += 1
        if (options.down === true) return reply(502, { error: { message: '中转这会儿不行' } })
        return reply(200, view())
      }
      if (path === '/v1/account/devices/revoke') {
        const id = (JSON.parse(raw === '' ? '{}' : raw) as { device_id?: string }).device_id ?? ''
        state.revoked.push(id)
        state.deviceIds = state.deviceIds.filter(one => one !== id)
        return reply(200, { ok: true, removed: 1, ...view() })
      }
      return reply(404, { error: { message: '没有这个路径' } })
    })
  })
  await new Promise<void>(resolve => { server.listen(0, LOOPBACK, resolve) })
  relays.push(server)
  const address = server.address()
  return { url: `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`, state }
}

/** 一台工作台。`dir` 给第二次启动复用(用例 ③ 的「重启」就是同一个 dir 再起一台)。 */
async function serve(options: { dir?: string, relay?: Awaited<ReturnType<typeof fakeRelay>> } = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'wb-device-revoke-'))
  if (options.dir === undefined) dirs.push(dir)
  const relay = options.relay ?? await fakeRelay()
  const pairing = createPairingService({ file: join(dir, 'devices.json'), now: () => NOW_SEC * 1000 })
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
  const channel = createChannelService({
    agentsFile: join(dir, 'AGENTS.md'),
    env: ENV,
    configFile: join(dir, '不存在.json'),
    nowSeconds: () => NOW_SEC,
    rememberTool: CALL_TOOL_REMEMBER,
    doingTool: CALL_TOOL_DOING,
  })

  const remote = { address: LOOPBACK }
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    pairing,
    account,
    channel,
    remoteAddress: () => remote.address,
    isLoopback: () => remote.address === LOOPBACK,
    lan: lanOn(),
  })
  started.push(server)

  let jar = ''
  const call = async (path: string, init: { method?: string, body?: unknown, from?: string, token?: string, asDevice?: string } = {}) => {
    remote.address = init.from ?? LOOPBACK
    const res = await fetch(`${server.url}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
        ...(init.asDevice === undefined ? {} : { 'x-workbench-channel-device': init.asDevice }),
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

  /** 扫码配对一台手机,回它的明文令牌与 device_id。 */
  const pair = async () => {
    const startRes = await call('/pair/start', { method: 'POST' })
    const code = (startRes.body.pairing as { code: string }).code
    const claimed = await call('/pair/claim', { body: { code, device_name: 'Ben 的 iPhone', platform: 'ios' }, from: PHONE })
    expect(claimed.status).toBe(200)
    return { token: claimed.body.token as string, id: claimed.body.device_id as string }
  }

  const login = async () => {
    expect((await call('/account/login', { body: { username: 'ben', password: 'hunter22' } })).status).toBe(200)
  }

  return { call, pair, login, relay, dir, pairing }
}

describe('一处撤销、三处生效', () => {
  it('① 移除之后,那台手机带旧令牌从局域网来一律 401,而且说的是「从账号里移除」', async () => {
    const wb = await serve()
    await wb.login()
    const phone = await wb.pair()
    wb.relay.state.deviceIds.push(phone.id)

    // 移除之前是好的:手机列得出事项(普通读路由,门是「回环或已配对设备」)。
    expect((await wb.call('/state', { from: PHONE, token: phone.token })).status).toBe(200)

    const removed = await wb.call('/account/devices/revoke', { body: { device_id: phone.id } })
    expect(removed.status).toBe(200)
    expect(wb.relay.state.revoked).toEqual([phone.id])

    const after = await wb.call('/state', { from: PHONE, token: phone.token })
    expect(after.status).toBe(401)
    expect(String(after.body.error)).toBe(DEVICE_LEFT_ACCOUNT_TEXT)
    // 写路由同样拒(不是只挡读的那一半)。
    expect((await wb.call('/butler/item', { body: { text: '随手记一条' }, from: PHONE, token: phone.token })).status).toBe(401)
  })

  it('② 移除之后再要进房凭证 → 拒,回包里没有 token', async () => {
    const wb = await serve()
    await wb.login()
    const phone = await wb.pair()
    wb.relay.state.deviceIds.push(phone.id)
    expect((await wb.call('/channel/token', { body: {}, from: PHONE, token: phone.token })).status).toBe(200)

    await wb.call('/account/devices/revoke', { body: { device_id: phone.id } })

    const signed = await wb.call('/channel/token', { body: {}, from: PHONE, token: phone.token })
    expect(signed.status).toBe(401)
    expect(signed.body.token).toBeUndefined()
  })

  it('③ 工作台重启之后仍然拒(撤销落了盘,不复活)', async () => {
    const first = await serve()
    await first.login()
    const phone = await first.pair()
    first.relay.state.deviceIds.push(phone.id)
    await first.call('/account/devices/revoke', { body: { device_id: phone.id } })
    await started.pop()?.close()

    // 同一个 dir、同一份 devices.json,新起一台。
    const again = await serve({ dir: first.dir, relay: first.relay })
    expect((await again.call('/state', { from: PHONE, token: phone.token })).status).toBe(401)
    expect((await again.call('/channel/token', { body: {}, from: PHONE, token: phone.token })).status).toBe(401)
  })

  it('④ 重新配对之后照旧能用(这条路不许被堵上)', async () => {
    const wb = await serve()
    await wb.login()
    const phone = await wb.pair()
    wb.relay.state.deviceIds.push(phone.id)
    await wb.call('/account/devices/revoke', { body: { device_id: phone.id } })

    const again = await wb.pair()
    wb.relay.state.deviceIds.push(again.id)
    expect(again.token).not.toBe(phone.token)
    expect((await wb.call('/state', { from: PHONE, token: again.token })).status).toBe(200)
    const signed = await wb.call('/channel/token', { body: {}, from: PHONE, token: again.token })
    expect(signed.status).toBe(200)
    expect(typeof signed.body.token).toBe('string')
    // 旧的那把仍然是废的:重新配对不会把上一把钥匙救回来。
    expect((await wb.call('/state', { from: PHONE, token: phone.token })).status).toBe(401)
  })

  it('⑤ 房里那条代理也撤得掉:工人替它来办事一律拒,它那张没过期的房票续不了', async () => {
    const wb = await serve()
    await wb.login()
    const phone = await wb.pair()
    wb.relay.state.deviceIds.push(phone.id)
    // 工人替它续票走的就是这一条(channel-worker/src/workbench.ts renewTicket)。
    expect((await wb.call('/channel/token', { body: {}, asDevice: phone.id })).status).toBe(200)

    await wb.call('/account/devices/revoke', { body: { device_id: phone.id } })

    const renew = await wb.call('/channel/token', { body: {}, asDevice: phone.id })
    expect(renew.status).toBe(401)
    expect(renew.body.token).toBeUndefined()
    expect(String(renew.body.error)).toBe(DEVICE_LEFT_ACCOUNT_TEXT)
    // 别的代办也一样(降权那一道门就是它的全部权限)。
    expect((await wb.call('/state', { asDevice: phone.id })).status).toBe(401)
  })

  it('本机那份「手机与设备」里也不再有它', async () => {
    const wb = await serve()
    await wb.login()
    const phone = await wb.pair()
    wb.relay.state.deviceIds.push(phone.id)
    expect(((await wb.call('/state')).body.devices as unknown[]).length).toBe(1)

    await wb.call('/account/devices/revoke', { body: { device_id: phone.id } })
    expect((await wb.call('/state')).body.devices).toEqual([])
  })
})

describe('签票先核归属', () => {
  it('⑥ 在别处把它从账号里移除:本机配对没人动过,签票这一处自己拒,并把本机配对也作废', async () => {
    const wb = await serve()
    await wb.login()
    const phone = await wb.pair()
    wb.relay.state.deviceIds.push(phone.id)
    // 先成功签一次 —— 这一次把「它在这个账号的设备表里」记进本机配对记录。
    expect((await wb.call('/channel/token', { body: {}, from: PHONE, token: phone.token })).status).toBe(200)

    // 另一台电脑上移除了它:中转的设备表里没有它了,本机 devices.json 一个字没改。
    wb.relay.state.deviceIds = wb.relay.state.deviceIds.filter(one => one !== phone.id)
    expect(await wb.pairing.list()).toHaveLength(1)

    const signed = await wb.call('/channel/token', { body: {}, from: PHONE, token: phone.token })
    expect(signed.status).toBe(403)
    expect(String(signed.body.error)).toBe(DEVICE_LEFT_ACCOUNT_TEXT)
    // 核出来就当场撤本机配对:下一条请求连门都进不来(而且这一下落了盘)。
    expect(await wb.pairing.list()).toEqual([])
    expect((await wb.call('/state', { from: PHONE, token: phone.token })).status).toBe(401)
  })

  it('⑥\' 被移出账号的手机不能靠 /channel/relay-device 把自己再挂回账号', async () => {
    const wb = await serve()
    await wb.login()
    const phone = await wb.pair()
    wb.relay.state.deviceIds.push(phone.id)
    expect((await wb.call('/channel/token', { body: {}, from: PHONE, token: phone.token })).status).toBe(200)

    wb.relay.state.deviceIds = wb.relay.state.deviceIds.filter(one => one !== phone.id)
    const again = await wb.call('/channel/relay-device', { body: {}, from: PHONE, token: phone.token })
    expect(again.status).toBe(403)
    expect(String(again.body.error)).toBe(DEVICE_LEFT_ACCOUNT_TEXT)
    expect(again.body.token).toBeUndefined()
  })

  it('刚配对、从没挂过账号的手机走 relay-device 过得了这道闸(拦的不是它)', async () => {
    const wb = await serve()
    await wb.login()
    const phone = await wb.pair()
    // 这台机器上没接模型服务 → 到不了中转那一步,回的是「取不到中转地址」那条 404。
    // 关键是**它不是 403**:归属那道闸放行了。
    const attach = await wb.call('/channel/relay-device', { body: {}, from: PHONE, token: phone.token })
    expect(attach.status).toBe(404)
    expect(String(attach.body.error)).not.toBe(DEVICE_LEFT_ACCOUNT_TEXT)
  })

  it('⑦ 从来没挂到账号下的纯局域网手机:照旧签得出票', async () => {
    const wb = await serve()
    await wb.login()
    const phone = await wb.pair()
    // 账号表里从来没有它(电脑那会儿还没登录 / 代领失败,phoneLogin 那一步「失败一律不吵」)。
    const signed = await wb.call('/channel/token', { body: {}, from: PHONE, token: phone.token })
    expect(signed.status).toBe(200)
    expect(typeof signed.body.token).toBe('string')
  })

  it('⑧ 账号设备表问不到时不许拦:取不到就缺席,不编一个「它被移除了」', async () => {
    const down = await fakeRelay({ down: true })
    const wb = await serve({ relay: down })
    await wb.login()
    const phone = await wb.pair()
    const signed = await wb.call('/channel/token', { body: {}, from: PHONE, token: phone.token })
    expect(signed.status).toBe(200)
    expect(typeof signed.body.token).toBe('string')
  })

  it('没登录账号时这一层压根不问中转(本机账号谈不上「归属」)', async () => {
    const wb = await serve()
    const phone = await wb.pair()
    const before = wb.relay.state.listed
    expect((await wb.call('/channel/token', { body: {}, from: PHONE, token: phone.token })).status).toBe(200)
    expect(wb.relay.state.listed).toBe(before)
  })
})
