/**
 * 账号搬到服务器(2026-09-21)。这个文件盯三件事,每一件都是"做错了会很难查"的那种:
 *
 *   1. **迁移**:Ben 那台上已经有一份本机账号,他照旧输一次用户名密码就该在服务器上了,
 *      而且本机那份密码当场消失;
 *   2. **退路**:服务器没有账号服务(404 / 连不上)时,一个字不改地退回本机账号 ——
 *      任务卡原话「不能把现在能用的登录搞坏」;
 *   3. **边界**:服务器会话令牌不进任何回包;服务器明确说 401 才下线,网络抖动不算。
 *
 * 中转这一头用一个真的 http 服务器演(不 mock fetch):要验的恰恰是状态码与回包形状怎么被翻译。
 */
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createAccountService, type AccountService } from '../src/server/account.ts'
import { createServerAccountService, type ServerAccountService } from '../src/server/serverAccount.ts'

let dir: string
let relay: Server
let relayUrl: string
/** 假中转的行为由用例挑。每条路一个 handler,回 `[status, body]`。 */
let routes: Record<string, (body: Record<string, unknown>, auth?: string) => [number, unknown]>
let seen: { path: string, auth?: string }[]

/** scrypt 那几条用例跑起来很慢,把 N 调到最小(只影响算得快不快,不影响任何逻辑)。 */
function localService(): AccountService {
  return createAccountService({
    file: join(dir, 'account.json'),
    keyFile: join(dir, 'account-session.key'),
    scryptN: 16,
  })
}

function serverService(overrides: Partial<Parameters<typeof createServerAccountService>[0]> = {}): ServerAccountService {
  return createServerAccountService({
    local: localService(),
    localFile: join(dir, 'account.json'),
    sessionFile: join(dir, 'account-server.json'),
    keyFile: join(dir, 'account-session.key'),
    relayUrl: async () => relayUrl,
    ...overrides,
  })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wb-account-'))
  seen = []
  routes = {}
  relay = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += String(chunk) })
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] as string
      seen.push({ path, ...(req.headers.authorization === undefined ? {} : { auth: req.headers.authorization }) })
      const handler = routes[path]
      if (handler === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: '没有这个路径' } }))
        return
      }
      let body: Record<string, unknown> = {}
      try { body = raw === '' ? {} : JSON.parse(raw) as Record<string, unknown> }
      catch { body = {} }
      const [status, payload] = handler(body, req.headers.authorization)
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
  await new Promise<void>((resolve) => { relay.listen(0, '127.0.0.1', resolve) })
  const address = relay.address()
  relayUrl = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => { relay.close(() => resolve()) })
  await rm(dir, { recursive: true, force: true })
})

/** 一个"什么都好"的中转:注册、登录、me、devices 都成。 */
function happyRelay(identifier = 'ben', accountId = 'acct-id-1'): void {
  const account = { id: accountId, email_or_phone: identifier, created_at: '2026-09-21T00:00:00.000Z' }
  routes['/v1/account/register'] = () => [201, { session_token: 'wbs_server-session-1', account }]
  routes['/v1/account/login'] = () => [200, { session_token: 'wbs_server-session-1', account }]
  routes['/v1/account/logout'] = () => [200, { ok: true }]
  routes['/v1/account/me'] = () => [200, account]
  routes['/v1/account/devices'] = () => [200, { devices: [
    { device_id: 'mac-1', name: '我的 Mac', kind: 'mac', created_at: '2026-09-21T00:00:00.000Z' },
    { device_id: 'phone-1', name: '我的手机', kind: 'phone', created_at: '2026-09-21T01:00:00.000Z' },
  ] }]
}

describe('注册到服务器', () => {
  it('注册成功:回一张本机 cookie,服务器那张会话令牌**不在回包里**', async () => {
    happyRelay()
    const service = serverService()
    const result = await service.register({ username: 'ben', password: 'hunter22', confirm: 'hunter22' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.token.includes('wbs_')).toBe(false)
    expect(await service.verify(result.token)).toEqual({ username: 'ben' })
    const view = await service.view(result.token)
    expect(view).toMatchObject({ registered: true, logged_in: true, username: 'ben', on_server: true })
  })

  it('会话令牌落在 0600 的 account-server.json 里,**不落 account.json**', async () => {
    happyRelay()
    const service = serverService()
    await service.register({ username: 'ben', password: 'hunter22', confirm: 'hunter22' })
    const file = join(dir, 'account-server.json')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(file, 'utf8')).session.token).toBe('wbs_server-session-1')
    // 本机那份里一个密码相关的字节都没有。
    const local = JSON.parse(await readFile(join(dir, 'account.json'), 'utf8').catch(() => '{}'))
    expect(local.account).toBeUndefined()
  })

  it('服务器说这个邮箱注册过了 → 原样把那句话回给界面', async () => {
    routes['/v1/account/register'] = () => [409, { error: { message: '这个邮箱/手机号已经注册过了,直接登录就行。', code: 'account_exists' } }]
    const result = await serverService().register({ username: 'ben', password: 'hunter22', confirm: 'hunter22' })
    expect(result).toMatchObject({ ok: false, status: 409, error: '这个邮箱/手机号已经注册过了,直接登录就行。' })
  })

  it('两次密码不一样 → 根本不打网络', async () => {
    happyRelay()
    const result = await serverService().register({ username: 'ben', password: 'hunter22', confirm: 'other' })
    expect(result.ok).toBe(false)
    expect(seen).toHaveLength(0)
  })
})

describe('登录', () => {
  it('登录成功之后 verify 认得出;换一张伪造的 cookie 认不出', async () => {
    happyRelay()
    const service = serverService()
    const result = await service.login({ username: 'ben', password: 'hunter22' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(await service.verify(result.token)).toEqual({ username: 'ben' })
    expect(await service.verify(`${result.token}x`)).toBeUndefined()
  })

  it('密码不对、而且本机也没有可迁移的账号 → 原样回服务器那句话', async () => {
    routes['/v1/account/login'] = () => [401, { error: { message: '邮箱/手机号或密码不对。', code: 'bad_credentials' } }]
    const result = await serverService().login({ username: 'ben', password: 'wrong-one' })
    expect(result).toMatchObject({ ok: false, status: 401, error: '邮箱/手机号或密码不对。' })
  })

  it('服务器说锁住了 → 429 带上 locked_until', async () => {
    routes['/v1/account/login'] = () => [429, { error: { message: '密码连续错 5 次,10 分钟内不再接受登录。', code: 'account_locked' } }]
    const service = serverService()
    const result = await service.login({ username: 'ben', password: 'wrong-one' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(429)
    expect(typeof result.locked_until).toBe('string')
    expect(service.lockedUntil()).toBe(result.locked_until)
  })
})

describe('无痛迁移(Ben 那台)', () => {
  /** 先在本机注册一个,模拟 Ben 那台已经有的那一份。 */
  async function localAccountExists(username = 'ben', password = 'hunter22'): Promise<void> {
    const local = localService()
    const done = await local.register({ username, password, confirm: password })
    expect(done.ok).toBe(true)
  }

  it('本机有账号、服务器没有 → 自动注册一次,然后本机那份密码消失', async () => {
    await localAccountExists()
    routes['/v1/account/login'] = () => [401, { error: { message: '邮箱/手机号或密码不对。', code: 'bad_credentials' } }]
    happyRelayRegisterOnly()

    const service = serverService()
    const result = await service.login({ username: 'ben', password: 'hunter22' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.username).toBe('ben')
    // 本机那份被抹掉了:从这一刻起这台机器上没有任何能验密码的东西。
    const local = JSON.parse(await readFile(join(dir, 'account.json'), 'utf8'))
    expect(local.account).toBeUndefined()
    // 而且登录态是真的(cookie 验得过)。
    expect(await service.verify(result.token)).toEqual({ username: 'ben' })
  })

  it('**本机密码对不上就不迁移** —— 否则随便输一对新密码都会被当成登录', async () => {
    await localAccountExists('ben', 'hunter22')
    routes['/v1/account/login'] = () => [401, { error: { message: '邮箱/手机号或密码不对。', code: 'bad_credentials' } }]
    happyRelayRegisterOnly()

    const result = await serverService().login({ username: 'ben', password: 'not-his-password' })
    expect(result).toMatchObject({ ok: false, status: 401 })
    // 一次注册都没发生过。
    expect(seen.some(r => r.path === '/v1/account/register')).toBe(false)
  })

  it('迁移途中服务器挂了:本机那份刚验过,就按本机登录算,别把人挡在外面', async () => {
    await localAccountExists()
    routes['/v1/account/login'] = () => [401, { error: { message: '邮箱/手机号或密码不对。', code: 'bad_credentials' } }]
    // /v1/account/register 没有 handler → 404 → unsupported
    const service = serverService()
    const result = await service.login({ username: 'ben', password: 'hunter22' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // 本机那份**没有**被抹掉(还没迁成,抹了就谁都登不上了)。
    const local = JSON.parse(await readFile(join(dir, 'account.json'), 'utf8'))
    expect(local.account?.hash).toBeTypeOf('string')
  })

  function happyRelayRegisterOnly(): void {
    routes['/v1/account/register'] = () => [201, {
      session_token: 'wbs_server-session-1',
      account: { id: 'acct-id-1', email_or_phone: 'ben', created_at: '2026-09-21T00:00:00.000Z' },
    }]
    routes['/v1/account/logout'] = () => [200, { ok: true }]
  }
})

describe('服务器没有账号服务时退回本机', () => {
  it('注册退回本机:本机 account.json 真的写出来了', async () => {
    // 一条 handler 都不挂 → 全是 404 → unsupported
    const service = serverService()
    const result = await service.register({ username: 'ben', password: 'hunter22', confirm: 'hunter22' })
    expect(result.ok).toBe(true)
    const local = JSON.parse(await readFile(join(dir, 'account.json'), 'utf8'))
    expect(local.account.username).toBe('ben')
  })

  it('登录退回本机:on_server 为假,界面据此不显示「我的设备」', async () => {
    const local = localService()
    await local.register({ username: 'ben', password: 'hunter22', confirm: 'hunter22' })
    const service = serverService()
    const result = await service.login({ username: 'ben', password: 'hunter22' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const view = await service.view(result.token)
    expect(view.on_server).toBe(false)
    expect(view.logged_in).toBe(true)
  })

  it('连不上(端口关了)也算退回,不是登录失败', async () => {
    const local = localService()
    await local.register({ username: 'ben', password: 'hunter22', confirm: 'hunter22' })
    const service = serverService({ relayUrl: async () => 'http://127.0.0.1:1' })
    const result = await service.login({ username: 'ben', password: 'hunter22' })
    expect(result.ok).toBe(true)
  })
})

describe('没接中转(零服务器档,2026-10-21)', () => {
  it('注册与登录照旧是本机账号,一个包都不往中转发;账号页说「不在服务器上」', async () => {
    let asked = 0
    const service = serverService({
      relayUrl: async () => '',
      fetchImpl: (async () => { asked += 1; return new Response('{}') }) as unknown as typeof fetch,
    })
    const created = await service.register({ username: 'ben', password: 'hunter22', confirm: 'hunter22' })
    expect(created.ok).toBe(true)
    const login = await service.login({ username: 'ben', password: 'hunter22' })
    expect(login.ok).toBe(true)
    if (!login.ok) return
    expect(await service.view(login.token)).toMatchObject({ logged_in: true, username: 'ben', on_server: false, relay_configured: false })
    expect(asked).toBe(0)
    expect(seen).toEqual([])
  })
})

describe('登出与「重置账号」', () => {
  it('登出把服务器那张吊销,本机 cookie 当场失效,**但记得上一次是谁**', async () => {
    happyRelay()
    const service = serverService()
    const login = await service.login({ username: 'ben', password: 'hunter22' })
    expect(login.ok).toBe(true)
    if (!login.ok) return

    await service.logout()
    expect(seen.some(r => r.path === '/v1/account/logout' && r.auth === 'Bearer wbs_server-session-1')).toBe(true)
    expect(await service.verify(login.token)).toBeUndefined()
    // 回到的是登录页(registered 为真),不是注册页。
    const view = await service.view(login.token)
    expect(view).toMatchObject({ registered: true, logged_in: false, username: 'ben' })
  })

  it('服务器吊销失败也照样本地下线 —— 人要的是「我下线了」', async () => {
    happyRelay()
    routes['/v1/account/logout'] = () => [500, { error: { message: '炸了' } }]
    const service = serverService()
    const login = await service.login({ username: 'ben', password: 'hunter22' })
    if (!login.ok) return
    await service.logout()
    expect(await service.verify(login.token)).toBeUndefined()
  })

  it('「重置账号」= 本机登出:服务器上那个账号**不删**', async () => {
    happyRelay()
    const service = serverService()
    const login = await service.login({ username: 'ben', password: 'hunter22' })
    if (!login.ok) return
    await service.reset()
    expect(await service.verify(login.token)).toBeUndefined()
    // 没有任何一条"删账号"的请求发出去过。
    expect(seen.every(r => !r.path.includes('delete'))).toBe(true)
    // 而且还能再登回来。
    const again = await service.login({ username: 'ben', password: 'hunter22' })
    expect(again.ok).toBe(true)
  })
})

describe('我的设备', () => {
  it('列得出来,而且回包里没有令牌', async () => {
    happyRelay()
    const service = serverService()
    await service.login({ username: 'ben', password: 'hunter22' })
    const result = await service.devices()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.view.devices.map(d => d.device_id)).toEqual(['mac-1', 'phone-1'])
    expect(JSON.stringify(result.view).includes('wb_')).toBe(false)
  })

  it('移除一台之后回的是剩下的那些', async () => {
    happyRelay()
    routes['/v1/account/devices/revoke'] = () => [200, {
      ok: true, removed: 1,
      devices: [{ device_id: 'mac-1', name: '我的 Mac', kind: 'mac', created_at: '2026-09-21T00:00:00.000Z' }],
    }]
    const service = serverService()
    await service.login({ username: 'ben', password: 'hunter22' })
    const result = await service.revokeDevice('phone-1')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.view.devices.map(d => d.device_id)).toEqual(['mac-1'])
  })

  it('没登录时回一句人话,不抛', async () => {
    const result = await serverService().devices()
    expect(result).toMatchObject({ ok: false })
  })

  it('服务器**明确说** 401 → 当场下线;500 / 连不上 → 只是一句话,不下线', async () => {
    happyRelay()
    const service = serverService()
    const login = await service.login({ username: 'ben', password: 'hunter22' })
    if (!login.ok) return

    routes['/v1/account/devices'] = () => [500, { error: { message: '服务器这会儿有点问题' } }]
    expect((await service.devices()).ok).toBe(false)
    // 500 不算下线。
    expect(await service.verify(login.token)).toEqual({ username: 'ben' })

    routes['/v1/account/devices'] = () => [401, { error: { message: '登录状态不认识或已失效。', code: 'invalid_account_session' } }]
    expect((await service.devices()).ok).toBe(false)
    // 401 才算。
    expect(await service.verify(login.token)).toBeUndefined()
  })
})

describe('改密码', () => {
  it('登录着 + 说得出当前密码 → 打中转那条路,cookie 不换', async () => {
    happyRelay()
    routes['/v1/account/password'] = () => [200, { ok: true }]
    const service = serverService()
    const login = await service.login({ username: 'ben', password: 'hunter22' })
    if (!login.ok) return
    const changed = await service.register({
      password: 'new-pass-9', confirm: 'new-pass-9', current_password: 'hunter22', token: login.token,
    })
    expect(changed.ok).toBe(true)
    if (!changed.ok) return
    // 还是登录着(sid 绑的是会话令牌,不是密码)。
    expect(await service.verify(changed.token)).toEqual({ username: 'ben' })
  })

  it('没登录就想改密码 → 403,一次网络都不打', async () => {
    happyRelay()
    const service = serverService()
    await service.login({ username: 'ben', password: 'hunter22' })
    const before = seen.length
    const changed = await service.register({ password: 'new-pass-9', confirm: 'new-pass-9', current_password: 'hunter22' })
    expect(changed).toMatchObject({ ok: false, status: 403 })
    expect(seen).toHaveLength(before)
  })

  it('当前密码没填 → 400', async () => {
    happyRelay()
    const service = serverService()
    const login = await service.login({ username: 'ben', password: 'hunter22' })
    if (!login.ok) return
    const changed = await service.register({ password: 'new-pass-9', confirm: 'new-pass-9', token: login.token })
    expect(changed).toMatchObject({ ok: false, status: 400 })
  })
})

describe('会话令牌的去向', () => {
  it('sessionToken() 拿得到(给 modelService 领设备令牌用),别的路一个字都不给', async () => {
    happyRelay()
    const service = serverService()
    const login = await service.login({ username: 'ben', password: 'hunter22' })
    if (!login.ok) return
    expect(await service.sessionToken()).toBe('wbs_server-session-1')
    // view 与 cookie 里都没有它。
    expect(JSON.stringify(await service.view(login.token)).includes('wbs_')).toBe(false)
    expect(login.token.includes('wbs_')).toBe(false)
  })

  it('登出之后 sessionToken() 是空的', async () => {
    happyRelay()
    const service = serverService()
    await service.login({ username: 'ben', password: 'hunter22' })
    await service.logout()
    expect(await service.sessionToken()).toBeUndefined()
  })
})
